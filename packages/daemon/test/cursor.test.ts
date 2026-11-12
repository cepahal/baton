import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BatonEvent, handoffPrompt } from "@baton/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { defaultCursorDir, resolveConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { runHandoffStart } from "../src/handoff-commands.js";
import { planReplay } from "../src/replay.js";
import { logSources } from "../src/sources.js";
import { StateStore } from "../src/state-store.js";
import { TranscriptWatcher } from "../src/watcher.js";
import { silent, tempProjects } from "./helpers.js";

const CHAT = "cursor-chat-1";
const timestamp = "Thursday, Jul 23, 2026, 11:20 PM (UTC+2)";
const prompt = (text: string, at = timestamp) =>
  JSON.stringify({
    role: "user",
    message: { content: `<timestamp>${at}</timestamp>\n<user_query>${text}</user_query>` },
  });
const toolCall = (cwd: string) =>
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Shell", input: { command: "pwd", working_directory: cwd } },
      ],
    },
  });
const workspaceSlug =
  process.platform === "win32" ? "c-Users-alice-project" : "Users-alice-project";
const workspacePath =
  process.platform === "win32" ? String.raw`C:\Users\alice\project` : "/Users/alice/project";

describe("Cursor config and CLI", () => {
  it("uses the default project directory and accepts an explicit Cursor root", () => {
    const config = resolveConfig({ port: 0, cursorDir: "./cursor-projects" });
    expect(defaultCursorDir()).toMatch(/[\\/]\.cursor[\\/]projects$/);
    expect(config.cursorDir).toMatch(/[\\/]cursor-projects$/);
    expect(parseCli(["start", "--cursor-dir", "./cursor-projects"])).toMatchObject({
      command: "start",
      config: { cursorDir: expect.stringMatching(/[\\/]cursor-projects$/) },
    });
  });

  it("rejects Cursor source options on the team server and requires a replay root", () => {
    expect(
      parseCli(["serve", "--cursor-dir", "./cursor-projects"], {
        BATON_TOKEN: "team-token-0123456789",
      }),
    ).toMatchObject({ command: "error", message: "--cursor-dir isn't a serve option" });
    expect(parseCli(["replay", "fixture.jsonl"], {})).toMatchObject({
      command: "error",
      message: expect.stringContaining("--cursor-dir"),
    });
  });
});

describe("Cursor replay", () => {
  const fixture = [
    prompt("First prompt"),
    toolCall("/Users/alice/project"),
    prompt("Second prompt", "Thursday, Jul 23, 2026, 11:21 PM (UTC+2)"),
  ].join("\n");

  it("replays Cursor timestamps into a new conversation under the workspace slug", () => {
    const plan = planReplay(fixture, {
      cursorDir: "/cursor",
      speed: 2,
      as: "bob",
      seed: "cursor",
      startMs: 0,
    });
    expect(plan.agent).toBe("cursor");
    expect(plan.file).toBe(
      join(
        "/cursor",
        "Users-bob-project",
        "agent-transcripts",
        plan.sessionId,
        `${plan.sessionId}.jsonl`,
      ),
    );
    expect(plan.lines.map(({ delayMs }) => delayMs)).toEqual([0, 0, 30_000]);
    const first = JSON.parse(plan.lines[0]?.text ?? "{}");
    expect(first.message.content).toContain("<timestamp>1970-01-01T00:00:00.000Z</timestamp>");
    expect(first.message.content).toContain("<user_query>First prompt</user_query>");
  });

  it("rejects a Cursor fixture when only another agent's directory is supplied", () => {
    expect(() =>
      planReplay(fixture, {
        projectsDir: "/claude",
        speed: 1,
        as: "bob",
        seed: "cursor",
        startMs: 0,
      }),
    ).toThrow(/cursor session: replaying it needs --cursor-dir/);
  });
});

describe("Cursor doctor check", () => {
  const deps = {
    fetch,
    gitVersion: async () => "git version 2.0",
    isDir: async (path: string) => path === "/cursor",
    now: Date.now,
  };

  it("reports Cursor logs when the configured directory exists", async () => {
    const checks = await runDoctor(
      {
        nodeVersion: "v20.19.0",
        projectsDir: "/claude",
        codexDir: "/codex",
        cursorDir: "/cursor",
        sharingFile: "/missing/sharing.json",
        logFile: "/missing/daemon.log",
      },
      deps,
    );
    expect(checks.some((check) => check.what === "agent logs found: Cursor")).toBe(true);
  });

  it("warns when none of the configured agent directories exist", async () => {
    const checks = await runDoctor(
      {
        nodeVersion: "v20.19.0",
        projectsDir: "/claude",
        codexDir: "/codex",
        cursorDir: "/absent",
        sharingFile: "/missing/sharing.json",
        logFile: "/missing/daemon.log",
      },
      deps,
    );
    expect(checks.some((check) => check.what.startsWith("no agent logs found"))).toBe(true);
  });
});

