import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { DEFAULT_BUFFER_MB, DEFAULT_PORT } from "../src/config.js";
import { StateStore } from "../src/state-store.js";
import { TranscriptTail } from "../src/tail.js";
import { record, SESSION_A, silent, tempProjects } from "./helpers.js";

let dirs: Awaited<ReturnType<typeof tempProjects>>;
beforeEach(async () => {
  dirs = await tempProjects();
});
afterEach(() => dirs.cleanup());

describe("StateStore", () => {
  it("saves offsets and loads them back", async () => {
    const store = await StateStore.load(dirs.stateFile, silent, 10_000);
    store.set("a", { offset: 10, ino: "1" });
    store.set("b", { offset: 20 });
    store.delete("b");
    await store.flush();
    const again = await StateStore.load(dirs.stateFile, silent);
    expect(again.keys()).toEqual(["a"]);
    expect(again.get("a")).toEqual({ offset: 10, ino: "1" });
  });

  it.each([
    ["not JSON", "{oops"],
    ["the wrong shape", JSON.stringify({ version: 99, files: [] })],
  ])("starts fresh when the file is %s", async (_, content) => {
    await writeFile(dirs.stateFile, content);
    const store = await StateStore.load(dirs.stateFile, silent);
    expect(store.keys()).toEqual([]);
  });

  it("starts fresh when there is no file, and creates its directory on save", async () => {
    const path = join(dirs.root, "nested", "dir", "state.json");
    const store = await StateStore.load(path, silent);
    store.set("a", { offset: 1 });
    await store.flush();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      files: { a: { offset: 1 } },
    });
  });
});

describe("TranscriptTail", () => {
  it("reads only new bytes and resets after truncation", async () => {
    const file = dirs.transcript(SESSION_A);
    await dirs.append(file, `${record(SESSION_A, "user", "a longer first prompt")}\n`);
    const tail = new TranscriptTail(file);
    expect((await tail.catchUp()).events.map((e) => e.text)).toEqual([
      "/home/dev/proj",
      "a longer first prompt",
    ]);
    expect((await tail.catchUp()).events).toEqual([]);

    // Rewritten shorter than what was already read, so the size gives it away.
    await writeFile(file, `${record(SESSION_A, "user", "new")}\n`);
    const after = await tail.catchUp();
    expect(after.reset).toBe(true);
    expect(after.events.map((e) => [e.kind, e.seq])).toEqual([
      ["session_start", 0],
      ["prompt", 1],
    ]);
  });

  it("warms up from history, returning the last events before the offset", async () => {
    const file = dirs.transcript(SESSION_A);
    const lines = ["a", "b", "c"].map((t) => `${record(SESSION_A, "user", t)}\n`);
    await dirs.append(file, lines.join(""));
    const offset = Buffer.byteLength(lines.join(""));
    await dirs.append(file, `${record(SESSION_A, "user", "d")}\n`);

    const tail = new TranscriptTail(file, { offset });
    expect((await tail.warmUp(2)).map((e) => e.text)).toEqual(["b", "c"]);
    const next = await tail.catchUp();
    expect(next.events.map((e) => [e.text, e.seq])).toEqual([["d", 4]]);
  });
});

describe("parseCli", () => {
  it("starts with defaults", () => {
    const r = parseCli(["start"]);
    expect(r.command).toBe("start");
    if (r.command !== "start") return;
    expect(r.config.port).toBe(DEFAULT_PORT);
    expect(r.config.projectsDir).toMatch(/[\\/]\.claude[\\/]projects$/);
    expect(r.config.codexDir).toMatch(/[\\/]\.codex[\\/]sessions$/);
    expect(r.config.cursorDir).toMatch(/[\\/]\.cursor[\\/]projects$/);
    expect(r.config.backlog).toBe("all");
    expect(r.config.bufferMb).toBe(DEFAULT_BUFFER_MB);
    expect(r.config.bufferSize).toBeUndefined();
  });

  it("accepts every option", () => {
    const r = parseCli([
      "start",
      "--port=7001",
      "--projects-dir",
      dirs.projectsDir,
      "--codex-dir",
      dirs.codexDir,
      "--cursor-dir",
      dirs.cursorDir,
      "--state-file",
      dirs.stateFile,
      "--backlog",
      "5",
      "--buffer-mb",
      "64",
      "--buffer-size",
      "20",
      "--active-minutes",
      "3",
      "--recent",
      "2",
      "--poll",
      "--log-level",
      "debug",
      "--web-dir",
      dirs.root,
    ]);
    expect(r).toEqual({
      command: "start",
      config: {
        port: 7001,
        projectsDir: dirs.projectsDir,
        codexDir: dirs.codexDir,
        cursorDir: dirs.cursorDir,
        stateFile: dirs.stateFile,
        backlog: 5,
        bufferMb: 64,
        bufferSize: 20,
        activeMinutes: 3,
        recent: 2,
        poll: true,
        logLevel: "debug",
        webDir: dirs.root,
        remote: undefined,
        summarizer: "ollama",
        summarizerModel: undefined,
        ollamaUrl: "http://127.0.0.1:11434",
      },
    });
  });

  it("accepts --backlog all", () => {
    const r = parseCli(["start", "--backlog", "all"]);
    expect(r.command === "start" && r.config.backlog).toBe("all");
  });

  it.each([[["--help"]], [["start", "-h"]]])("shows help for %j", (argv) => {
    expect(parseCli(argv)).toEqual({ command: "help" });
  });

  it.each([
    [[], "missing command"],
    [["stop"], "unknown command: stop"],
    [["start", "extra"], "unexpected argument: extra"],
    [["start", "--port", "http"], "--port:"],
    [["start", "--port", "70000"], "--port:"],
    [["start", "--buffer-size", "0"], "--buffer-size:"],
    [["start", "--buffer-mb", "0"], "--buffer-mb:"],
    [["start", "--backlog", "lots"], "--backlog:"],
    [["start", "--log-level", "loud"], "--log-level:"],
    [["start", "--nope"], "Unknown option"],
  ])("reports an error for %j", (argv, message) => {
    const r = parseCli(argv);
    expect(r.command).toBe("error");
    if (r.command === "error") expect(r.message).toContain(message);
  });
});
