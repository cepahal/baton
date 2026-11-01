import type { JsonValue } from "../event.js";
import type { ToolResultContent } from "./records.js";
import { cutChars } from "./truncate.js";

/** Max length of a one-line `text` for tool_call / tool_result events. */
export const ONE_LINE_MAX = 120;

/** Collapses whitespace and cuts to `max` characters, ending in `…` if cut. */
export function oneLine(s: string, max = ONE_LINE_MAX): string {
  return cutChars(s.replace(/\s+/g, " ").trim(), max);
}

/** The tool call a result answers, as the parser remembers it. */
export type ToolCallInfo = { name: string; input: Record<string, JsonValue> };

const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

const nonEmptyLines = (text: string): string[] =>
  text.split(/\r?\n/).filter((l) => l.trim() !== "");

/** `path` relative to `cwd` (with `/` separators) when it is inside it, else as is. */
export function displayPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const c = norm(cwd);
  // Drive-letter paths are case-insensitive on Windows.
  const fold = /^[a-z]:\//i.test(c) ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(p).startsWith(`${fold(c)}/`) ? p.slice(c.length + 1) : path;
}

function shortArgs(name: string, input: Record<string, JsonValue>, cwd?: string): string {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return str(input.command)?.split("\n")[0] ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const path = str(input.file_path) ?? str(input.notebook_path);
      return path ? displayPath(path, cwd) : "";
    }
    case "Grep":
    case "Glob": {
      const pattern = str(input.pattern) ?? "";
      const path = str(input.path);
      return path ? `${pattern} in ${displayPath(path, cwd)}` : pattern;
    }
    case "WebFetch":
      return str(input.url) ?? "";
    case "WebSearch":
      return str(input.query) ?? "";
    case "Agent":
    case "Task":
      return str(input.description) ?? "";
    default:
      return Object.keys(input).length === 0 ? "" : JSON.stringify(input);
  }
}

/** `<tool name> <short args>` on one line. */
export function summarizeToolCall(
  name: string,
  input: Record<string, JsonValue>,
  cwd?: string,
): string {
  return oneLine(`${name} ${shortArgs(name, input, cwd)}`);
}

/** True if the text already fits on one line of at most {@link ONE_LINE_MAX} characters. */
export function isOneLiner(text: string): boolean {
  const t = text.trim();
  return !t.includes("\n") && [...t].length <= ONE_LINE_MAX;
}

/**
 * One-line recap of multi-line text: the first non-empty line, plus
 * ` (+N lines)` if more non-empty lines follow. Empty string if there is no text.
 */
export function summarizeText(text: string): string {
  const lines = nonEmptyLines(text);
  const [first] = lines;
  if (first === undefined) return "";
  const suffix = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
  return `${oneLine(first, ONE_LINE_MAX - suffix.length)}${suffix}`;
}

export type ToolResultSummary = {
  /** One line; see `tool_result` in docs/spec.md for the format per tool. */
  summary: string;
  /** Every text part of the result, joined with newlines. */
  full: string;
  lines: number;
  /** Non-text blocks (images, documents) in the result. */
  nonText: number;
};

export type ToolResultContext = {
  /** The call this result answers, if the parser saw it. */
  call?: ToolCallInfo | undefined;
  isError?: boolean | undefined;
  /** Session cwd, used to shorten paths. */
  cwd?: string | undefined;
};

/** First line of a failed shell result. Newer Claude Code versions prefix `Error: `. */
const EXIT_CODE_RE = /^(?:Error: )?Exit code (-?\d+)\s*$/;
const TOOL_ERROR_TAG_RE = /<\/?tool_use_error>/g;
/** Read output lines look like `  42\tcode`. */
const NUMBERED_LINE_RE = /^\s*\d+\t/;

/** `Bash → exit 0, 42 lines`. Lines are non-empty output lines. */
function shellOutcome(name: string, text: string, isError: boolean): string {
  const lines = nonEmptyLines(text);
  const code = EXIT_CODE_RE.exec(lines[0] ?? "")?.[1];
  const body = code === undefined ? lines.length : lines.length - 1;
  const status = code !== undefined ? `exit ${code}` : isError ? "error" : "exit 0";
  return `${name} → ${status}, ${body === 0 ? "no output" : plural(body, "line")}`;
}

function resultLine(text: string, nonText: number, ctx: ToolResultContext): string {
  const recap = summarizeText(text.replace(TOOL_ERROR_TAG_RE, ""));
  const attachments = nonText > 0 ? plural(nonText, "attachment") : "";
  const { call } = ctx;
  if (!call) return recap || attachments || "(no output)";

  const { name, input } = call;
  if (name === "Bash" || name === "PowerShell") {
    return shellOutcome(name, text, ctx.isError ?? false);
  }

  const args = shortArgs(name, input, ctx.cwd);
  const head = args ? `${name} ${args}` : name;
  if (ctx.isError) return `${head} → error: ${recap || "(no message)"}`;

  switch (name) {
    case "Read": {
      if (text.trim() === "" && attachments) return `${head} (${attachments})`;
      const numbered = text.split(/\r?\n/).filter((l) => NUMBERED_LINE_RE.test(l)).length;
      return `${head} (${plural(numbered || nonEmptyLines(text).length, "line")})`;
    }
    case "Write": {
      const content = str(input.content);
      if (content === undefined) return `${head} → ok`;
      return `${head} (${plural(content.split(/\r?\n/).length, "line")})`;
    }
    case "Edit":
    case "NotebookEdit":
      return `${head} → ok`;
    case "Grep":
    case "Glob": {
      const n = nonEmptyLines(text).length;
      const none = n === 0 || /^No (?:files|matches) found/.test(text.trim());
      return `${head} → ${none ? "no matches" : plural(n, "line")}`;
    }
    default:
      return `${head} → ${recap || attachments || "no output"}`;
  }
}

/** One-line summary plus the full text of a tool result. */
export function summarizeToolResult(
  content: ToolResultContent | undefined,
  ctx: ToolResultContext = {},
): ToolResultSummary {
  const parts = content === undefined ? [] : typeof content === "string" ? [content] : content;
  const texts: string[] = [];
  let nonText = 0;
  for (const p of parts) {
    if (typeof p === "string") texts.push(p);
    else if (p.type === "text" && p.text !== undefined) texts.push(p.text);
    else nonText++;
  }

  const full = texts.join("\n");
  const lines = full === "" ? 0 : full.split(/\r?\n/).length;
  return { summary: oneLine(resultLine(full, nonText, ctx)), full, lines, nonText };
}
