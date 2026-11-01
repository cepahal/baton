import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BatonEvent } from "@baton/core";
import { type FSWatcher, watch } from "chokidar";
import type { Logger } from "pino";
import { limitConcurrency } from "./limit.js";
import { fileKey, isTranscript } from "./paths.js";
import type { EventSink } from "./sink.js";
import type { StateStore } from "./state-store.js";
import { fileIdentity, TranscriptTail } from "./tail.js";

export type WatcherOptions = {
  projectsDir: string;
  sink: EventSink;
  state: StateStore;
  logger: Logger;
  /**
   * History events published per session (`Infinity` = all): at startup for
   * active sessions, and when an inactive session first changes.
   */
  backlogPerSession: number;
  /** A file modified this recently counts as an active session at startup. */
  activeWindowMs: number;
  /** Files read at once during startup. Default 8. */
  concurrency?: number;
  /** Poll instead of using native file events (network drives, some VMs). */
  poll?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
};

type Job = {
  running: boolean;
  again: boolean;
  idle: Promise<void>;
  recheck?: NodeJS.Timeout | undefined;
};

type Opened = { active: boolean; backlog: BatonEvent[]; missed: BatonEvent[] };

const RETRY_MS = 250;
const RETRIES = 3;
/**
 * chokidar drops a file's change events that come within 50 ms of the previous
 * one, with no trailing event, so the end of a burst of writes can go unseen.
 * After each read the file is checked again this much later, and again for as
 * long as those checks keep finding new bytes.
 */
const RECHECK_MS = 150;

/**
 * Watches the projects directory for transcript changes and publishes the new
 * events to a sink. Knows nothing about how events are delivered.
 */
export class TranscriptWatcher {
  readonly #tails = new Map<string, TranscriptTail>();
  readonly #jobs = new Map<string, Job>();
  readonly #limit: ReturnType<typeof limitConcurrency>;
  readonly #log: Logger;
  #watcher: FSWatcher | undefined;
  #closed = false;

  constructor(readonly options: WatcherOptions) {
    this.#limit = limitConcurrency(options.concurrency ?? 8);
    this.#log = options.logger;
  }

  get fileCount(): number {
    return this.#tails.size;
  }

