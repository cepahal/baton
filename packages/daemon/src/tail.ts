import { stat } from "node:fs/promises";
import {
  type AgentAdapter,
  type AgentId,
  type BatonEvent,
  createAdapter,
  type ParserOptions,
} from "@baton/core";
import { LineBuffer } from "./lines.js";
import {
  compressedPath,
  isCompressed,
  type LogFile,
  openLog,
  ZstdUnavailableError,
} from "./log-file.js";
import { logKey } from "./sources.js";

export type PartOptions = {
  /** Bytes already taken from the file. Default 0. */
  offset?: number;
  ino?: string | undefined;
  /**
   * A compressed log whose length isn't known yet because it hasn't been
   * decompressed. It counts as fully read, and is decompressed only if the
   * session's history has to be replayed.
   */
  sealed?: boolean;
};

export type TailOptions = PartOptions & {
  /** Which adapter parses the lines. Default `claude-code`. */
  agent?: AgentId;
  parser?: ParserOptions;
};

export type CatchUpResult = {
  events: BatonEvent[];
  /** A file shrank or was replaced, so every file was read again from the start. */
  reset: boolean;
  /** Files that disappeared; they're no longer part of the session. */
  gone: string[];
};

/** How far into one file events have been taken, as saved between runs. */
export type PartState = {
  readonly path: string;
  readonly offset: number;
  readonly ino: string | undefined;
  readonly sealed: boolean;
};

type Part = {
  path: string;
  offset: number;
  ino: string | undefined;
  sealed: boolean;
  lines: LineBuffer;
};

type Opened = { log: LogFile } | { gone: true } | { skip: true };

/**
 * Turns one session's log files into events. Usually that's one file; a Codex
 * thread that was rewound continues in segment files, read after it in order.
 * Keeps byte offsets, each file's trailing partial line, and one adapter for
 * the session's whole life so `seq` and tool names carry across reads and files.
 *
 * A tail created at an offset > 0 (resuming, or skipping an idle file's
 * history) is cold: the adapter hasn't seen the bytes before the offsets.
 * `catchUp` warms it first; `warmUp` does so explicitly and returns history.
 */
export class TranscriptTail {
  readonly agent: AgentId;
  readonly #parserOptions: ParserOptions;
  readonly #parts: Part[] = [];
  #adapter: AgentAdapter;
  #warm = true;

  constructor(path: string, options: TailOptions = {}) {
    this.agent = options.agent ?? "claude-code";
    this.#parserOptions = options.parser ?? {};
    this.#adapter = createAdapter(this.agent, this.#parserOptions);
    this.addPart(path, options);
  }

  /** The session's first file. */
  get path(): string {
    return this.#parts[0]?.path ?? "";
  }

