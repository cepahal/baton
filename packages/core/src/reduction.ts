import { parseSession } from "./agents/adapter.js";
import { compactForLLM } from "./compact.js";
import type { AgentId, BatonEvent } from "./event.js";
import { utf8Length } from "./transcript/truncate.js";

/** How much smaller the parsed views are than the transcript they came from. */
export type ReductionReport = {
  /** The size the reduction is measured against: `raw`'s UTF-8 bytes, or `originalBytes`. */
  rawBytes: number;
  rawLines: number;
  /** Full view (what teammates see), as JSONL. */
  fullEvents: number;
  fullBytes: number;
  /** compactForLLM output (the handoff), as JSONL. */
  compactEvents: number;
  compactBytes: number;
  /** 1 - compactBytes / rawBytes. */
  reduction: number;
  warnings: number;
};

const jsonlBytes = (events: BatonEvent[]): number =>
  events.reduce((n, e) => n + utf8Length(JSON.stringify(e)) + 1, 0);

export type ReductionOptions = {
  agent?: AgentId;
  /**
   * Byte size of the log before redaction, when `raw` is a redacted fixture.
   * Redaction cuts long strings and blobs, so the redacted text understates
   * what the agent really wrote. See "Size target" in docs/spec.md.
   */
  originalBytes?: number;
};

/** Parses a session log and measures both views against its raw UTF-8 size. */
export function measureReduction(raw: string, options: ReductionOptions = {}): ReductionReport {
  const { events, warnings } = parseSession(options.agent ?? "claude-code", raw);
  const compact = compactForLLM(events);
  const rawBytes = options.originalBytes ?? utf8Length(raw);
  const compactBytes = jsonlBytes(compact);
  return {
    rawBytes,
    rawLines: raw.split("\n").filter((l) => l.trim() !== "").length,
    fullEvents: events.length,
    fullBytes: jsonlBytes(events),
    compactEvents: compact.length,
    compactBytes,
    reduction: rawBytes === 0 ? 0 : 1 - compactBytes / rawBytes,
    warnings: warnings.length,
  };
}
