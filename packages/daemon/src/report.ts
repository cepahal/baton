import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { BATON_VERSION, INGEST_PROTOCOL_VERSION, maskSecrets } from "@baton/core";

/** Log lines bundled into an issue report. */
export const REPORT_LOG_LINES = 200;

/** Where bug reports go. */
export const ISSUES_URL = "https://github.com/cepahal/baton/issues/new?template=bug.md";

export type ReportInput = {
  /** Log file to take the last lines from; missing files are fine. */
  logFile: string;
  /** Secrets known to this process (the team token): removed wherever they appear. */
  secrets?: readonly string[];
  /** Extra facts for the report, e.g. `{ mode: "team", server: "ws://…" }`. */
  facts?: Record<string, string>;
  home?: string;
};

/**
 * Redacts a log line for sharing: known secrets, anything that looks like a
 * credential, and the home directory (which carries the OS username).
 */
export function redactLine(line: string, secrets: readonly string[], home: string): string {
  let out = line;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  out = maskSecrets(out);
  if (home.length > 1) {
    // Paths appear raw and JSON-escaped (Windows backslashes doubled).
    for (const h of new Set([home, home.replace(/\\/g, "\\\\"), home.replace(/\\/g, "/")])) {
      out = out.split(h).join("~");
    }
  }
  return out;
}

/** The text a teammate pastes into a bug report. */
export async function buildReport(input: ReportInput): Promise<string> {
  const home = input.home ?? homedir();
  const secrets = input.secrets ?? [];
  const raw = await readFile(input.logFile, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).filter((l) => l !== "");
  const tail = lines.slice(-REPORT_LOG_LINES).map((l) => redactLine(l, secrets, home));
  const facts: Record<string, string> = {
    baton: BATON_VERSION,
    protocol: String(INGEST_PROTOCOL_VERSION),
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    ...input.facts,
  };
  return [
    "## Environment",
    "",
    ...Object.entries(facts).map(([k, v]) => `- ${k}: ${redactLine(v, secrets, home)}`),
    "",
    `## Last ${tail.length} log lines (redacted)`,
    "",
    "```",
    ...tail,
    "```",
    "",
  ].join("\n");
}
