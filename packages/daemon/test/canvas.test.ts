import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BatonEvent, CanvasResponse, ServerMessage, SessionsResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasStore, MAX_CANVAS_NODES } from "../src/canvas-store.js";
import { MemoryEventLog } from "../src/event-log.js";
import { type ClientSocket, Hub } from "../src/hub.js";
import { createServer } from "../src/server.js";
import { SessionFiles } from "../src/session-files.js";
import { SESSION_A, SESSION_B, silent } from "./helpers.js";

class FakeSocket implements ClientSocket {
  readonly sent: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string) {
    this.sent.push(ServerMessage.parse(JSON.parse(data)));
  }
  close() {}
  canvas() {
    return this.sent.flatMap((m) => (m.type === "canvas" ? [m.positions] : []));
  }
}

const hub = (options: Partial<ConstructorParameters<typeof Hub>[0]> = {}) =>
  new Hub({
    log: new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents: 1000 }),
    activeWindowMs: 60 * 60_000,
    logger: silent,
    now: () => Date.parse("2026-11-01T12:01:00.000Z"),
    ...options,
  });

let n = 0;
const call = (sessionId: string, toolName: string, input: BatonEvent["meta"]): BatonEvent => ({
  id: `c${++n}`,
  agent: "claude-code",
  sessionId,
  projectPath: "/home/dev/proj",
  ts: "2026-11-01T12:00:00.000Z",
  seq: n,
  kind: "tool_call",
  text: toolName,
  meta: { toolName, toolUseId: `t${n}`, input: input ?? null },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baton-canvas-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CanvasStore", () => {
  it("reports only real changes and saves them to disk", async () => {
    const file = join(dir, "canvas.json");
    const store = new CanvasStore({ file, saveDelayMs: 5 });
    expect(store.set({ "repo:a": { x: 1, y: 2 } })).toEqual({ "repo:a": { x: 1, y: 2 } });
    expect(store.set({ "repo:a": { x: 1, y: 2 } })).toEqual({});
    await store.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "repo:a": { x: 1, y: 2 } });

    const again = new CanvasStore({ file });
    await again.load();
    expect(again.all()).toEqual({ "repo:a": { x: 1, y: 2 } });
  });

  it("starts empty from a missing or corrupt file", async () => {
    const missing = new CanvasStore({ file: join(dir, "nope.json"), logger: silent });
    await missing.load();
    expect(missing.all()).toEqual({});
    const file = join(dir, "bad.json");
    await writeFile(file, '{"repo:a": {"x": "left"}}');
    const corrupt = new CanvasStore({ file, logger: silent });
    await corrupt.load();
    expect(corrupt.all()).toEqual({});
  });

  it("forgets removed nodes and saves that", async () => {
    const file = join(dir, "canvas.json");
    const store = new CanvasStore({ file, saveDelayMs: 5 });
    store.set({ "session:a": { x: 1, y: 2 }, "session:b": { x: 3, y: 4 } });
    expect(store.remove(["session:a", "session:nope"])).toEqual(["session:a"]);
    await store.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "session:b": { x: 3, y: 4 } });
  });

  it("forgets the least recently moved nodes past the cap", () => {
    const store = new CanvasStore();
    for (let i = 0; i <= MAX_CANVAS_NODES; i++) store.set({ [`session:${i}`]: { x: i, y: 0 } });
    expect(store.size).toBe(MAX_CANVAS_NODES);
    expect(store.all()["session:0"]).toBeUndefined();
  });
});

