import { z } from "zod";

/** Kinds of BatonEvent. See docs/spec.md. */
export const BATON_EVENT_KINDS = [
  "session_start",
  "prompt",
  "reply",
  "thinking",
  "tool_call",
  "tool_result",
  "system",
] as const;

export const BatonEventKind = z.enum(BATON_EVENT_KINDS);
export type BatonEventKind = z.infer<typeof BatonEventKind>;

/** Coding agents Baton can read. See "Agents and sources" in docs/spec.md. */
export const AGENT_IDS = ["claude-code", "codex"] as const;

export const AgentId = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentId>;

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export const BatonEventMeta = z.record(z.string(), JsonValue);
export type BatonEventMeta = z.infer<typeof BatonEventMeta>;

/** A single event derived from an agent's session log. */
export const BatonEvent = z.object({
  id: z.string().min(1),
  /** Events written before `agent` existed are all Claude Code's. */
  agent: AgentId.default("claude-code"),
  sessionId: z.string().min(1),
  projectPath: z.string(),
  ts: z.iso.datetime({ offset: true }),
  seq: z.number().int().nonnegative(),
  kind: BatonEventKind,
  text: z.string(),
  meta: BatonEventMeta.optional(),
});
export type BatonEvent = z.infer<typeof BatonEvent>;
