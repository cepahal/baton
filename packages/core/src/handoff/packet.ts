import { z } from "zod";
import { compactForLLM } from "../compact.js";
import type { BatonEvent } from "../event.js";
import type { TouchedFile } from "../files/schema.js";
import { renderNote } from "../notes/render.js";
import type { Note } from "../notes/schema.js";
import { keepChars, truncateBytes, utf8Length } from "../transcript/truncate.js";
import { renderChat } from "./chat.js";
import type { HandoffKind, HandoffParty, HandoffSummary } from "./schema.js";

export const HANDOFF_GOAL_MAX = 600;
export const HANDOFF_STATE_MAX = 1000;
/** A snippet keeps at most this many bytes of its event. */
export const HANDOFF_SNIPPET_MAX_BYTES = 16 * 1024;
/** The summarizer sees at most this many bytes of compacted events. */
export const SUMMARIZER_INPUT_MAX_BYTES = 150 * 1024;
const LIST_MAX = 5;

const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;

/** What the summarizer must answer: the template minus `filesTouched`. */
export const SummarizerReply = z.object({
  goal: z.string(),
  currentState: z.string(),
  decisions: z.array(z.string()),
  deadEnds: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
export type SummarizerReply = z.infer<typeof SummarizerReply>;

/** Fills the template from the session itself, for when no summarizer runs. */
export function heuristicSummary(
  events: readonly BatonEvent[],
  filesTouched: TouchedFile[],
): HandoffSummary {
  const main = events.filter((e) => e.meta?.sidechain !== true);
  const prompt = main.find((e) => e.kind === "prompt" && e.text.trim() !== "");
  const reply = main.findLast((e) => e.kind === "reply" && e.text.trim() !== "");
  const failures = main
    .filter((e) => e.kind === "tool_result" && e.meta?.isError === true)
    .map((e) => e.text.trim())
    .filter((t) => t !== "");
  const questions = (reply?.text ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*\d.)\s]+/, ""))
    .filter((l) => l.endsWith("?"));
  return {
    goal: keepChars(prompt?.text.trim() ?? "", HANDOFF_GOAL_MAX),
    currentState: keepChars(reply?.text.trim() ?? "", HANDOFF_STATE_MAX),
    decisions: [],
    deadEnds: failures.slice(-LIST_MAX),
    openQuestions: questions.slice(-LIST_MAX),
    filesTouched,
    nextSteps: [],
  };
}

/**
 * The summarizer's input: the compact view as JSONL, oldest first, keeping the
 * newest events that fit in `SUMMARIZER_INPUT_MAX_BYTES`.
 */
export function summarizerInput(events: readonly BatonEvent[]): string {
  const lines = compactForLLM(events).map((e) =>
    JSON.stringify({ ts: e.ts, kind: e.kind, text: e.text }),
  );
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const size = utf8Length(line) + 1;
    if (bytes + size > SUMMARIZER_INPUT_MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  return kept.reverse().join("\n");
}

/** The model's answer with the computed file list put back. */
export function withFiles(reply: SummarizerReply, filesTouched: TouchedFile[]): HandoffSummary {
  return { ...reply, filesTouched };
}

export type HandoffHeader = {
  sender: string;
  from: HandoffParty;
  to: HandoffParty;
  /** ISO time the draft was made. */
  at: string;
};

/** Renders a full handoff's markdown. Pure; the sender edits the result. */
export function renderHandoff(header: HandoffHeader, summary: HandoffSummary): string {
  const out = [...headerLines("Handoff", header)];
  section(out, "Goal", summary.goal);
  section(out, "Current state", summary.currentState);
  list(out, "Decisions", summary.decisions);
  list(out, "Dead ends", summary.deadEnds);
  list(out, "Open questions", summary.openQuestions);
  list(
    out,
    "Files touched",
    summary.filesTouched.map((f) => `\`${f.path}\`${rangesText(f.ranges)}`),
  );
  list(out, "Next steps", summary.nextSteps);
  return `${out.join("\n").trimEnd()}\n`;
}

/** Renders a snippet: one event's full text under a header saying where it came from. */
export function renderSnippet(header: HandoffHeader, event: BatonEvent): string {
  const full = typeof event.meta?.full === "string" ? event.meta.full : event.text;
  const out = [...headerLines("Snippet", header)];
  out.push(`From a \`${event.kind}\` event at ${event.ts}:`, "");
  const fence = full.includes("```") ? "````" : "```";
  out.push(fence, truncateBytes(full, HANDOFF_SNIPPET_MAX_BYTES), fence);
  return `${out.join("\n").trimEnd()}\n`;
}

export type DraftResult =
  | { ok: true; kind: HandoffKind; markdown: string; summary?: HandoffSummary }
  | { ok: false; error: string };

/**
 * The heuristic draft of a handoff: a filled template for `full`, the named
 * event for `snippet`, the whole conversation for `chat`. The daemon swaps in
 * the summarizer's answer for `full` when it has one.
 */
export function buildHandoffDraft(
  events: readonly BatonEvent[],
  header: HandoffHeader,
  request: {
    kind: HandoffKind;
    eventId?: string | undefined;
    filesTouched: TouchedFile[];
    note?: Note | undefined;
  },
): DraftResult {
  if (request.kind === "note") {
    if (!request.note) return { ok: false, error: "that sticky note is gone" };
    return { ok: true, kind: "note", markdown: renderNote(header, request.note) };
  }
  if (request.kind === "snippet") {
    const event = events.find((e) => e.id === request.eventId);
    if (!event) return { ok: false, error: "that event is no longer held; pick a newer one" };
    return { ok: true, kind: "snippet", markdown: renderSnippet(header, event) };
  }
  if (request.kind === "chat") {
    return { ok: true, kind: "chat", markdown: renderChat(headerLines("Chat", header), events) };
  }
  const summary = heuristicSummary(events, request.filesTouched);
  return { ok: true, kind: "full", markdown: renderHandoff(header, summary), summary };
}

function headerLines(title: string, h: HandoffHeader): string[] {
  const from = `${h.from.user ?? "someone"}'s ${AGENT_NAMES[h.from.agent]} session \`${short(h.from.sessionId)}\``;
  const to = `${h.to.user ?? "someone"}'s ${AGENT_NAMES[h.to.agent]} session \`${short(h.to.sessionId)}\``;
  const repo = h.from.repoId
    ? `${h.from.repoId}${h.from.branch ? ` @ \`${h.from.branch}\`` : ""}`
    : "not in git";
  return [
    `# ${title} from ${h.sender}`,
    "",
    `- **From:** ${from}`,
    `- **To:** ${to}`,
    `- **Repo:** ${repo}`,
    `- **Sent:** ${h.at}`,
    "",
  ];
}

