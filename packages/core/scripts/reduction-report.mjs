#!/usr/bin/env node
// Size-reduction report: raw transcript bytes vs. parser output bytes.
// Usage: node scripts/reduction-report.mjs [transcript.jsonl ...]
// With no arguments it measures every fixture in test/fixtures.
// Reads the built package (dist), so run `pnpm build` first; `pnpm report` does both.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { measureReduction } from "../dist/index.js";

const MIN_REDUCTION = 0.9;
const fixtureDir = join(import.meta.dirname, "..", "test", "fixtures");
const files = process.argv.slice(2);
if (files.length === 0) {
  for (const f of readdirSync(fixtureDir).sort()) {
    if (f.endsWith(".jsonl")) files.push(join(fixtureDir, f));
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (r) => `${(r * 100).toFixed(1)}%`;
const rows = files.map((file) => ({
  name: basename(file),
  ...measureReduction(readFileSync(file, "utf8")),
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
  ["transcript", "lines", "raw", "full view", "events", "handoff", "events", "reduction"],
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
