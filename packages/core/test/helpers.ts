import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Synthetic transcript records for unit tests. */

export const SESSION = "00000000-0000-4000-8000-000000000001";
export const CWD = "/home/dev/proj";

let n = 0;
export const base = () => ({
  uuid: `u${++n}`,
  sessionId: SESSION,
  timestamp: "2026-11-01T12:00:00.000Z",
  cwd: CWD,
  gitBranch: "main",
  version: "2.1.300",
});

export const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ ...base(), type: "user", message: { role: "user", content }, ...extra });

export const assistant = (content: unknown[]) =>
  JSON.stringify({
    ...base(),
    type: "assistant",
    message: { role: "assistant", model: "claude-x", content },
  });

export const toolUse = (id: string, name: string, input: object) =>
  assistant([{ type: "tool_use", id, name, input }]);

export const toolResult = (id: string, content: unknown, isError = false) =>
  user([{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);

export const jsonl = (...lines: string[]) => lines.join("\n");

/** The redacted real transcripts in test/fixtures. */
export const FIXTURES = [
  "heavy-tools",
  "api-requests",
  "mixed",
  "code-review",
  "install-debug",
  "long-build",
] as const;

export const fixturePath = (name: string) => join(import.meta.dirname, "fixtures", `${name}.jsonl`);
export const readFixture = (name: string) => readFileSync(fixturePath(name), "utf8");

/** The redacted Codex sessions in test/fixtures/codex (see its README). */
export const CODEX_FIXTURES = ["speech-tool", "forked-frontend"] as const;

export const codexRolloutPath = (name: string) =>
  join(import.meta.dirname, "fixtures", "codex", `${name}.rollout.jsonl`);
export const readCodexRollout = (name: string) => readFileSync(codexRolloutPath(name), "utf8");
export const readCodexThreadItems = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures", "codex", `${name}.thread-items.jsonl`),
    "utf8",
  );

/** Pre-redaction byte size of each Codex fixture (see the fixtures README). */
export const codexOriginalBytes = (name: string): number => {
  const sizes = z
    .record(z.string(), z.number().int().positive())
    .parse(
      JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "codex", "raw-bytes.json"), "utf8"),
      ),
    );
  const n = sizes[name];
  if (n === undefined) throw new Error(`no raw-bytes.json entry for ${name}`);
  return n;
};
