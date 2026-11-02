import { z } from "zod";
import { JsonValue } from "../event.js";

/**
 * Zod schemas for the Codex rollout records core understands
 * (`~/.codex/sessions/**\/rollout-*.jsonl`). Objects are loose: Codex adds
 * fields often, and we only read a few.
 */

/** Every rollout line: `{ timestamp, ordinal, type, payload }`. */
export const RolloutLine = z.looseObject({
  type: z.string(),
  timestamp: z.iso.datetime({ offset: true }).optional().catch(undefined),
  ordinal: z.number().int().nonnegative().optional().catch(undefined),
  payload: z.unknown(),
});
export type RolloutLine = z.infer<typeof RolloutLine>;

/** Record types the adapter reads. */
export const HANDLED_ROLLOUT_TYPES = [
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
] as const;

/** Known record types that never produce events (see "Dropped (Codex)" in docs/spec.md). */
export const IGNORED_ROLLOUT_TYPES = ["world_state", "token_usage_record", "compacted"] as const;

export const SessionMeta = z.looseObject({
  id: z.string().min(1),
  /** The thread that started this one; differs from `id` for helper threads. */
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  cli_version: z.string().optional(),
  originator: z.string().optional(),
  /** `"vscode"`, `"exec"`, … or `{ subagent: … }` for helper threads. */
  source: JsonValue.optional(),
  git: z.looseObject({ branch: z.string().optional() }).nullish().catch(undefined),
  /** Set on a segment file that continues the thread from an earlier record (a rewind). */
  history_base: z
    .looseObject({ end_ordinal_exclusive: z.number().int().nonnegative() })
    .nullish()
    .catch(undefined),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

export const TurnContext = z.looseObject({
  cwd: z.string().optional(),
  model: z.string().optional(),
});

/** `event_msg` payloads: only `type` is checked here; items are parsed one by one. */
export const EventMsg = z.looseObject({ type: z.string() });

export const ItemCompleted = z.looseObject({
  type: z.literal("item_completed"),
  thread_id: z.string().optional(),
  item: z.looseObject({ type: z.string(), id: z.string().min(1) }),
});

/** A `response_item` message (model-facing copy of a turn). */
export const ResponseMessage = z.looseObject({
  type: z.literal("message"),
  role: z.string(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([]),
});

const TextPart = z.looseObject({ type: z.string(), text: z.string().optional() });
const Parts = z.array(TextPart).catch([]);
const Strings = z.array(z.string()).catch([]);

export const UserMessageItem = z.looseObject({
  type: z.literal("UserMessage"),
  id: z.string(),
  content: Parts,
});

export const AgentMessageItem = z.looseObject({
  type: z.literal("AgentMessage"),
  id: z.string(),
  content: Parts,
  phase: z.string().optional(),
});

export const ReasoningItem = z.looseObject({
  type: z.literal("Reasoning"),
  id: z.string(),
  summary_text: Strings,
  raw_content: Strings,
});

export const CommandExecutionItem = z.looseObject({
  type: z.literal("CommandExecution"),
  id: z.string(),
  /** argv, e.g. `["pwsh.exe", "-Command", "<script>"]`. Older builds may write one string. */
  command: z.union([z.array(z.string()), z.string()]).catch([]),
  cwd: z.string().optional(),
  status: z.string().optional(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().int().nullish(),
});
export type CommandExecutionItem = z.infer<typeof CommandExecutionItem>;

export const FileChangeItem = z.looseObject({
  type: z.literal("FileChange"),
  id: z.string(),
  changes: z.record(z.string(), JsonValue).catch({}),
  status: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type FileChangeItem = z.infer<typeof FileChangeItem>;

export const McpToolCallItem = z.looseObject({
  type: z.literal("McpToolCall"),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: JsonValue.optional(),
  status: z.string().optional(),
  result: z.looseObject({ content: Parts }).nullish().catch(undefined),
  error: JsonValue.optional(),
});
export type McpToolCallItem = z.infer<typeof McpToolCallItem>;

export const ImageViewItem = z.looseObject({
  type: z.literal("ImageView"),
  id: z.string(),
  path: z.string(),
});

export const ContextCompactionItem = z.looseObject({
  type: z.literal("ContextCompaction"),
  id: z.string(),
});

/** Item types the adapter knows and drops on purpose. */
export const IGNORED_ITEM_TYPES = ["Sleep"] as const;
