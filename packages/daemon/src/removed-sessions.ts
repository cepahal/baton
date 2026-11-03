import type { Logger } from "pino";
import { z } from "zod";
import {
  loadVersioned,
  parseRecords,
  saveVersioned,
  type VersionedSpec,
} from "./versioned-file.js";

/** Removed sessions remembered; past it the oldest are forgotten. */
export const MAX_REMOVED = 10_000;

export const REMOVED_FILE: VersionedSpec<string[]> = {
  what: "removed sessions",
  version: 1,
  migrations: [(data) => data],
  parse: parseRecords(z.string().min(1).max(512), MAX_REMOVED),
};

/**
 * Sessions someone removed from the hub. Their events are dropped on
 * arrival, so a daemon resending its backlog can't bring one back.
 */
export class RemovedSessions {
  readonly #ids = new Set<string>();
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: { file?: string; logger?: Logger } = {}) {}

  async load(): Promise<void> {
    if (this.options.file === undefined) return;
    for (const id of (await loadVersioned(this.options.file, REMOVED_FILE, this.options.logger)) ??
      []) {
      this.#ids.add(id);
    }
  }

  has(sessionId: string): boolean {
    return this.#ids.has(sessionId);
  }

  add(sessionId: string): void {
    this.#ids.delete(sessionId);
    this.#ids.add(sessionId);
    while (this.#ids.size > MAX_REMOVED) {
      const oldest = this.#ids.values().next().value;
      if (oldest === undefined) break;
      this.#ids.delete(oldest);
    }
    const file = this.options.file;
    if (file === undefined) return;
    const data = [...this.#ids];
    this.#saving = this.#saving.then(() =>
      saveVersioned(file, REMOVED_FILE.version, data).catch((err: unknown) => {
        this.options.logger?.warn({ err, file }, "could not save removed sessions");
      }),
    );
  }

  async flush(): Promise<void> {
    await this.#saving;
  }
}
