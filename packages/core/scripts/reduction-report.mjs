#!/usr/bin/env node
// Size-reduction report: raw transcript bytes vs. parser output bytes.
// Usage: node scripts/reduction-report.mjs [session-log.jsonl ...]
// With no arguments it measures every fixture in test/fixtures (Claude Code)
// and test/fixtures/codex (Codex rollouts). The agent is picked from the file name.
// Reads the built package (dist), so run `pnpm build` first; `pnpm report` does both.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { detectAgent, measureReduction } from "../dist/index.js";

const MIN_REDUCTION = 0.9;
const fixtureDir = join(import.meta.dirname, "..", "test", "fixtures");
const files = process.argv.slice(2);
if (files.length === 0) {
  for (const f of readdirSync(fixtureDir).sort()) {
    if (f.endsWith(".jsonl")) files.push(join(fixtureDir, f));
  }
  const codexDir = join(fixtureDir, "codex");
  for (const f of readdirSync(codexDir).sort()) {
    if (f.endsWith(".rollout.jsonl")) files.push(join(codexDir, f));
  }
}

/** Codex fixtures are named `<name>.rollout.jsonl`, not `rollout-….jsonl`. */
/** Pre-redaction sizes of the Codex fixtures, which the reduction is measured against. */
const codexRawBytes = JSON.parse(readFileSync(join(fixtureDir, "codex", "raw-bytes.json"), "utf8"));
const originalBytes = (file) => codexRawBytes[basename(file, ".rollout.jsonl")];

const agentOf = (file) =>
  file.endsWith(".rollout.jsonl") ? "codex" : (detectAgent(file) ?? "claude-code");

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (r) => `${(r * 100).toFixed(1)}%`;
const rows = files.map((file) => ({
  name: basename(file),
  ...measureReduction(readFileSync(file, "utf8"), {
    agent: agentOf(file),
    originalBytes: originalBytes(file),
  }),
}));
const total = rows.reduce(
  (t, r) => ({
    rawBytes: t.rawBytes + r.rawBytes,
    fullBytes: t.fullBytes + r.fullBytes,
    compactBytes: t.compactBytes + r.compactBytes,
  }),
  { rawBytes: 0, fullBytes: 0, compactBytes: 0 },
);

const table = [
  ["session log", "lines", "raw", "full view", "events", "handoff", "events", "reduction"],
  ...rows.map((r) => [
    r.name,
    r.rawLines,
    kb(r.rawBytes),
    kb(r.fullBytes),
    r.fullEvents,
    kb(r.compactBytes),
    r.compactEvents,
    pct(r.reduction),
  ]),
  [
    "total",
    "",
    kb(total.rawBytes),
    kb(total.fullBytes),
    "",
    kb(total.compactBytes),
    "",
    pct(1 - total.compactBytes / total.rawBytes),
  ],
].map((row) => row.map(String));
const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
const line = (row) =>
  row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(line(table[0]));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of table.slice(1)) console.log(line(row));

console.log("\nreduction = 1 - handoff bytes / raw bytes (UTF-8, events as JSONL)");
const failing = rows.filter((r) => r.reduction <= MIN_REDUCTION || r.warnings > 0);
for (const r of failing) {
  console.error(
    `FAIL ${r.name}: ${pct(r.reduction)} reduction, ${r.warnings} warnings (need >${pct(MIN_REDUCTION)}, 0 warnings)`,
  );
}
process.exitCode = failing.length > 0 ? 1 : 0;
