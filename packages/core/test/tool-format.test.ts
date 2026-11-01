import { describe, expect, it } from "vitest";
import { ONE_LINE_MAX, oneLine, summarizeToolCall, summarizeToolResult } from "../src/index.js";

describe("oneLine", () => {
  it("collapses whitespace", () => {
    expect(oneLine("  a\n\tb  c ")).toBe("a b c");
  });

  it("cuts long text with an ellipsis", () => {
    const out = oneLine("x".repeat(500));
    expect(out).toHaveLength(ONE_LINE_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("summarizeToolCall", () => {
  it.each([
    ["Bash", { command: "ls -la\necho done" }, "Bash ls -la"],
    ["Read", { file_path: "/src/a.ts", offset: 10 }, "Read /src/a.ts"],
    ["Grep", { pattern: "TODO", path: "src" }, "Grep TODO in src"],
    ["Glob", { pattern: "**/*.ts" }, "Glob **/*.ts"],
    ["WebFetch", { url: "https://example.com" }, "WebFetch https://example.com"],
    ["Agent", { description: "Find callers", prompt: "long…" }, "Agent Find callers"],
    ["mcp__x__y", { a: 1 }, 'mcp__x__y {"a":1}'],
    ["ToolSearch", {}, "ToolSearch"],
  ])("%s", (name, input, expected) => {
    expect(summarizeToolCall(name, input)).toBe(expected);
  });
});

describe("summarizeToolResult", () => {
  it("uses the first non-empty line plus a count of the rest", () => {
    const r = summarizeToolResult("\nfirst\n\nsecond\nthird");
    expect(r.summary).toBe("first (+2 lines)");
    expect(r.full).toBe("\nfirst\n\nsecond\nthird");
    expect(r.lines).toBe(5);
  });

  it("joins text parts and counts non-text parts", () => {
    const r = summarizeToolResult([
      { type: "text", text: "a" },
      { type: "image" },
      { type: "text", text: "b" },
    ]);
    expect(r).toEqual({ summary: "a (+1 lines)", full: "a\nb", lines: 2, nonText: 1 });
  });

  it("reports empty output", () => {
    expect(summarizeToolResult(undefined).summary).toBe("(no output)");
    expect(summarizeToolResult("  \n").summary).toBe("(no output)");
  });

  it("keeps the summary within the one-line limit", () => {
    expect(summarizeToolResult(`${"y".repeat(300)}\nmore`).summary.length).toBeLessThanOrEqual(
      ONE_LINE_MAX,
    );
  });
});
