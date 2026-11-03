import { CanvasKey, CanvasPoint, type CanvasPositions } from "@baton/core";
import type { Logger } from "pino";
import { loadVersioned, saveVersioned, type VersionedSpec } from "./versioned-file.js";

/** The canvas file. Version 0 was a bare `{ key: { x, y } }` object. */
export const CANVAS_FILE: VersionedSpec<CanvasPositions> = {
  what: "canvas",
  version: 1,
  migrations: [(data) => data],
  parse: (data) => {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    const value: CanvasPositions = {};
    let dropped = 0;
    for (const [key, point] of Object.entries(data)) {
      const k = CanvasKey.safeParse(key);
      const p = CanvasPoint.safeParse(point);
      if (k.success && p.success) value[k.data] = p.data;
      else dropped++;
    }
    return { value, dropped };
  },
};

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

  /** Reads the saved file, if any, upgrading older versions (see `loadVersioned`). */
  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    const positions = await loadVersioned(file, CANVAS_FILE, this.options.logger);
    if (positions) this.set(positions);
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
    const data = this.all();
    this.#saving = this.#saving.then(async () => {
      try {
        await saveVersioned(file, CANVAS_FILE.version, data);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save the canvas file");
      }
    });
  }
}