describe("Hub canvas", () => {
  it("sends the saved canvas after hello, and every move to every viewer", () => {
    const h = hub();
    const quiet = new FakeSocket();
    h.connect(quiet, { session: "all" });
    // Always a snapshot, even empty, so a reconnecting viewer drops removed nodes.
    expect(quiet.sent.find((m) => m.type === "canvas")).toEqual({
      type: "canvas",
      positions: {},
      snapshot: true,
    });
    expect(quiet.canvas()).toEqual([{}]);

    h.moveCanvasNodes({ "session:x": { x: 10, y: 20 } });
    expect(quiet.canvas()).toEqual([{}, { "session:x": { x: 10, y: 20 } }]);

    const late = new FakeSocket();
    h.connect(late, { session: SESSION_A });
    expect(late.sent.map((m) => m.type).slice(0, 3)).toEqual(["hello", "canvas", "notes"]);
    expect(late.canvas()).toEqual([{ "session:x": { x: 10, y: 20 } }]);

    // A move that changes nothing isn't broadcast.
    h.moveCanvasNodes({ "session:x": { x: 10, y: 20 } });
    h.moveCanvasNodes({}, ["session:never"]);
    expect(quiet.canvas()).toHaveLength(2);

    h.moveCanvasNodes({}, ["session:x"]);
    const last = quiet.sent.at(-1);
    expect(last).toEqual({ type: "canvas", positions: {}, removed: ["session:x"] });
    expect(h.canvasPositions()).toEqual({});
  });
});

describe("canvas routes", () => {
  it("reads and writes positions, rejecting bad bodies", async () => {
    const h = hub();
    const viewer = new FakeSocket();
    h.connect(viewer, { session: "all" });
    const app = await createServer(h, silent, { access: { kind: "local" } });
    try {
      const put = (payload: object) =>
        app.inject({ method: "PUT", url: "/canvas/positions", payload });
      expect((await put({ positions: { "repo:r": { x: 5, y: 6 } } })).statusCode).toBe(204);
      expect((await put({ positions: { "bogus:r": { x: 5, y: 6 } } })).statusCode).toBe(400);
      expect((await put({ positions: { "repo:r": { x: "5" } } })).statusCode).toBe(400);
      const res = await app.inject({ method: "GET", url: "/canvas" });
      expect(CanvasResponse.parse(res.json())).toEqual({ positions: { "repo:r": { x: 5, y: 6 } } });
      expect(viewer.canvas()).toEqual([{}, { "repo:r": { x: 5, y: 6 } }]);
      expect((await put({ positions: {}, removed: ["repo:r"] })).statusCode).toBe(204);
      expect((await put({ positions: {}, removed: ["bogus"] })).statusCode).toBe(400);
      const after = await app.inject({ method: "GET", url: "/canvas" });
      expect(CanvasResponse.parse(after.json())).toEqual({ positions: {} });
    } finally {
      await app.close();
    }
  });
});

describe("session files", () => {
  it("lists the files each session wrote, repo-relative, with merged line ranges", () => {
    const files = new SessionFiles();
    files.record(
      call(SESSION_A, "Write", { file_path: "/home/dev/proj/src/a.ts", content: "1\n2\n3\n" }),
    );
    files.record(call(SESSION_A, "Edit", { file_path: "src/b.ts" }));
    files.record(
      call(SESSION_A, "Patch", {
        "/home/dev/proj/src/a.ts": { type: "update", unified_diff: "@@ -2,1 +2,4 @@\n" },
      }),
    );
    files.record(call(SESSION_B, "Read", { file_path: "/home/dev/proj/src/a.ts" }));
    expect(files.files(SESSION_A, "/home/dev/proj")).toEqual([
      { path: "src/b.ts", ranges: [] },
      { path: "src/a.ts", ranges: [[1, 5]] },
    ]);
    expect(files.files(SESSION_A, null).map((f) => f.path)).toEqual([
      "/home/dev/proj/src/b.ts",
      "/home/dev/proj/src/a.ts",
    ]);
    expect(files.files(SESSION_B, null)).toEqual([]);
  });

  it("appear in /sessions with the session's user", () => {
    const h = hub({ user: "dana" });
    h.publish([call(SESSION_A, "Edit", { file_path: "/home/dev/proj/x.ts" })]);
    h.publish([call(SESSION_B, "Edit", { file_path: "y.ts" })], { source: "lee" });
    const sessions = SessionsResponse.parse({ sessions: h.sessions() }).sessions;
    expect(sessions.map((s) => [s.sessionId, s.user, s.files])).toEqual(
      expect.arrayContaining([
        [SESSION_A, "dana", [{ path: "/home/dev/proj/x.ts", ranges: [] }]],
        [SESSION_B, "lee", [{ path: "/home/dev/proj/y.ts", ranges: [] }]],
      ]),
    );
  });
});
