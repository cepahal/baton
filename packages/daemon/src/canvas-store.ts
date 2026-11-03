import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CanvasPositions } from "@baton/core";
import type { Logger } from "pino";

/** Most node positions kept; beyond it the least recently moved go. */
export const MAX_CANVAS_NODES = 5000;

/**
 * Where viewers put each canvas node, shared by everyone on the hub. Kept in
 * memory and, given a file, saved there (debounced) so it survives restarts.
 */
export class CanvasStore {
  readonly #positions = new Map<string, { x: number; y: number }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: { file?: string; logger?: Logger; saveDelayMs?: number } = {}) {}

  /** Reads the saved file, if any. A missing or corrupt file starts empty. */
  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    try {
      const parsed = CanvasPositions.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success) this.set(parsed.data);
      else this.options.logger?.warn({ file }, "ignoring an invalid canvas file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger?.warn({ err, file }, "could not read the canvas file");
      }
    }
  }

  all(): CanvasPositions {
    return Object.fromEntries(this.#positions);
  }

  get size(): number {
    return this.#positions.size;
  }

  /** Stores moved nodes; returns the ones that actually changed. */
  set(moved: CanvasPositions): CanvasPositions {
    const changed: CanvasPositions = {};
    for (const [key, p] of Object.entries(moved)) {
      const prev = this.#positions.get(key);
      if (prev && prev.x === p.x && prev.y === p.y) continue;
      this.#positions.delete(key);
      this.#positions.set(key, { x: p.x, y: p.y });
      changed[key] = { x: p.x, y: p.y };
    }
    while (this.#positions.size > MAX_CANVAS_NODES) {
      const oldest = this.#positions.keys().next().value;
      if (oldest === undefined) break;
      this.#positions.delete(oldest);
    }
    if (Object.keys(changed).length > 0) this.#scheduleSave();
    return changed;
  }

  /** Forgets nodes; returns the keys that were there. */
  remove(keys: readonly string[]): string[] {
    const removed = keys.filter((k) => this.#positions.delete(k));
    if (removed.length > 0) this.#scheduleSave();
    return removed;
  }

  /** Writes any pending change now. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#save();
    }
    await this.#saving;
  }

  #scheduleSave(): void {
    if (this.options.file === undefined || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#save();
    }, this.options.saveDelayMs ?? 500);
    this.#timer.unref?.();
  }

  #save(): void {
    const file = this.options.file;
    if (file === undefined) return;
    const data = JSON.stringify(this.all());
    this.#saving = this.#saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, file);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save the canvas file");
      }
    });
  }
}
