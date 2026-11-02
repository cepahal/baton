import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRolloutName, parseSession, parseTranscript, sniffAgent } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { planReplay, runReplay } from "../src/replay.js";
import { silent, tempProjects } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
const SID = "00000000-0000-4000-8000-000000000001";

function line(uuid: string, timestamp: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    sessionId: SID,
    timestamp,
    cwd: "C:\\Users\\dev\\proj",
    message: { role: "user", content: "hi from /home/dev/x" },
    ...extra,
  });
}

const base = { projectsDir: "/p", speed: 1, as: "alice", seed: "s", startMs: 0 };

describe("planReplay", () => {
  it("follows recorded gaps divided by speed, and cuts long ones", () => {
    const text = [
      line("00000000-0000-4000-8000-0000000000a1", "2026-01-01T00:00:00.000Z"),
      line("00000000-0000-4000-8000-0000000000a2", "2026-01-01T00:00:10.000Z"),
      line("00000000-0000-4000-8000-0000000000a3", "2026-01-01T00:10:10.000Z"),
    ].join("\n");
    const plan = planReplay(text, { ...base, speed: 10, maxGapMs: 5000 });
    expect(plan.lines.map((l) => l.delayMs)).toEqual([0, 1000, 6000]);
    const stamps = plan.lines.map((l) => JSON.parse(l.text).timestamp);
    expect(stamps).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:01.000Z",
      "1970-01-01T00:00:06.000Z",
    ]);
  });

  it("writes a record whose timestamp goes backwards straight away", () => {
    const text = [
      line("00000000-0000-4000-8000-0000000000a1", "2026-01-01T00:00:10.000Z"),
      line("00000000-0000-4000-8000-0000000000a2", "2026-01-01T00:00:04.000Z"),
      line("00000000-0000-4000-8000-0000000000a3", "2026-01-01T00:00:12.000Z"),
    ].join("\n");
    const plan = planReplay(text, { ...base, speed: 2 });
    expect(plan.lines.map((l) => l.delayMs)).toEqual([0, 0, 1000]);
  });

  it("gives every UUID a fresh one, consistently, and swaps in the user name", () => {
    const parent = "00000000-0000-4000-8000-0000000000a1";
    const text = [
      line(parent, "2026-01-01T00:00:00.000Z"),
      line("00000000-0000-4000-8000-0000000000a2", "2026-01-01T00:00:01.000Z", {
        parentUuid: parent,
      }),
    ].join("\n");
    const plan = planReplay(text, base);
    const [first, second] = plan.lines.map((l) => JSON.parse(l.text));
    expect(first.uuid).not.toBe(parent);
    expect(second.parentUuid).toBe(first.uuid);
    expect(first.sessionId).toBe(plan.sessionId);
    expect(plan.sessionId).not.toBe(SID);
    expect(first.cwd).toBe("C:\\Users\\alice\\proj");
    expect(first.message.content).toBe("hi from /home/alice/x");
    expect(plan.file).toBe(join("/p", "C--Users-alice-proj", `${plan.sessionId}.jsonl`));

    const other = planReplay(text, { ...base, seed: "t" });
    expect(other.sessionId).not.toBe(plan.sessionId);
    expect(planReplay(text, base).sessionId).toBe(plan.sessionId);
  });

  it("rejects a non-positive speed", () => {
    expect(() => planReplay("", { ...base, speed: 0 })).toThrow(RangeError);
  });
});