function section(out: string[], title: string, text: string): void {
  out.push(`## ${title}`, "", text.trim() === "" ? "_Not known._" : text.trim(), "");
}

function list(out: string[], title: string, items: readonly string[]): void {
  out.push(`## ${title}`, "");
  if (items.length === 0) out.push("_None._");
  else for (const item of items) out.push(`- ${item.replace(/\s*\n\s*/g, " ")}`);
  out.push("");
}

function rangesText(ranges: readonly (readonly [number, number])[]): string {
  if (ranges.length === 0) return "";
  return ` (lines ${ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")})`;
}

const short = (id: string) => id.slice(0, 8);

/** Where an accepted handoff is written, relative to the checkout. */
export function handoffFilePath(id: string): string {
  return `.baton/handoffs/${id}.md`;
}

/** Where the sender's patch is written, next to the markdown. */
export function handoffPatchPath(id: string): string {
  return `.baton/handoffs/${id}/changes.patch`;
}

/**
 * The prompt the receiver starts their agent with. Only fixed text and paths,
 * so it is safe to paste into a shell command.
 */
export function handoffPrompt(id: string, withPatch = false): string {
  const read = `Read ${handoffFilePath(id)} and continue the work it describes.`;
  if (!withPatch) return read;
  return `${read} The sender's changes are in ${handoffPatchPath(id)}; adapt them to this codebase.`;
}

/** `C:\…`, `C:/…` or `\\server\share\…`: a folder on a Windows machine. */
const isWindowsPath = (folder: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(folder);

/**
 * A folder for a shell command line: quoted when it holds anything but plain
 * characters, for the shell the receiving machine uses.
 *
 * - POSIX folders are double-quoted with `\`, `"`, `$` and `` ` `` escaped, so
 *   `sh` reads back exactly the folder.
 * - Windows folders go to cmd or PowerShell, where `\` is a path separator, not
 *   an escape, so nothing is escaped (`"` can't occur in a Windows name). A
 *   trailing `\` is dropped: `cd` doesn't need it, and before the closing
 *   quote it would read as an escaped quote in a POSIX-style shell.
 */
export function shellFolder(folder: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(folder)) return folder;
  if (isWindowsPath(folder)) {
    return `"${folder.replace(/\\+$/, "")}"`;
  }
  return `"${folder.replace(/(["$`\\])/g, "\\$1")}"`;
}

/** `cd <folder> && claude "<prompt>"`: what the receiver runs to pick the work up. */
export function handoffCommand(agent: string, folder: string, prompt: string): string {
  const command = agent === "codex" ? "codex" : agent === "cursor" ? "agent" : "claude";
  return `cd ${shellFolder(folder)} && ${command} "${prompt}"`;
}
