import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_PATCH_MAX, isSecretPath, redactPatch, type SkippedFile } from "@baton/core";
import { type GitExec, gitExec } from "./git-exec.js";
import type { CodeReply } from "./handoff-route.js";

/** Files bigger than this stay out of a bundle. */
export const BUNDLE_FILE_MAX = 1024 * 1024;

/** A checkout's uncommitted changes as a patch against `base`. */
export type CodeBundle = {
  base: string;
  branch: string | null;
  patch: string;
  files: string[];
  skipped: SkippedFile[];
  redacted: string[];
};

export type BundleResult = { ok: true; bundle: CodeBundle } | { ok: false; reason: string };

/**
 * A patch of `dir`'s working tree against HEAD: tracked changes plus untracked
 * files, without ignored files, secret-looking files, or files over 1 MB.
 * Built in a temporary index so the user's staging area is never touched.
 */
export async function buildCodeBundle(dir: string, git: GitExec = gitExec): Promise<BundleResult> {
  const root = (await git(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!root) return { ok: false, reason: "not a git checkout" };
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  const base = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(base)) {
    return { ok: false, reason: "the checkout has no commits yet" };
  }
  const branchOut = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() || null : null;

  const tmp = await mkdtemp(join(tmpdir(), "baton-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    if ((await git(root, ["read-tree", "HEAD"], { env })).code !== 0) {
      return { ok: false, reason: "could not read HEAD" };
    }
    // A fresh index has no stat data; without a refresh every file looks modified.
    await git(root, ["update-index", "-q", "--refresh"], { env });
    // Changed and untracked files, ignored ones excluded by git itself.
    const listed = await git(
      root,
      ["ls-files", "-z", "--modified", "--others", "--deleted", "--exclude-standard"],
      { env },
    );
    const candidates = [...new Set(listed.stdout.split("\0").filter((p) => p !== ""))];
    const skipped: SkippedFile[] = [];
    const include: string[] = [];
    for (const path of candidates) {
      if (isSecretPath(path)) {
        skipped.push({ path, reason: "looks like a secret" });
        continue;
      }
      const size = await fileSize(join(root, path));
      if (size !== undefined && size > BUNDLE_FILE_MAX) {
        skipped.push({ path, reason: `over ${BUNDLE_FILE_MAX / 1024 / 1024} MB` });
        continue;
      }
      include.push(path);
    }
    if (include.length === 0) {
      return { ok: false, reason: "no uncommitted changes to share" };
    }
    // `--` and literal pathspecs: names are data, never options or globs.
    const added = await git(root, ["--literal-pathspecs", "add", "-A", "--", ...include], { env });
    if (added.code !== 0)
      return { ok: false, reason: `git add failed: ${firstLine(added.stderr)}` };
    const diff = await git(
      root,
      ["diff", "--binary", "--cached", "--no-color", "--no-ext-diff", base],
      {
        env,
      },
    );
    if (diff.code !== 0) return { ok: false, reason: `git diff failed: ${firstLine(diff.stderr)}` };
    const { patch, redacted } = redactPatch(diff.stdout);
    if (Buffer.byteLength(patch) > HANDOFF_PATCH_MAX) {
      return {
        ok: false,
        reason: `the changes are over ${HANDOFF_PATCH_MAX / 1024 / 1024} MB; commit or trim them first`,
      };
    }
    const files = [...patch.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1] ?? "");
    return { ok: true, bundle: { base, branch, patch, files, skipped, redacted } };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined; // deleted: git records the deletion
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** A session's changes as the answer to "attach my code": a summary and the patch. */
export async function codeReply(
  dir: string | undefined,
  git: GitExec = gitExec,
): Promise<CodeReply> {
  if (dir === undefined) {
    return {
      code: { state: "unavailable", reason: "This machine doesn't know that session's folder." },
    };
  }
  const result = await buildCodeBundle(dir, git);
  if (!result.ok) return { code: { state: "unavailable", reason: result.reason } };
  const { patch, ...rest } = result.bundle;
  const bytes = Buffer.from(patch, "utf8");
  return { code: { state: "attached", ...rest, bytes: bytes.length }, patch: bytes };
}
