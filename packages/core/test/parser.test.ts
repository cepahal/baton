import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatonEvent, createTranscriptParser, parseTranscript } from "../src/index.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
let n = 0;
const base = () => ({
  uuid: `u${++n}`,
  sessionId: SESSION,
  timestamp: "2026-11-01T12:00:00.000Z",
  cwd: "/home/dev/proj",
  gitBranch: "main",
  version: "2.1.300",
});
const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ ...base(), type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) =>
  JSON.stringify({
    ...base(),
    type: "assistant",
    message: { role: "assistant", model: "claude-x", content },
  });
const jsonl = (...lines: string[]) => lines.join("\n");
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
      ["tool_result", "a (+2 lines)"],
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
    expect(p.parseLine(user("two")).events.map((e) => e.seq)).toEqual([2]);
  });
});

describe.each(["heavy-tools", "api-requests", "mixed"])("fixture %s", (name) => {
  const { events, warnings } = parseTranscript(
    readFileSync(join(import.meta.dirname, "fixtures", `${name}.jsonl`), "utf8"),
  );

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
