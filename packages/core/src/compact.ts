import type { BatonEvent } from "./event.js";

/** How far thinking text is kept when `thinking: "truncate"`. */
export const COMPACT_THINKING_MAX = 500;

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
    switch (e.kind) {
      case "system":
        break;
      case "thinking":
        if (thinking === "truncate") {
          const text =
            e.text.length > COMPACT_THINKING_MAX
              ? `${e.text.slice(0, COMPACT_THINKING_MAX)}…`
              : e.text;
          out.push({ ...e, text });
        }
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
  return out;
}
