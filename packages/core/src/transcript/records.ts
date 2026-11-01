import { z } from "zod";
import { JsonValue } from "../event.js";

/**
 * Zod schemas for the Claude Code transcript records core understands.
 * Objects are loose: Claude Code adds fields often, and we only read a few.
 */

export const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
export type TextBlock = z.infer<typeof TextBlock>;

export const ThinkingBlock = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string().optional(),
});

export const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), JsonValue).catch({}),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;

/** Content of a tool_result: a string, or blocks (text, image, …). */
export const ToolResultContent = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);
export type ToolResultContent = z.infer<typeof ToolResultContent>;

export const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: ToolResultContent.optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

/**
 * A content block of any type. Records keep blocks loose; the parser narrows
 * each one with the specific block schema above, so one malformed or unknown
 * block (image, document, redacted_thinking, …) never rejects the whole record.
 */
export const ContentBlock = z.looseObject({ type: z.string() });
export type ContentBlock = z.infer<typeof ContentBlock>;

const RecordBase = {
  uuid: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  isSidechain: z.boolean().optional(),
};

export const UserRecord = z.looseObject({
  ...RecordBase,
  type: z.literal("user"),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  message: z.looseObject({
    content: z.union([z.string(), z.array(ContentBlock)]),
  }),
});
export type UserRecord = z.infer<typeof UserRecord>;

export const AssistantRecord = z.looseObject({
  ...RecordBase,
  type: z.literal("assistant"),
  message: z.looseObject({
    model: z.string().optional(),
    content: z.array(ContentBlock),
  }),
});
export type AssistantRecord = z.infer<typeof AssistantRecord>;

export const SystemRecord = z.looseObject({
  ...RecordBase,
  type: z.literal("system"),
  subtype: z.string().optional(),
  level: z.string().optional(),
  content: z.string().optional(),
});
export type SystemRecord = z.infer<typeof SystemRecord>;

/** Record types that can produce events. Everything else is dropped. */
export const HANDLED_RECORD_TYPES = ["user", "assistant", "system"] as const;
