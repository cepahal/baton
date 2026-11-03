import { execFile } from "node:child_process";
import { normalizeRemoteUrl, type RepoInfo, repoRelativePath } from "@baton/core";

/** Runs `git <args>` in `cwd`; resolves stdout, or undefined if git fails. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string | undefined>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", [...args], { cwd, timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });

export const NOT_A_REPO: RepoInfo = { repoId: null, branch: null, relativeCwd: null };

/** Looks up a directory's git identity: remote-derived repoId (or root commit), branch, relative cwd. */
export async function lookupRepo(dir: string, run: GitRunner = runGit): Promise<RepoInfo> {
  const git: GitRunner = async (cwd, args) => (await run(cwd, args))?.trim();
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) return NOT_A_REPO;
  const [branch, remotes, roots] = await Promise.all([
    git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(dir, ["remote"]),
    git(dir, ["rev-list", "--max-parents=0", "HEAD"]),
  ]);
  let repoId: string | null = null;
  const names = (remotes ?? "").split(/\r?\n/).filter((r) => r !== "");
  const remote = names.includes("origin") ? "origin" : names[0];
  if (remote !== undefined) {
    const url = await git(dir, ["remote", "get-url", remote]);
    repoId = url ? normalizeRemoteUrl(url) : null;
  }
  if (repoId === null) {
    // No usable remote: the oldest root commit (sorted, for repos with several roots).
    repoId =
      (roots ?? "")
        .split(/\r?\n/)
        .filter((r) => /^[0-9a-f]{7,64}$/.test(r))
        .sort()[0] ?? null;
  }
  return { repoId, branch: branch || null, relativeCwd: repoRelativePath(root, dir) };
}

export type RepoResolverOptions = {
  git?: GitRunner;
  /** Branches move; a cached lookup older than this is refreshed. Default 60 s. */
  ttlMs?: number;
  now?: () => number;
};

/** `lookupRepo`, cached per directory; concurrent lookups of one directory share a git run. */
export class RepoResolver {
  readonly #cache = new Map<string, { at: number; info: Promise<RepoInfo>; settled?: RepoInfo }>();
  readonly #git: GitRunner;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: RepoResolverOptions = {}) {
    this.#git = options.git ?? runGit;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  resolve(dir: string): Promise<RepoInfo> {
    const hit = this.#cache.get(dir);
    if (hit && this.fresh(dir)) return hit.info;
    const entry: { at: number; info: Promise<RepoInfo>; settled?: RepoInfo } = {
      at: this.#now(),
      info: lookupRepo(dir, this.#git).catch(() => NOT_A_REPO),
    };
    // Until the new lookup settles, `cached` keeps answering with the old one.
    if (hit?.settled) entry.settled = hit.settled;
    void entry.info.then((info) => {
      entry.settled = info;
    });
    this.#cache.set(dir, entry);
    return entry.info;
  }

  /** The latest finished lookup of `dir`, however old; never waits. */
  cached(dir: string): RepoInfo | undefined {
    return this.#cache.get(dir)?.settled;
  }

  /** Whether a lookup of `dir` started within the TTL (finished or not). */
  fresh(dir: string): boolean {
    const hit = this.#cache.get(dir);
    return hit !== undefined && this.#now() - hit.at < this.#ttlMs;
  }
}
