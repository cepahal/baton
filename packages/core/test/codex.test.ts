import { describe, expect, it } from "vitest";
import { fileUrlToPath, shellScript } from "../src/codex/tool-format.js";
import {
  BatonEvent,
  createAdapter,
  detectAgent,
  parseRolloutName,
  parseSession,
} from "../src/index.js";
import { CODEX_FIXTURES, readCodexRollout, readCodexThreadItems } from "./helpers.js";

const THREAD = "00000000-0000-4000-8000-000000000001";
let ordinal = 0;
let clock = 0;

/** One rollout line. */
const line = (type: string, payload: unknown) =>
  JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 10, 1, 12, 0, clock++)).toISOString(),
    ordinal: ordinal++,
    type,
    payload,
  });

const sessionMeta = (extra: Record<string, unknown> = {}) =>
  line("session_meta", {
    id: THREAD,
    cwd: "C:\\proj",
    cli_version: "0.166.0",
    originator: "codex_exec",
    source: "exec",
    git: { branch: "main" },
    ...extra,
  });
const turnContext = (extra: Record<string, unknown> = {}) =>
  line("turn_context", { turn_id: "t1", cwd: "C:\\proj", model: "gpt-test", ...extra });
const item = (it: Record<string, unknown>) =>
  line("event_msg", { type: "item_completed", thread_id: THREAD, turn_id: "t1", item: it });
const userContext = (...texts: string[]) =>
  line("response_item", {
    type: "message",
    role: "user",
    content: texts.map((text) => ({ type: "input_text", text })),
  });

const parse = (...lines: string[]) => parseSession("codex", lines.join("\n"));
const rows = (...lines: string[]) =>
  parse(...lines).events.map((e) => [e.kind, e.text, e.meta?.toolName ?? e.meta?.source ?? ""]);

