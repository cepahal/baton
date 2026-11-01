import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

export const FileState = z.object({
  /** Bytes up to the end of the last complete line already delivered. */
  offset: z.number().int().nonnegative(),
  /** File identity (inode / NTFS file id) when the offset was taken, to spot replaced files. */
  ino: z.string().optional(),
});
export type FileState = z.infer<typeof FileState>;

const StateFile = z.object({
  version: z.literal(1),
  files: z.record(z.string(), FileState),
});

/** Per-file read offsets, kept in a small JSON file so a restart doesn't replay everything. */
export class StateStore {
  readonly #files: Map<string, FileState>;
  #timer: NodeJS.Timeout | undefined;
  #saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly path: string,
    files: Map<string, FileState>,
    readonly saveDelayMs: number,
    readonly logger: Logger,
  ) {
    this.#files = files;
  }

  /** Loads the state file. A missing or unreadable file starts empty (logged, never fatal). */
  static async load(path: string, logger: Logger, saveDelayMs = 500): Promise<StateStore> {
    let files = new Map<string, FileState>();
    try {
      const parsed = StateFile.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (parsed.success) files = new Map(Object.entries(parsed.data.files));
      else logger.warn({ path }, "state file is not valid; starting fresh");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ path, err }, "could not read state file; starting fresh");
      }
    }
    return new StateStore(path, files, saveDelayMs, logger);
  }

  get(key: string): FileState | undefined {
    return this.#files.get(key);
  }

  keys(): string[] {
    return [...this.#files.keys()];
  }

  set(key: string, state: FileState): void {
    const prev = this.#files.get(key);
    if (prev?.offset === state.offset && prev.ino === state.ino) return;
    this.#files.set(key, state);
    this.#scheduleSave();
  }

  delete(key: string): void {
    if (this.#files.delete(key)) this.#scheduleSave();
  }

  /** Writes pending changes now. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#saving = this.#saving.then(() => this.#write());
    }
    await this.#saving;
  }

  #scheduleSave(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#saving = this.#saving.then(() => this.#write());
    }, this.saveDelayMs);
  }

  /** Atomic: write a temp file, then rename over the old one. */
  async #write(): Promise<void> {
    const body: z.infer<typeof StateFile> = { version: 1, files: Object.fromEntries(this.#files) };
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(body)}\n`);
      await rename(tmp, this.path);
    } catch (err) {
      this.logger.warn({ path: this.path, err }, "could not save state file");
    }
  }
}
