import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_ID_PATTERN, patchPaths } from "@baton/core";
import { type GitExec, gitExec } from "./git-exec.js";

export type ApplyResult =
  | { ok: true; branch: string; conflicts: string[] }
  | { ok: false; reason: string };

/** The branch a handoff's code goes on. */
export const handoffBranch = (id: string) => `baton/handoff-${id}`;

/**
 * Puts a handoff's patch on a new branch `baton/handoff-<id>` made from the
 * checkout's current HEAD (the base commit must exist locally, for the 3-way merge), with `git apply --3way`. Refuses, changing nothing,
 * when the working tree is dirty, the branch exists, the base commit is
 * missing, or the patch reaches outside the repo or into `.git`. On conflicts
 * the branch stays checked out with conflict markers; the tree was clean
 * before, so `git switch -` gets the user back.
 */
export async function applyHandoffCode(
  input: { checkout: string; id: string; base: string; patch: string },
  git: GitExec = gitExec,
): Promise<ApplyResult> {
  const { checkout, id, base, patch } = input;
  if (!HANDOFF_ID_PATTERN.test(id)) return { ok: false, reason: "invalid handoff id" };
  if (!/^[0-9a-f]{40,64}$/.test(base)) return { ok: false, reason: "invalid base commit" };
  const paths = patchPaths(patch);
  if ("error" in paths) return { ok: false, reason: paths.error };

  const root = (await git(checkout, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!root) return { ok: false, reason: `${checkout} is not a git checkout` };
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return { ok: false, reason: "git status failed" };
  if (status.stdout.trim() !== "") {
    return {
      ok: false,
      reason: "the working tree has uncommitted changes; commit or stash them first",
    };
  }
  if ((await git(root, ["cat-file", "-e", `${base}^{commit}`])).code !== 0) {
    return {
      ok: false,
      reason: `base commit ${base.slice(0, 7)} not found — fetch, then try again`,
    };
  }
  const branch = handoffBranch(id);
  if ((await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
    return { ok: false, reason: `branch ${branch} already exists` };
  }
  const switched = await git(root, ["switch", "-q", "-c", branch]);
  if (switched.code !== 0) return { ok: false, reason: `could not create ${branch}` };

  const tmp = await mkdtemp(join(tmpdir(), "baton-patch-"));
  try {
    const file = join(tmp, `${id}.patch`);
    await writeFile(file, patch);
    const applied = await git(root, ["apply", "--3way", "--index", "--whitespace=nowarn", file]);
    if (applied.code === 0) return { ok: true, branch, conflicts: [] };
    const unmerged = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = unmerged.stdout.split(/\r?\n/).filter((l) => l !== "");
    if (conflicts.length > 0) return { ok: true, branch, conflicts };
    // Nothing applied: undo the branch. The tree was clean, so this loses nothing.
    await git(root, ["reset", "-q", "--hard", "HEAD"]);
    await git(root, ["switch", "-q", "-"]);
    await git(root, ["branch", "-q", "-D", branch]);
    return {
      ok: false,
      reason: `the patch does not apply: ${applied.stderr.trim().split("\n")[0] ?? ""}`,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
