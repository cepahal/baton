import { appendFile, mkdir, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BatonEvent } from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";

/** One event waiting to reach the team server. */
export type QueuedEvent = { backlog: boolean; event: BatonEvent };

/** A line of `queue.jsonl`. Read back from disk, so validated like any other input. */
const QueueLine = z.object({ b: z.literal(true).optional(), e: BatonEvent });
/** `queue.ack`: how many leading bytes of `queue.jsonl` the server has acknowledged. */
const AckFile = z.object({ ackedBytes: z.number().int().nonnegative() });

type Entry = QueuedEvent & { bytes: number };

export type DiskQueueOptions = {
  /** Directory for `queue.jsonl` and `queue.ack`; created if missing. */
  dir: string;
  /** `push` waits while the unacknowledged events take more than this. */
  maxBytes: number;
  logger: Logger;
};

/** Rewrite the file once this much of it is acknowledged and it is mostly dead. */
const COMPACT_BYTES = 4 * 1024 * 1024;

/**
 * Events on their way to a team server, kept on disk so neither a lost
 * connection nor a daemon crash loses them.
 *
 * Events are appended to `queue.jsonl` before `push` resolves (the watcher only
 * advances its saved offsets after that), and `queue.ack` records how much of
 * the file the server has acknowledged. After a restart everything past the
 * ack offset is sent again; the server skips ids it already holds.
 *
 * The queue is bounded: `push` waits for acks while it is over `maxBytes`, so
 * a long outage stalls the watcher instead of growing without limit. Nothing
 * is lost by waiting, because the transcripts themselves are the source.
 */
export class DiskQueue {
  readonly #file: string;
  readonly #ackFile: string;
  readonly #entries: Entry[] = [];
  /** Index of the first unacknowledged entry in `#entries`. */
  #head = 0;
  #bytes = 0;
  /** Bytes of `queue.jsonl` before the first unacknowledged line. */
  #ackedBytes = 0;
  /** Serializes file writes. */
  #io: Promise<void> = Promise.resolve();
  #waiters: (() => void)[] = [];
  #closed = false;

  private constructor(readonly options: DiskQueueOptions) {
    this.#file = join(options.dir, "queue.jsonl");
    this.#ackFile = join(options.dir, "queue.ack");
  }

  /** Opens the queue in `dir`, loading whatever an earlier run left unsent. */
  static async open(options: DiskQueueOptions): Promise<DiskQueue> {
    if (!(options.maxBytes > 0)) throw new RangeError("maxBytes must be positive");
    const queue = new DiskQueue(options);
    await mkdir(options.dir, { recursive: true });
    await queue.#load();
    return queue;
  }

  /** Unacknowledged events. */
  get size(): number {
    return this.#entries.length - this.#head;
  }

  /** Approximate bytes of unacknowledged events, including ones still being written. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Appends events and resolves once they are written. Waits first while the
   * queue is full, unless it is empty (one oversized batch must still fit) or
   * closing (shutdown must not hang, and dropping the events would lose them).
   */
  async push(items: readonly QueuedEvent[]): Promise<void> {
    if (items.length === 0) return;
    const lines = items.map((item) => `${JSON.stringify(toLine(item))}\n`);
    const entries = items.map((item, i) => ({
      ...item,
      bytes: Buffer.byteLength(lines[i] ?? ""),
    }));
    const added = entries.reduce((sum, e) => sum + e.bytes, 0);
    while (!this.#closed && this.#bytes > 0 && this.#bytes + added > this.options.maxBytes) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    // Counted now so a concurrent push sees the space as taken, but only
    // visible to `peek` (and compaction) once the lines are on disk.
    this.#bytes += added;
    try {
      await this.#write(async () => {
        await appendFile(this.#file, lines.join(""));
        this.#entries.push(...entries);
      });
    } catch (err) {
      this.#bytes -= added;
      throw err;
    }
  }

