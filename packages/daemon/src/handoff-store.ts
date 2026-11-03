import { Handoff } from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";
import {
  loadVersioned,
  parseRecords,
  saveVersioned,
  type VersionedSpec,
} from "./versioned-file.js";

/** Handoffs kept; beyond it the oldest go. */
export const MAX_HANDOFFS = 500;

/** A stored handoff plus what only the server needs: who sends and who receives. */
export const HandoffRecord = z.object({
  handoff: Handoff,
  /** Daemon running the sending session (team server); absent locally. */
  fromDaemon: z.string().optional(),
  /** Daemon running the receiving session (team server); absent locally. */
  toDaemon: z.string().optional(),
});
export type HandoffRecord = z.infer<typeof HandoffRecord>;

/** The handoffs file. Version 0 was `{ records: [...] }`; version 1 is the bare array. */
export const HANDOFFS_FILE: VersionedSpec<HandoffRecord[]> = {
  what: "handoffs",
  version: 1,
  migrations: [
    (data) =>
      typeof data === "object" && data !== null && "records" in data ? data.records : undefined,
  ],
  parse: parseRecords(HandoffRecord, MAX_HANDOFFS),
};

/** Handoffs by id, oldest first. With a file, saved there so they survive restarts. */
export class HandoffStore {
  readonly #records = new Map<string, HandoffRecord>();
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: { file?: string; logger?: Logger } = {}) {}

  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    const records = await loadVersioned(file, HANDOFFS_FILE, this.options.logger);
    for (const r of records ?? []) this.#records.set(r.handoff.id, r);
  }

  get(id: string): HandoffRecord | undefined {
    return this.#records.get(id);
  }

  /** Newest first. */
  list(): HandoffRecord[] {
    return [...this.#records.values()].reverse();
  }

  /** Adds or replaces a record. */
  put(record: HandoffRecord): void {
    const id = record.handoff.id;
    this.#records.delete(id);
    this.#records.set(id, record);
    while (this.#records.size > MAX_HANDOFFS) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
    this.#save();
  }

  async flush(): Promise<void> {
    await this.#saving;
  }

  #save(): void {
    const file = this.options.file;
    if (file === undefined) return;
    const data = [...this.#records.values()];
    this.#saving = this.#saving.then(async () => {
      try {
        await saveVersioned(file, HANDOFFS_FILE.version, data);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save handoffs");
      }
    });
  }
}