describe("Codex adapter", () => {
  it("starts with session_start from session_meta and tags every event agent codex", () => {
    const { events, warnings } = parse(
      sessionMeta(),
      turnContext(),
      item({ type: "UserMessage", id: "u1", content: [{ type: "text", text: " fix it " }] }),
      item({
        type: "AgentMessage",
        id: "m1",
        content: [{ type: "Text", text: "Done." }],
        phase: "final_answer",
      }),
    );
    expect(warnings).toEqual([]);
    for (const e of events) expect(BatonEvent.parse(e)).toEqual(e);
    expect(events.map((e) => [e.seq, e.kind, e.id, e.agent])).toEqual([
      [0, "session_start", `${THREAD}:start`, "codex"],
      [1, "prompt", "u1:0", "codex"],
      [2, "reply", "m1:0", "codex"],
    ]);
    expect(events[0]).toMatchObject({
      sessionId: THREAD,
      projectPath: "C:\\proj",
      text: "C:\\proj",
      meta: { version: "0.166.0", gitBranch: "main", originator: "codex_exec" },
    });
    expect(events[1]).toMatchObject({ text: "fix it", meta: { sources: ["typed"] } });
    expect(events[2]?.meta).toEqual({ model: "gpt-test", phase: "final_answer" });
  });

  it("marks helper threads with meta.subagent", () => {
    const { events } = parse(sessionMeta({ source: { subagent: { other: "guardian" } } }));
    expect(events[0]?.meta?.subagent).toEqual({ other: "guardian" });
  });

  it("turns reasoning summaries into thinking and skips empty reasoning", () => {
    expect(
      rows(
        sessionMeta(),
        item({ type: "Reasoning", id: "r1", summary_text: [], raw_content: [] }),
        item({ type: "Reasoning", id: "r2", summary_text: ["**A**", "**B**"], raw_content: [] }),
      ),
    ).toEqual([
      ["session_start", "C:\\proj", ""],
      ["thinking", "**A**\n\n**B**", ""],
    ]);
  });

  it("maps a command execution to a Shell call and result", () => {
    const { events } = parse(
      sessionMeta(),
      item({
        type: "CommandExecution",
        id: "exec-1",
        command: ["C:\\tools\\pwsh.exe", "-Command", "git status\nGet-ChildItem"],
        cwd: "file:///C:/proj",
        status: "completed",
        aggregated_output: "M a.ts\n\nM b.ts\n",
        exit_code: 0,
      }),
      item({
        type: "CommandExecution",
        id: "exec-2",
        command: ["/bin/bash", "-lc", "false"],
        status: "failed",
        aggregated_output: "",
        exit_code: 1,
      }),
    );
    expect(events.slice(1).map((e) => [e.id, e.kind, e.text])).toEqual([
      ["exec-1:0", "tool_call", "Shell git status"],
      ["exec-1:1", "tool_result", "Shell → exit 0, 2 lines"],
      ["exec-2:0", "tool_call", "Shell false"],
      ["exec-2:1", "tool_result", "Shell → exit 1, no output"],
    ]);
    expect(events[2]?.meta).toMatchObject({
      toolUseId: "exec-1",
      toolName: "Shell",
      isError: false,
      full: "M a.ts\n\nM b.ts\n",
    });
    expect(events[4]?.meta?.isError).toBe(true);
  });

  it("maps file changes, MCP calls, and image views", () => {
    expect(
      rows(
        sessionMeta(),
        item({
          type: "FileChange",
          id: "p1",
          changes: { "C:\\proj\\src\\a.ts": { type: "add" }, "C:\\proj\\b.ts": { type: "add" } },
          status: "completed",
          stdout: "Success.",
          stderr: "",
        }),
        item({
          type: "FileChange",
          id: "p2",
          changes: { "C:\\proj\\c.ts": { type: "update" } },
          status: "failed",
          stdout: "",
          stderr: "patch rejected\nmore",
        }),
        item({
          type: "McpToolCall",
          id: "c1",
          server: "docs",
          tool: "search",
          arguments: { q: "zod" },
          status: "completed",
          result: { content: [{ type: "text", text: "3 hits\nfoo" }] },
        }),
        item({ type: "ImageView", id: "i1", path: "file:///C:/proj/shot%201.png" }),
      ),
    ).toEqual([
      ["session_start", "C:\\proj", ""],
      ["tool_call", "Patch src/a.ts (+1 file)", "Patch"],
      ["tool_result", "Patch src/a.ts (+1 file) → ok", "Patch"],
      ["tool_call", "Patch c.ts", "Patch"],
      ["tool_result", "Patch c.ts → error: patch rejected", "Patch"],
      ["tool_call", 'mcp__docs__search {"q":"zod"}', "mcp__docs__search"],
      ["tool_result", 'mcp__docs__search {"q":"zod"} → 3 hits (+1 lines)', "mcp__docs__search"],
      ["tool_call", "ViewImage shot 1.png", "ViewImage"],
      ["tool_result", "ViewImage shot 1.png (1 attachment)", "ViewImage"],
    ]);
  });

  it("labels injected user-role context as system and ignores the model-facing duplicates", () => {
    expect(
      rows(
        sessionMeta(),
        userContext(
          "<environment_context>\n  <cwd>C:\\proj</cwd>\n</environment_context>",
          "fix it",
          '<image name=[Image #1] path="a.png">',
        ),
        line("response_item", {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions>x</permissions>" }],
        }),
        line("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "dup" }],
        }),
        line("response_item", { type: "reasoning", summary: [], encrypted_content: "x" }),
      ),
    ).toEqual([
      ["session_start", "C:\\proj", ""],
      ["system", "<cwd>C:\\proj</cwd>", "environment_context"],
    ]);
  });

  it("emits system events for compaction and interrupted turns", () => {
    expect(
      rows(
        sessionMeta(),
        item({ type: "ContextCompaction", id: "cc1" }),
        line("event_msg", { type: "turn_aborted", reason: "interrupted" }),
      ),
    ).toEqual([
      ["session_start", "C:\\proj", ""],
      ["system", "Conversation compacted", "compaction"],
      ["system", "Turn interrupted", "interrupt"],
    ]);
  });

  it("follows turn_context for cwd and model", () => {
    const { events } = parse(
      sessionMeta(),
      turnContext({ cwd: "C:\\other", model: "gpt-b" }),
      item({ type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "hi" }] }),
    );
    expect(events[1]).toMatchObject({ projectPath: "C:\\other", meta: { model: "gpt-b" } });
  });

  it("continues one session across segments (repeated session_meta)", () => {
    const { events } = parse(
      sessionMeta(),
      item({ type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "a" }] }),
      sessionMeta({ history_base: { thread_id: THREAD } }),
      item({ type: "AgentMessage", id: "m2", content: [{ type: "Text", text: "b" }] }),
    );
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [0, "session_start"],
      [1, "reply"],
      [2, "reply"],
    ]);
  });

  it("drops bookkeeping silently and reports unknown types in debug mode", () => {
    const debug: string[] = [];
    const text = [
      sessionMeta(),
      line("world_state", {}),
      line("token_usage_record", {}),
      line("compacted", { message: "", replacement_history: [] }),
      line("event_msg", { type: "token_count" }),
      line("event_msg", { type: "task_complete" }),
      item({ type: "Sleep", id: "s1", durationMs: 10 }),
      item({ type: "Hologram", id: "h1" }),
      line("brand_new_record", {}),
    ].join("\n");
    const { events, warnings } = parseSession("codex", text, { debug: (m) => debug.push(m) });
    expect(events.map((e) => e.kind)).toEqual(["session_start"]);
    expect(warnings).toEqual([]);
    expect(debug).toEqual([
      'line 8: dropped unknown item type "Hologram"',
      'line 9: dropped unknown record type "brand_new_record"',
    ]);
  });

  it("never throws on bad input and warns on broken lines", () => {
    const adapter = createAdapter("codex");
    const bad = [
      sessionMeta(),
      "",
      "{",
      "[]",
      "null",
      '{"type":"event_msg"}',
      line("session_meta", { cwd: 3 }),
      line("event_msg", { type: "item_completed", item: { type: "UserMessage" } }),
      line("event_msg", {
        type: "item_completed",
        item: { type: "CommandExecution", id: "x", exit_code: "zero" },
      }),
    ];
    for (const b of bad) expect(() => adapter.parse(b)).not.toThrow();
    const { warnings } = parseSession("codex", bad.join("\n"));
    // Line 6 has no payload; line 7's session_meta has no id.
    expect(warnings.map((w) => w.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it("emits nothing before session_meta", () => {
    expect(
      parse(item({ type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "a" }] }))
        .events,
    ).toEqual([]);
  });
});

