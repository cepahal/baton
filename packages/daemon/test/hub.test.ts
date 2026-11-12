import { type BatonEvent, PROTOCOL_VERSION, ServerMessage } from "@baton/core";
import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "../src/event-log.js";
import { type ClientSocket, Hub, type HubOptions } from "../src/hub.js";
import { SESSION_A, SESSION_B, silent } from "./helpers.js";

class FakeSocket implements ClientSocket {
  readonly sent: ServerMessage[] = [];
  bufferedAmount = 0;
  closed: number | undefined;
  send(data: string) {
    this.sent.push(ServerMessage.parse(JSON.parse(data)));
  }
  close(code?: number) {
    this.closed = code;
  }
  get texts() {
    return this.sent.flatMap((m) => (m.type === "event" ? [m.event.text] : []));
  }
  ofType<T extends ServerMessage["type"]>(type: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

let n = 0;
const ev = (sessionId: string, text: string, ts = "2026-11-01T12:00:00.000Z"): BatonEvent => ({
  id: `e${++n}`,
  agent: "claude-code",
  sessionId,
  projectPath: "/home/dev/proj",
  ts,
  seq: n,
  kind: "prompt",
  text,
});

const hub = ({ maxEvents = 100, ...options }: Partial<HubOptions> & { maxEvents?: number } = {}) =>
  new Hub({
    log: new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents }),
    activeWindowMs: 60_000,
    logger: silent,
    ...options,
  });

describe("Hub", () => {
  it("numbers events with a monotonic seq and greets each client", () => {
    const h = hub();
    const s = new FakeSocket();
    h.connect(s, { session: "all" });
    h.publish([ev(SESSION_A, "a"), ev(SESSION_B, "b")]);
    h.publish([ev(SESSION_A, "c")], { backlog: true });
    expect(s.sent[0]).toEqual({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      epoch: h.epoch,
      seq: 0,
      session: "all",
    });
    expect(s.ofType("event").map((m) => [m.seq, m.event.text, m.backlog])).toEqual([
      [1, "a", undefined],
      [2, "b", undefined],
      [3, "c", true],
    ]);
    expect(h.seq).toBe(3);
  });

  it("replays the whole buffer to a new client, filtered by session", () => {
    const h = hub();
    h.publish([ev(SESSION_A, "a1"), ev(SESSION_B, "b1"), ev(SESSION_A, "a2")]);
    const s = new FakeSocket();
    h.connect(s, { session: SESSION_A });
    expect(s.texts).toEqual(["a1", "a2"]);
    h.publish([ev(SESSION_B, "b2"), ev(SESSION_A, "a3")]);
    expect(s.texts).toEqual(["a1", "a2", "a3"]);
  });

  it("replays only what came after lastSeq", () => {
    const h = hub();
    h.publish(["a", "b", "c"].map((t) => ev(SESSION_A, t)));
    const s = new FakeSocket();
    h.connect(s, { session: "all", lastSeq: 1, epoch: h.epoch });
    expect(s.texts).toEqual(["b", "c"]);
    expect(s.ofType("gap")).toEqual([]);
  });

  it("replays everything when lastSeq is from another epoch or the future", () => {
    const h = hub();
    h.publish(["a", "b"].map((t) => ev(SESSION_A, t)));
    const other = new FakeSocket();
    h.connect(other, { session: "all", lastSeq: 1, epoch: "previous-run" });
    expect(other.texts).toEqual(["a", "b"]);
    const future = new FakeSocket();
    h.connect(future, { session: "all", lastSeq: 99 });
    expect(future.texts).toEqual(["a", "b"]);
  });

  it("sends a gap when lastSeq is older than the buffer", () => {
    const h = hub({ maxEvents: 2 });
    h.publish(["a", "b", "c", "d"].map((t) => ev(SESSION_A, t)));
    const s = new FakeSocket();
    h.connect(s, { session: "all", lastSeq: 0 });
    expect(s.ofType("gap")).toEqual([{ type: "gap", fromSeq: 1, toSeq: 2 }]);
    expect(s.texts).toEqual(["c", "d"]);
  });

  it("resubscribes on a subscribe message and rejects bad messages", () => {
    const h = hub();
    h.publish([ev(SESSION_A, "a"), ev(SESSION_B, "b")]);
    const s = new FakeSocket();
    const client = h.connect(s, { session: SESSION_A });
    h.receive(client, JSON.stringify({ type: "subscribe", session: SESSION_B }));
    expect(s.ofType("hello").map((m) => m.session)).toEqual([SESSION_A, SESSION_B]);
    expect(s.texts).toEqual(["a", "b"]);

    h.receive(client, "not json");
    h.receive(client, JSON.stringify({ type: "subscribe" }));
    h.receive(client, JSON.stringify({ type: "nope", session: "all" }));
    const errors = s.ofType("error").map((m) => m.message);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe("message is not valid JSON");
    expect(errors[1]).toMatch(/^invalid message: session/);
  });

  it("stops sending to a disconnected client", () => {
    const h = hub();
    const s = new FakeSocket();
    const client = h.connect(s, { session: "all" });
    h.disconnect(client);
    h.publish([ev(SESSION_A, "a")]);
    expect(s.texts).toEqual([]);
    expect(h.clientCount).toBe(0);
  });

  it("drops a client that is not keeping up", () => {
    const h = hub({ maxClientBufferBytes: 10 });
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    h.connect(slow, { session: "all" });
    h.connect(fast, { session: "all" });
    slow.bufferedAmount = 11;
    h.publish([ev(SESSION_A, "a"), ev(SESSION_A, "b")]);
    expect(slow.closed).toBe(1013);
    expect(slow.texts).toEqual([]);
    expect(fast.texts).toEqual(["a", "b"]);
    expect(h.clientCount).toBe(1);
  });

  it("lists sessions seen within the window, most recent activity first", () => {
    let now = 1_000_000;
    const h = hub({ now: () => now, activeWindowMs: 1000 });
    h.publish([ev(SESSION_A, "old", "2026-11-01T10:00:00.000Z")]);
    now += 2000;
    h.publish([
      ev(SESSION_B, "b", "2026-11-01T11:00:00.000Z"),
      ev("00000000-0000-4000-8000-00000000000c", "c", "2026-11-01T12:00:00.000Z"),
      // An older-timestamped event doesn't move lastActivity backwards.
      ev(SESSION_B, "b-late", "2026-11-01T09:00:00.000Z"),
    ]);
    expect(h.sessions()).toEqual([
      {
        sessionId: "00000000-0000-4000-8000-00000000000c",
        agent: "claude-code",
        projectPath: "/home/dev/proj",
        projectName: "proj",
        lastActivity: "2026-11-01T12:00:00.000Z",
        events: 1,
        domain: {
          label: "unknown",
          confidence: 0,
          reasons: ["no domain signals"],
          source: "rules",
        },
      },
      {
        sessionId: SESSION_B,
        agent: "claude-code",
        projectPath: "/home/dev/proj",
        projectName: "proj",
        lastActivity: "2026-11-01T11:00:00.000Z",
        events: 2,
        domain: {
          label: "unknown",
          confidence: 0,
          reasons: ["no domain signals"],
          source: "rules",
        },
      },
    ]);
  });
});

