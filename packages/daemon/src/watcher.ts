import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BatonEvent } from "@baton/core";
import { type FSWatcher, watch } from "chokidar";
import type { Logger } from "pino";
import { limitConcurrency } from "./limit.js";
import { isCompressed, openLog, zstdAvailable } from "./log-file.js";
import { mergeByTime } from "./merge.js";
import type { EventSink } from "./sink.js";
import { belongsTo, cursorSessionInfo, type LogSource, logKey, sessionKey } from "./sources.js";
import type { StateStore } from "./state-store.js";
import { errnoCode, type PartOptions, TranscriptTail } from "./tail.js";

export type WatcherOptions = {
  /** Where each agent's session logs live; one per adapter in the core registry. */
  sources: readonly LogSource[];
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
  /**
   * The N most recently modified sessions of each agent also count as active
   * at startup, however old. Default 0.
   */
  recentPerAgent?: number;
  /** Sessions read at once during startup. Default 8. */
  concurrency?: number;
  /** Poll instead of using native file events (network drives, some VMs). */
  poll?: boolean;
  pollIntervalMs?: number;
  /**
   * How often every followed file's size is checked, as a backstop for missed
   * change events (0 = never). Default 1000.
   */
  sweepIntervalMs?: number;
  now?: () => number;
};

type Job = {
  running: boolean;
  again: boolean;
  /** Files that changed since the last read. */
  paths: Set<string>;
  idle: Promise<void>;
  recheck?: NodeJS.Timeout | undefined;
};

type Opened = { active: boolean; backlog: BatonEvent[]; missed: BatonEvent[] };

/** One session's files at startup, oldest first. */
type Group = { key: string; source: LogSource; paths: string[] };

const RETRY_MS = 250;
const RETRIES = 3;
/**
 * chokidar drops a file's change events that come within 50 ms of the previous
 * one, with no trailing event, so the end of a burst of writes can go unseen.
 * After each read the session is checked again this much later, and again for
 * as long as those checks keep finding new bytes.
 */
const RECHECK_MS = 150;
/** See `sweepIntervalMs`. */
const SWEEP_MS = 1000;

/**
 * Watches every agent's session-log directory and publishes new events to a
 * sink. Knows nothing about how events are delivered. Files that belong to one
 * session (a Codex thread and its segment files) share one tail, so their
 * events come out in order with one `seq`.
 */
export class TranscriptWatcher {
  readonly #tails = new Map<string, TranscriptTail>();
  readonly #jobs = new Map<string, Job>();
  readonly #limit: ReturnType<typeof limitConcurrency>;
  readonly #log: Logger;
  #sources: LogSource[] = [];
  #watcher: FSWatcher | undefined;
  #sweep: NodeJS.Timeout | undefined;
  readonly #mtimes = new Map<string, { mtimeMs: number; ctimeMs: number }>();
  #closed = false;

  constructor(readonly options: WatcherOptions) {
    this.#limit = limitConcurrency(options.concurrency ?? 8);
    this.#log = options.logger;
  }

