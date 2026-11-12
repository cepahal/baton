import { describe, expect, it, vi } from "vitest";
import { createCursorParser, detectAgent, sniffAgent, summarizeToolCall } from "../src/index.js";

const user = (content: string) => JSON.stringify({ role: "user", message: { content } });
const assistant = (content: unknown[]) =>
  JSON.stringify({ role: "assistant", message: { content } });

describe("Cursor transcript parser", () => {
  it("emits prompts, replies and tool calls with timestamps and a path update", () => {
    const parser = createCursorParser({
      sessionId: "chat-1",
      projectPath: "/Users/alice/project",
      fallbackTimestamp: "2026-01-01T00:00:00.000Z",
    });
    const first = parser.parseLine(
      user(
        "<timestamp>Thursday, Jul 23, 2026, 11:20 PM (UTC+2)</timestamp>\n<user_query>Fix the bug</user_query>",
      ),
    );
    const second = parser.parseLine(
      assistant([
        { type: "text", text: "I’ll inspect the project." },
        {
          type: "tool_use",
          name: "Shell",
          input: { command: "pwd", working_directory: String.raw`C:\Users\alice\project` },
        },
      ]),
    );

    expect([...first, ...second].map((event) => [event.kind, event.text, event.ts])).toEqual([
      ["session_start", "/Users/alice/project", "2026-07-23T21:20:00.000Z"],
      ["prompt", "Fix the bug", "2026-07-23T21:20:00.000Z"],
      ["reply", "I’ll inspect the project.", "2026-07-23T21:20:00.000Z"],
      ["tool_call", "Shell pwd", "2026-07-23T21:20:00.000Z"],
    ]);
    expect(second[1]).toMatchObject({
      agent: "cursor",
      projectPath: String.raw`C:\Users\alice\project`,
      seq: 3,
      id: "chat-1:line:2:1",
      meta: {
        toolName: "Shell",
        toolUseId: "chat-1:2:tool:1",
        input: { command: "pwd" },
      },
    });
    expect(second.some((event) => event.kind === "tool_result")).toBe(false);
  });

  it("warns on malformed rows, ignores unknown roles, and continues parsing", () => {
    const debug = vi.fn();
    const parser = createCursorParser({ sessionId: "chat-2", debug });

    expect(parser.parseLine("{bad json")).toEqual([]);
    expect(
      parser.parseLine(JSON.stringify({ role: "system", message: { content: "ignored" } })),
    ).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ role: "user", message: { content: 42 } }))).toEqual(
      [],
    );
    expect(
      parser.parseLine(
        user("<timestamp>not a date</timestamp><user_query>Still works</user_query>"),
      ),
    ).toMatchObject([
      { kind: "session_start", ts: "1970-01-01T00:00:00.000Z" },
      { kind: "prompt", text: "Still works" },
    ]);

    expect(parser.warnings.map(({ line, reason }) => [line, reason])).toEqual([
      [1, "invalid JSON"],
      [3, "malformed Cursor transcript record"],
    ]);
    expect(debug).toHaveBeenCalledWith('line 2: dropped unknown Cursor role "system"');
  });

  it("does not turn empty user messages or invalid timestamps into events", () => {
    const parser = createCursorParser({ fallbackTimestamp: "not a date" });
    expect(
      parser.parseLine(user("<timestamp>not a date</timestamp><user_query> </user_query>")),
    ).toEqual([]);
    expect(parser.warnings).toEqual([]);
  });
});

describe("Cursor detection", () => {
  it("recognizes Cursor JSONL paths and record shapes", () => {
    const path = String.raw`C:\Users\alice\.cursor\projects\c-Users-alice-project\agent-transcripts\chat\chat.jsonl`;
    expect(detectAgent(path)).toBe("cursor");
    expect(sniffAgent(user("hello"))).toBe("cursor");
    expect(sniffAgent(assistant([{ type: "text", text: "hello" }]))).toBe("cursor");
    expect(summarizeToolCall("Write", { path: "/work/a.ts", contents: "const a = 1" })).toBe(
      "Write /work/a.ts",
    );
  });

  it("does not claim unrelated JSONL paths or malformed records", () => {
    expect(detectAgent(String.raw`C:\Users\alice\.claude\projects\chat.jsonl`)).toBe("claude-code");
    expect(detectAgent(String.raw`C:\Users\alice\.cursor\projects\notes.txt`)).toBeUndefined();
    expect(sniffAgent(JSON.stringify({ role: "user", message: { content: 42 } }))).toBeUndefined();
    expect(sniffAgent("not json")).toBeUndefined();
  });
});
