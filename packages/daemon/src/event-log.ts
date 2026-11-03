import { randomUUID } from "node:crypto";
import type { BatonEvent } from "@baton/core";

/** One event as the hub numbered it. */
export type LogEntry = { seq: number; backlog: boolean; event: BatonEvent };

/**
 * Where the hub keeps numbered events for replay. Owns the hub-wide `seq` and
 * the `epoch` that says which seqs a client's `lastSeq` can be compared with.
 *
 * `MemoryEventLog` is the only implementation today, so a daemon restart means
 * a new epoch and clients replay everything. A persistent log (a file or
 * SQLite under the state dir) can implement this interface to keep the epoch,
 * seqs and history across restarts; the hub and watcher don't change. Because
 * `append` skips event ids it already holds for that session, the history the
 * watcher publishes again after a restart is deduplicated rather than replayed
 * twice. Ids are only unique within a session (docs/spec.md): a forked Codex
 * thread repeats its parent's item ids, so two sessions may share one.
 */
export interface EventLog {
  /** Seqs are only comparable within one epoch. */
  readonly epoch: string;
  /** Latest seq assigned; 0 before any event. */
  readonly lastSeq: number;
  /** Seq of the oldest entry still held; `lastSeq + 1` when empty. */
  readonly firstSeq: number;
  /** Numbers and stores an event. Returns `undefined` if its id is already held. */
  append(event: BatonEvent, backlog: boolean): LogEntry | undefined;
  /** Up to `limit` entries with seq > `after`, oldest first. */
  read(after: number, limit: number): LogEntry[];
  /**
   * Drops every held event of one session. Other events keep their seqs;
   * the removed ones read as absent. Returns how many went.
   */
  forgetSession(sessionId: string): number;
}

export type MemoryEventLogOptions = {
  /** Approximate memory budget (JSON size of the events). */
  maxBytes: number;
  /** Optional cap on the number of events as well. */
  maxEvents?: number | undefined;
  /** Called the first time the log has to drop old events. */
  onEvict?: (info: { seq: number; bytes: number; events: number }) => void;
};

/** Rough per-entry cost beyond the event's JSON (object headers, the id index). */
const ENTRY_OVERHEAD_BYTES = 200;

/** A held event, or the hole a forgotten one leaves (its seq stays taken). */
type Stored = (LogEntry & { bytes: number }) | { seq: number; hole: true; bytes: 0 };

const isHole = (s: Stored): s is Extract<Stored, { hole: true }> => "hole" in s;

/**
 * Keeps events in memory, dropping the oldest once the byte budget (or event
 * cap) is exceeded. The newest event is always kept.
 */
export class MemoryEventLog implements EventLog {
  readonly epoch = randomUUID();
  readonly #entries: (Stored | undefined)[] = [];
  /** Index of the oldest live entry; the array is compacted occasionally. */
  #head = 0;
  /** `dedupeKey` of every held event. */
  readonly #ids = new Set<string>();
  #bytes = 0;
  #lastSeq = 0;
  #evicted = false;

  constructor(readonly options: MemoryEventLogOptions) {
    if (!(options.maxBytes > 0)) throw new RangeError("maxBytes must be positive");
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get firstSeq(): number {
    return this.#entries[this.#head]?.seq ?? this.#lastSeq + 1;
  }

  /** Events held. */
  get size(): number {
    return this.#entries.length - this.#head;
  }

  /** Approximate bytes held. */
  get bytes(): number {
    return this.#bytes;
  }

  append(event: BatonEvent, backlog: boolean): LogEntry | undefined {
    const key = dedupeKey(event);
    if (this.#ids.has(key)) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(event)) + ENTRY_OVERHEAD_BYTES;
    const stored: Stored = { seq: ++this.#lastSeq, backlog, event, bytes };
    this.#entries.push(stored);
    this.#ids.add(key);
    this.#bytes += bytes;
    this.#evict();
    return { seq: stored.seq, backlog, event };
  }

  read(after: number, limit: number): LogEntry[] {
    const out: LogEntry[] = [];
    // Holes are skipped, so keep going until `limit` real entries or the end.
    for (let i = this.#indexAfter(after); i < this.#entries.length && out.length < limit; i++) {
      const s = this.#entries[i];
      if (s && !isHole(s)) out.push({ seq: s.seq, backlog: s.backlog, event: s.event });
    }
    return out;
  }

  forgetSession(sessionId: string): number {
    let removed = 0;
    for (let i = this.#head; i < this.#entries.length; i++) {
      const s = this.#entries[i];
      if (!s || isHole(s) || s.event.sessionId !== sessionId) continue;
      this.#entries[i] = { seq: s.seq, hole: true, bytes: 0 };
      this.#bytes -= s.bytes;
      this.#ids.delete(dedupeKey(s.event));
      removed++;
    }
    return removed;
  }

  /** Index of the first live entry with seq > `after` (seqs are contiguous). */
  #indexAfter(after: number): number {
    const first = this.firstSeq;
    return this.#head + Math.max(0, after + 1 - first);
  }

  #evict(): void {
    const { maxBytes, maxEvents } = this.options;
    const over = () =>
      this.size > 1 &&
      (this.#bytes > maxBytes || (maxEvents !== undefined && this.size > maxEvents));
    if (!over()) return;
    if (!this.#evicted) {
      this.#evicted = true;
      this.options.onEvict?.({ seq: this.firstSeq, bytes: this.#bytes, events: this.size });
    }
    while (over()) {
      const oldest = this.#entries[this.#head];
      if (!oldest) break;
      this.#entries[this.#head] = undefined;
      this.#head++;
      this.#bytes -= oldest.bytes;
      if (!isHole(oldest)) this.#ids.delete(dedupeKey(oldest.event));
    }
    // Compact once the dead prefix is large, so shifting stays amortized O(1).
    if (this.#head > 1024 && this.#head * 2 > this.#entries.length) {
      this.#entries.splice(0, this.#head);
      this.#head = 0;
    }
  }
}

/** Event ids are unique within a session, so duplicates are found per session. */
const dedupeKey = (event: BatonEvent): string => `${event.sessionId}\u0000${event.id}`;
