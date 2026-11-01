import { describe, expect, it } from "vitest";
import { BatonEvent, createTranscriptParser, ONE_LINE_MAX, parseTranscript } from "../src/index.js";
import { assistant, base, FIXTURES, jsonl, readFixture, SESSION, user } from "./helpers.js";

const kinds = (text: string) => parseTranscript(text).events.map((e) => e.kind);

describe("parseTranscript", () => {
  it("starts each session with one session_start and numbers seq from 0", () => {
    const { events } = parseTranscript(
      jsonl(user("hi"), assistant([{ type: "text", text: "hello" }])),
    );
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [0, "session_start"],
      [1, "prompt"],
      [2, "reply"],
    ]);
    expect(events[0]).toMatchObject({
      id: `${SESSION}:start`,
      text: "/home/dev/proj",
      meta: { gitBranch: "main", version: "2.1.300" },
    });
    expect(events[1]).toMatchObject({
      text: "hi",
      projectPath: "/home/dev/proj",
      meta: { sources: ["typed"] },
    });
  });

  it("drops non-human record types silently", () => {
    const noise = [
      "attachment",
      "queue-operation",
      "cost-state",
      "api-request",
      "file-history-snapshot",
      "mystery",
    ];
    const r = parseTranscript(jsonl(...noise.map((type) => JSON.stringify({ ...base(), type }))));
    expect(r).toEqual({ events: [], warnings: [] });
  });

  it("warns on bad lines and keeps going", () => {
    const r = parseTranscript(
      jsonl("{oops", "42", JSON.stringify({ type: "user" }), user("still here")),
    );
    expect(r.warnings.map((w) => [w.line, w.reason.split(":")[0]])).toEqual([
      [1, "invalid JSON"],
      [2, "not a transcript record"],
      [3, "malformed user record"],
    ]);
    expect(r.events.map((e) => e.kind)).toEqual(["session_start", "prompt"]);
  });

  it("labels user-side content as prompt, tool_result, or system", () => {
    const { events } = parseTranscript(
      jsonl(
        user("<system-reminder>ctx</system-reminder>do it"),
        assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
        user([{ type: "tool_result", tool_use_id: "t1", content: "a\nb\nc" }]),
        user("summary of earlier work", { isCompactSummary: true }),
        user("<local-command-caveat>caveat</local-command-caveat>", { isMeta: true }),
      ),
    );
    expect(events.slice(1).map((e) => [e.kind, e.text])).toEqual([
      ["system", "ctx"],
      ["prompt", "do it"],
      ["tool_call", "Bash ls"],
      ["tool_result", "Bash → exit 0, 3 lines"],
      ["system", "summary of earlier work"],
      ["system", "<local-command-caveat>caveat</local-command-caveat>"],
    ]);
    expect(events.find((e) => e.kind === "tool_result")?.meta).toEqual({
      toolUseId: "t1",
      toolName: "Bash",
      isError: false,
      lines: 3,
      full: "a\nb\nc",
    });
    expect(events.at(-2)?.meta).toEqual({ source: "compact_summary" });
  });

  it("keeps tool call args in meta.input", () => {
    const input = { file_path: "/a.ts", old_string: "x", new_string: "y" };
    const { events } = parseTranscript(
      assistant([{ type: "tool_use", id: "t9", name: "Edit", input }]),
    );
    expect(events[1]).toMatchObject({
      kind: "tool_call",
      text: "Edit /a.ts",
      meta: { toolName: "Edit", input },
    });
  });

  it("emits thinking when present and skips empty thinking blocks", () => {
    const text = jsonl(
      assistant([{ type: "thinking", thinking: "", signature: "sig" }]),
      assistant([{ type: "thinking", signature: "sig" }]),
      assistant([{ type: "redacted_thinking", data: "x" }]),
      assistant([
        { type: "thinking", thinking: "let me check", signature: "sig" },
        { type: "text", text: "Done." },
      ]),
    );
    const { events } = parseTranscript(text);
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["session_start", "/home/dev/proj"],
      ["thinking", "let me check"],
      ["reply", "Done."],
    ]);
    expect(events[1]?.meta).toEqual({ model: "claude-x" });
  });

  it("turns system records with content into system events and drops the rest", () => {
    const sys = (extra: object) => JSON.stringify({ ...base(), type: "system", ...extra });
    const { events } = parseTranscript(
      jsonl(
        sys({ subtype: "turn_duration", durationMs: 10 }),
        sys({ subtype: "compact_boundary", content: "Conversation compacted", level: "info" }),
      ),
    );
    expect(events.slice(1)).toMatchObject([
      {
        kind: "system",
        text: "Conversation compacted",
        meta: { source: "compact_boundary", level: "info" },
      },
    ]);
  });

  it("drops empty prompts and images", () => {
    expect(
      kinds(
        user([
          { type: "image", source: {} },
          { type: "text", text: "  " },
        ]),
      ),
    ).toEqual([]);
  });

  it("gives every event in a record a distinct id", () => {
    const { events } = parseTranscript(
      assistant([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    );
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("keeps seq counting across parseLine calls", () => {
    const p = createTranscriptParser();
    p.parseLine(user("one"));
    expect(p.parseLine(user("two")).map((e) => e.seq)).toEqual([2]);
  });
});

describe("system events", () => {
  const sysEvents = (text: string) =>
    parseTranscript(text).events.filter((e) => e.kind === "system");

  it("keeps one-liners as they are", () => {
    const [e] = sysEvents(user("<system-reminder>  short note </system-reminder>hi"));
    expect(e).toMatchObject({ text: "short note", meta: { source: "system-reminder" } });
    expect(e?.meta).not.toHaveProperty("full");
  });

  it("recaps multi-line content into one line and keeps the original in meta.full", () => {
    const body = "Tasks:\n\n- one\n- two";
    const [e] = sysEvents(user(`<task-notification>${body}</task-notification>`));
    expect(e).toMatchObject({
      text: "Tasks: (+2 lines)",
      meta: { source: "task-notification", full: body },
    });
  });

  it("recaps a single line that is too long", () => {
    const long = "x".repeat(300);
    const [e] = sysEvents(user(long, { isCompactSummary: true }));
    expect(e?.text.length).toBeLessThanOrEqual(ONE_LINE_MAX);
    expect(e?.meta).toEqual({ source: "compact_summary", full: long });
  });

  it("recaps system records the same way", () => {
    const rec = JSON.stringify({
      ...base(),
      type: "system",
      subtype: "informational",
      content: "line 1\nline 2",
    });
    expect(sysEvents(rec)[0]).toMatchObject({
      text: "line 1 (+1 lines)",
      meta: { source: "informational", full: "line 1\nline 2" },
    });
  });
});

describe("subagent (sidechain) records", () => {
  it("tags their events with sidechain and agentId", () => {
    const { events } = parseTranscript(
      jsonl(
        assistant([
          { type: "tool_use", id: "t1", name: "Agent", input: { description: "Find it" } },
        ]),
        user("Find the config loader", { isSidechain: true, agentId: "a1" }),
        JSON.stringify({
          ...base(),
          type: "assistant",
          isSidechain: true,
          agentId: "a1",
          message: { model: "claude-x", content: [{ type: "text", text: "Found it." }] },
        }),
      ),
    );
    expect(
      events.slice(1).map((e) => [e.kind, e.meta?.sidechain ?? false, e.meta?.agentId]),
    ).toEqual([
      ["tool_call", false, undefined],
      ["prompt", true, "a1"],
      ["reply", true, "a1"],
    ]);
  });
});

describe.each(FIXTURES)("fixture %s", (name) => {
  const { events, warnings } = parseTranscript(readFixture(name));

  it("parses without warnings into valid events", () => {
    expect(warnings).toEqual([]);
    for (const e of events) expect(BatonEvent.safeParse(e).success).toBe(true);
  });

  it("has a session_start first and strictly increasing seq", () => {
    expect(events[0]?.kind).toBe("session_start");
    expect(events.filter((e) => e.kind === "session_start")).toHaveLength(1);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("covers prompts, replies, and tool calls with results", () => {
    const seen = new Set(events.map((e) => e.kind));
    for (const k of ["prompt", "reply", "thinking", "tool_call", "tool_result"])
      expect(seen).toContain(k);
    const callIds = new Set(
      events.filter((e) => e.kind === "tool_call").map((e) => e.meta?.toolUseId),
    );
    for (const r of events.filter((e) => e.kind === "tool_result"))
      expect(callIds).toContain(r.meta?.toolUseId);
  });

  it("never leaks injected tags into prompts", () => {
    const typedOnly = (e: (typeof events)[number]) =>
      Array.isArray(e.meta?.sources) && !e.meta.sources.includes("pasted");
    for (const e of events.filter((e) => e.kind === "prompt" && typedOnly(e))) {
      expect(e.text).not.toMatch(/<(system-reminder|ide_opened_file|pasted_content)\b/);
    }
  });
});
