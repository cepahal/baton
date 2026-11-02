import type { BatonEvent } from "@baton/core";
import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/lib/backoff.js";
import {
  ConnectionManager,
  type SocketFactory,
  type SocketHandlers,
} from "../src/lib/connection.js";
import { EventStore } from "../src/lib/event-store.js";
import { buildFeedRows } from "../src/lib/feed-rows.js";
import { latestOnly } from "../src/lib/latest-only.js";
import { defaultSelection, SELECTION_KEY, Selection } from "../src/lib/selection.js";
import { formatAgo, isLive } from "../src/lib/time.js";

function ev(seq: number, extra: Partial<BatonEvent> = {}): BatonEvent {
  return {
    id: `e${seq}`,
    agent: "claude-code",
    sessionId: "s1",
    projectPath: "/p",
    ts: new Date(seq * 1000).toISOString(),
    seq,
    kind: "reply",
    text: `event ${seq}`,
    ...extra,
  };
}

describe("backoffDelay", () => {
  it("doubles per attempt, caps, and jitters into [50%, 100%]", () => {
    const opts = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(0, opts, () => 1)).toBe(100);
    expect(backoffDelay(3, opts, () => 1)).toBe(800);
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
    expect(backoffDelay(10, opts, () => 0)).toBe(500);
  });
});

describe("EventStore", () => {
  it("dedupes by id, orders by seq, and batches notifications", () => {
    const flushes: (() => void)[] = [];
    const store = new EventStore({ schedule: (f) => flushes.push(f) });
    let calls = 0;
    let sessions = 0;
    store.subscribe("s1", () => calls++);
    store.subscribeSessions(() => sessions++);
    expect(store.add(ev(2))).toBe(true);
    expect(store.add(ev(1))).toBe(true);
    expect(store.add(ev(2))).toBe(false);
    expect(flushes).toHaveLength(1);
    flushes[0]?.();
    expect(calls).toBe(1);
    expect(sessions).toBe(1);
    expect(store.events("s1").map((e) => e.seq)).toEqual([1, 2]);
    expect(store.events("s1")).toBe(store.events("s1"));
    expect(store.lastTs("s1")).toBe(ev(2).ts);
  });
});

describe("buildFeedRows", () => {
  it("folds consecutive sidechain events from one agent into a group", () => {
    const side = (seq: number, agentId: string) => ev(seq, { meta: { sidechain: true, agentId } });
    const rows = buildFeedRows([ev(1), side(2, "a"), side(3, "a"), side(4, "b"), ev(5)]);
    expect(rows.map((r) => (r.type === "event" ? r.type : `${r.type}:${r.events.length}`))).toEqual(
      ["event", "sidechain:2", "sidechain:1", "event"],
    );
  });
});

describe("time", () => {
  it("formats relative time and liveness", () => {
    expect(formatAgo(0, 2000)).toBe("just now");
    expect(formatAgo(0, 300_000)).toBe("5m ago");
    expect(isLive(new Date(0).toISOString(), 10_000)).toBe(true);
    expect(isLive(new Date(0).toISOString(), 1_000_000)).toBe(false);
    expect(isLive("nonsense", 0)).toBe(false);
  });
});

class FakeSockets {
  urls: string[] = [];
  handlers: SocketHandlers[] = [];
  closed = 0;
  factory: SocketFactory = (url, handlers) => {
    this.urls.push(url);
    this.handlers.push(handlers);
    return { close: () => this.closed++ };
  };
  get last(): SocketHandlers {
    const h = this.handlers.at(-1);
    if (!h) throw new Error("no socket");
    return h;
  }
}

