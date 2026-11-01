import { compactForLLM } from "./compact.js";
import type { BatonEvent } from "./event.js";
import { parseTranscript } from "./transcript/parser.js";
import { utf8Length } from "./transcript/truncate.js";

/** How much smaller the parsed views are than the transcript they came from. */
export type ReductionReport = {
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

/** Parses a transcript and measures both views against its raw UTF-8 size. */
export function measureReduction(raw: string): ReductionReport {
  const { events, warnings } = parseTranscript(raw);
  const compact = compactForLLM(events);
  const rawBytes = utf8Length(raw);
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
