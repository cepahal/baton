import { z } from "zod";
import type { BatonEvent, BatonEventKind, BatonEventMeta, JsonValue } from "../event.js";
import {
  AssistantRecord,
  type ContentBlock,
  HANDLED_RECORD_TYPES,
  IGNORED_RECORD_TYPES,
  SystemRecord,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserRecord,
} from "./records.js";
import {
  isOneLiner,
  summarizeText,
  summarizeToolCall,
  summarizeToolResult,
  type ToolCallInfo,
} from "./tool-format.js";
import { mergePromptSegments, segmentUserText } from "./user-content.js";

export type ParseWarning = { line: number; reason: string };
export type ParseResult = { events: BatonEvent[]; warnings: ParseWarning[] };

export type ParserOptions = {
  /** Lines that look broken: invalid JSON, or a handled record that fails its schema. */
  onWarning?: (warning: ParseWarning) => void;
  /** Debug mode: called with a message for every record of an unknown type. */
  debug?: (message: string) => void;
};

type Draft = { kind: BatonEventKind; text: string; meta?: BatonEventMeta };
type CommonRecord = {
  uuid: string;
  sessionId: string;
  timestamp: string;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  version?: string | undefined;
  isSidechain?: boolean | undefined;
  agentId?: string | undefined;
};

const RecordType = z.looseObject({ type: z.string() });
const isHandled = (t: string): t is (typeof HANDLED_RECORD_TYPES)[number] =>
  (HANDLED_RECORD_TYPES as readonly string[]).includes(t);
const isIgnored = (t: string): boolean => (IGNORED_RECORD_TYPES as readonly string[]).includes(t);

/** Builds a meta object, leaving out undefined values. */
function meta(fields: Record<string, JsonValue | undefined>): BatonEventMeta {
  const out: BatonEventMeta = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * A system event: one-liners as is; anything longer gets a one-line recap in
 * `text` and the original in `meta.full`.
 */
function systemDraft(text: string, fields: Record<string, JsonValue | undefined>): Draft {
  const t = text.trim();
  if (isOneLiner(t)) return { kind: "system", text: t, meta: meta(fields) };
  return { kind: "system", text: summarizeText(t), meta: meta({ ...fields, full: t }) };
}

/**
 * Incremental transcript parser: feed it lines in file order, get events back.
 * Holds per-session state (seq counters, tool calls) but does no I/O.
 * Never throws on bad input: a line it can't use yields no events.
 */
export function createTranscriptParser(options: ParserOptions = {}) {
  const sessions = new Map<string, { seq: number; projectPath: string }>();
  const toolCalls = new Map<string, ToolCallInfo>();
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
          if (text.data.text.trim()) drafts.push(systemDraft(text.data.text, { source }));
          continue;
        }
        for (const s of mergePromptSegments(segmentUserText(text.data.text))) {
          if (s.label === "prompt") {
            drafts.push({ kind: "prompt", text: s.text, meta: { sources: s.sources } });
          } else {
            drafts.push(systemDraft(s.text, { source: s.source }));
          }
        }
        continue;
      }

      const result = ToolResultBlock.safeParse(block);
      if (result.success) {
        const { tool_use_id, content, is_error } = result.data;
        const call = toolCalls.get(tool_use_id);
        const s = summarizeToolResult(content, { call, isError: is_error, cwd: r.cwd });
        drafts.push({
          kind: "tool_result",
          text: s.summary,
          meta: meta({
            toolUseId: tool_use_id,
            toolName: call?.name,
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
        toolCalls.set(id, { name, input });
        drafts.push({
          kind: "tool_call",
          text: summarizeToolCall(name, input, r.cwd),
          meta: { toolName: name, toolUseId: id, input },
        });
      }
      // redacted_thinking and unknown blocks are dropped.
    }
    return drafts;
  }

  function systemDrafts(r: SystemRecord): Draft[] {
    if (!r.content?.trim()) return [];
    return [systemDraft(r.content, { source: r.subtype ?? "system", level: r.level })];
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

    // Subagent work: viewers fold it under the Agent/Task call that started it.
    const sidechain = r.isSidechain ? meta({ sidechain: true, agentId: r.agentId }) : {};
    drafts.forEach((d, i) => {
      const m = { ...d.meta, ...sidechain };
      events.push({
        id: `${r.uuid}:${i}`,
        sessionId: r.sessionId,
        projectPath: session.projectPath,
        ts: r.timestamp,
        seq: session.seq++,
        kind: d.kind,
        text: d.text,
        ...(Object.keys(m).length > 0 ? { meta: m } : {}),
      });
    });
    return events;
  }

  /** One JSONL line in, zero or more events out. */
  function parseLine(line: string): BatonEvent[] {
    lineNo++;
    if (line.trim() === "") return [];
    const warn = (reason: string): BatonEvent[] => {
      options.onWarning?.({ line: lineNo, reason });
      return [];
    };

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return warn("invalid JSON");
    }
    const head = RecordType.safeParse(raw);
    if (!head.success) return warn("not a transcript record");
    const type = head.data.type;
    if (!isHandled(type)) {
      if (!isIgnored(type))
        options.debug?.(`line ${lineNo}: dropped unknown record type "${type}"`);
      return [];
    }

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
    return emit(r, drafts);
  }

  return { parseLine };
}

/** Parses a whole transcript file's contents, collecting warnings. */
export function parseTranscript(
  text: string,
  options: Pick<ParserOptions, "debug"> = {},
): ParseResult {
  const warnings: ParseWarning[] = [];
  const parser = createTranscriptParser({ ...options, onWarning: (w) => warnings.push(w) });
  const events: BatonEvent[] = [];
  for (const line of text.split(/\r?\n/)) events.push(...parser.parseLine(line));
  return { events, warnings };
}
