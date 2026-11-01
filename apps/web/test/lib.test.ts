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
import { formatAgo, isLive } from "../src/lib/time.js";

function ev(seq: number, extra: Partial<BatonEvent> = {}): BatonEvent {
  return {
    id: `e${seq}`,
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
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
    });
    return { sockets, timers, received, manager };
  }
  const send = (h: SocketHandlers, msg: unknown) => h.onMessage(JSON.stringify(msg));
  const hello = (epoch: string) => ({ type: "hello", protocol: 1, epoch, seq: 0, session: "all" });

  it("resumes with lastSeq and epoch after a drop, with growing backoff", () => {
    const { sockets, timers, received, manager } = setup();
    manager.start();
    expect(sockets.urls[0]).toBe("ws://h/ws?session=all");
    sockets.last.onOpen();
    send(sockets.last, hello("E1"));
    send(sockets.last, { type: "event", seq: 7, event: ev(1) });
    expect(received).toEqual([7]);
    sockets.last.onClose();
    expect(manager.getState().status).toBe("reconnecting");
    expect(timers[0]?.ms).toBe(100);
    timers[0]?.fn();
    expect(sockets.urls[1]).toBe("ws://h/ws?session=all&lastSeq=7&epoch=E1");
    sockets.last.onClose();
    expect(timers[1]?.ms).toBe(200);
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