describe("Hub replay of a long history", () => {
  /** A socket whose unsent data grows with each send until `drain()` is called. */
  class SlowSocket extends FakeSocket {
    override send(data: string) {
      super.send(data);
      this.bufferedAmount += data.length;
    }
    drain() {
      this.bufferedAmount = 0;
    }
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it("pauses while the client is backed up, then delivers everything in order", async () => {
    const h = hub({ maxEvents: 10_000, replayHighWaterBytes: 2000 });
    const history = Array.from({ length: 100 }, (_, i) => `h${i}`);
    h.publish(history.map((t) => ev(SESSION_A, t)));
    const s = new SlowSocket();
    h.connect(s, { session: "all" });
    const sentBeforeDrain = s.texts.length;
    expect(sentBeforeDrain).toBeLessThan(100);

    // Live events published mid-replay must queue behind the history.
    h.publish([ev(SESSION_A, "live1")]);
    expect(s.texts).not.toContain("live1");

    const drainer = setInterval(() => s.drain(), 2);
    try {
      await until(() => s.texts.includes("live1"));
    } finally {
      clearInterval(drainer);
    }
    h.publish([ev(SESSION_A, "live2")]);
    expect(s.texts).toEqual([...history, "live1", "live2"]);
    expect(s.closed).toBeUndefined();
  });

  it("drops a client whose replay stops making progress", async () => {
    const h = hub({ replayHighWaterBytes: 10, replayStallMs: 30 });
    h.publish(["a", "b", "c"].map((t) => ev(SESSION_A, t)));
    const s = new SlowSocket();
    h.connect(s, { session: "all" });
    await until(() => s.closed !== undefined);
    expect(s.closed).toBe(1013);
    expect(h.clientCount).toBe(0);
  });

  it("stops an old replay when the client resubscribes", async () => {
    const h = hub({ replayHighWaterBytes: 10 });
    h.publish([ev(SESSION_A, "a1"), ev(SESSION_A, "a2"), ev(SESSION_B, "b1")]);
    const s = new SlowSocket();
    const client = h.connect(s, { session: SESSION_A });
    expect(s.texts).toEqual(["a1"]);
    h.receive(client, JSON.stringify({ type: "subscribe", session: SESSION_B }));
    s.drain();
    await until(() => s.texts.includes("b1"));
    await new Promise((r) => setTimeout(r, 30));
    expect(s.texts).toEqual(["a1", "b1"]);
  });

  it("sends a gap if history it was waiting to send is dropped meanwhile", async () => {
    const h = hub({ maxEvents: 3, replayHighWaterBytes: 10 });
    h.publish(["a", "b", "c"].map((t) => ev(SESSION_A, t)));
    const s = new SlowSocket();
    h.connect(s, { session: "all" });
    expect(s.texts).toEqual(["a"]);
    h.publish(["d", "e", "f"].map((t) => ev(SESSION_A, t)));
    const drainer = setInterval(() => s.drain(), 2);
    try {
      await until(() => s.texts.includes("f"));
    } finally {
      clearInterval(drainer);
    }
    expect(s.ofType("gap")).toEqual([{ type: "gap", fromSeq: 2, toSeq: 3 }]);
    expect(s.texts).toEqual(["a", "d", "e", "f"]);
  });

  it("publishes an event id only once", () => {
    const h = hub();
    const s = new FakeSocket();
    h.connect(s, { session: "all" });
    const e = ev(SESSION_A, "once");
    h.publish([e], { backlog: true });
    h.publish([e]);
    expect(s.texts).toEqual(["once"]);
    expect(h.seq).toBe(1);
  });
});
