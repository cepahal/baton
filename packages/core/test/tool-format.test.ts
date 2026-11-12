import { describe, expect, it } from "vitest";
import {
  displayPath,
  isOneLiner,
  ONE_LINE_MAX,
  oneLine,
  summarizeText,
  summarizeToolCall,
  summarizeToolResult,
} from "../src/index.js";

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

describe("isOneLiner / summarizeText", () => {
  it("accepts short single lines only", () => {
    expect(isOneLiner("  fine  ")).toBe(true);
    expect(isOneLiner("a\nb")).toBe(false);
    expect(isOneLiner("z".repeat(ONE_LINE_MAX + 1))).toBe(false);
  });

  it("recaps to the first non-empty line plus a count", () => {
    expect(summarizeText("\n\nhead\n\nbody\nmore")).toBe("head (+2 lines)");
    expect(summarizeText("only")).toBe("only");
    expect(summarizeText(" \n ")).toBe("");
  });
});

describe("summarizeToolCall", () => {
  it.each([
    ["Bash", { command: "ls -la\necho done" }, "Bash ls -la"],
    ["Shell", { command: "ls -la\necho done" }, "Shell ls -la"],
    ["Read", { file_path: "/src/a.ts", offset: 10 }, "Read /src/a.ts"],
    ["Write", { path: "/src/a.ts", contents: "export {}" }, "Write /src/a.ts"],
    ["StrReplace", { path: "/src/a.ts" }, "StrReplace /src/a.ts"],
    ["Delete", { path: "/src/a.ts" }, "Delete /src/a.ts"],
    ["Grep", { pattern: "TODO", path: "src" }, "Grep TODO in src"],
    ["Glob", { pattern: "**/*.ts" }, "Glob **/*.ts"],
    ["WebFetch", { url: "https://example.com" }, "WebFetch https://example.com"],
    ["Agent", { description: "Find callers", prompt: "long…" }, "Agent Find callers"],
    ["mcp__x__y", { a: 1 }, 'mcp__x__y {"a":1}'],
    ["ToolSearch", {}, "ToolSearch"],
    ["WebSearch", { query: "zod 4 looseObject" }, "WebSearch zod 4 looseObject"],
    ["NotebookEdit", { notebook_path: "/n.ipynb" }, "NotebookEdit /n.ipynb"],
  ])("%s", (name, input, expected) => {
    expect(summarizeToolCall(name, input)).toBe(expected);
  });

  it.each([
    "Bash",
    "Shell",
    "Read",
    "StrReplace",
    "Delete",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Agent",
  ])("%s with its main argument missing or not a string", (name) => {
    expect(summarizeToolCall(name, {})).toBe(name);
    expect(
      summarizeToolCall(name, {
        command: 1,
        file_path: 1,
        pattern: 1,
        url: 1,
        query: 1,
        description: 1,
      }),
    ).toBe(name);
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

describe("summarizeToolResult with its call", () => {
  const cwd = "/home/dev/proj";
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\tcode`).join("\n");
  const r = (
    name: string,
    input: Record<string, string>,
    content: string | undefined,
    isError = false,
  ) => summarizeToolResult(content, { call: { name, input }, isError, cwd }).summary;

  it.each([
    ["Bash ok", "Bash", {}, "a\nb\n\nc", false, "Bash → exit 0, 3 lines"],
    ["Bash one line", "Bash", {}, "done", false, "Bash → exit 0, 1 line"],
    ["Bash silent", "Bash", {}, "", false, "Bash → exit 0, no output"],
    ["Bash exit code", "Bash", {}, "Exit code 2\nboom", true, "Bash → exit 2, 1 line"],
    ["Bash Error: prefix", "Bash", {}, "Error: Exit code 127", true, "Bash → exit 127, no output"],
    ["Bash error w/o code", "Bash", {}, "Command timed out", true, "Bash → error, 1 line"],
    ["PowerShell", "PowerShell", {}, "x\r\ny", false, "PowerShell → exit 0, 2 lines"],
    [
      "Read",
      "Read",
      { file_path: `${cwd}/src/api.ts` },
      numbered(180),
      false,
      "Read src/api.ts (180 lines)",
    ],
    [
      "Read + appended reminder",
      "Read",
      { file_path: "/etc/hosts" },
      `${numbered(2)}\n\n<system-reminder>\nnote\n</system-reminder>`,
      false,
      "Read /etc/hosts (2 lines)",
    ],
    [
      "Read unnumbered",
      "Read",
      { file_path: `${cwd}/a` },
      "plain\ntext",
      false,
      "Read a (2 lines)",
    ],
    [
      "Write",
      "Write",
      { file_path: `${cwd}/b.ts`, content: "1\n2\n3" },
      "File created",
      false,
      "Write b.ts (3 lines)",
    ],
    [
      "Write w/o content",
      "Write",
      { file_path: `${cwd}/b.ts` },
      "File created",
      false,
      "Write b.ts → ok",
    ],
    ["Edit", "Edit", { file_path: `${cwd}/c.ts` }, "The file was updated", false, "Edit c.ts → ok"],
    [
      "Edit error",
      "Edit",
      { file_path: `${cwd}/c.ts` },
      "<tool_use_error>File has not been read yet.</tool_use_error>",
      true,
      "Edit c.ts → error: File has not been read yet.",
    ],
    [
      "Error w/o message",
      "Edit",
      { file_path: `${cwd}/c.ts` },
      "",
      true,
      "Edit c.ts → error: (no message)",
    ],
    ["Grep", "Grep", { pattern: "TODO" }, "a.ts\nb.ts", false, "Grep TODO → 2 lines"],
    ["Grep none", "Grep", { pattern: "TODO" }, "No matches found", false, "Grep TODO → no matches"],
    ["Glob none", "Glob", { pattern: "*.rs" }, "No files found", false, "Glob *.rs → no matches"],
    ["Glob empty", "Glob", { pattern: "*.rs" }, "", false, "Glob *.rs → no matches"],
    [
      "other tool",
      "WebFetch",
      { url: "https://x.dev" },
      "Title\nbody",
      false,
      "WebFetch https://x.dev → Title (+1 lines)",
    ],
    ["other, no output", "ToolSearch", {}, undefined, false, "ToolSearch → no output"],
  ])("%s", (_, name, input, content, isError, expected) => {
    expect(r(name, input, content, isError)).toBe(expected);
  });

  it("describes non-text output", () => {
    const img = [{ type: "image" }];
    const call = (name: string) => ({ name, input: { file_path: `${cwd}/p.png` } });
    expect(summarizeToolResult(img, { call: call("Read"), cwd }).summary).toBe(
      "Read p.png (1 attachment)",
    );
    expect(summarizeToolResult(img, { call: call("Screenshot") }).summary).toBe(
      `Screenshot {"file_path":"${cwd}/p.png"} → 1 attachment`,
    );
    expect(summarizeToolResult([...img, ...img]).summary).toBe("2 attachments");
  });
});

describe("displayPath", () => {
  it.each([
    ["/home/dev/proj/src/a.ts", "/home/dev/proj", "src/a.ts"],
    ["/home/dev/proj/src/a.ts", "/home/dev/proj/", "src/a.ts"],
    ["/home/dev/project2/a.ts", "/home/dev/proj", "/home/dev/project2/a.ts"],
    ["/home/dev/proj", "/home/dev/proj", "/home/dev/proj"],
    [String.raw`C:\Users\dev\proj\src\a.ts`, String.raw`c:\Users\dev\proj`, "src/a.ts"],
    ["/Home/Dev/proj/a.ts", "/home/dev/proj", "/Home/Dev/proj/a.ts"],
    ["/x/a.ts", undefined, "/x/a.ts"],
  ])("%s in %s", (path, cwd, expected) => {
    expect(displayPath(path, cwd)).toBe(expected);
  });

  it("shortens tool call paths too", () => {
    expect(summarizeToolCall("Read", { file_path: "/home/dev/proj/a.ts" }, "/home/dev/proj")).toBe(
      "Read a.ts",
    );
    expect(
      summarizeToolCall("Grep", { pattern: "x", path: "/home/dev/proj/src" }, "/home/dev/proj"),
    ).toBe("Grep x in src");
  });
});
