import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * How one saved JSON file is versioned. Files are written as
 * `{ "version": n, "data": … }`. A file without that envelope is version 0:
 * the bare format every store wrote before versioning existed.
 */
export type VersionedSpec<T> = {
  /** Used in log messages, e.g. "notes". */
  what: string;
  /** Version written by this build. */
  version: number;
  /**
   * `migrations[n]` turns version-n data into version n+1, so there is one
   * per version below `version`. Each step only reshapes; `parse` validates.
   */
  migrations: readonly ((data: unknown) => unknown)[];
  /**
   * Reads current-version data leniently: records that fail their schema are
   * skipped and counted, never fatal. Undefined when the shape is wrong as a
   * whole (e.g. not an array).
   */
  parse(data: unknown): { value: T; dropped: number } | undefined;
};

/** The saved file was written by a newer Baton; loading it would lose what it knows. */
export class NewerFileError extends Error {
  constructor(
    readonly file: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `${file} was written by a newer version of Baton (file version ${found}, this build reads up to ${supported}). Update Baton, or restore an older backup.`,
    );
    this.name = "NewerFileError";
  }
}

const Envelope = z.object({ version: z.number().int().nonnegative(), data: z.unknown() });

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

/**
 * Loads a versioned file: missing means `undefined`. Never loses data on the
 * way in:
 *
 * - unreadable JSON, or data of the wrong shape, is renamed aside to
 *   `<file>.corrupt-<time>` before starting empty, so the next save can't
 *   overwrite it;
 * - an older version is copied to `<file>.v<n>.bak`, then migrated;
 * - records skipped as invalid are kept in a `<file>.dropped-<time>` copy;
 * - a newer version throws `NewerFileError` (the caller should refuse to start).
 *
 * Read errors other than "missing" (permissions, I/O) are thrown too: starting
 * empty would mean overwriting the file on the next save.
 */
export async function loadVersioned<T>(
  file: string,
  spec: VersionedSpec<T>,
  logger?: Logger,
  now: () => Date = () => new Date(),
): Promise<T | undefined> {
  if (spec.migrations.length !== spec.version) {
    throw new Error(
      `${spec.what}: need ${spec.version} migrations, have ${spec.migrations.length}`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    await setAside(file, "corrupt", now, logger, spec.what, "is not valid JSON");
    return undefined;
  }
  const envelope = Envelope.safeParse(json);
  let version = envelope.success ? envelope.data.version : 0;
  let data = envelope.success ? envelope.data.data : json;
  if (version > spec.version) throw new NewerFileError(file, version, spec.version);
  if (version < spec.version) {
    await copyFile(file, `${file}.v${version}.bak`);
    logger?.info(
      { file, from: version, to: spec.version },
      `upgrading the ${spec.what} file (the old copy is kept as .v${version}.bak)`,
    );
    try {
      while (version < spec.version) {
        const step = spec.migrations[version];
        if (step === undefined) throw new Error(`no migration from version ${version}`);
        data = step(data);
        version++;
      }
    } catch (err) {
      logger?.warn({ err, file }, `could not upgrade the ${spec.what} file`);
      await setAside(file, "corrupt", now, logger, spec.what, "could not be upgraded");
      return undefined;
    }
  }
  const parsed = spec.parse(data);
  if (!parsed) {
    await setAside(file, "corrupt", now, logger, spec.what, "has the wrong shape");
    return undefined;
  }
  if (parsed.dropped > 0) {
    const copy = `${file}.dropped-${stamp(now())}`;
    await copyFile(file, copy);
    logger?.warn(
      { file, dropped: parsed.dropped, copy },
      `skipped ${parsed.dropped} invalid record(s) in the ${spec.what} file; the original is kept`,
    );
  }
  return parsed.value;
}

async function setAside(
  file: string,
  tag: string,
  now: () => Date,
  logger: Logger | undefined,
  what: string,
  why: string,
): Promise<void> {
  const aside = `${file}.${tag}-${stamp(now())}`;
  await rename(file, aside);
  logger?.warn(
    { file, aside },
    `the ${what} file ${why}; it was moved aside and Baton starts empty`,
  );
}

/** Writes `{ version, data }` atomically (temp file, then rename). */
export async function saveVersioned(file: string, version: number, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ version, data }));
  await rename(tmp, file);
}

/** `parse` for an array of records: each checked alone, invalid ones skipped, at most `max` kept. */
export function parseRecords<S extends z.ZodType>(
  schema: S,
  max: number,
): (data: unknown) => { value: z.infer<S>[]; dropped: number } | undefined {
  return (data) => {
    if (!Array.isArray(data)) return undefined;
    const value: z.infer<S>[] = [];
    let dropped = 0;
    for (const item of data) {
      const r = schema.safeParse(item);
      if (r.success && value.length < max) value.push(r.data);
      else dropped++;
    }
    return { value, dropped };
  };
}
