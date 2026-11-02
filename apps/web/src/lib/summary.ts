import type { BatonEvent } from "@baton/core";

export type SessionSummary = {
  /** The first prompt: what the session set out to do. */
  topic: string | undefined;
  /** The latest reply: where it got to. */
  latest: string | undefined;
  prompts: number;
  toolCalls: number;
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A short card-sized summary of a session's events. */
export function summarize(events: readonly BatonEvent[], max = 160): SessionSummary {
  let topic: string | undefined;
  let latest: string | undefined;
  let prompts = 0;
  let toolCalls = 0;
  for (const e of events) {
    if (e.kind === "prompt" && e.text.trim()) {
      prompts++;
      topic ??= clip(e.text, max);
    } else if (e.kind === "reply" && e.text.trim()) {
      latest = e.text;
    } else if (e.kind === "tool_call") {
      toolCalls++;
    }
  }
  return {
    topic,
    latest: latest === undefined ? undefined : clip(latest, max),
    prompts,
    toolCalls,
  };
}