describe("ConnectionManager", () => {
  const STABLE_MS = 5000;
  function setup() {
    const sockets = new FakeSockets();
    const timers: { fn: () => void; ms: number }[] = [];
    const received: number[] = [];
    const manager = new ConnectionManager({
      url: "ws://h/ws",
      onEvent: (m) => received.push(m.seq),
      createSocket: sockets.factory,
      random: () => 1,
      now: () => 0,
      backoff: { baseMs: 100, maxMs: 1000 },
      stableMs: STABLE_MS,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
    });
    /** Reconnect timers, without the stable-connection timers. */
    const backoffs = () => timers.filter((t) => t.ms !== STABLE_MS);
    return { sockets, timers, backoffs, received, manager };
  }
  const send = (h: SocketHandlers, msg: unknown) => h.onMessage(JSON.stringify(msg));
  const hello = (epoch: string) => ({ type: "hello", protocol: 1, epoch, seq: 0, session: "all" });

  it("resumes with lastSeq and epoch after a drop, with growing backoff", () => {
    const { sockets, backoffs, received, manager } = setup();
    manager.start();
    expect(sockets.urls[0]).toBe("ws://h/ws?session=all");
    sockets.last.onOpen();
    send(sockets.last, hello("E1"));
    send(sockets.last, { type: "event", seq: 7, event: ev(1) });
    expect(received).toEqual([7]);
    sockets.last.onClose();
    expect(manager.getState().status).toBe("reconnecting");
    expect(backoffs()[0]?.ms).toBe(100);
    backoffs()[0]?.fn();
    expect(sockets.urls[1]).toBe("ws://h/ws?session=all&lastSeq=7&epoch=E1");
    sockets.last.onClose();
    expect(backoffs()[1]?.ms).toBe(200);
  });

  it("forgets lastSeq when the epoch changes and ignores invalid messages", () => {
    const { sockets, manager } = setup();
    manager.start();
    sockets.last.onOpen();
    send(sockets.last, hello("E1"));
    send(sockets.last, { type: "event", seq: 3, event: ev(1) });
    send(sockets.last, hello("E2"));
    sockets.last.onMessage("not json");
    send(sockets.last, { type: "event", seq: "x" });
    expect(manager.getState()).toMatchObject({ epoch: "E2", status: "open" });
    expect(manager.getState().lastSeq).toBeUndefined();
  });

  it("keeps backing off and shows the hub error when a socket opens then closes", () => {
    const { sockets, backoffs, manager } = setup();
    manager.start();
    for (let i = 0; i < 3; i++) {
      sockets.last.onOpen();
      send(sockets.last, { type: "error", message: "invalid query" });
      sockets.last.onClose();
      backoffs().at(-1)?.fn();
    }
    expect(backoffs().map((t) => t.ms)).toEqual([100, 200, 400]);
    expect(manager.getState()).toMatchObject({ attempt: 3, error: "invalid query" });
  });

  it("resets backoff and clears the error once a socket stays open", () => {
    const { sockets, timers, manager } = setup();
    manager.start();
    sockets.last.onOpen();
    send(sockets.last, { type: "error", message: "boom" });
    sockets.last.onClose();
    timers.at(-1)?.fn();
    sockets.last.onOpen();
    const stable = timers.at(-1);
    expect(stable?.ms).toBe(STABLE_MS);
    stable?.fn();
    expect(manager.getState().attempt).toBe(0);
    expect(manager.getState().error).toBeUndefined();
  });

  it("only offers retryNow while waiting out backoff", () => {
    const { sockets, timers, manager } = setup();
    manager.start();
    sockets.last.onClose();
    expect(manager.getState().retryAt).toBeDefined();
    timers.at(-1)?.fn();
    expect(manager.getState()).toMatchObject({ status: "reconnecting" });
    expect(manager.getState().retryAt).toBeUndefined();
  });

  it("ignores callbacks from a socket after stop", () => {
    const { sockets, timers, manager } = setup();
    manager.start();
    const old = sockets.last;
    manager.stop();
    old.onClose();
    expect(timers).toHaveLength(0);
    expect(manager.getState().status).toBe("stopped");
  });
});

class MemoryStorage {
  items = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.items.set(key, value);
  }
}

describe("Selection", () => {
  it("doesn't write storage on load, so a later visit can still get defaults", () => {
    const storage = new MemoryStorage();
    new Selection(storage, 3);
    expect(storage.writes).toBe(0);
    const next = new Selection(storage, 3);
    next.initialize(["a"]);
    expect(next.get()).toEqual(["a"]);
    expect(storage.getItem(SELECTION_KEY)).toBe('["a"]');
  });

  it("keeps a remembered or picked selection over defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(SELECTION_KEY, '["x","y","z","w"]');
    const remembered = new Selection(storage, 3);
    remembered.initialize(["a"]);
    expect(remembered.get()).toEqual(["x", "y", "z"]);

    const picked = new Selection(new MemoryStorage(), 1);
    picked.toggle("b");
    picked.toggle("c");
    picked.initialize(["a"]);
    expect(picked.get()).toEqual(["b"]);
  });
});

describe("defaultSelection", () => {
  const session = (sessionId: string, lastActivity: string) => ({
    sessionId,
    agent: "claude-code" as const,
    projectPath: "/p",
    projectName: "p",
    lastActivity,
    events: 1,
  });

  it("waits for a successful fetch", () => {
    const now = 10_000_000;
    const sessions = [session("live", new Date(now).toISOString()), session("old", ev(1).ts)];
    expect(defaultSelection({ sessions: [], loaded: false }, now, 3)).toBeUndefined();
    expect(
      defaultSelection({ sessions: [], loaded: true, error: "HTTP 502" }, now, 3),
    ).toBeUndefined();
    expect(defaultSelection({ sessions, loaded: true }, now * 2, 3)).toEqual([]);
    expect(defaultSelection({ sessions, loaded: true }, now, 3)).toEqual(["live"]);
  });
});

describe("latestOnly", () => {
  it("drops a response that settles after a newer one", async () => {
    const pending: ((v: string) => void)[] = [];
    const seen: string[] = [];
    const call = latestOnly(
      () => new Promise<string>((resolve) => pending.push(resolve)),
      (v) => seen.push(v),
      () => seen.push("error"),
    );
    const first = call();
    const second = call();
    pending[1]?.("new");
    await second;
    pending[0]?.("old");
    await first;
    expect(seen).toEqual(["new"]);
  });
});
