import { describe, expect, it } from "vitest";
import {
  type BatonEvent,
  compactForLLM,
  measureReduction,
  oneLine,
  parseTranscript,
} from "../src/index.js";
import { FIXTURES, readFixture } from "./helpers.js";

/** One line per event: seq, kind, label, and the start of its text. */
const digest = (events: BatonEvent[]) =>
  events
    .map((e) => {
      const label = e.meta?.source ?? e.meta?.sources ?? e.meta?.toolName ?? "";
      return `${e.seq}\t${e.kind}\t${Array.isArray(label) ? label.join("+") : label}\t${oneLine(e.text, 160)}`;
    })
    .join("\n");

const jsonl = (events: BatonEvent[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe.each(FIXTURES)("fixture %s", (name) => {
  const raw = readFixture(name);
  const { events } = parseTranscript(raw);

  it("matches the full-view snapshot", async () => {
    await expect(`${digest(events)}\n`).toMatchFileSnapshot(`__snapshots__/${name}.events.tsv`);
  });

  it("matches the handoff snapshot", async () => {
    await expect(jsonl(compactForLLM(events))).toMatchFileSnapshot(
      `__snapshots__/${name}.compact.jsonl`,
    );
  });

  it("shrinks the handoff by more than 90% vs. raw bytes", () => {
    const r = measureReduction(raw);
    expect(r.warnings).toBe(0);
    expect(r.reduction).toBeGreaterThan(0.9);
    expect(r.fullBytes).toBeGreaterThan(r.compactBytes);
  });
});

describe("measureReduction", () => {
  it("handles empty input", () => {
    expect(measureReduction("")).toMatchObject({
      rawBytes: 0,
      fullEvents: 0,
      compactBytes: 0,
      reduction: 0,
    });
  });
});