  /** Reads existing transcripts (publishing the backlog), then starts watching. */
  async start(): Promise<void> {
    const { projectsDir } = this.options;
    const dir = await stat(projectsDir).catch(() => undefined);
    if (!dir?.isDirectory()) {
      throw new Error(
        `projects directory not found: ${projectsDir} (run Claude Code once, or pass --projects-dir)`,
      );
    }

    const files = await listTranscripts(projectsDir);
    const opened = await Promise.all(files.map((f) => this.#limit(() => this.#open(f))));
    this.#pruneState(new Set(files.map((f) => fileKey(f))));

    const backlog = opened.flatMap((r) => r.backlog);
    const missed = opened.flatMap((r) => r.missed);
    if (backlog.length > 0) await this.#publish(byTime(backlog), true);
    if (missed.length > 0) await this.#publish(byTime(missed), false);
    this.#log.info(
      {
        projectsDir,
        files: files.length,
        activeSessions: opened.filter((r) => r.active).length,
        backlogEvents: backlog.length,
        missedEvents: missed.length,
      },
      "read existing transcripts",
    );

    await new Promise<void>((resolve) => {
      this.#watcher = watch(projectsDir, {
        ignoreInitial: true,
        // Directories must pass so their contents are watched.
        ignored: (path, stats) => stats?.isFile() === true && !isTranscript(path),
        usePolling: this.options.poll ?? false,
        interval: this.options.pollIntervalMs ?? 500,
      })
        .on("add", (path) => this.#schedule(path))
        .on("change", (path) => this.#schedule(path))
        .on("unlink", (path) => this.#forget(path))
        .on("error", (err) => this.#log.error({ err }, "file watcher error"))
        .on("ready", resolve);
    });
    // Catch anything written between the initial read and the watcher being ready.
    for (const tail of this.#tails.values()) this.#schedule(tail.path);
    this.#log.info({ projectsDir }, "watching for transcript changes");
  }

  /** Stops watching and waits for in-flight reads. The caller saves offsets. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) clearTimeout(job.recheck);
    await this.#watcher?.close();
    await this.idle();
  }

  /** Resolves once no file is being read. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.#jobs.values()].filter((j) => j.running);
      if (running.length === 0) return;
      await Promise.all(running.map((j) => j.idle));
    }
  }

  /**
   * Startup handling for one existing file. An active session (recently
   * modified, or grown since its saved offset) yields its last N events as
   * backlog plus everything after the saved offset. Other files are only
   * remembered, and parsed the first time they change.
   */
  async #open(path: string): Promise<Opened> {
    const key = fileKey(path);
    try {
      const [{ size, ino }, { mtimeMs }] = await Promise.all([fileIdentity(path), stat(path)]);
      const saved = this.options.state.get(key);
      const resumeAt =
        saved !== undefined &&
        saved.offset <= size &&
        (saved.ino === undefined || ino === undefined || saved.ino === ino)
          ? saved.offset
          : undefined;
      const now = (this.options.now ?? Date.now)();
      const active =
        mtimeMs >= now - this.options.activeWindowMs || (resumeAt !== undefined && size > resumeAt);

      const tail = this.#tail(path, resumeAt ?? size, ino);
      this.#tails.set(key, tail);
      if (!active) {
        this.#saveOffset(key, tail);
        return { active, backlog: [], missed: [] };
      }
      const backlog = await tail.warmUp(this.options.backlogPerSession);
      const { events: missed } = resumeAt === undefined ? { events: [] } : await tail.catchUp();
      this.#saveOffset(key, tail);
      return { active, backlog, missed };
    } catch (err) {
      this.#log.warn({ file: path, err }, "could not read transcript at startup");
      return { active: false, backlog: [], missed: [] };
    }
  }

  #tail(path: string, offset: number, ino: string | undefined): TranscriptTail {
    const log = this.#log.child({ file: path });
    return new TranscriptTail(path, {
      offset,
      ino,
      parser: {
        onWarning: (w) => log.warn({ line: w.line, reason: w.reason }, "skipped transcript line"),
        debug: (message) => log.debug(message),
      },
    });
  }

  /**
   * Reads a file after a change. One read per file at a time; changes during a
   * read coalesce. `recheck` marks the follow-up check described at RECHECK_MS.
   */
  #schedule(path: string, recheck = false): void {
    if (this.#closed || !isTranscript(path)) return;
    const key = fileKey(path);
    const current = this.#jobs.get(key);
    clearTimeout(current?.recheck);
    if (current?.running) {
      current.again = true;
      return;
    }
    let done = () => {};
    const job: Job = { running: true, again: false, idle: new Promise((r) => (done = r)) };
    this.#jobs.set(key, job);
    void (async () => {
      let grew = false;
      do {
        job.again = false;
        if (await this.#read(key, path)) grew = true;
      } while (job.again && !this.#closed);
      job.running = false;
      if (!this.#closed && (grew || !recheck)) {
        job.recheck = setTimeout(() => this.#schedule(path, true), RECHECK_MS);
      }
      done();
    })();
  }

  /** Reads new bytes and publishes their events. True if the file had new bytes. */
  async #read(key: string, path: string): Promise<boolean> {
    let tail = this.#tails.get(key);
    if (!tail) {
      tail = this.#tail(path, 0, undefined);
      this.#tails.set(key, tail);
      this.#log.info({ file: path }, "new transcript");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        if (!tail.warm) {
          // An idle session's history is parsed only once it actually grows
          // (the sweep after startup touches every file); then it goes out first.
          const { size } = await fileIdentity(path);
          if (size === tail.bytesRead) return false;
          if (size > tail.bytesRead) {
            const history = await tail.warmUp(this.options.backlogPerSession);
            if (history.length > 0) await this.#publish(history, true);
          }
        }
        const before = tail.bytesRead;
        const { events, reset } = await tail.catchUp();
        if (reset)
          this.#log.info({ file: path }, "transcript shrank or was replaced; rereading it");
        if (events.length > 0) await this.#publish(events, false);
        this.#saveOffset(key, tail);
        return reset || tail.bytesRead !== before;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          this.#forget(path);
          return false;
        }
        // Windows briefly locks files that are being written.
        const locked = code === "EBUSY" || code === "EPERM" || code === "EACCES";
        if (!locked || attempt >= RETRIES) {
          this.#log.warn({ file: path, err }, "could not read transcript");
          return false;
        }
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  #forget(path: string): void {
    const key = fileKey(path);
    clearTimeout(this.#jobs.get(key)?.recheck);
    if (this.#tails.delete(key)) this.#log.info({ file: path }, "transcript removed");
    this.options.state.delete(key);
  }

  #saveOffset(key: string, tail: TranscriptTail): void {
    const { ino } = tail;
    this.options.state.set(key, { offset: tail.committedOffset, ...(ino ? { ino } : {}) });
  }

  #pruneState(present: Set<string>): void {
    for (const key of this.options.state.keys()) {
      if (!present.has(key)) this.options.state.delete(key);
    }
  }

  async #publish(events: BatonEvent[], backlog: boolean): Promise<void> {
    try {
      await this.options.sink.publish(events, backlog ? { backlog } : {});
    } catch (err) {
      this.#log.error({ err, events: events.length }, "event sink failed");
    }
  }
}

/** Every `.jsonl` file under `dir`, at any depth. */
async function listTranscripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isTranscript(e.name))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Oldest first. Stable, so a session's order survives equal timestamps. */
function byTime(events: BatonEvent[]): BatonEvent[] {
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}