describe("runReplay", () => {
  let dirs: Awaited<ReturnType<typeof tempProjects>>;
  beforeEach(async () => {
    dirs = await tempProjects();
  });
  afterEach(() => dirs.cleanup());

  it("writes a fixture that parses to the same events, on a simulated clock", async () => {
    const fixture = join(FIXTURES, "heavy-tools.jsonl");
    let clock = 1_000_000;
    const waits: number[] = [];
    const plan = await runReplay({
      fixture,
      projectsDir: dirs.projectsDir,
      speed: 50,
      as: "bob",
      seed: "x",
      logger: silent,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const written = await readFile(plan.file, "utf8");
    const original = parseTranscript(await readFile(fixture, "utf8")).events;
    const replayed = parseTranscript(written).events;
    expect(replayed.map((e) => [e.kind, e.seq])).toEqual(original.map((e) => [e.kind, e.seq]));
    expect(new Set(replayed.map((e) => e.sessionId))).toEqual(new Set([plan.sessionId]));
    expect(waits.length).toBeGreaterThan(1);
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBe(plan.lines.at(-1)?.delayMs);
  });

  it("replays a Codex rollout into the Codex sessions directory, as a new thread", async () => {
    const fixture = join(FIXTURES, "codex", "speech-tool.rollout.jsonl");
    let clock = Date.UTC(2026, 10, 2, 3, 4, 5);
    const plan = await runReplay({
      fixture,
      codexDir: dirs.codexDir,
      speed: 1000,
      maxGapMs: 50,
      as: "carol",
      seed: "codex",
      logger: silent,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(plan.agent).toBe("codex");
    expect(plan.file).toBe(
      join(
        dirs.codexDir,
        "2026",
        "11",
        "02",
        `rollout-2026-11-02T03-04-05-${plan.sessionId}.jsonl`,
      ),
    );
    expect(parseRolloutName(plan.file)?.threadId).toBe(plan.sessionId);
    const written = await readFile(plan.file, "utf8");
    const original = parseSession("codex", await readFile(fixture, "utf8")).events;
    const replayed = parseSession("codex", written).events;
    expect(replayed.map((e) => [e.kind, e.seq])).toEqual(original.map((e) => [e.kind, e.seq]));
    expect(new Set(replayed.map((e) => e.sessionId))).toEqual(new Set([plan.sessionId]));
    expect(new Set(replayed.map((e) => e.agent))).toEqual(new Set(["codex"]));
    expect(written).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("needs the directory for the fixture's agent", async () => {
    await expect(
      runReplay({
        fixture: join(FIXTURES, "codex", "speech-tool.rollout.jsonl"),
        projectsDir: dirs.projectsDir,
        speed: 1,
        as: "x",
        logger: silent,
      }),
    ).rejects.toThrow(/codex session: replaying it needs --codex-dir/);
    await expect(
      runReplay({
        fixture: join(FIXTURES, "mixed.jsonl"),
        codexDir: dirs.codexDir,
        speed: 1,
        as: "x",
        logger: silent,
      }),
    ).rejects.toThrow(/claude-code session: replaying it needs --projects-dir/);
  });

  it("stops when aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(
      runReplay({
        fixture: join(FIXTURES, "mixed.jsonl"),
        projectsDir: dirs.projectsDir,
        speed: 1,
        as: "x",
        logger: silent,
        signal: abort.signal,
      }),
    ).rejects.toThrow("stop");
  });
});

describe("parseCli team commands", () => {
  const env = { BATON_TOKEN: "team-token-0123456789" };

  it("starts a forwarder with --server, a name and the token", () => {
    const r = parseCli(["start", "--server", "ws://hub:7777", "--name", "alice"], env);
    expect(r.command).toBe("start");
    if (r.command !== "start") return;
    expect(r.config.remote).toMatchObject({
      server: "ws://hub:7777",
      name: "alice",
      token: env.BATON_TOKEN,
    });
  });

  it("needs the token for --server and serve", () => {
    expect(parseCli(["start", "--server", "ws://hub:7777"], {})).toMatchObject({
      command: "error",
      message: expect.stringContaining("BATON_TOKEN"),
    });
    expect(parseCli(["serve"], {})).toMatchObject({
      command: "error",
      message: expect.stringContaining("BATON_TOKEN"),
    });
    expect(parseCli(["serve"], { BATON_TOKEN: "short" })).toMatchObject({
      command: "error",
      message: expect.stringMatching(/^BATON_TOKEN: /),
    });
  });

  it("rejects --name without --server, and a bad name", () => {
    expect(parseCli(["start", "--name", "a"], env).command).toBe("error");
    expect(parseCli(["start", "--server", "ws://h:1", "--name", "a/b"], env)).toMatchObject({
      command: "error",
      message: expect.stringMatching(/^--name: /),
    });
  });

  it("serves on 0.0.0.0 by default", () => {
    const r = parseCli(["serve", "--port", "8080"], env);
    expect(r).toMatchObject({ command: "serve", config: { host: "0.0.0.0", port: 8080 } });
    expect(parseCli(["serve", "--projects-dir", "x"], env).command).toBe("error");
  });

  it("parses replay", () => {
    const r = parseCli(
      ["replay", "f.jsonl", "--projects-dir", "p", "--speed", "4", "--as", "bob", "--max-gap", "2"],
      {},
    );
    expect(r).toEqual({
      command: "replay",
      options: {
        fixture: "f.jsonl",
        projectsDir: "p",
        speed: 4,
        as: "bob",
        maxGapMs: 2000,
        logLevel: "info",
      },
    });
    expect(parseCli(["replay", "f.jsonl"], {})).toMatchObject({ command: "error" });
    expect(parseCli(["replay", "r.jsonl", "--codex-dir", "c"], {})).toEqual({
      command: "replay",
      options: { fixture: "r.jsonl", codexDir: "c", speed: 1, as: "replay", logLevel: "info" },
    });
    for (const [flag, speed] of [
      ["10x", 10],
      ["1X", 1],
      ["2.5", 2.5],
    ] as const) {
      expect(
        parseCli(["replay", "f.jsonl", "--projects-dir", "p", "--speed", flag], {}),
      ).toMatchObject({
        command: "replay",
        options: { speed },
      });
    }
    expect(
      parseCli(["replay", "f.jsonl", "--projects-dir", "p", "--speed", "fast"], {}),
    ).toMatchObject({
      command: "error",
      message: expect.stringMatching(/^--speed: /),
    });
    expect(
      parseCli(["replay", "f.jsonl", "--projects-dir", "p", "--speed", "0"], {}),
    ).toMatchObject({
      command: "error",
      message: expect.stringMatching(/^--speed: /),
    });
  });
});

describe("sniffAgent", () => {
  it("tells a Codex rollout from a Claude Code transcript by its first record", async () => {
    expect(sniffAgent(await readFile(join(FIXTURES, "mixed.jsonl"), "utf8"))).toBe("claude-code");
    expect(
      sniffAgent(await readFile(join(FIXTURES, "codex", "forked-frontend.rollout.jsonl"), "utf8")),
    ).toBe("codex");
    expect(sniffAgent('not json\n{"type":"user","message":{}}')).toBe("claude-code");
    expect(sniffAgent("\n[1]\nnope")).toBeUndefined();
  });
});
