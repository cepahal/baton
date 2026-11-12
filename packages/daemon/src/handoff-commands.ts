import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffPrompt } from "@baton/core";
import { applyHandoffCode } from "./git-apply.js";
import { type GitExec, gitExec } from "./git-exec.js";
import { readHandoffMeta } from "./handoff-meta.js";

type Out = { write(text: string): void };

/** Runs a program in this terminal and resolves its exit code. */
export type RunInTerminal = (file: string, args: string[], cwd: string) => Promise<number>;

/**
 * `baton handoff apply <id>`, run by the receiver in the folder the handoff was
 * accepted into: puts `changes.patch` on a new branch `baton/handoff-<id>`.
 * Only ever run by hand; nothing on a server can start it.
 */
export async function runHandoffApply(
  input: { dir: string; id: string },
  out: Out,
  err: Out,
  git: GitExec = gitExec,
): Promise<number> {
  const found = await readHandoffMeta(input.dir, input.id);
  if (!found.ok) {
    err.write(`baton: ${found.error}\n`);
    return 1;
  }
  const { meta } = found;
  if (!meta.patch || meta.base === null) {
    err.write("baton: this handoff has no changes.patch to apply.\n");
    return 1;
  }
  let patch: string;
  try {
    patch = await readFile(join(found.dir, "changes.patch"), "utf8");
  } catch {
    err.write(`baton: ${join(found.dir, "changes.patch")} is missing.\n`);
    return 1;
  }
  const result = await applyHandoffCode(
    { checkout: input.dir, id: meta.id, base: meta.base, patch },
    git,
  );
  if (!result.ok) {
    err.write(`baton: could not apply the handoff's changes: ${result.reason}\n`);
    return 1;
  }
  out.write(`Applied ${meta.sender}'s changes on a new branch ${result.branch}.\n`);
  if (result.conflicts.length > 0) {
    out.write(
      `These files have conflicts to resolve:\n${result.conflicts.map((f) => `  ${f}\n`).join("")}`,
    );
    out.write("`git switch -` returns to your previous branch.\n");
  }
  return result.conflicts.length > 0 ? 3 : 0;
}

/**
 * `baton handoff start <id>`: starts the receiving agent in this terminal with
 * the handoff's prompt. A convenience for typing `claude "<prompt>"` yourself.
 */
export async function runHandoffStart(
  input: { dir: string; id: string },
  err: Out,
  run: RunInTerminal = runInTerminal,
): Promise<number> {
  const found = await readHandoffMeta(input.dir, input.id);
  if (!found.ok) {
    err.write(`baton: ${found.error}\n`);
    return 1;
  }
  const { meta } = found;
  const program = meta.agent === "codex" ? "codex" : meta.agent === "cursor" ? "agent" : "claude";
  try {
    return await run(program, [handoffPrompt(meta.id, meta.patch)], input.dir);
  } catch (e) {
    err.write(`baton: could not start ${program}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const runInTerminal: RunInTerminal = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    // npm installs `claude` and `codex` as .cmd shims on Windows, which only a shell runs.
    // The prompt is fixed text plus a validated id, so quoting it is enough.
    const windows = process.platform === "win32";
    const child = spawn(file, windows ? args.map((a) => `"${a}"`) : args, {
      cwd,
      stdio: "inherit",
      shell: windows,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
