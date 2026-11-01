import { open, stat } from "node:fs/promises";
import { type BatonEvent, createTranscriptParser, type ParserOptions } from "@baton/core";
import { LineBuffer } from "./lines.js";

const CHUNK_BYTES = 256 * 1024;

export type TailOptions = {
  /** Where reading starts. If it falls inside a line, warmUp moves it back to the line start. */
  offset?: number;
  /** File identity the offset belongs to. */
  ino?: string | undefined;
  /** Parser hooks; a fresh parser is made from them on every reset. */
  parser?: ParserOptions;
};

export type CatchUpResult = {
  events: BatonEvent[];
  /** The file shrank or was replaced, so reading restarted at byte 0. */
  reset: boolean;
};

/** File identity as a string; `undefined` where the filesystem doesn't report one. */
export async function fileIdentity(
  path: string,
): Promise<{ size: number; ino: string | undefined }> {
  const s = await stat(path, { bigint: true });
  return { size: Number(s.size), ino: s.ino === 0n ? undefined : s.ino.toString() };
}

/**
 * Follows one transcript file: reads only bytes it hasn't seen, holds back a
 * trailing partial line, and keeps one parser for the file's whole life so
 * tool names and per-session seq stay right.
 */
export class TranscriptTail {
  readonly #lines = new LineBuffer();
  readonly #parserOptions: ParserOptions;
  #parser: ReturnType<typeof createTranscriptParser>;
  /** Bytes read into the line buffer so far. */
  #offset: number;
  #ino: string | undefined;
  /** False until bytes before `#offset` have been fed to the parser. */
  #warm: boolean;

  constructor(
    readonly path: string,
    options: TailOptions = {},
  ) {
    this.#parserOptions = options.parser ?? {};
    this.#parser = createTranscriptParser(this.#parserOptions);
    this.#offset = options.offset ?? 0;
    this.#ino = options.ino;
    this.#warm = this.#offset === 0;
  }

  /** End of the last complete line read: safe to persist and resume from. */
  get committedOffset(): number {
    return this.#offset - this.#lines.pendingBytes;
  }

  /** Bytes read so far, including a held-back partial line. */
  get bytesRead(): number {
    return this.#offset;
  }

  /** True once the bytes before the start offset have been parsed. */
  get warm(): boolean {
    return this.#warm;
  }

  get ino(): string | undefined {
    return this.#ino;
  }

  /**
   * Feeds the bytes before the start offset to the parser, so later events get
   * the right seq and tool names. Returns the last `keep` events of that history
   * (`Infinity` for all of it).
   */
  async warmUp(keep = 0): Promise<BatonEvent[]> {
    if (this.#warm) return [];
    const history: BatonEvent[] = [];
    const buffer = new LineBuffer();
    await readRange(this.path, 0, this.#offset, (chunk) => {
      for (const line of buffer.push(chunk)) {
        for (const e of this.#parser.parseLine(line)) {
          if (keep === 0) continue;
          history.push(e);
          if (history.length > keep) history.shift();
        }
      }
    });
    // A start offset taken from the file size can land inside a line still being
    // written; back up to its start so catchUp reads that line whole.
    this.#offset -= buffer.pendingBytes;
    this.#warm = true;
    return history;
  }

  /** Reads everything appended since the last call. */
  async catchUp(): Promise<CatchUpResult> {
    const { size, ino } = await fileIdentity(this.path);
    const replaced = this.#ino !== undefined && ino !== undefined && ino !== this.#ino;
    const reset = replaced || size < this.committedOffset;
    if (reset) this.#reset();
    this.#ino = ino;
    await this.warmUp();

    const events: BatonEvent[] = [];
    if (size > this.#offset) {
      const start = this.#offset;
      this.#offset = await readRange(this.path, start, size, (chunk) => {
        for (const line of this.#lines.push(chunk)) events.push(...this.#parser.parseLine(line));
      });
    }
    return { events, reset };
  }

  #reset(): void {
    this.#offset = 0;
    this.#lines.reset();
    this.#parser = createTranscriptParser(this.#parserOptions);
    this.#warm = true;
  }
}

/** Reads `[start, end)` in chunks; returns where reading stopped (end, or EOF if sooner). */
async function readRange(
  path: string,
  start: number,
  end: number,
  onChunk: (chunk: Buffer) => void,
): Promise<number> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(end - start, 1)));
    let pos = start;
    while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead === 0) break;
      onChunk(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return pos;
  } finally {
    await handle.close();
  }
}
