import type { AgentId, BatonEvent, BatonEventKind, BatonEventMeta, JsonValue } from "./event.js";
import { isOneLiner, summarizeText } from "./transcript/tool-format.js";

/** An event before the session fields (id, seq, ts, …) are filled in. */
export type Draft = { kind: BatonEventKind; text: string; meta?: BatonEventMeta };

/** Builds a meta object, leaving out undefined values. */
export function meta(fields: Record<string, JsonValue | undefined>): BatonEventMeta {
  const out: BatonEventMeta = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * A system event: one-liners as is; anything longer gets a one-line recap in
 * `text` and the original in `meta.full`.
 */
export function systemDraft(text: string, fields: Record<string, JsonValue | undefined>): Draft {
  const t = text.trim();
  if (isOneLiner(t)) return { kind: "system", text: t, meta: meta(fields) };
  return { kind: "system", text: summarizeText(t), meta: meta({ ...fields, full: t }) };
}

/** Per-session state every adapter keeps: the next seq and the current cwd. */
export type SessionState = { seq: number; projectPath: string };

/**
 * Turns one record's drafts into events with ids `<recordId>:<n>`, advancing
 * the session's seq. `extraMeta` is merged into every event's meta.
 */
export function eventsFromDrafts(
  agent: AgentId,
  sessionId: string,
  session: SessionState,
  ts: string,
  recordId: string,
  drafts: Draft[],
  extraMeta: BatonEventMeta = {},
): BatonEvent[] {
  return drafts.map((d, i) => {
    const m = { ...d.meta, ...extraMeta };
    return {
      id: `${recordId}:${i}`,
      agent,
      sessionId,
      projectPath: session.projectPath,
      ts,
      seq: session.seq++,
      kind: d.kind,
      text: d.text,
      ...(Object.keys(m).length > 0 ? { meta: m } : {}),
    };
  });
}
