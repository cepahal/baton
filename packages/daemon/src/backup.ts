import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BlobId } from "@baton/core";
import type { Logger } from "pino";

export const DAY_MS = 24 * 60 * 60_000;
/** Snapshots kept by default: a week of nightly ones. */
export const DEFAULT_BACKUP_KEEP = 7;

export type BackupOptions = {
  /** JSON state files to copy (missing ones are skipped). */
  files: readonly string[];
  /** The note files folder (content-addressed). */
  blobsDir: string;
  /** Where snapshots go: one folder per snapshot plus a shared `blobs/`. */
  backupDir: string;
  keep?: number;
  intervalMs?: number;
  /** Writes pending changes first, so a snapshot is current. */
  flush?: () => Promise<void>;
  logger?: Logger;
  now?: () => Date;
};

/** Snapshot folders are named by time, so sorting them sorts by age. */
const SNAPSHOT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const BLOB_LIST = "blobs.txt";

const stampOf = (d: Date) => d.toISOString().replace(/[:.]/g, "-");
const timeOf = (name: string) =>
  Date.parse(name.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, "$1:$2:$3.$4"));

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

/** Snapshot folders, oldest first. */
export async function snapshots(backupDir: string): Promise<string[]> {
  return (await list(backupDir)).filter((n) => SNAPSHOT.test(n)).sort();
}

/**
 * Copies the state files into `<backupDir>/<time>/` and any note files not
 * yet backed up into `<backupDir>/blobs/` (each file once, however many
 * snapshots need it). Then drops snapshots past `keep`, and backed-up note
 * files no remaining snapshot lists. Returns the snapshot folder.
 */
export async function snapshot(options: BackupOptions): Promise<string> {
  await options.flush?.();
  const now = options.now?.() ?? new Date();
  const dest = join(options.backupDir, stampOf(now));
  await mkdir(dest, { recursive: true });
  for (const file of options.files) {
    await copyFile(file, join(dest, basename(file))).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
  const blobs = (await list(options.blobsDir)).filter((n) => BlobId.safeParse(n).success);
  const store = join(options.backupDir, "blobs");
  await mkdir(store, { recursive: true });
  const have = new Set(await list(store));
  for (const id of blobs) {
    if (!have.has(id)) await copyFile(join(options.blobsDir, id), join(store, id));
  }
  await writeFile(join(dest, BLOB_LIST), blobs.length > 0 ? `${blobs.join("\n")}\n` : "");
  await prune(options);
  return dest;
}

async function prune(options: BackupOptions): Promise<void> {
  const all = await snapshots(options.backupDir);
  const keep = Math.max(1, options.keep ?? DEFAULT_BACKUP_KEEP);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    await rm(join(options.backupDir, old), { recursive: true, force: true });
  }
  const needed = new Set<string>();
  for (const s of await snapshots(options.backupDir)) {
    const listed = await readFile(join(options.backupDir, s, BLOB_LIST), "utf8").catch(() => "");
    for (const id of listed.split("\n")) if (id) needed.add(id);
  }
  const store = join(options.backupDir, "blobs");
  for (const id of await list(store)) {
    if (!needed.has(id)) await rm(join(store, id), { force: true });
  }
}

/**
 * Takes a snapshot now if the newest is older than the interval (a server
 * that restarts nightly still gets one a day), then one per interval.
 */
export function startBackups(options: BackupOptions): { stop(): void; ready: Promise<void> } {
  const interval = options.intervalMs ?? DAY_MS;
  const run = async () => {
    try {
      const dest = await snapshot(options);
      options.logger?.info({ dest }, "backed up the team server's notes, handoffs and canvas");
    } catch (err) {
      options.logger?.error({ err, backupDir: options.backupDir }, "backup failed");
    }
  };
  const ready = (async () => {
    const newest = (await snapshots(options.backupDir)).at(-1);
    const age = newest ? (options.now?.() ?? new Date()).getTime() - timeOf(newest) : Infinity;
    if (!(age < interval)) await run();
  })();
  const timer = setInterval(() => void run(), interval);
  timer.unref();
  return { stop: () => clearInterval(timer), ready };
}