  /** Session-log files being followed. */
  get fileCount(): number {
    let n = 0;
    for (const tail of this.#tails.values()) n += tail.parts.length;
    return n;
  }

  /** Reads existing session logs (publishing the backlog), then starts watching. */
  async start(): Promise<void> {
    for (const source of this.options.sources) {
      const dir = await stat(source.dir).catch(() => undefined);
      if (dir?.isDirectory()) this.#sources.push(source);
      else
        this.#log.info({ agent: source.agent, dir: source.dir }, "no session logs here; skipping");
    }
    if (this.#sources.length === 0) {
      const dirs = this.options.sources.map((s) => s.dir).join(", ");
      throw new Error(
        `no session log directory found: ${dirs} (run Claude Code, Codex or Cursor once, or pass --projects-dir / --codex-dir / --cursor-dir)`,
      );
    }

    const files = await this.#listAll();
    if (!zstdAvailable() && files.some(isCompressed)) {
      this.#log.warn("this Node.js has no zstd support (needs 22.15+): skipping .zst session logs");
    }
    const groups = this.#group(files);
    const recent = await this.#mostRecent(groups);
    const opened = await Promise.all(
      groups.map((g) => this.#limit(() => this.#open(g, recent.has(g.key)))),
    );
    await this.#rememberMtimes(files);
    this.#pruneState(new Set(files.map(logKey)));

    const backlog = opened.flatMap((r) => r.backlog);
    const missed = opened.flatMap((r) => r.missed);
    if (backlog.length > 0) await this.#publish(mergeByTime(backlog), true);
    if (missed.length > 0) await this.#publish(mergeByTime(missed), false);
    const dirs = Object.fromEntries(this.#sources.map((s) => [s.agent, s.dir]));
    this.#log.info(
      {
        dirs,
        files: files.length,
        sessions: groups.length,
        activeSessions: opened.filter((r) => r.active).length,
        backlogEvents: backlog.length,
        missedEvents: missed.length,
      },
      "read existing transcripts",
    );

    await new Promise<void>((resolve) => {
      this.#watcher = watch(
        this.#sources.map((s) => s.dir),
        {
          ignoreInitial: true,
          // Directories must pass so their contents are watched.
          ignored: (path, stats) => stats?.isFile() === true && !this.#sourceOf(path),
          usePolling: this.options.poll ?? false,
          interval: this.options.pollIntervalMs ?? 500,
        },
      )
        .on("add", (path) => this.#schedule(path))
        .on("change", (path) => this.#schedule(path))
        // The tail notices the file is gone (or was compressed) on its next read.
        .on("unlink", (path) => this.#schedule(path))
        .on("error", (err) => this.#log.error({ err }, "file watcher error"))
        .on("ready", resolve);
    });
    // Catch anything written between the initial read and the watcher being
    // ready, including files created in that window: with ignoreInitial,
    // chokidar never reports those as added, and if their directory appeared
    // while chokidar was still scanning it may not be watching them either.
    const known = [...this.#tails.values()].flatMap((t) => t.parts.map((p) => p.path));
    const now = await this.#listAll().catch(() => []);
    const late = now.filter((path) => !this.#tailFor(path)?.has(path));
    if (late.length > 0) this.#watcher?.add([...new Set(late.map((path) => dirname(path)))]);
    for (const path of new Set([...known, ...now])) this.#schedule(path);
    const sweepMs = this.options.sweepIntervalMs ?? SWEEP_MS;
    if (sweepMs > 0) this.#sweep = setInterval(() => void this.#sweepSizes(), sweepMs);
    this.#log.info({ dirs }, "watching for transcript changes");
  }

  /** Stops watching and waits for in-flight reads. The caller saves offsets. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const job of this.#jobs.values()) clearTimeout(job.recheck);
    await this.#watcher?.close();
    await this.idle();
  }

  /** Resolves once no session is being read. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.#jobs.values()].filter((j) => j.running);
      if (running.length === 0) return;
      await Promise.all(running.map((j) => j.idle));
    }
  }

  /**
   * Schedules a read of every followed file whose size differs from what was
   * read. Codex Desktop appends to a rollout it holds open, and on Windows that
   * leaves the file's mtime unchanged, so chokidar drops the change events.
   */
  async #sweepSizes(): Promise<void> {
    const parts = [...this.#tails.values()]
      .flatMap((tail) => tail.parts.map((part) => ({ tail, part })))
      .filter(({ part }) => !part.sealed);
    await Promise.all(
      parts.map(async ({ tail, part }) => {
        const info = await stat(part.path).then(
          (s) => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }),
          () => undefined,
        );
        if (!info) return;
        const key = logKey(part.path);
        const previousMtime = this.#mtimes.get(key);
        const rewritten =
          tail.agent === "cursor" &&
          info.size === part.offset &&
          previousMtime !== undefined &&
          (info.mtimeMs !== previousMtime.mtimeMs || info.ctimeMs !== previousMtime.ctimeMs);
        const changed = info.size !== part.offset || rewritten;
        const running = this.#jobs.get(this.#keyOf(part.path))?.running;
        if (changed) {
          if (!running) this.#schedule(part.path);
        } else {
          this.#mtimes.set(key, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
        }
      }),
    );
  }

  #keyOf(path: string): string {
    const source = this.#sourceOf(path);
    return source ? sessionKey(source, path) : path;
  }

  #sourceOf(path: string): LogSource | undefined {
    return this.#sources.find((s) => belongsTo(s, path));
  }

  #tailFor(path: string): TranscriptTail | undefined {
    const source = this.#sourceOf(path);
    return source && this.#tails.get(sessionKey(source, path));
  }

  /** Every session log in every watched directory, at any depth. */
  async #listAll(): Promise<string[]> {
    const lists = await Promise.all(this.#sources.map((s) => listLogs(s)));
    return lists.flat();
  }

  /**
   * Groups files into sessions. When Codex has both `x.jsonl` and
   * `x.jsonl.zst` (mid-compression), the uncompressed one is used.
   */
  #group(files: string[]): Group[] {
    const byLog = new Map<string, string>();
    for (const path of files) {
      const key = logKey(path);
      const seen = byLog.get(key);
      if (seen === undefined || isCompressed(seen)) byLog.set(key, path);
    }
    const groups = new Map<string, Group>();
    for (const path of [...byLog.values()].sort()) {
      const source = this.#sourceOf(path);
      if (!source) continue;
      const key = sessionKey(source, path);
      const group = groups.get(key);
      if (group) group.paths.push(path);
      else groups.set(key, { key, source, paths: [path] });
    }
    return [...groups.values()];
  }

  /**
   * Startup handling for one existing session. An active session (a file
   * recently modified, or grown since its saved offset) yields its last N
   * events as backlog plus everything after the saved offsets. Other sessions
   * are only remembered, and parsed the first time they change. Compressed
   * Codex logs of idle sessions aren't even decompressed.
   */
  async #open({ key, source, paths }: Group, forceActive = false): Promise<Opened> {
    try {
      const now = (this.options.now ?? Date.now)();
      const recent = await Promise.all(
        paths.map(async (p) => (await stat(p)).mtimeMs >= now - this.options.activeWindowMs),
      );
      let active = forceActive || recent.some(Boolean);
      let resumed = false;
      const parts: { path: string; options: PartOptions }[] = [];
      for (const path of paths) {
        const saved = this.options.state.get(logKey(path));
        if (isCompressed(path) && !active) {
          parts.push({ path, options: { sealed: true } });
          continue;
        }
        const { size, ino } = await openLog(path);
        const resumeAt =
          saved !== undefined &&
          saved.offset <= size &&
          (saved.ino === undefined || ino === undefined || saved.ino === ino)
            ? saved.offset
            : undefined;
        if (resumeAt !== undefined) resumed = true;
        if (resumeAt !== undefined && size > resumeAt) active = true;
        parts.push({ path, options: { offset: resumeAt ?? size, ino } });
      }

      const [first, ...rest] = parts;
      if (!first) return { active: false, backlog: [], missed: [] };
      const tail = this.#tail(source, first.path, first.options);
      for (const part of rest) tail.addPart(part.path, part.options);
      this.#tails.set(key, tail);
      if (!active) {
        this.#saveOffsets(tail);
        return { active, backlog: [], missed: [] };
      }
      const backlog = await tail.warmUp(this.options.backlogPerSession);
      const { events: missed } = resumed ? await tail.catchUp() : { events: [] };
      this.#saveOffsets(tail);
      return { active, backlog, missed };
    } catch (err) {
      this.#log.warn({ files: paths, err }, "could not read transcript at startup");
      return { active: false, backlog: [], missed: [] };
    }
  }

