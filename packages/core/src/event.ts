import { z } from "zod";

/** Kinds of BatonEvent. See docs/spec.md. */
export const BATON_EVENT_KINDS = [
  "session_start",
  "prompt",
  "reply",
  "tool_call",
  "tool_result",
] as const;

export const BatonEventKind = z.enum(BATON_EVENT_KINDS);
export type BatonEventKind = z.infer<typeof BatonEventKind>;

/** A single filtered, display-ready event derived from a Claude Code transcript. */
export const BatonEvent = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  projectPath: z.string(),
  ts: z.iso.datetime({ offset: true }),
  seq: z.number().int().nonnegative(),
  kind: BatonEventKind,
  text: z.string(),
  meta: z.record(z.string(), z.json()).optional(),
});
export type BatonEvent = z.infer<typeof BatonEvent>;
