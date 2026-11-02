import type { BatonEvent } from "@baton/core";
import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "../src/event-log.js";
import { SESSION_A, SESSION_B } from "./helpers.js";

let n = 0;
const ev = (text = "x", id = `e${++n}`): BatonEvent => ({
  id,
  agent: "claude-code",
  sessionId: SESSION_A,
  projectPath: "/home/dev/proj",
  ts: "2026-11-01T12:00:00.000Z",
  seq: n,
  kind: "reply",
  text,
});

const texts = (log: MemoryEventLog, after = 0, limit = 1000) =>
  log.read(after, limit).map((e) => e.event.text);

describe("MemoryEventLog", () => {
  it("numbers events from 1 and reads after a seq", () => {
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024 });
    expect([log.lastSeq, log.firstSeq]).toEqual([0, 1]);
    expect(log.append(ev("a"), false)).toMatchObject({ seq: 1, backlog: false });
    expect(log.append(ev("b"), true)).toMatchObject({ seq: 2, backlog: true });
    log.append(ev("c"), false);
    expect([log.lastSeq, log.firstSeq, log.size]).toEqual([3, 1, 3]);
    expect(texts(log)).toEqual(["a", "b", "c"]);
    expect(texts(log, 1)).toEqual(["b", "c"]);
    expect(texts(log, 0, 2)).toEqual(["a", "b"]);
    expect(texts(log, 3)).toEqual([]);
    expect(texts(log, -5)).toEqual(["a", "b", "c"]);
  });

  it("skips an event id it already holds", () => {
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024 });
    log.append(ev("a", "same"), true);
    expect(log.append(ev("again", "same"), false)).toBeUndefined();
    expect([log.lastSeq, log.size]).toEqual([1, 1]);
  });

  it("keeps the same event id in two sessions (ids are unique per session)", () => {
    // A forked Codex thread repeats its parent's item ids.
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024 });
    log.append(ev("parent", "item_1:0"), false);
    const other = { ...ev("fork", "item_1:0"), sessionId: SESSION_B };
    expect(log.append(other, false)?.seq).toBe(2);
    expect(log.append({ ...other, text: "again" }, false)).toBeUndefined();
    expect(texts(log)).toEqual(["parent", "fork"]);
  });

  it("drops the oldest events once over its byte budget", () => {
    const evictions: unknown[] = [];
    const big = "x".repeat(1000);
    const log = new MemoryEventLog({ maxBytes: 3500, onEvict: (i) => evictions.push(i) });
    for (let i = 0; i < 10; i++) log.append(ev(`${i}${big}`), false);
    expect(log.bytes).toBeLessThanOrEqual(3500);
    expect(log.size).toBe(2);
    expect(log.firstSeq).toBe(9);
    expect(log.lastSeq).toBe(10);
    expect(texts(log, 0).map((t) => t[0])).toEqual(["8", "9"]);
    expect(texts(log, 9).map((t) => t[0])).toEqual(["9"]);
    expect(evictions).toHaveLength(1); // warns once, not on every append
  });

  it("forgets the ids of dropped events", () => {
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents: 1 });
    log.append(ev("a", "one"), false);
    log.append(ev("b", "two"), false);
    expect(log.append(ev("a again", "one"), false)).toMatchObject({ seq: 3 });
  });

  it("caps the event count when asked", () => {
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents: 3 });
    for (const t of ["a", "b", "c", "d", "e"]) log.append(ev(t), false);
    expect(texts(log)).toEqual(["c", "d", "e"]);
    expect(log.firstSeq).toBe(3);
  });

  it("always keeps the newest event, even if it alone is over budget", () => {
    const log = new MemoryEventLog({ maxBytes: 10 });
    log.append(ev("a".repeat(100)), false);
    log.append(ev("b".repeat(100)), false);
    expect(log.size).toBe(1);
    expect(texts(log)[0]?.[0]).toBe("b");
  });

  it("stays correct across many evictions (array compaction)", () => {
    const log = new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents: 10 });
    for (let i = 1; i <= 5000; i++) log.append(ev(String(i)), false);
    expect(log.firstSeq).toBe(4991);
    expect(texts(log, 4995)).toEqual(["4996", "4997", "4998", "4999", "5000"]);
  });

  it("rejects a non-positive budget", () => {
    expect(() => new MemoryEventLog({ maxBytes: 0 })).toThrow(RangeError);
  });

  it("uses a new epoch per instance", () => {
    const a = new MemoryEventLog({ maxBytes: 1 });
    const b = new MemoryEventLog({ maxBytes: 1 });
    expect(a.epoch).not.toBe(b.epoch);
  });
});
