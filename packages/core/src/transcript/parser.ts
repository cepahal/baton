import { z } from "zod";
import type { BatonEvent, BatonEventKind, BatonEventMeta, JsonValue } from "../event.js";
import {
  AssistantRecord,
  type ContentBlock,
  HANDLED_RECORD_TYPES,
  SystemRecord,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserRecord,
} from "./records.js";
import { summarizeToolCall, summarizeToolResult } from "./tool-format.js";
import { mergePromptSegments, segmentUserText } from "./user-content.js";

export type ParseWarning = { line: number; reason: string };
export type ParseResult = { events: BatonEvent[]; warnings: ParseWarning[] };

type Draft = { kind: BatonEventKind; text: string; meta?: BatonEventMeta };
type CommonRecord = {
  uuid: string;
  sessionId: string;
  timestamp: string;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  version?: string | undefined;
};

const RecordType = z.looseObject({ type: z.string() });
const isHandled = (t: string): t is (typeof HANDLED_RECORD_TYPES)[number] =>
  (HANDLED_RECORD_TYPES as readonly string[]).includes(t);

/** Builds a meta object, leaving out undefined values. */
function meta(fields: Record<string, JsonValue | undefined>): BatonEventMeta {
  const out: BatonEventMeta = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Incremental transcript parser: feed it lines in file order, get events back.
 * Holds per-session state (seq counters, tool names) but does no I/O.
 * Never throws on bad input; problems come back as warnings.
 */
export function createTranscriptParser() {
  const sessions = new Map<string, { seq: number; projectPath: string }>();
  const toolNames = new Map<string, string>();
  let lineNo = 0;

  function userDrafts(r: UserRecord): Draft[] {
    const blocks: ContentBlock[] =
      typeof r.message.content === "string"
        ? [{ type: "text", text: r.message.content }]
        : r.message.content;
    const drafts: Draft[] = [];

    for (const block of blocks) {
      const text = TextBlock.safeParse(block);
      if (text.success) {
        if (r.isCompactSummary || r.isMeta) {
          const source = r.isCompactSummary ? "compact_summary" : "meta";
          if (text.data.text.trim())
            drafts.push({ kind: "system", text: text.data.text, meta: { source } });
          continue;
        }
        for (const s of mergePromptSegments(segmentUserText(text.data.text))) {
          if (s.label === "prompt") {
            drafts.push({ kind: "prompt", text: s.text, meta: { sources: s.sources } });
          } else {
            drafts.push({ kind: "system", text: s.text, meta: { source: s.source } });
          }
        }
        continue;
      }

      const result = ToolResultBlock.safeParse(block);
      if (result.success) {
        const { tool_use_id, content, is_error } = result.data;
        const s = summarizeToolResult(content);
        drafts.push({
          kind: "tool_result",
          text: s.summary,
          meta: meta({
            toolUseId: tool_use_id,
            toolName: toolNames.get(tool_use_id),
            isError: is_error ?? false,
            lines: s.lines,
            nonText: s.nonText || undefined,
            full: s.full,
          }),
        });
      }
      // Images and other non-text blocks are dropped.
    }
    return drafts;
  }

  function assistantDrafts(r: AssistantRecord): Draft[] {
    const model = r.message.model;
    const drafts: Draft[] = [];
    for (const block of r.message.content) {
      const text = TextBlock.safeParse(block);
      if (text.success) {
        if (text.data.text.trim())
          drafts.push({ kind: "reply", text: text.data.text, meta: meta({ model }) });
        continue;
      }
      const thinking = ThinkingBlock.safeParse(block);
      if (thinking.success) {
        // Empty thinking (signature only) is normal, especially on smaller models.
        const t = thinking.data.thinking ?? "";
        if (t.trim()) drafts.push({ kind: "thinking", text: t, meta: meta({ model }) });
        continue;
      }
      const tool = ToolUseBlock.safeParse(block);
      if (tool.success) {
        const { id, name, input } = tool.data;
        toolNames.set(id, name);
        drafts.push({
          kind: "tool_call",
          text: summarizeToolCall(name, input),
          meta: { toolName: name, toolUseId: id, input },
        });
      }
      // redacted_thinking and unknown blocks are dropped.
    }
    return drafts;
  }

  function systemDrafts(r: SystemRecord): Draft[] {
    if (!r.content?.trim()) return [];
    return [
      {
        kind: "system",
        text: r.content,
        meta: meta({ source: r.subtype ?? "system", level: r.level }),
      },
    ];
  }

  function emit(r: CommonRecord, drafts: Draft[]): BatonEvent[] {
    if (drafts.length === 0) return [];
    const events: BatonEvent[] = [];
    let session = sessions.get(r.sessionId);
    if (!session) {
      session = { seq: 0, projectPath: r.cwd ?? "" };
      sessions.set(r.sessionId, session);
      events.push({
        id: `${r.sessionId}:start`,
        sessionId: r.sessionId,
        projectPath: session.projectPath,
        ts: r.timestamp,
        seq: session.seq++,
        kind: "session_start",
        text: session.projectPath,
        meta: meta({ gitBranch: r.gitBranch, version: r.version }),
      });
    }
    if (r.cwd) session.projectPath = r.cwd;

    drafts.forEach((d, i) => {
      events.push({
        id: `${r.uuid}:${i}`,
        sessionId: r.sessionId,
        projectPath: session.projectPath,
        ts: r.timestamp,
        seq: session.seq++,
        kind: d.kind,
        text: d.text,
        ...(d.meta && Object.keys(d.meta).length > 0 ? { meta: d.meta } : {}),
      });
    });
    return events;
  }

  function parseLine(line: string): ParseResult {
    lineNo++;
    const none: ParseResult = { events: [], warnings: [] };
    if (line.trim() === "") return none;
    const warn = (reason: string): ParseResult => ({
      events: [],
      warnings: [{ line: lineNo, reason }],
    });

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return warn("invalid JSON");
    }
    const head = RecordType.safeParse(raw);
    if (!head.success) return warn("not a transcript record");
    const type = head.data.type;
    if (!isHandled(type)) return none;

    const parsed =
      type === "user"
        ? UserRecord.safeParse(raw)
        : type === "assistant"
          ? AssistantRecord.safeParse(raw)
          : SystemRecord.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return warn(
        `malformed ${type} record: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim(),
      );
    }

    const r = parsed.data;
    const drafts =
      r.type === "user"
        ? userDrafts(r)
        : r.type === "assistant"
          ? assistantDrafts(r)
          : systemDrafts(r);
    return { events: emit(r, drafts), warnings: [] };
  }

  return { parseLine };
}

/** Parses a whole transcript file's contents. */
export function parseTranscript(text: string): ParseResult {
  const parser = createTranscriptParser();
  const result: ParseResult = { events: [], warnings: [] };
  for (const line of text.split(/\r?\n/)) {
    const r = parser.parseLine(line);
    result.events.push(...r.events);
    result.warnings.push(...r.warnings);
  }
  return result;
}
