import { compactForLLM } from "../compact.js";
import type { BatonEvent } from "../event.js";
import { HANDOFF_MARKDOWN_MAX } from "./schema.js";

/** Room kept under the markdown cap for the header and the "omitted" line. */
const HEADER_ROOM = 2 * 1024;

const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;

/** One compacted event as markdown, or undefined for events a reader doesn't need. */
function renderEvent(e: BatonEvent): string | undefined {
  const text = e.text.trim();
  switch (e.kind) {
    case "prompt":
      return text === "" ? undefined : `### Prompt\n\n${text}`;
    case "reply":
      return text === "" ? undefined : `### ${AGENT_NAMES[e.agent]}\n\n${text}`;
    case "thinking":
      return text === "" ? undefined : `> _Thinking:_ ${text.replace(/\s*\n\s*/g, " ")}`;
    case "tool_call":
      return `- **Tool:** ${fenceInline(text)}`;
    case "tool_result": {
      if (text === "") return undefined;
      const fence = text.includes("```") ? "````" : "```";
      const label = e.meta?.isError === true ? "Tool error" : "Result";
      return `<details><summary>${label}</summary>\n\n${fence}\n${text}\n${fence}\n\n</details>`;
    }
    default:
      return undefined;
  }
}

function fenceInline(text: string): string {
  const line = text.replace(/\s*\n\s*/g, " ");
  return line.includes("`") ? `\`\` ${line} \`\`` : `\`${line}\``;
}

/**
 * The whole conversation as markdown, built by code from the compact view
 * (`compactForLLM`): no model involved. Oldest first; when it is too long for a
 * handoff the oldest turns go (the first prompt is always kept) and a line says
 * how many.
 */
export function renderChat(
  headerLines: readonly string[],
  events: readonly BatonEvent[],
  maxChars: number = HANDOFF_MARKDOWN_MAX,
): string {
  const blocks = compactForLLM(events)
    .map(renderEvent)
    .filter((b): b is string => b !== undefined);
  const header = headerLines.join("\n");
  if (blocks.length === 0) return `${header}\n_The conversation has no messages yet._\n`;

  const intro =
    "_The whole conversation, oldest first: thinking and subagent work left out, long tool output and replies shortened._";
  const budget = maxChars - HEADER_ROOM - header.length - intro.length;
  const firstPrompt = blocks.findIndex((b) => b.startsWith("### Prompt"));
  const first = firstPrompt === -1 ? undefined : blocks[firstPrompt];
  let used = first === undefined ? 0 : first.length + 2;

  // Keep the newest entries that fit; everything from `start` on stays.
  let start = blocks.length;
  while (start > 0) {
    const i = start - 1;
    if (i !== firstPrompt) {
      const size = (blocks[i] ?? "").length + 2;
      if (used + size > budget) break;
      used += size;
    }
    start = i;
  }
  const body: string[] = [];
  if (first !== undefined && firstPrompt < start) {
    body.push(first);
    const omitted = start - 1;
    if (omitted > 0) {
      body.push(`_… ${omitted} earlier ${omitted === 1 ? "entry" : "entries"} left out to fit._`);
    }
  } else if (start > 0) {
    body.push(`_… ${start} earlier ${start === 1 ? "entry" : "entries"} left out to fit._`);
  }
  body.push(...blocks.slice(start));
  return `${header}\n${intro}\n\n${body.join("\n\n")}\n`;
}
