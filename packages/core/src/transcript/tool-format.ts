import type { JsonValue } from "../event.js";
import type { ToolResultContent } from "./records.js";

/** Max length of a one-line `text` for tool_call / tool_result events. */
export const ONE_LINE_MAX = 120;

/** Collapses whitespace and cuts to `max` chars, ending in `…` if cut. */
export function oneLine(s: string, max = ONE_LINE_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function shortArgs(name: string, input: Record<string, JsonValue>): string {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return str(input.command)?.split("\n")[0] ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str(input.file_path) ?? str(input.notebook_path) ?? "";
    case "Grep":
    case "Glob": {
      const pattern = str(input.pattern) ?? "";
      const path = str(input.path);
      return path ? `${pattern} in ${path}` : pattern;
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
export function summarizeToolCall(name: string, input: Record<string, JsonValue>): string {
  return oneLine(`${name} ${shortArgs(name, input)}`);
}

export type ToolResultSummary = {
  /** One line: first non-empty line, plus ` (+N lines)` if there are more. */
  summary: string;
  /** Every text part of the result, joined with newlines. */
  full: string;
  lines: number;
  /** Non-text blocks (images, documents) in the result. */
  nonText: number;
};

export function summarizeToolResult(content: ToolResultContent | undefined): ToolResultSummary {
  const parts = content === undefined ? [] : typeof content === "string" ? [content] : content;
  const texts: string[] = [];
  let nonText = 0;
  for (const p of parts) {
    if (typeof p === "string") texts.push(p);
    else if (p.type === "text" && p.text !== undefined) texts.push(p.text);
    else nonText++;
  }

  const full = texts.join("\n");
  const allLines = full === "" ? [] : full.split(/\r?\n/);
  const firstIdx = allLines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) {
    return { summary: "(no output)", full, lines: allLines.length, nonText };
  }

  const rest = allLines.slice(firstIdx + 1).filter((l) => l.trim() !== "").length;
  const suffix = rest > 0 ? ` (+${rest} lines)` : "";
  const first = oneLine(allLines[firstIdx] ?? "", ONE_LINE_MAX - suffix.length);
  return { summary: `${first}${suffix}`, full, lines: allLines.length, nonText };
}