  get parts(): PartState[] {
    return this.#parts.map((p) => ({
      path: p.path,
      offset: p.offset - p.lines.pendingBytes,
      ino: p.ino,
      sealed: p.sealed,
    }));
  }

  /** Offset in the first file up to the last complete line. */
  get committedOffset(): number {
    return this.parts[0]?.offset ?? 0;
  }

  /** Bytes taken so far across all files (sealed files count as 0). */
  get bytesRead(): number {
    return this.#parts.reduce((n, p) => n + (p.sealed ? 0 : p.offset), 0);
  }

  get warm(): boolean {
    return this.#warm;
  }

  /** Is `path` (or its compressed / uncompressed twin) one of this session's files? */
  has(path: string): boolean {
    const key = logKey(path);
    return this.#parts.some((p) => logKey(p.path) === key);
  }

  /** Adds a later file of the same session; its events follow the earlier files'. */
  addPart(path: string, options: PartOptions = {}): void {
    const offset = options.offset ?? 0;
    const sealed = options.sealed ?? false;
    this.#parts.push({ path, offset, ino: options.ino, sealed, lines: new LineBuffer() });
    if (offset > 0 || sealed) this.#warm = false;
  }

  /**
   * Replays every file up to its offset through a fresh adapter, so later
   * events get the right seq and tool names. Returns the last `keep` events of
   * that history (`Infinity` = all). Makes the tail warm.
   */
  async warmUp(keep = 0): Promise<BatonEvent[]> {
    this.#adapter = createAdapter(this.agent, this.#parserOptions);
    const history: BatonEvent[] = [];
    for (const part of this.#parts) {
      part.lines.reset();
      if (part.offset === 0 && !part.sealed) continue;
      const opened = await this.#open(part);
      if (!("log" in opened)) continue;
      const { log } = opened;
      const end = part.sealed ? log.size : Math.min(part.offset, log.size);
      const buffer = new LineBuffer();
      await log.read(0, end, (chunk) => {
        for (const line of buffer.push(chunk)) {
          for (const event of this.#adapter.parse(line)) {
            if (keep === 0) continue;
            history.push(event);
            if (history.length > keep) history.shift();
          }
        }
      });
      // An unfinished last line is read again, whole, by the next catchUp.
      part.offset = end - buffer.pendingBytes;
      part.ino = log.ino;
      part.sealed = false;
    }
    this.#warm = true;
    return history;
  }

  /** Has any file grown, shrunk, been replaced or gone away since it was last read? */
  async changed(): Promise<boolean> {
    for (const part of this.#parts) {
      if (part.sealed) {
        if (!(await exists(part.path))) return true;
        continue;
      }
      let log: LogFile;
      try {
        log = await openLog(part.path);
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") throw err;
        // Codex compressed an idle log we hadn't read past: still idle.
        const zst = compressedPath(part.path);
        if (isCompressed(part.path) || !(await exists(zst))) return true;
        part.path = zst;
        part.sealed = true;
        continue;
      }
      if (log.size !== part.offset || replaced(part, log)) return true;
    }
    return false;
  }

  /** Reads what was appended since the last call, from every file in order. */
  async catchUp(): Promise<CatchUpResult> {
    if (!this.#warm) await this.warmUp();
    const gone: string[] = [];
    let reset = false;
    for (let attempt = 0; ; attempt++) {
      const events: BatonEvent[] = [];
      let restart = false;
      for (const part of [...this.#parts]) {
        if (part.sealed) {
          if (!(await exists(part.path))) gone.push(this.#drop(part));
          continue;
        }
        const opened = await this.#open(part);
        if ("gone" in opened) {
          gone.push(this.#drop(part));
          continue;
        }
        if ("skip" in opened) continue;
        const { log } = opened;
        const committed = part.offset - part.lines.pendingBytes;
        if ((replaced(part, log) || log.size < committed) && attempt === 0) {
          restart = true;
          break;
        }
        part.ino = log.ino;
        part.offset = await log.read(part.offset, log.size, (chunk) => {
          for (const line of part.lines.push(chunk)) events.push(...this.#adapter.parse(line));
        });
      }
      if (!restart) return { events, reset, gone };
      // Rewritten in place: start the whole session over.
      reset = true;
      for (const part of this.#parts) {
        part.offset = 0;
        part.ino = undefined;
        part.lines.reset();
      }
      await this.warmUp();
    }
  }

  #drop(part: Part): string {
    this.#parts.splice(this.#parts.indexOf(part), 1);
    return part.path;
  }

  /**
   * Opens a part's file. Codex replaces an idle `x.jsonl` with `x.jsonl.zst`;
   * the text is the same, so reading carries on in the compressed copy.
   */
  async #open(part: Part): Promise<Opened> {
    const attempt = async (path: string): Promise<Opened> => {
      try {
        return { log: await openLog(path) };
      } catch (err) {
        if (err instanceof ZstdUnavailableError) return { skip: true };
        if (errnoCode(err) === "ENOENT") return { gone: true };
        throw err;
      }
    };
    const first = await attempt(part.path);
    if (!("gone" in first) || isCompressed(part.path)) return first;
    const zst = compressedPath(part.path);
    const second = await attempt(zst);
    if (!("gone" in second)) part.path = zst;
    return second;
  }
}

const replaced = (part: Part, log: LogFile): boolean =>
  part.ino !== undefined && log.ino !== undefined && part.ino !== log.ino;

export const errnoCode = (err: unknown): string | undefined =>
  err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
