import type { BatonEvent } from "@baton/core";

type Listener = () => void;

const EMPTY: readonly BatonEvent[] = Object.freeze([]);

class SessionLog {
  readonly events: BatonEvent[] = [];
  readonly ids = new Set<string>();
  snapshot: readonly BatonEvent[] = EMPTY;
  dirty = false;
}

export type EventStoreOptions = {
  /** Runs a flush later; batches notifications (the app uses requestAnimationFrame). */
  schedule?: (flush: () => void) => void;
};

/**
 * Every event received, per session, ordered by `event.seq` and de-duplicated
 * by `event.id` (replays after a reconnect or daemon restart repeat events).
 * Listeners are notified once per batch, not once per event.
 */
export class EventStore {
  readonly #sessions = new Map<string, SessionLog>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #sessionListeners = new Set<Listener>();
  readonly #dirty = new Set<string>();
  readonly #schedule: (flush: () => void) => void;
  #scheduled = false;
  #newSession = false;

  constructor(options: EventStoreOptions = {}) {
    this.#schedule = options.schedule ?? queueMicrotask;
  }

  /** Adds one event; false if it was already there. */
  add(event: BatonEvent): boolean {
    let log = this.#sessions.get(event.sessionId);
    if (!log) {
      log = new SessionLog();
      this.#sessions.set(event.sessionId, log);
      this.#newSession = true;
    }
    if (log.ids.has(event.id)) return false;
    log.ids.add(event.id);
    insertBySeq(log.events, event);
    log.dirty = true;
    this.#dirty.add(event.sessionId);
    this.#requestFlush();
    return true;
  }

  /** Forgets a session (removed from the hub); its listeners see it empty. */
  remove(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) return;
    this.#dirty.add(sessionId);
    this.#newSession = true;
    this.#requestFlush();
  }

  /** A session's events. The same array until the session changes. */
  events(sessionId: string): readonly BatonEvent[] {
    const log = this.#sessions.get(sessionId);
    if (!log) return EMPTY;
    if (log.dirty) {
      log.snapshot = log.events.slice();
      log.dirty = false;
    }
    return log.snapshot;
  }

  /** `ts` of a session's newest event, if any. */
  lastTs(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.events.at(-1)?.ts;
  }

  sessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  /** Called after a batch that changed `sessionId`. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.#listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#listeners.set(sessionId, set);
    }
    const listeners = set;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Called after a batch that added a session the store hadn't seen. */
  subscribeSessions(listener: Listener): () => void {
    this.#sessionListeners.add(listener);
    return () => {
      this.#sessionListeners.delete(listener);
    };
  }

  #requestFlush(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.flush());
  }

  /** Notifies listeners of everything added since the last flush. */
  flush(): void {
    this.#scheduled = false;
    const dirty = [...this.#dirty];
    this.#dirty.clear();
    for (const id of dirty) for (const l of this.#listeners.get(id) ?? []) l();
    if (this.#newSession) {
      this.#newSession = false;
      for (const l of this.#sessionListeners) l();
    }
  }
}

/** Appends in the common case; binary-inserts an out-of-order event. */
function insertBySeq(events: BatonEvent[], event: BatonEvent): void {
  const last = events.at(-1);
  if (!last || last.seq <= event.seq) {
    events.push(event);
    return;
  }
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid]?.seq ?? 0) <= event.seq) lo = mid + 1;
    else hi = mid;
  }
  events.splice(lo, 0, event);
}
