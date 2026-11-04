import { mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Level, type LevelWithSilent, type Logger, multistream, pino } from "pino";

/** A log file past this is rotated to `.1` when Baton starts. */
const ROTATE_BYTES = 5 * 1024 * 1024;

/** Fields that never reach a log, whatever logs them. */
const REDACT = [
  "token",
  "*.token",
  "*.*.token",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "headers.cookie",
  "*.headers.cookie",
];

/** `daemon.log` / `server.log` in the state dir's `logs/`. */
export const logFilePath = (stateDir: string, kind: "daemon" | "server"): string =>
  join(stateDir, "logs", `${kind}.log`);

/**
 * The process logger: stdout as before, plus a file the "Report issue" page
 * and `baton report` read from. Tokens and auth headers are redacted at the
 * source. Without a file (tests, `replay`), stdout only.
 */
export function createLogger(level: LevelWithSilent, file?: string): Logger {
  const options = { level, redact: { paths: REDACT, censor: "[redacted]" } };
  if (file === undefined || level === "silent") return pino(options);
  const streamLevel: Level = level;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > ROTATE_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    return pino(options);
  }
  return pino(
    options,
    multistream([
      { level: streamLevel, stream: process.stdout },
      // Synchronous, so the last lines before a `process.exit` (a refusal, a
      // crash) reach the file the report reads. Baton logs little.
      { level: streamLevel, stream: pino.destination({ dest: file, mkdir: true, sync: true }) },
    ]),
  );
}
