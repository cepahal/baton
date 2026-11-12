import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { BatonEvent } from "@baton/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  belongsTo,
  cursorSessionInfo,
  decodeCursorProjectSlug,
  defaultSourceDir,
  logKey,
  logSources,
  sessionKey,
} from "../src/sources.js";
import { StateStore } from "../src/state-store.js";
import { TranscriptTail } from "../src/tail.js";
import { TranscriptWatcher } from "../src/watcher.js";
import { silent, tempProjects } from "./helpers.js";

const THREAD = "00000000-0000-4000-8000-0000000000c1";
const SEGMENT = "00000000-0000-4000-8000-0000000000c2";

let clock = 0;
/** One Codex rollout line. */
const rollout = (ordinal: number, type: string, payload: unknown) =>
  `${JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 10, 2, 12, 0, 0, clock++)).toISOString(),
    ordinal,
    type,
    payload,
  })}\n`;
const meta = (ordinal: number, extra: Record<string, unknown> = {}) =>
  rollout(ordinal, "session_meta", { id: THREAD, cwd: "/home/dev/proj", ...extra });
const prompt = (ordinal: number, text: string) =>
  rollout(ordinal, "event_msg", {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: "t1",
    item: { type: "UserMessage", id: `u-${text}`, content: [{ type: "text", text }] },
  });

/** `zlib.zstdCompressSync` (Node 22.15+); typed loosely because @types/node targets 20. */
function zstd(data: Buffer): Buffer {
  const fn: unknown = Reflect.get(zlib, "zstdCompressSync");
  if (typeof fn !== "function") throw new Error("no zstd in this Node.js");
  const out: unknown = fn.call(zlib, data);
  if (!Buffer.isBuffer(out)) throw new Error("zstdCompressSync returned no buffer");
  return out;
}
const hasZstd = typeof Reflect.get(zlib, "zstdCompressSync") === "function";

