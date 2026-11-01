import { truncate, utimes, writeFile } from "node:fs/promises";
import { SessionsResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Daemon } from "../src/daemon.js";
import {
  record,
  SESSION_A,
  SESSION_B,
  sleep,
  start,
  TestClient,
  tempProjects,
  wsUrl,
} from "./helpers.js";

/** Long enough for the watcher to have seen a write if it was going to act on it. */
const SETTLE_MS = 400;

let dirs: Awaited<ReturnType<typeof tempProjects>>;
let daemon: Daemon | undefined;
const clients: TestClient[] = [];

const connect = async (query = "", headers: Record<string, string> = {}) => {
  if (!daemon) throw new Error("daemon not started");
  const client = new TestClient(wsUrl(daemon, query), headers);
  clients.push(client);
  await client.opened;
  await client.until(() => client.messages.some((m) => m.type === "hello"), "hello");
  return client;
};

beforeEach(async () => {
  dirs = await tempProjects();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await daemon?.close();
  daemon = undefined;
  await dirs.cleanup();
});

describe("baton daemon", () => {
  it("streams appended lines to a WebSocket client in order", async () => {
    daemon = await start(dirs);
    const client = await connect();
    const file = dirs.transcript(SESSION_A);

    await dirs.append(file, `${record(SESSION_A, "user", "first")}\n`);
    await client.untilEvents(2);
    await dirs.append(
      file,
      `${record(SESSION_A, "assistant", "second")}\n${record(SESSION_A, "user", "third")}\n`,
    );
    await client.untilEvents(4);

    expect(client.events.map((m) => m.event.kind)).toEqual([
      "session_start",
      "prompt",
      "reply",
      "prompt",
    ]);
    expect(client.texts.slice(1)).toEqual(["first", "second", "third"]);
    const seqs = client.events.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(client.events.every((m) => m.backlog === undefined)).toBe(true);
  });

  it("delivers the end of a burst of quick writes", async () => {
    // Regression: chokidar drops change events within 50 ms of each other, so
    // the last lines of a burst used to wait for the next write.
    daemon = await start(dirs);
    const client = await connect();
    const file = dirs.transcript(SESSION_A);
    const texts = Array.from({ length: 10 }, (_, i) => `burst ${i}`);
    for (const t of texts) {
      await dirs.append(file, `${record(SESSION_A, "user", t)}\n`);
      await sleep(10);
    }
    await client.untilEvents(11);
    expect(client.texts.slice(1)).toEqual(texts);
  });

  it("holds back a partial line, even one cut mid-character, until it is complete", async () => {
    daemon = await start(dirs);
    const client = await connect();
    const file = dirs.transcript(SESSION_A);
    await dirs.append(file, `${record(SESSION_A, "user", "whole")}\n`);
    await client.untilEvents(2);

    const bytes = Buffer.from(`${record(SESSION_A, "assistant", "split ✓ across writes")}\n`);
    const cut = bytes.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte UTF-8 sequence
    await writeFile(file, bytes.subarray(0, cut), { flag: "a" });
    await sleep(SETTLE_MS);
    expect(client.events).toHaveLength(2);

    await writeFile(file, bytes.subarray(cut), { flag: "a" });
    await client.untilEvents(3);
    expect(client.texts.at(-1)).toBe("split ✓ across writes");
  }, 10_000);

  it("replays what a client missed when it reconnects with lastSeq", async () => {
    daemon = await start(dirs);
    const file = dirs.transcript(SESSION_A);
    const first = await connect();
    await dirs.append(file, `${record(SESSION_A, "user", "one")}\n`);
    await first.untilEvents(2);
    const hello = first.messages.find((m) => m.type === "hello");
    const lastSeq = first.events.at(-1)?.seq ?? 0;
    await first.close();

    await dirs.append(
      file,
      `${record(SESSION_A, "assistant", "two")}\n${record(SESSION_A, "user", "three")}\n`,
    );
    await daemon.watcher.idle();
    await sleep(SETTLE_MS);
    await daemon.watcher.idle();

    const epoch = hello?.type === "hello" ? hello.epoch : "";
    const second = await connect(`lastSeq=${lastSeq}&epoch=${epoch}`);
    await second.untilEvents(2);
    expect(second.texts).toEqual(["two", "three"]);
    expect(second.events[0]?.seq).toBe(lastSeq + 1);

    // Live events keep flowing after the replay.
    await dirs.append(file, `${record(SESSION_A, "assistant", "four")}\n`);
    await second.untilEvents(3);
    expect(second.texts).toEqual(["two", "three", "four"]);
  });

  it("reports a gap when the missed events have left the buffer", async () => {
    daemon = await start(dirs, { bufferSize: 3 });
    const file = dirs.transcript(SESSION_A);
    const first = await connect();
    await dirs.append(file, `${record(SESSION_A, "user", "a")}\n`);
    await first.untilEvents(2);
    const lastSeq = first.events.at(-1)?.seq ?? 0;
    await first.close();

    const lines = ["b", "c", "d", "e", "f"].map((t) => record(SESSION_A, "user", t));
    await dirs.append(file, `${lines.join("\n")}\n`);
    await sleep(SETTLE_MS);
    await daemon.watcher.idle();

    const second = await connect(`lastSeq=${lastSeq}&epoch=${daemon.hub.epoch}`);
    await second.untilEvents(3);
    expect(second.messages.find((m) => m.type === "gap")).toEqual({
      type: "gap",
      fromSeq: lastSeq + 1,
      toSeq: lastSeq + 2,
    });
    expect(second.texts).toEqual(["d", "e", "f"]);
  });

  it("only sends a subscribed session's events", async () => {
    daemon = await start(dirs);
    const onlyB = await connect(`session=${SESSION_B}`);
    const all = await connect();
    await dirs.append(dirs.transcript(SESSION_A), `${record(SESSION_A, "user", "from A")}\n`);
    await dirs.append(dirs.transcript(SESSION_B), `${record(SESSION_B, "user", "from B")}\n`);
    await all.untilEvents(4);
    await onlyB.untilEvents(2);
    await sleep(SETTLE_MS);
    expect(onlyB.events.every((m) => m.event.sessionId === SESSION_B)).toBe(true);
    expect(onlyB.texts).toEqual(["/home/dev/proj", "from B"]);

    // Switching subscription over the socket replays the buffer for the new one.
    onlyB.send({ type: "subscribe", session: SESSION_A });
    await onlyB.until(() => onlyB.texts.includes("from A"), "session A replay");
  });

  it("lists active sessions with project name and last activity", async () => {
    daemon = await start(dirs);
    const client = await connect();
    await dirs.append(dirs.transcript(SESSION_A), `${record(SESSION_A, "user", "hi")}\n`);
    await client.untilEvents(2);

    const res = await fetch(`${daemon.url}/sessions`);
    const body = SessionsResponse.parse(await res.json());
    expect(body.sessions).toEqual([
      {
        sessionId: SESSION_A,
        projectPath: "/home/dev/proj",
        projectName: "proj",
        lastActivity: client.events.at(-1)?.event.ts,
        events: 2,
      },
    ]);
  });

  it("resumes from saved offsets after a restart, replaying a backlog", async () => {
    const file = dirs.transcript(SESSION_A);
    const lines = ["p1", "p2", "p3", "p4"].map((t) => record(SESSION_A, "user", t));
    await dirs.append(file, `${lines.join("\n")}\n`);

    daemon = await start(dirs, { backlog: 2 });
    let client = await connect();
    await client.untilEvents(2);
    expect(client.events.map((m) => [m.event.text, m.backlog])).toEqual([
      ["p3", true],
      ["p4", true],
    ]);
    await client.close();
    await daemon.close();

    // Written while the daemon was down: seen as new, not as backlog.
    await dirs.append(file, `${record(SESSION_A, "user", "p5")}\n`);
    daemon = await start(dirs, { backlog: 2 });
    client = await connect();
    await client.untilEvents(3);
    expect(client.events.map((m) => [m.event.text, m.backlog ?? false])).toEqual([
      ["p3", true],
      ["p4", true],
      ["p5", false],
    ]);
    // seq inside the session continues from the history (session_start + 5 prompts).
    expect(client.events.at(-1)?.event.seq).toBe(5);
  });

  it("sends the whole history of an active session by default", async () => {
    const file = dirs.transcript(SESSION_A);
    const lines = ["p1", "p2", "p3", "p4"].map((t) => record(SESSION_A, "user", t));
    await dirs.append(file, `${lines.join("\n")}\n`);
    daemon = await start(dirs);
    const client = await connect();
    await client.untilEvents(5);
    expect(client.events.map((m) => [m.event.kind, m.backlog])).toEqual([
      ["session_start", true],
      ["prompt", true],
      ["prompt", true],
      ["prompt", true],
      ["prompt", true],
    ]);
    await dirs.append(file, `${record(SESSION_A, "user", "live")}\n`);
    await client.untilEvents(6);
    expect(client.events.at(-1)?.backlog).toBeUndefined();
  });

  it("sends the history of an idle session when it wakes up", async () => {
    const file = dirs.transcript(SESSION_A);
    const lines = ["old1", "old2"].map((t) => record(SESSION_A, "user", t));
    await dirs.append(file, `${lines.join("\n")}\n`);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await utimes(file, dayAgo, dayAgo);

    daemon = await start(dirs);
    const client = await connect();
    await sleep(SETTLE_MS);
    expect(client.events).toEqual([]);

    await dirs.append(file, `${record(SESSION_A, "user", "new")}\n`);
    await client.untilEvents(4);
    expect(client.events.map((m) => [m.event.text, m.backlog ?? false]).slice(1)).toEqual([
      ["old1", true],
      ["old2", true],
      ["new", false],
    ]);
    expect(client.events[0]?.backlog).toBe(true);
    expect(client.events.map((m) => m.event.seq)).toEqual([0, 1, 2, 3]);
  });

  it("starts over when a transcript is truncated", async () => {
    daemon = await start(dirs);
    const client = await connect();
    const file = dirs.transcript(SESSION_A);
    await dirs.append(
      file,
      `${record(SESSION_A, "user", "old 1")}\n${record(SESSION_A, "user", "old 2")}\n`,
    );
    await client.untilEvents(3);

    await truncate(file, 0);
    await sleep(SETTLE_MS);
    await dirs.append(file, `${record(SESSION_A, "user", "new")}\n`);
    await client.until(() => client.texts.includes("new"), "event after truncation");
    expect(client.events.at(-1)?.event.seq).toBe(1);
  });

  it("picks up many files written at once", async () => {
    daemon = await start(dirs);
    const client = await connect();
    const sessions = Array.from(
      { length: 20 },
      (_, i) => `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
    );
    await Promise.all(
      sessions.map((s) => dirs.append(dirs.transcript(s), `${record(s, "user", `hi ${s}`)}\n`)),
    );
    await client.until(
      () => new Set(client.events.map((m) => m.event.sessionId)).size === 20,
      "all 20 sessions",
      10_000,
    );
    expect(client.events).toHaveLength(40);
  }, 15_000);

  it("refuses WebSocket connections from other websites", async () => {
    daemon = await start(dirs);
    const client = new TestClient(wsUrl(daemon), { origin: "https://example.com" });
    clients.push(client);
    await expect(client.opened).rejects.toThrow("HTTP 403");
    await expect(connect("", { origin: "http://localhost:5173" })).resolves.toBeDefined();
  });
});
