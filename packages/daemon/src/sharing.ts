import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { type BatonEvent, maskEventSecrets, type RepoInfo } from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";
import { osDir } from "./paths.js";
import type { EventSink, PublishOptions } from "./sink.js";
import { loadVersioned, saveVersioned, type VersionedSpec } from "./versioned-file.js";

/**
 * What this machine shares with a team server. Nothing is shared until a
 * repo (by git remote) or folder is added: see docs/what-baton-shares.md.
 */
export const Sharing = z.object({
  /** While true, nothing is sent at all. */
  paused: z.boolean().default(false),
  /** repoIds (normalized git remotes, see `lookupRepo`) whose sessions are shared. */
  repos: z.array(z.string().min(1)).default([]),
  /** Absolute folders whose sessions are shared, for work outside git. */
  folders: z.array(z.string().min(1)).default([]),
});
export type Sharing = z.infer<typeof Sharing>;

export const EMPTY_SHARING: Sharing = { paused: false, repos: [], folders: [] };

export const SHARING_FILE: VersionedSpec<Sharing> = {
  what: "sharing",
  version: 1,
  migrations: [(data) => data],
  parse: (data) => {
    const r = Sharing.safeParse(data);
    return r.success ? { value: r.data, dropped: 0 } : undefined;
  },
};

export async function readSharing(file: string, logger?: Logger): Promise<Sharing | undefined> {
  return loadVersioned(file, SHARING_FILE, logger);
}

export async function writeSharing(file: string, sharing: Sharing): Promise<void> {
  await saveVersioned(file, SHARING_FILE.version, sharing);
}

/** Whether `dir` is `folder` or inside it. Case-insensitive where the OS usually is. */
export function isInside(
  folder: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = platform === "win32" ? win32 : posix;
  const fold = (p: string) =>
    platform === "win32" || platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const rel = path.relative(fold(folder), fold(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Pure: is a session in `dir` (whose git identity is `repo`) shared under `sharing`? */
export function isShared(
  sharing: Sharing,
  dir: string,
  repo: RepoInfo | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (sharing.paused || dir === "") return false;
  if (repo?.repoId && sharing.repos.includes(repo.repoId)) return true;
  return sharing.folders.some((f) => isInside(f, dir, platform));
}

export type SharingPolicyOptions = {
  file: string;
  /** Git identity of a directory (a `RepoResolver`'s `resolve`). */
  repoOf: (dir: string) => Promise<RepoInfo>;
  logger: Logger;
  /** How often the file is checked for changes. Default 1 s. */
  recheckMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
};

/**
 * The sharing file as the running daemon sees it: re-read whenever it
 * changes, so `baton share`/`pause` take effect without a restart.
 */
export class SharingPolicy {
  #sharing: Sharing = EMPTY_SHARING;
  #mtimeMs: number | undefined;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #loading: Promise<void> | undefined;
  #generation = 0;

  constructor(readonly options: SharingPolicyOptions) {}

  /** Changes whenever the settings do (share, unshare, pause, resume). */
  get generation(): number {
    return this.#generation;
  }

  async current(): Promise<Sharing> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.#checkedAt >= (this.options.recheckMs ?? 1000)) {
      this.#checkedAt = now;
      this.#loading ??= this.#reload().finally(() => {
        this.#loading = undefined;
      });
    }
    if (this.#loading) await this.#loading;
    return this.#sharing;
  }

  /** Whether a session working in `rawDir` (as its log spells it) is shared. */
  async shared(rawDir: string): Promise<boolean> {
    const sharing = await this.current();
    if (sharing.paused || rawDir === "") return false;
    const platform = this.options.platform ?? process.platform;
    const dir = osDir(rawDir, platform);
    if (sharing.folders.some((f) => isInside(f, dir, platform))) return true;
    if (sharing.repos.length === 0) return false;
    const repo = await this.options.repoOf(dir).catch(() => undefined);
    return isShared(sharing, dir, repo, platform);
  }

  async #reload(): Promise<void> {
    const mtimeMs = await stat(this.options.file).then(
      (s) => s.mtimeMs,
      () => undefined,
    );
    if (mtimeMs === this.#mtimeMs) return;
    this.#mtimeMs = mtimeMs;
    this.#generation++;
    const prev = this.#sharing;
    try {
      this.#sharing = (await readSharing(this.options.file, this.options.logger)) ?? EMPTY_SHARING;
    } catch (err) {
      // A file from a newer Baton, or unreadable: share nothing rather than guess.
      this.options.logger.error({ err }, "could not read the sharing file; sharing nothing");
      this.#sharing = { ...EMPTY_SHARING, paused: true };
    }
    if (prev.paused !== this.#sharing.paused) {
      this.options.logger.info(this.#sharing.paused ? "sharing paused" : "sharing resumed");
    }
  }
}

/**
 * Wraps the team sink so only shared sessions leave the machine, with
 * credentials masked. Events of unshared sessions are dropped here; the
 * watcher still reads them (it only talks to its sink), so sharing a repo
 * later sends its sessions from then on, not their past.
 *
 * The session is the unit: once an event of a session is in a shared repo or
 * folder, the rest of that session is shared too, even when the agent works
 * in a subfolder or the log spells the path another way (`C:\…`, `c:\…`,
 * `/c/…`). Any change to the settings (unshare, pause) forgets that at once.
 */
export class SharingSink implements EventSink {
  readonly #skipped = new Set<string>();
  readonly #sharedSessions = new Set<string>();
  #generation = -1;

  constructor(
    readonly inner: EventSink,
    readonly policy: SharingPolicy,
    readonly logger: Logger,
  ) {}

  async publish(events: readonly BatonEvent[], options: PublishOptions = {}): Promise<void> {
    if (events.length === 0) return;
    const sharing = await this.policy.current();
    if (sharing.paused) return;
    if (this.policy.generation !== this.#generation) {
      this.#generation = this.policy.generation;
      this.#sharedSessions.clear();
    }
    const dirs = new Map<string, boolean>();
    const kept: BatonEvent[] = [];
    for (const event of events) {
      if (!this.#sharedSessions.has(event.sessionId)) {
        const dir = event.projectPath;
        let ok = dirs.get(dir);
        if (ok === undefined) {
          ok = await this.policy.shared(dir);
          dirs.set(dir, ok);
        }
        if (!ok) {
          this.#logSkipped(dir);
          continue;
        }
        this.#sharedSessions.add(event.sessionId);
      }
      kept.push(maskEventSecrets(event));
    }
    if (kept.length === 0) return;
    const { repos: _repos, ...rest } = options;
    await this.inner.publish(kept, rest);
  }

  #logSkipped(dir: string): void {
    if (this.#skipped.has(dir)) return;
    this.#skipped.add(dir);
    this.logger.info(
      { dir },
      "not sharing sessions in this folder (run `baton share` there to share it)",
    );
  }
}
