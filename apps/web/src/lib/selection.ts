import type { SessionInfo } from "@baton/core";
import { z } from "zod";
import { isLive } from "./time.js";

export const SELECTION_KEY = "baton.selectedSessions";
const Stored = z.array(z.string()).catch([]);

export type SelectionStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Which sessions have a column open, remembered across reloads. Storage is
 * written only when the selection changes, never on load, so "nothing
 * remembered" survives until a default or the user picks something.
 */
export class Selection {
  readonly #storage: SelectionStorage | undefined;
  readonly #max: number;
  readonly #listeners = new Set<() => void>();
  #ids: string[];
  #initialized: boolean;

  constructor(storage: SelectionStorage | undefined, max: number) {
    this.#storage = storage;
    this.#max = max;
    const stored = this.#load();
    this.#initialized = stored !== undefined;
    this.#ids = (stored ?? []).slice(0, max);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get = (): string[] => this.#ids;

  toggle = (id: string): void => {
    const s = this.#ids;
    if (s.includes(id)) this.#set(s.filter((x) => x !== id));
    else if (s.length < this.#max) this.#set([...s, id]);
  };

  /** Adds a session if there's room; a no-op if it's already there. */
  add = (id: string): void => {
    if (!this.#ids.includes(id) && this.#ids.length < this.#max) this.#set([...this.#ids, id]);
  };

  remove = (id: string): void => {
    if (this.#ids.includes(id)) this.#set(this.#ids.filter((x) => x !== id));
  };

  /** Sets a default selection once, only if nothing was remembered or picked. */
  initialize = (ids: string[]): void => {
    if (this.#initialized) return;
    this.#set(ids.slice(0, this.#max));
  };

  #set(ids: string[]): void {
    this.#initialized = true;
    this.#ids = ids;
    try {
      this.#storage?.setItem(SELECTION_KEY, JSON.stringify(ids));
    } catch {
      // Storage may be full or unavailable; the selection just won't persist.
    }
    for (const l of this.#listeners) l();
  }

  #load(): string[] | undefined {
    try {
      const raw = this.#storage?.getItem(SELECTION_KEY) ?? null;
      return raw === null ? undefined : Stored.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}

/**
 * The first-visit default: sessions live right now. Undefined until a
 * `/sessions` fetch has succeeded, so an unreachable daemon doesn't decide it.
 */
export function defaultSelection(
  state: { sessions: SessionInfo[]; loaded: boolean; error?: string },
  now: number,
  max: number,
): string[] | undefined {
  if (!state.loaded || state.error !== undefined) return undefined;
  return state.sessions
    .filter((s) => isLive(s.lastActivity, now))
    .slice(0, max)
    .map((s) => s.sessionId);
}
