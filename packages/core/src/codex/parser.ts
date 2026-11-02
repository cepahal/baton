import type { z } from "zod";
import { type Draft, eventsFromDrafts, meta, type SessionState, systemDraft } from "../draft.js";
import type { BatonEvent, JsonValue } from "../event.js";
import type { ParserOptions } from "../transcript/parser.js";
import {
  AgentMessageItem,
  CommandExecutionItem,
  ContextCompactionItem,
  EventMsg,
  FileChangeItem,
  HANDLED_ROLLOUT_TYPES,
  IGNORED_ITEM_TYPES,
  IGNORED_ROLLOUT_TYPES,
  ImageViewItem,
  ItemCompleted,
  McpToolCallItem,
  ReasoningItem,
  ResponseMessage,
  RolloutLine,
  SessionMeta,
  TurnContext,
  UserMessageItem,
} from "./records.js";
import { mcpDrafts, patchDrafts, shellDrafts, viewImageDrafts } from "./tool-format.js";

const isHandled = (t: string): boolean => (HANDLED_ROLLOUT_TYPES as readonly string[]).includes(t);
const isIgnored = (t: string): boolean => (IGNORED_ROLLOUT_TYPES as readonly string[]).includes(t);
const isIgnoredItem = (t: string): boolean => (IGNORED_ITEM_TYPES as readonly string[]).includes(t);

