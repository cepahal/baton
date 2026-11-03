import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Handoff } from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";

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

const StoreFile = z.object({ records: z.array(HandoffRecord) });

/** Handoffs by id, oldest first. With a file, saved there so they survive restarts. */
export class HandoffStore {
  readonly #records = new Map<string, HandoffRecord>();
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: { file?: string; logger?: Logger } = {}) {}

  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger?.warn({ err, file }, "could not read the handoff file");
      }
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = StoreFile.safeParse(json);
    if (!parsed.success) {
      this.options.logger?.warn({ file }, "ignoring an invalid handoff file");
      return;
    }
    for (const r of parsed.data.records) this.#records.set(r.handoff.id, r);
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
    const data = JSON.stringify({ records: [...this.#records.values()] });
    this.#saving = this.#saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, file);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save handoffs");
      }
    });
  }
}
