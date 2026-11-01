import type { BatonEvent } from "./event.js";
import { keepChars, truncateBytes } from "./transcript/truncate.js";

/** How far thinking text is kept when `thinking: "truncate"`. */
export const COMPACT_THINKING_MAX = 500;

/** Replies longer than this many characters are cut for the handoff. */
export const COMPACT_REPLY_MAX = 1000;

/** No `text` in the handoff is longer than this many UTF-8 bytes (plus a marker). */
export const COMPACT_TEXT_MAX_BYTES = 4096;

export type CompactOptions = {
  /** "drop" (default) removes thinking events; "truncate" keeps the first 500 chars. */
  thinking?: "drop" | "truncate";
};

/** Returns the event with one meta key removed (and no meta at all if none are left). */
function withoutMeta(e: BatonEvent, key: string): BatonEvent {
  const { meta, ...base } = e;
  if (!meta) return base;
  const { [key]: _dropped, ...rest } = meta;
  return Object.keys(rest).length > 0 ? { ...base, meta: rest } : base;
}

/**
 * Shrinks a full-fidelity event stream for handing off to another LLM session.
 * See "Compaction" in docs/spec.md. Returns new events; the input is untouched.
 * `seq` is kept as-is, so gaps show where events were removed.
 */
export function compactForLLM(
  events: readonly BatonEvent[],
  options: CompactOptions = {},
): BatonEvent[] {
  const thinking = options.thinking ?? "drop";
  const out: BatonEvent[] = [];

  for (const e of events) {
    // The parent's Agent/Task call and result already summarize subagent work.
    if (e.meta?.sidechain === true) continue;

    switch (e.kind) {
      case "system":
        break;
      case "thinking":
        if (thinking === "truncate") {
          out.push({ ...e, text: keepChars(e.text, COMPACT_THINKING_MAX) });
        }
        break;
      case "reply":
        out.push({ ...e, text: keepChars(e.text, COMPACT_REPLY_MAX) });
        break;
      case "tool_result":
        out.push(withoutMeta(e, "full"));
        break;
      case "tool_call":
        out.push(withoutMeta(e, "input"));
        break;
      default:
        out.push(e);
    }
  }
  return out.map((e) => {
    const text = truncateBytes(e.text, COMPACT_TEXT_MAX_BYTES);
    return text === e.text ? e : { ...e, text };
  });
}