  /**
   * The oldest unacknowledged events, without removing them: up to
   * `maxEvents`, about `maxBytes`, all with the same `backlog` flag. At least
   * one event if the queue isn't empty.
   */
  peek(maxEvents: number, maxBytes: number): QueuedEvent[] {
    const out: QueuedEvent[] = [];
    let bytes = 0;
    for (let i = this.#head; i < this.#entries.length && out.length < maxEvents; i++) {
      const entry = this.#entries[i];
      if (!entry) break;
      if (out.length > 0 && (entry.backlog !== out[0]?.backlog || bytes + entry.bytes > maxBytes)) {
        break;
      }
      out.push({ backlog: entry.backlog, event: entry.event });
      bytes += entry.bytes;
    }
    return out;
  }

  /** Forgets the oldest `count` events: the server holds them. */
  async ack(count: number): Promise<void> {
    const n = Math.min(count, this.size);
    if (n <= 0) return;
    let freed = 0;
    for (let i = 0; i < n; i++) freed += this.#entries[this.#head + i]?.bytes ?? 0;
    this.#head += n;
    this.#bytes -= freed;
    this.#ackedBytes += freed;
    if (this.#head > 1024 && this.#head * 2 > this.#entries.length) {
      this.#entries.splice(0, this.#head);
      this.#head = 0;
    }
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
    await this.#write(() => this.#persistAck());
  }

  /** Stops waiting for space; later pushes write straight through. */
  async close(): Promise<void> {
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
    await this.#io;
  }

  #write(op: () => Promise<void>): Promise<void> {
    const next = this.#io.then(op);
    // Keep the chain alive after a failure; the caller still sees the error.
    this.#io = next.catch((err: unknown) => {
      this.options.logger.error({ err }, "could not write the send queue");
    });
    return next;
  }

  /** Records the ack offset, or empties the file once everything is acknowledged. */
  async #persistAck(): Promise<void> {
    if (this.size === 0) {
      await truncate(this.#file, 0);
      this.#ackedBytes = 0;
    } else if (this.#ackedBytes >= COMPACT_BYTES && this.#ackedBytes > this.#bytes) {
      const rest = this.#entries
        .slice(this.#head)
        .map((e) => `${JSON.stringify(toLine(e))}\n`)
        .join("");
      await atomicWrite(this.#file, rest);
      this.#ackedBytes = 0;
    }
    await atomicWrite(this.#ackFile, JSON.stringify({ ackedBytes: this.#ackedBytes }));
  }

  async #load(): Promise<void> {
    const ack = await readFile(this.#ackFile, "utf8").then(
      (text) => AckFile.safeParse(safeJson(text)),
      () => undefined,
    );
    const data = await readFile(this.#file).catch(() => Buffer.alloc(0));
    let start = ack?.success ? Math.min(ack.data.ackedBytes, data.length) : 0;
    // An ack offset that isn't at a line start means the files disagree; resend it all.
    if (start > 0 && data[start - 1] !== 0x0a) start = 0;
    this.#ackedBytes = start;

    // A crash mid-append can leave a partial last line. Cut it off so the next
    // append doesn't glue onto it; the watcher re-reads those events anyway,
    // since it only saves offsets after a push resolves.
    const end = data.lastIndexOf(0x0a) + 1;
    if (end < data.length) await truncate(this.#file, end);

    let skipped = 0;
    let offset = start;
    while (offset < end) {
      const nl = data.indexOf(0x0a, offset);
      const raw = data.subarray(offset, nl);
      const bytes = nl + 1 - offset;
      offset = nl + 1;
      const line = QueueLine.safeParse(safeJson(raw.toString("utf8")));
      if (!line.success) {
        skipped++;
        continue;
      }
      this.#entries.push({ backlog: line.data.b === true, event: line.data.e, bytes });
      this.#bytes += bytes;
    }
    if (this.size > 0 || skipped > 0) {
      this.options.logger.info(
        { events: this.size, bytes: this.#bytes, skipped },
        "loaded unsent events from the send queue",
      );
    }
  }
}

function toLine(item: QueuedEvent): z.infer<typeof QueueLine> {
  return item.backlog ? { b: true, e: item.event } : { e: item.event };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
