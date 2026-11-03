import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobId } from "@baton/core";
import type { Logger } from "pino";

/** Most bytes kept across every file; uploads past it are refused. */
export const BLOBS_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * Files pinned to sticky notes, stored by the SHA-256 of their bytes: the same
 * file uploaded twice is kept once. A folder, not a database. Without a folder
 * the files live in memory (tests, and hubs started without a state dir).
 */
export class BlobStore {
  readonly #memory = new Map<string, Buffer>();
  /** When each file was last uploaded; sweeps spare recent ones not yet on a note. */
  readonly #uploaded = new Map<string, number>();
  #total: number | undefined;

  constructor(
    readonly options: {
      dir?: string;
      logger?: Logger;
      maxTotalBytes?: number;
      /** How long a fresh upload is safe from sweeps before it's attached. Default 10 minutes. */
      graceMs?: number;
      now?: () => number;
    } = {},
  ) {}

  /** Stores bytes; returns their id, or undefined when the store is full. */
  async put(bytes: Buffer): Promise<string | undefined> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (await this.has(sha256)) {
      this.#uploaded.set(sha256, this.#now());
      return sha256;
    }
    const total = await this.#totalBytes();
    if (total + bytes.length > (this.options.maxTotalBytes ?? BLOBS_MAX_TOTAL_BYTES)) {
      return undefined;
    }
    const dir = this.options.dir;
    if (dir === undefined) {
      this.#memory.set(sha256, Buffer.from(bytes));
    } else {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${sha256}.${process.pid}.tmp`);
      await writeFile(tmp, bytes);
      await rename(tmp, join(dir, sha256));
    }
    this.#total = total + bytes.length;
    this.#uploaded.set(sha256, this.#now());
    return sha256;
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  async has(sha256: string): Promise<boolean> {
    if (!BlobId.safeParse(sha256).success) return false;
    const dir = this.options.dir;
    if (dir === undefined) return this.#memory.has(sha256);
    try {
      return (await stat(join(dir, sha256))).isFile();
    } catch {
      return false;
    }
  }

  /** The file's bytes, or undefined if it isn't held. Ids are checked, never paths. */
  async read(sha256: string): Promise<Buffer | undefined> {
    if (!BlobId.safeParse(sha256).success) return undefined;
    const dir = this.options.dir;
    if (dir === undefined) return this.#memory.get(sha256);
    try {
      return await readFile(join(dir, sha256));
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes every file not in `keepIds`, except fresh uploads not attached to
   * anything yet: an upload is pinned to its note by a second request, and a
   * sweep someone else starts in between must not take it. A file that was
   * attached once gets no grace, so taking its note down removes it at once.
   * Returns how many went.
   */
  async sweep(keepIds: ReadonlySet<string>): Promise<number> {
    const cutoff = this.#now() - (this.options.graceMs ?? 10 * 60_000);
    const keep = new Set(keepIds);
    for (const [id, at] of this.#uploaded) {
      if (keepIds.has(id) || at < cutoff) this.#uploaded.delete(id);
      else keep.add(id);
    }
    let removed = 0;
    const dir = this.options.dir;
    if (dir === undefined) {
      for (const id of [...this.#memory.keys()]) {
        if (keep.has(id)) continue;
        this.#memory.delete(id);
        removed++;
      }
    } else {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!BlobId.safeParse(name).success || keep.has(name)) continue;
        await rm(join(dir, name), { force: true }).catch((err: unknown) => {
          this.options.logger?.warn({ err, name }, "could not delete a note file");
        });
        removed++;
      }
    }
    if (removed > 0) this.#total = undefined;
    return removed;
  }

  async #totalBytes(): Promise<number> {
    if (this.#total !== undefined) return this.#total;
    let total = 0;
    const dir = this.options.dir;
    if (dir === undefined) {
      for (const b of this.#memory.values()) total += b.length;
    } else {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!BlobId.safeParse(name).success) continue;
        total += await stat(join(dir, name)).then(
          (s) => s.size,
          () => 0,
        );
      }
    }
    this.#total = total;
    return total;
  }
}
