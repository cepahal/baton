import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BatonEvent,
  COMPACT_REPLY_MAX,
  COMPACT_THINKING_MAX,
  compactForLLM,
  parseTranscript,
} from "../src/index.js";

let seq = 0;
const ev = (kind: BatonEvent["kind"], text: string, meta?: BatonEvent["meta"]): BatonEvent => ({
  id: `e${seq}`,
  agent: "claude-code",
  sessionId: "s",
  projectPath: "/p",
  ts: "2026-11-01T12:00:00.000Z",
  seq: seq++,
  kind,
  text,
  ...(meta ? { meta } : {}),
});

describe("compactForLLM", () => {
  const events = [
    ev("session_start", "/p"),
    ev("prompt", "do it", { sources: ["typed"] }),
    ev("system", "reminder", { source: "system-reminder" }),
    ev("thinking", "t".repeat(COMPACT_THINKING_MAX + 50)),
    ev("tool_call", "Bash ls", { toolName: "Bash", toolUseId: "t1", input: { command: "ls" } }),
    ev("tool_result", "a (+2 lines)", { toolUseId: "t1", lines: 3, full: "a\nb\nc" }),
    ev("reply", "done"),
  ];

  it("drops system and thinking events by default and keeps seq gaps", () => {
    const out = compactForLLM(events);
    expect(out.map((e) => [e.seq, e.kind])).toEqual([
      [0, "session_start"],
      [1, "prompt"],
      [4, "tool_call"],
      [5, "tool_result"],
      [6, "reply"],
    ]);
  });

  it("strips full tool output and tool args, keeping one-line text", () => {
    const out = compactForLLM(events);
    expect(out.find((e) => e.kind === "tool_result")).toMatchObject({
      text: "a (+2 lines)",
      meta: { toolUseId: "t1", lines: 3 },
    });
    expect(out.find((e) => e.kind === "tool_result")?.meta).not.toHaveProperty("full");
    expect(out.find((e) => e.kind === "tool_call")?.meta).toEqual({
      toolName: "Bash",
      toolUseId: "t1",
    });
  });

  it("removes meta entirely when nothing is left", () => {
    const [out] = compactForLLM([ev("tool_result", "x", { full: "x" })]);
    expect(out).not.toHaveProperty("meta");
  });

  it("can truncate thinking instead of dropping it", () => {
    const out = compactForLLM(events, { thinking: "truncate" });
    const thinking = out.find((e) => e.kind === "thinking");
    expect(thinking?.text).toBe(`${"t".repeat(COMPACT_THINKING_MAX)}…`);
    expect(compactForLLM([ev("thinking", "short")], { thinking: "truncate" })[0]?.text).toBe(
      "short",
    );
  });

  it("cuts long replies for the handoff and keeps short ones", () => {
    const long = "r".repeat(COMPACT_REPLY_MAX + 1);
    const [cutReply, shortReply] = compactForLLM([ev("reply", long), ev("reply", "ok")]);
    expect(cutReply?.text).toBe(`${"r".repeat(COMPACT_REPLY_MAX)}…`);
    expect(shortReply?.text).toBe("ok");
  });

  it("drops subagent (sidechain) events", () => {
    const out = compactForLLM([
      ev("tool_call", "Agent Find it", { toolName: "Agent" }),
      ev("reply", "inside the subagent", { sidechain: true, agentId: "a1" }),
      ev("tool_result", "Found it.", { toolName: "Agent", full: "Found it." }),
    ]);
    expect(out.map((e) => e.text)).toEqual(["Agent Find it", "Found it."]);
  });

  it("does not modify its input", () => {
    const before = structuredClone(events);
    compactForLLM(events, { thinking: "truncate" });
    expect(events).toEqual(before);
  });

  it("shrinks a real transcript", () => {
    const text = readFileSync(join(import.meta.dirname, "fixtures", "heavy-tools.jsonl"), "utf8");
    const { events: full } = parseTranscript(text);
    const out = compactForLLM(full);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(out.some((e) => e.kind === "thinking" || e.kind === "system")).toBe(false);
  });
});