/** A text part that is one whole tagged element, e.g. `<environment_context>…</environment_context>`. */
const TAGGED_RE = /^\s*<([A-Za-z_][\w-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>\s*$/;

/** `{ subagent: X }` → X, for `session_start.meta.subagent`. */
function subagentOf(source: JsonValue | undefined): JsonValue | undefined {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
  return source.subagent;
}

const issueText = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim();
};

/**
 * Incremental Codex rollout parser: feed it a thread's rollout lines in order
 * (every segment of the thread, oldest first), get events back. Holds the
 * thread's state (seq, cwd, model) but does no I/O, and never throws.
 * Mapping rules: "Codex adapter" in docs/spec.md.
 */
export function createCodexParser(options: ParserOptions = {}) {
  let sessionId: string | undefined;
  const session: SessionState = { seq: 0, projectPath: "" };
  let model: string | undefined;
  let lineNo = 0;
  /** Set once a segment rewinds the thread; qualifies ordinal-based ids. */
  let branch: string | undefined;

  function itemDrafts(item: { type: string; id: string }, raw: unknown): Draft[] | string {
    const bad = (e: z.ZodError) => `malformed ${item.type} item: ${issueText(e)}`;
    switch (item.type) {
      case "UserMessage": {
        const p = UserMessageItem.safeParse(raw);
        if (!p.success) return bad(p.error);
        const text = p.data.content
          .filter((c) => c.type === "text" && c.text !== undefined)
          .map((c) => c.text)
          .join("\n")
          .trim();
        return text ? [{ kind: "prompt", text, meta: { sources: ["typed"] } }] : [];
      }
      case "AgentMessage": {
        const p = AgentMessageItem.safeParse(raw);
        if (!p.success) return bad(p.error);
        return p.data.content
          .filter((c) => c.type.toLowerCase() === "text" && c.text?.trim())
          .map((c) => ({
            kind: "reply",
            text: c.text ?? "",
            meta: meta({ model, phase: p.data.phase }),
          }));
      }
      case "Reasoning": {
        const p = ReasoningItem.safeParse(raw);
        if (!p.success) return bad(p.error);
        const text = [...p.data.summary_text, ...p.data.raw_content]
          .filter((t) => t.trim() !== "")
          .join("\n\n");
        return text ? [{ kind: "thinking", text, meta: meta({ model }) }] : [];
      }
      case "CommandExecution": {
        const p = CommandExecutionItem.safeParse(raw);
        return p.success ? shellDrafts(p.data) : bad(p.error);
      }
      case "FileChange": {
        const p = FileChangeItem.safeParse(raw);
        return p.success ? patchDrafts(p.data, session.projectPath) : bad(p.error);
      }
      case "McpToolCall": {
        const p = McpToolCallItem.safeParse(raw);
        return p.success ? mcpDrafts(p.data) : bad(p.error);
      }
      case "ImageView": {
        const p = ImageViewItem.safeParse(raw);
        return p.success
          ? viewImageDrafts(p.data.id, p.data.path, session.projectPath)
          : bad(p.error);
      }
      case "ContextCompaction": {
        const p = ContextCompactionItem.safeParse(raw);
        if (!p.success) return bad(p.error);
        return [systemDraft("Conversation compacted", { source: "compaction" })];
      }
      default:
        if (!isIgnoredItem(item.type))
          options.debug?.(`line ${lineNo}: dropped unknown item type "${item.type}"`);
        return [];
    }
  }

  /** Injected user-role context (`<environment_context>`, …) as system events. */
  function injectedContext(payload: unknown): Draft[] {
    const p = ResponseMessage.safeParse(payload);
    if (!p.success || p.data.role !== "user") return [];
    const drafts: Draft[] = [];
    for (const part of p.data.content) {
      const m = part.text === undefined ? null : TAGGED_RE.exec(part.text);
      const tag = m?.[1];
      const inner = m?.[2]?.trim();
      if (!tag || tag === "image" || !inner) continue;
      drafts.push(systemDraft(inner, { source: tag }));
    }
    return drafts;
  }

  /** Id prefix for records that have no item id of their own. */
  function ordinalId(ordinal: number | undefined): string {
    const at = ordinal ?? `line${lineNo}`;
    return `${sessionId ?? ""}:${branch === undefined ? "" : `${branch}:`}${at}`;
  }

  /** One rollout line in, zero or more events out. */
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
    const parsed = RolloutLine.safeParse(raw);
    if (!parsed.success) return warn("not a rollout record");
    const { type, timestamp: ts, ordinal, payload } = parsed.data;
    if (!isHandled(type)) {
      if (!isIgnored(type))
        options.debug?.(`line ${lineNo}: dropped unknown record type "${type}"`);
      return [];
    }

    if (type === "session_meta") {
      const m = SessionMeta.safeParse(payload);
      if (!m.success) return warn(`malformed session_meta record: ${issueText(m.error)}`);
      if (m.data.cwd) session.projectPath = m.data.cwd;
      // A segment file continues the thread from record N, so records after it
      // reuse ordinals the abandoned branch already used: qualify their ids.
      const base = m.data.history_base?.end_ordinal_exclusive;
      if (base !== undefined) branch = `b${base}`;
      // A segment repeats the thread's session_meta: same session.
      if (sessionId !== undefined || ts === undefined) {
        sessionId ??= m.data.id;
        if (base === undefined || ts === undefined) return [];
        return eventsFromDrafts("codex", sessionId, session, ts, ordinalId(ordinal), [
          systemDraft(`Conversation rewound to record ${base}; continuing from there`, {
            source: "rewind",
          }),
        ]);
      }
      sessionId = m.data.id;
      const parent = m.data.session_id;
      return [
        {
          id: `${sessionId}:start`,
          agent: "codex",
          sessionId,
          projectPath: session.projectPath,
          ts,
          seq: session.seq++,
          kind: "session_start",
          text: session.projectPath,
          meta: meta({
            version: m.data.cli_version,
            gitBranch: m.data.git?.branch,
            originator: m.data.originator,
            subagent: subagentOf(m.data.source),
            parentSessionId: parent !== undefined && parent !== sessionId ? parent : undefined,
          }),
        },
      ];
    }

    if (type === "turn_context") {
      const c = TurnContext.safeParse(payload);
      if (!c.success) return warn(`malformed turn_context record: ${issueText(c.error)}`);
      if (c.data.cwd) session.projectPath = c.data.cwd;
      if (c.data.model) model = c.data.model;
      return [];
    }

    // Every other handled record belongs to a session; before session_meta, or
    // without a timestamp, there's nothing to attach it to.
    if (sessionId === undefined || ts === undefined) return [];
    const recordId = ordinalId(ordinal);
    const emit = (id: string, drafts: Draft[]) =>
      eventsFromDrafts("codex", sessionId ?? "", session, ts, id, drafts);

    if (type === "response_item") return emit(recordId, injectedContext(payload));

    const msg = EventMsg.safeParse(payload);
    if (!msg.success) return warn(`malformed event_msg record: ${issueText(msg.error)}`);
    if (msg.data.type === "turn_aborted") {
      return emit(recordId, [systemDraft("Turn interrupted", { source: "interrupt" })]);
    }
    if (msg.data.type !== "item_completed") return [];

    const done = ItemCompleted.safeParse(payload);
    if (!done.success) return warn(`malformed item_completed record: ${issueText(done.error)}`);
    const drafts = itemDrafts(done.data.item, done.data.item);
    if (typeof drafts === "string") return warn(drafts);
    return emit(done.data.item.id, drafts);
  }

  return { parseLine };
}
