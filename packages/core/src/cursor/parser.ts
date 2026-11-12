import { z } from "zod";
import { type Draft, eventsFromDrafts, type SessionState } from "../draft.js";
import { type BatonEvent, JsonValue } from "../event.js";
import type { ParserOptions, ParseWarning } from "../transcript/parser.js";
import { summarizeToolCall } from "../transcript/tool-format.js";

const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), JsonValue).optional(),
});

const CursorRecord = z.looseObject({
  role: z.enum(["user", "assistant"]),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]) }),
});

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export type CursorParserOptions = ParserOptions & {
  /** Conversation id from the transcript file's path. */
  sessionId?: string;
  /** Working directory encoded by Cursor's project folder. */
  projectPath?: string;
  /** Parent conversation id for a transcript under `subagents/`. */
  parentSessionId?: string;
  /** Daemon-side timestamp used only when a record has no embedded timestamp. */
  fallbackTimestamp?: string;
};

/**
 * Cursor's local transcript JSONL currently contains `{ role, message }`
 * records. It carries timestamps in user-message text, and tool calls but not
 * tool results. All state is local to one transcript parser.
 */
export function createCursorParser(options: CursorParserOptions = {}) {
  const sessionId = options.sessionId ?? "cursor-session";
  const session: SessionState = { seq: 0, projectPath: options.projectPath ?? "" };
  const warnings: ParseWarning[] = [];
  let lineNo = 0;
  let started = false;
  let lastTimestamp = validTimestamp(options.fallbackTimestamp) ?? FALLBACK_TIMESTAMP;

  function parseLine(line: string): BatonEvent[] {
    lineNo++;
    if (line.trim() === "") return [];

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return warn("invalid JSON");
    }
    const parsed = CursorRecord.safeParse(raw);
    if (!parsed.success) {
      if (
        isObject(raw) &&
        typeof raw.role === "string" &&
        raw.role !== "user" &&
        raw.role !== "assistant"
      ) {
        options.debug?.(`line ${lineNo}: dropped unknown Cursor role "${raw.role}"`);
        return [];
      }
      return warn("malformed Cursor transcript record");
    }

    const blocks =
      typeof parsed.data.message.content === "string"
        ? [{ type: "text", text: parsed.data.message.content }]
        : parsed.data.message.content;
    const textParts = blocks.flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    );
    for (const text of textParts) {
      const timestamp = cursorTimestamp(text);
      if (timestamp) lastTimestamp = timestamp;
    }

    const drafts: Draft[] = [];
    if (parsed.data.role === "user") {
      const prompt = cleanPrompt(textParts.join("\n"));
      if (prompt !== "")
        drafts.push({ kind: "prompt", text: prompt, meta: { sources: ["typed"] } });
    } else {
      blocks.forEach((block, index) => {
        if (block.type === "text" && block.text?.trim()) {
          drafts.push({ kind: "reply", text: block.text });
          return;
        }
        if (block.type !== "tool_use" || !block.name) return;

        const input = block.input ?? {};
        const cwd = stringField(input, "working_directory") ?? stringField(input, "cwd");
        if (cwd && isAbsolutePath(cwd)) session.projectPath = cwd;
        const toolUseId = `${sessionId}:${lineNo}:tool:${index}`;
        drafts.push({
          kind: "tool_call",
          text: summarizeToolCall(block.name, input, session.projectPath),
          meta: { toolName: block.name, toolUseId, input },
        });
      });
    }

    if (drafts.length === 0) return [];
    const events: BatonEvent[] = [];
    if (!started) {
      started = true;
      events.push({
        id: `${sessionId}:start`,
        agent: "cursor",
        sessionId,
        projectPath: session.projectPath,
        ts: lastTimestamp,
        seq: session.seq++,
        kind: "session_start",
        text: session.projectPath,
        ...(options.parentSessionId
          ? { meta: { parentSessionId: options.parentSessionId, source: "cursor" } }
          : { meta: { source: "cursor" } }),
      });
    }
    events.push(
      ...eventsFromDrafts(
        "cursor",
        sessionId,
        session,
        lastTimestamp,
        `${sessionId}:line:${lineNo}`,
        drafts,
      ),
    );
    return events;
  }

  function warn(reason: string): BatonEvent[] {
    const warning = { line: lineNo, reason };
    warnings.push(warning);
    options.onWarning?.(warning);
    return [];
  }

  return { parseLine, warnings };
}

/** Parses Cursor's timestamp prefix, e.g. `Thursday, Jul 23, 2026, 11:20 PM (UTC+2)`. */
export function cursorTimestamp(text: string): string | undefined {
  const match = /<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/i.exec(text);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  const normalized = raw.replace(
    /\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)/i,
    (_all, sign: string, hours: string, minutes?: string) =>
      `GMT${sign}${hours.padStart(2, "0")}${(minutes ?? "0").padStart(2, "0")}`,
  );
  return validTimestamp(normalized);
}

function cleanPrompt(text: string): string {
  const withoutTimestamp = text.replace(/<timestamp>[\s\S]*?(?:<\/timestamp>|$)/gi, "").trim();
  const wrapped = /<user_query>([\s\S]*?)<\/user_query>/i.exec(withoutTimestamp);
  return (wrapped?.[1] ?? withoutTimestamp.replace(/<\/?user_query>/gi, "")).trim();
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : new Date(milliseconds).toISOString();
}

function stringField(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
