import type { BatonEvent, JsonValue } from "../event.js";

/** Inclusive 1-based line range `[first, last]`. */
export type LineRange = readonly [number, number];

/** A file a tool call wrote, and which lines when the event says. */
export type FileTouch = {
  path: string;
  /** Lines written (in the file as it is afterwards); empty when the event doesn't say. */
  ranges: LineRange[];
};

/**
 * Files a tool call writes: Claude Edit/Write/MultiEdit/NotebookEdit and Codex
 * patches. Line ranges come only from what the event carries: a Write's whole
 * content, a Codex added file, or a Codex diff's hunk headers. Claude Edit
 * results don't say where the edit landed, so those touches have no ranges.
 */
export function fileTouches(event: BatonEvent): FileTouch[] {
  if (event.kind !== "tool_call") return [];
  const meta = event.meta;
  const input = asRecord(meta?.input);
  if (!input) return [];
  switch (meta?.toolName) {
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? [{ path: input.file_path, ranges: [] }] : [];
    case "Write": {
      if (typeof input.file_path !== "string") return [];
      const lines = typeof input.content === "string" ? lineCount(input.content) : 0;
      return [{ path: input.file_path, ranges: lines > 0 ? [[1, lines]] : [] }];
    }
    case "NotebookEdit":
      return typeof input.notebook_path === "string"
        ? [{ path: input.notebook_path, ranges: [] }]
        : [];
    case "Patch":
      // Codex fileChange: `input` is the `changes` object, keyed by path.
      return Object.entries(input).map(([path, change]) => ({ path, ranges: patchRanges(change) }));
    default:
      return [];
  }
}

function patchRanges(change: JsonValue): LineRange[] {
  const c = asRecord(change);
  if (!c) return [];
  if (c.type === "add" && typeof c.content === "string") {
    const lines = lineCount(c.content);
    return lines > 0 ? [[1, lines]] : [];
  }
  if (typeof c.unified_diff === "string") return hunkRanges(c.unified_diff);
  return [];
}

/** New-side line ranges of each `@@ -a,b +c,d @@` hunk header. */
export function hunkRanges(diff: string): LineRange[] {
  const out: LineRange[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion (`+c,0`) still touches the spot it removed lines from.
    out.push([Math.max(1, start), Math.max(1, start) + Math.max(count, 1) - 1]);
  }
  return out;
}

/** Sorted, merged copy of `ranges` (touching ranges join). */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}