  /** Keys of the `recentPerAgent` most recently modified sessions of each agent. */
  async #mostRecent(groups: Group[]): Promise<Set<string>> {
    const n = this.options.recentPerAgent ?? 0;
    if (n <= 0) return new Set();
    const dated = await Promise.all(
      groups.map(async (g) => {
        const times = await Promise.all(
          g.paths.map((p) =>
            stat(p).then(
              (s) => s.mtimeMs,
              () => 0,
            ),
          ),
        );
        return { g, mtime: Math.max(0, ...times) };
      }),
    );
    const keys = new Set<string>();
    for (const source of this.#sources) {
      const newest = dated
        .filter((d) => d.g.source.agent === source.agent)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, n);
      for (const d of newest) keys.add(d.g.key);
    }
    return keys;
  }

  #tail(source: LogSource, path: string, options: PartOptions): TranscriptTail {
    const log = this.#log.child({ file: path });
    const cursor = source.agent === "cursor" ? cursorSessionInfo(source, path) : undefined;
    return new TranscriptTail(path, {
      ...options,
      agent: source.agent,
      parser: {
        ...(cursor ?? {}),
        ...(source.agent === "cursor" ? { fallbackTimestamp: new Date().toISOString() } : {}),
        onWarning: (w) => log.warn({ line: w.line, reason: w.reason }, "skipped transcript line"),
        debug: (message) => log.debug(message),
      },
    });
  }

  /**
   * Reads a session after one of its files changed. One read per session at a
   * time; changes during a read coalesce. `recheck` marks the follow-up check
   * described at RECHECK_MS.
   */
  #schedule(path: string, recheck = false): void {
    if (this.#closed) return;
    const source = this.#sourceOf(path);
    if (!source) return;
    const key = sessionKey(source, path);
    const current = this.#jobs.get(key);
    clearTimeout(current?.recheck);
    if (current?.running) {
      current.paths.add(path);
      current.again = true;
      return;
    }
    let done = () => {};
    const job: Job = {
      running: true,
      again: false,
      paths: new Set([path]),
      idle: new Promise((r) => (done = r)),
    };
    this.#jobs.set(key, job);
    void (async () => {
      let grew = false;
      do {
        job.again = false;
        const paths = [...job.paths];
        job.paths.clear();
        if (await this.#read(key, source, paths)) grew = true;
      } while (job.again && !this.#closed);
      job.running = false;
      if (!this.#closed && (grew || !recheck)) {
        job.recheck = setTimeout(() => this.#schedule(path, true), RECHECK_MS);
      }
      done();
    })();
  }

  /** Reads new bytes and publishes their events. True if the session had new bytes. */
  async #read(key: string, source: LogSource, paths: string[]): Promise<boolean> {
    let tail = this.#tails.get(key);
    for (const path of paths.sort()) {
      if (tail?.has(path) || !(await exists(path))) continue;
      if (tail) {
        tail.addPart(path);
        this.#log.info({ file: path }, "new segment of a known session");
      } else {
        tail = this.#tail(source, path, {});
        this.#tails.set(key, tail);
        this.#log.info({ file: path }, "new transcript");
      }
    }
    if (!tail) return false;
    const before = tail.bytesRead;
    if (source.agent === "cursor" && (await this.#cursorWasRewritten(tail, paths))) {
      tail.rereadCursorHistory();
    }
    await this.#rememberMtimes(paths);

    for (let attempt = 0; ; attempt++) {
      try {
        if (!tail.warm) {
          // An idle session's history is parsed only once it actually changes
          // (the sweep after startup touches every file); then it goes out first.
          if (!(await tail.changed())) {
            this.#saveOffsets(tail);
            return false;
          }
          const history = await tail.warmUp(this.options.backlogPerSession);
          if (history.length > 0) await this.#publish(history, true);
        }
        const { events, reset, gone } = await tail.catchUp();
        if (reset) {
          this.#log.info({ file: tail.path }, "transcript shrank or was replaced; rereading it");
        }
        if (events.length > 0) await this.#publish(events, false);
        for (const path of gone) {
          this.options.state.delete(logKey(path));
          this.#log.info({ file: path }, "transcript removed");
        }
        if (tail.parts.length === 0) {
          this.#tails.delete(key);
          return false;
        }
        this.#saveOffsets(tail);
        return reset || tail.bytesRead !== before;
      } catch (err) {
        // Windows briefly locks files that are being written.
        const code = errnoCode(err);
        const locked = code === "EBUSY" || code === "EPERM" || code === "EACCES";
        if (!locked || attempt >= RETRIES) {
          this.#log.warn({ file: tail.path, err }, "could not read transcript");
          return false;
        }
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  async #rememberMtimes(paths: readonly string[]): Promise<void> {
    await Promise.all(
      paths.map(async (path) => {
        const times = await stat(path).then(
          (s) => ({ mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }),
          () => undefined,
        );
        if (times) this.#mtimes.set(logKey(path), times);
      }),
    );
  }

  /** Cursor may rewrite a completed transcript in place without changing its size. */
  async #cursorWasRewritten(tail: TranscriptTail, paths: readonly string[]): Promise<boolean> {
    const parts = new Map(tail.parts.map((part) => [part.path, part]));
    for (const path of paths) {
      const part = parts.get(path);
      const previous = this.#mtimes.get(logKey(path));
      if (!part || !previous) continue;
      const current = await stat(path).catch(() => undefined);
      if (
        current &&
        current.size === part.offset &&
        (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Saves each file's offset. A sealed (never decompressed) file keeps its old entry. */
  #saveOffsets(tail: TranscriptTail): void {
    for (const part of tail.parts) {
      if (part.sealed) continue;
      const { ino } = part;
      this.options.state.set(logKey(part.path), { offset: part.offset, ...(ino ? { ino } : {}) });
    }
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

/** Every file under `source.dir`, at any depth, that is one of its session logs. */
async function listLogs(source: LogSource): Promise<string[]> {
  const entries = await readdir(source.dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => belongsTo(source, path))
    .sort();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