describe("Codex tool helpers", () => {
  it("extracts the script from shell argv", () => {
    expect(shellScript(["pwsh.exe", "-Command", "ls"])).toBe("ls");
    expect(shellScript(['"C:\\x\\powershell.EXE"', "-NoProfile", "-Command", "dir"])).toBe("dir");
    expect(shellScript(["bash", "-lc", "echo hi"])).toBe("echo hi");
    expect(shellScript(["git", "status"])).toBe("git status");
    expect(shellScript("already a string")).toBe("already a string");
  });

  it("turns file URLs into paths", () => {
    expect(fileUrlToPath("file:///C:/a/b%20c.png")).toBe("C:/a/b c.png");
    expect(fileUrlToPath("file:///home/dev/a.png")).toBe("/home/dev/a.png");
    expect(fileUrlToPath("C:\\a.png")).toBe("C:\\a.png");
  });
});

describe("agent detection", () => {
  it("tells Codex rollouts from Claude transcripts by file name", () => {
    expect(detectAgent("/h/.codex/sessions/2026/11/02/rollout-2026-11-02T01-03-26-abc.jsonl")).toBe(
      "codex",
    );
    expect(detectAgent("C:\\h\\.codex\\sessions\\rollout-x_y.jsonl.zst")).toBe("codex");
    expect(detectAgent("/h/.claude/projects/-proj/0000.jsonl")).toBe("claude-code");
    expect(detectAgent("/h/notes.txt")).toBeUndefined();
    expect(createAdapter("codex").source).toBe("rollout-tail");
    expect(createAdapter("claude-code").source).toBe("jsonl-tail");
  });
});

describe.each(CODEX_FIXTURES)("codex fixture %s", (name) => {
  const { events, warnings } = parseSession("codex", readCodexRollout(name));

  it("parses without warnings into valid, strictly sequenced events", () => {
    expect(warnings).toEqual([]);
    expect(events[0]?.kind).toBe("session_start");
    events.forEach((e, i) => {
      expect(BatonEvent.safeParse(e).success).toBe(true);
      expect(e.seq).toBe(i);
      expect(e.agent).toBe("codex");
    });
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("pairs every tool call with a result", () => {
    const calls = events.filter((e) => e.kind === "tool_call").map((e) => e.meta?.toolUseId);
    const results = events.filter((e) => e.kind === "tool_result").map((e) => e.meta?.toolUseId);
    expect(calls.length).toBeGreaterThan(5);
    expect(results).toEqual(calls);
  });

  it("emits one event group per thread_items row that has content", () => {
    // Ids are `<item id>:<n>`, and item ids are thread_items.item_id.
    const emitted = new Set(events.map((e) => e.id.replace(/:\d+$/, "")));
    const rowsWithContent = readCodexThreadItems(name)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { item_id: string; item_type: string; item_json: string })
      .filter((r) => {
        if (r.item_type !== "reasoning") return true;
        const j = JSON.parse(r.item_json) as { summary?: string[]; content?: string[] };
        return [...(j.summary ?? []), ...(j.content ?? [])].some((t) => t.trim() !== "");
      });
    for (const r of rowsWithContent) expect(emitted, r.item_id).toContain(r.item_id);
  });
});

describe("parseRolloutName", () => {
  const thread = "01A12741-021d-7180-89f6-c32141d63627";
  const segment = "01a1287e-ffb8-72e1-a421-6dbbd1c46241";

  it("reads the thread id, segment id and compression from a rollout path", () => {
    expect(
      parseRolloutName(
        String.raw`C:\Users\dev\.codex\sessions\2026\10\10\rollout-2026-10-10T15-18-54-${thread}.jsonl`,
      ),
    ).toEqual({ time: "2026-10-10T15-18-54", threadId: thread.toLowerCase(), compressed: false });
    expect(
      parseRolloutName(
        `/home/dev/.codex/sessions/rollout-2026-10-10T21-06-14-${thread}_${segment}.jsonl.zst`,
      ),
    ).toEqual({
      time: "2026-10-10T21-06-14",
      threadId: thread.toLowerCase(),
      segmentId: segment,
      compressed: true,
    });
  });

  it("rejects other file names", () => {
    expect(parseRolloutName("rollout-2026-10-10T15-18-54-not-a-uuid.jsonl")).toBeUndefined();
    expect(parseRolloutName(`rollout-2026-10-10T15-18-54-${thread}.json`)).toBeUndefined();
    expect(parseRolloutName(`/x/session-${thread}.jsonl`)).toBeUndefined();
  });
});