/** What Codex does to an idle log: write `x.jsonl.zst`, then delete `x.jsonl`. */
function compress(path: string): string {
  writeFileSync(`${path}.zst`, zstd(readFileSync(path)));
  rmSync(path);
  return `${path}.zst`;
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function codexDirs() {
  const dirs = await tempProjects();
  const day = join(dirs.codexDir, "2026", "11", "02");
  mkdirSync(day, { recursive: true });
  return {
    ...dirs,
    base: join(day, `rollout-2026-11-02T12-00-00-${THREAD}.jsonl`),
    segment: join(day, `rollout-2026-11-02T12-30-00-${THREAD}_${SEGMENT}.jsonl`),
  };
}

describe("log sources", () => {
  it("comes from the core adapter registry, one per agent", () => {
    const home = join("/", "home", "dev");
    const sources = logSources({}, home);
    expect(sources.map((s) => [s.agent, s.kind, s.dir])).toEqual([
      ["claude-code", "jsonl-tail", join(home, ".claude", "projects")],
      ["codex", "rollout-tail", join(home, ".codex", "sessions")],
      ["cursor", "jsonl-tail", join(home, ".cursor", "projects")],
    ]);
    const custom = logSources({ codex: "/x" }, home);
    expect(custom.find((s) => s.agent === "codex")?.dir).toBe("/x");
    expect(defaultSourceDir("cursor", home)).toBe(join(home, ".cursor", "projects"));
  });

  it("matches Cursor transcript paths and derives Windows, macOS and subagent identity", () => {
    const source = logSources({ cursor: "/cursor" }).find((s) => s.agent === "cursor");
    if (!source) throw new Error("missing Cursor source");
    expect(decodeCursorProjectSlug("c-Users-alice-Projects-baton", "win32")).toBe(
      String.raw`C:\Users\alice\Projects\baton`,
    );
    expect(decodeCursorProjectSlug("Users-alice-Projects-baton", "darwin")).toBe(
      "/Users/alice/Projects/baton",
    );
    const slug =
      process.platform === "win32" ? "c-Users-alice-Projects-baton" : "Users-alice-Projects-baton";
    const expectedPath =
      process.platform === "win32"
        ? String.raw`C:\Users\alice\Projects\baton`
        : "/Users/alice/Projects/baton";
    const transcript = join("/cursor", slug, "agent-transcripts", "chat-1", "chat-1.jsonl");
    expect(source.detect(transcript)).toBe(true);
    expect(cursorSessionInfo(source, transcript)).toEqual({
      sessionId: "chat-1",
      projectPath: expectedPath,
    });
    const mac = join(
      "/cursor",
      "Users-alice-Projects-baton",
      "agent-transcripts",
      "parent",
      "subagents",
      "child.jsonl",
    );
    expect(cursorSessionInfo(source, mac)).toEqual({
      sessionId: "child",
      projectPath: "/Users/alice/Projects/baton",
      parentSessionId: "parent",
    });
    expect(sessionKey(source, transcript)).toBe("cursor:chat-1");
    expect(source.detect(join("/cursor", "notes.jsonl"))).toBe(false);
  });

  it("assigns files to sources and groups a Codex thread's segments", () => {
    const [claude, codex, cursor] = logSources({ "claude-code": "/c", codex: "/x", cursor: "/u" });
    if (!claude || !codex || !cursor) throw new Error("missing source");
    const base = join("/x", "2026", "11", "02", `rollout-2026-11-02T12-00-00-${THREAD}.jsonl`);
    const seg = join(
      "/x",
      "2026",
      "11",
      "02",
      `rollout-2026-11-02T12-30-00-${THREAD}_${SEGMENT}.jsonl`,
    );
    expect(belongsTo(codex, base)).toBe(true);
    expect(belongsTo(codex, `${base}.zst`)).toBe(true);
    expect(belongsTo(codex, join("/x", "notes.jsonl"))).toBe(false);
    expect(belongsTo(claude, base)).toBe(false);
    expect(belongsTo(claude, join("/c", "-proj", "s.jsonl"))).toBe(true);
    expect(sessionKey(codex, seg)).toBe(sessionKey(codex, base));
    expect(sessionKey(codex, `${base}.zst`)).toBe(sessionKey(codex, base));
    expect(belongsTo(cursor, join("/u", "Users-a-work", "agent-transcripts", "id.jsonl"))).toBe(
      true,
    );
    expect(belongsTo(claude, join("/c", "Users-a-work", "agent-transcripts", "id.jsonl"))).toBe(
      false,
    );
  });
});

describe("Codex tail", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  it("reads a thread and its segment file as one session with one seq", async () => {
    const dirs = await codexDirs();
    cleanup = dirs.cleanup;
    writeFileSync(dirs.base, meta(0) + prompt(1, "first") + prompt(2, "abandoned"));
    writeFileSync(
      dirs.segment,
      meta(2, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 2 } }) +
        prompt(2, "instead"),
    );
    const tail = new TranscriptTail(dirs.base, { agent: "codex" });
    tail.addPart(dirs.segment);
    const { events } = await tail.catchUp();
    expect(events.map((e) => [e.seq, e.kind, e.agent, e.text])).toEqual([
      [0, "session_start", "codex", "/home/dev/proj"],
      [1, "prompt", "codex", "first"],
      [2, "prompt", "codex", "abandoned"],
      [3, "system", "codex", "Conversation rewound to record 2; continuing from there"],
      [4, "prompt", "codex", "instead"],
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it.runIf(hasZstd)("carries on in x.jsonl.zst when Codex compresses x.jsonl", async () => {
    const dirs = await codexDirs();
    cleanup = dirs.cleanup;
    writeFileSync(dirs.base, meta(0) + prompt(1, "hello"));
    const tail = new TranscriptTail(dirs.base, { agent: "codex" });
    expect((await tail.catchUp()).events.map((e) => e.kind)).toEqual(["session_start", "prompt"]);

    const zst = compress(dirs.base);
    expect(await tail.catchUp()).toEqual({ events: [], reset: false, gone: [] });
    expect(tail.path).toBe(zst);
    expect(tail.has(dirs.base)).toBe(true);
    // The history is still there, decompressed on demand.
    expect((await tail.warmUp(Number.POSITIVE_INFINITY)).map((e) => e.text)).toEqual([
      "/home/dev/proj",
      "hello",
    ]);
  });

  it.runIf(hasZstd)("leaves a sealed compressed log undecompressed while it is idle", async () => {
    const dirs = await codexDirs();
    cleanup = dirs.cleanup;
    writeFileSync(dirs.base, meta(0) + prompt(1, "old"));
    const zst = compress(dirs.base);
    const tail = new TranscriptTail(zst, { agent: "codex", sealed: true });
    expect(tail.warm).toBe(false);
    expect(await tail.changed()).toBe(false);
    expect(tail.parts).toEqual([{ path: zst, offset: 0, ino: undefined, sealed: true }]);
  });
});

describe("TranscriptWatcher with Codex", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let watcher: TranscriptWatcher | undefined;
  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    await cleanup?.();
  });

  const watch = async (
    dirs: Awaited<ReturnType<typeof codexDirs>>,
    events: BatonEvent[],
    sources = logSources({
      "claude-code": dirs.projectsDir,
      codex: dirs.codexDir,
      cursor: dirs.cursorDir,
    }),
  ) => {
    const state = await StateStore.load(dirs.stateFile, silent);
    watcher = new TranscriptWatcher({
      sources,
      sink: { publish: (e) => void events.push(...e) },
      state,
      logger: silent,
      backlogPerSession: Number.POSITIVE_INFINITY,
      activeWindowMs: 60_000,
    });
    await watcher.start();
    return state;
  };

  it("follows a new rollout, its segment, and its compression, without repeats", async () => {
    const dirs = await codexDirs();
    cleanup = dirs.cleanup;
    const events: BatonEvent[] = [];
    const state = await watch(dirs, events);

    writeFileSync(dirs.base, meta(0) + prompt(1, "one"));
    await until(() => events.some((e) => e.text === "one"));
    appendFileSync(dirs.base, prompt(2, "two"));
    await until(() => events.some((e) => e.text === "two"));
    writeFileSync(
      dirs.segment,
      meta(3, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 3 } }) +
        prompt(3, "three"),
    );
    await until(() => events.some((e) => e.text === "three"));

    // Codex compresses the idle base file; the session goes on in the segment.
    if (hasZstd) compress(dirs.base);
    appendFileSync(dirs.segment, prompt(4, "four"));
    await until(() => events.some((e) => e.text === "four"));
    await watcher?.idle();

    expect(events.map((e) => [e.seq, e.kind, e.agent, e.sessionId])).toEqual([
      [0, "session_start", "codex", THREAD],
      [1, "prompt", "codex", THREAD],
      [2, "prompt", "codex", THREAD],
      [3, "system", "codex", THREAD],
      [4, "prompt", "codex", THREAD],
      [5, "prompt", "codex", THREAD],
    ]);
    // The compressed file keeps the original's saved offset.
    expect(state.get(logKey(dirs.base))?.offset).toBeGreaterThan(0);
  });

  it("starts with only the Codex directory present", async () => {
    const dirs = await codexDirs();
    cleanup = dirs.cleanup;
    writeFileSync(dirs.base, meta(0) + prompt(1, "backlog"));
    rmSync(dirs.projectsDir, { recursive: true });
    const events: BatonEvent[] = [];
    await watch(dirs, events);
    expect(events.map((e) => e.text)).toEqual(["/home/dev/proj", "backlog"]);
  });

  it("refuses to start when no source directory exists", async () => {
    const dirs = await tempProjects();
    cleanup = dirs.cleanup;
    const sources = logSources({
      "claude-code": join(dirs.root, "nope"),
      codex: dirs.codexDir,
      cursor: dirs.cursorDir,
    });
    await expect(watch({ ...dirs, base: "", segment: "" }, [], sources)).rejects.toThrow(
      /no session log directory found/,
    );
  });
});