describe("Cursor handoff start", () => {
  let dirs: Awaited<ReturnType<typeof tempProjects>>;
  afterEach(async () => dirs?.cleanup());

  it("starts Cursor's Agent CLI with the accepted handoff prompt", async () => {
    dirs = await tempProjects();
    const id = "h0123456789";
    const handoffDir = join(dirs.root, ".baton", "handoffs", id);
    await mkdir(handoffDir, { recursive: true });
    await writeFile(
      join(handoffDir, "handoff.json"),
      JSON.stringify({
        id,
        agent: "cursor",
        sender: "Ada",
        repoId: null,
        branch: null,
        base: null,
        patch: false,
      }),
    );
    const calls: { file: string; args: string[]; cwd: string }[] = [];
    const code = await runHandoffStart(
      { dir: dirs.root, id },
      { write: () => {} },
      async (file, args, cwd) => {
        calls.push({ file, args, cwd });
        return 0;
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ file: "agent", args: [handoffPrompt(id, false)], cwd: dirs.root }]);
  });

  it("does not start an agent for a missing handoff", async () => {
    dirs = await tempProjects();
    const errors: string[] = [];
    let started = false;
    const code = await runHandoffStart(
      { dir: dirs.root, id: "h0123456789" },
      { write: (text) => errors.push(text) },
      async () => {
        started = true;
        return 0;
      },
    );
    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(errors.join("")).toContain("No handoff");
  });
});

describe("Cursor live watcher", () => {
  let dirs: Awaited<ReturnType<typeof tempProjects>>;
  let watcher: TranscriptWatcher | undefined;
  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    await dirs?.cleanup();
  });

  async function startWatcher(events: BatonEvent[]) {
    const state = await StateStore.load(dirs.stateFile, silent);
    watcher = new TranscriptWatcher({
      sources: logSources({
        "claude-code": dirs.projectsDir,
        codex: dirs.codexDir,
        cursor: dirs.cursorDir,
      }),
      sink: { publish: (batch) => void events.push(...batch) },
      state,
      logger: silent,
      backlogPerSession: Number.POSITIVE_INFINITY,
      activeWindowMs: 60_000,
      poll: true,
      pollIntervalMs: 60 * 60_000,
      sweepIntervalMs: 40,
    });
    await watcher.start();
  }

  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for Cursor events");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("streams a new prompt and later tool call from a live transcript", async () => {
    dirs = await tempProjects();
    const transcript = join(
      dirs.cursorDir,
      workspaceSlug,
      "agent-transcripts",
      CHAT,
      `${CHAT}.jsonl`,
    );
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, `${prompt("Start work")}\n`);
    const events: BatonEvent[] = [];
    await startWatcher(events);
    await waitFor(() => events.some((event) => event.kind === "prompt"));
    await appendFile(transcript, `${toolCall(workspacePath)}\n`);
    await waitFor(() => events.some((event) => event.kind === "tool_call"));
    await watcher?.idle();
    expect(events.filter((event) => event.agent !== "cursor")).toEqual([]);
    expect(events.filter((event) => event.kind === "prompt")).toHaveLength(1);
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({
      projectPath: workspacePath,
      text: "Shell pwd",
      meta: { toolName: "Shell" },
    });
  });

  it("recovers a same-size rewrite that replaces an invalid row with valid JSONL", async () => {
    dirs = await tempProjects();
    const transcript = join(
      dirs.cursorDir,
      workspaceSlug,
      "agent-transcripts",
      CHAT,
      `${CHAT}.jsonl`,
    );
    await mkdir(dirname(transcript), { recursive: true });
    const valid = `${prompt("Recovered prompt")}\n`;
    await writeFile(transcript, `${valid.slice(0, -2)}x\n`);
    const events: BatonEvent[] = [];
    await startWatcher(events);
    expect(events).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(transcript, valid);
    const future = new Date(Date.now() + 5000);
    await utimes(transcript, future, future);
    await waitFor(() => events.some((event) => event.kind === "prompt"));
    expect(events.find((event) => event.kind === "prompt")?.text).toBe("Recovered prompt");
    expect(events.filter((event) => event.kind === "prompt")).toHaveLength(1);
  });
});
