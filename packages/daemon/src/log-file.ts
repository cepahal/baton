import { open, readFile, stat } from "node:fs/promises";
import * as zlib from "node:zlib";

const CHUNK_BYTES = 256 * 1024;

/** `x.jsonl.zst` → `x.jsonl`. Codex compresses an idle rollout under that name. */
export const livePath = (path: string): string => path.replace(/\.zst$/i, "");
/** `x.jsonl` → `x.jsonl.zst`. */
export const compressedPath = (path: string): string => `${livePath(path)}.zst`;
export const isCompressed = (path: string): boolean => /\.zst$/i.test(path);

/** A session log opened for reading: a plain file read in place, or a `.zst` decompressed whole. */
export type LogFile = {
  readonly path: string;
  /** Bytes of log text; for `.zst`, the decompressed size. */
  readonly size: number;
  /**
   * File identity, to spot a replaced file. `undefined` for `.zst`: offsets
   * count bytes of the text, which the compressed copy shares with the original.
   */
  readonly ino: string | undefined;
  /** Feeds `[start, end)` to `onChunk`; returns where reading stopped (end, or EOF if sooner). */
  read(start: number, end: number, onChunk: (chunk: Buffer) => void): Promise<number>;
};

/** Size and identity of a plain file. */
export async function fileIdentity(
  path: string,
): Promise<{ size: number; ino: string | undefined }> {
  const s = await stat(path, { bigint: true });
  return { size: Number(s.size), ino: s.ino === 0n ? undefined : s.ino.toString() };
}

export async function openLog(path: string): Promise<LogFile> {
  if (isCompressed(path)) {
    const text = await zstdDecompress(await readFile(path));
    return {
      path,
      size: text.length,
      ino: undefined,
      read: async (start, end, onChunk) => {
        const stop = Math.min(end, text.length);
        for (let pos = start; pos < stop; pos += CHUNK_BYTES) {
          onChunk(text.subarray(pos, Math.min(pos + CHUNK_BYTES, stop)));
        }
        return Math.max(start, stop);
      },
    };
  }
  const { size, ino } = await fileIdentity(path);
  return { path, size, ino, read: (start, end, onChunk) => readRange(path, start, end, onChunk) };
}

/** Thrown for `.zst` logs when this Node has no zstd (it arrived in 22.15 / 23.8). */
export class ZstdUnavailableError extends Error {
  readonly code = "ERR_BATON_NO_ZSTD";
  constructor() {
    super("this Node.js has no zstd support (needs 22.15+), so .zst session logs are skipped");
  }
}

/** Can this Node.js read `.zst` logs? */
export const zstdAvailable = (): boolean =>
  typeof Reflect.get(zlib, "zstdDecompress") === "function";

/** `zlib.zstdDecompress`, looked up at runtime: Baton supports Node versions without it. */
function zstdDecompress(input: Buffer): Promise<Buffer> {
  const fn: unknown = Reflect.get(zlib, "zstdDecompress");
  if (typeof fn !== "function") return Promise.reject(new ZstdUnavailableError());
  return new Promise((resolve, reject) => {
    fn.call(zlib, input, (err: unknown, out: unknown) => {
      if (err) reject(err);
      else if (Buffer.isBuffer(out)) resolve(out);
      else reject(new Error("zstdDecompress returned no buffer"));
    });
  });
}

async function readRange(
  path: string,
  start: number,
  end: number,
  onChunk: (chunk: Buffer) => void,
): Promise<number> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(end - start, 1)));
    let pos = start;
    while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead === 0) break;
      onChunk(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return pos;
  } finally {
    await handle.close();
  }
}
