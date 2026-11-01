/**
 * Unicode-safe cutting. Strings are cut on code point boundaries, never in
 * the middle of a surrogate pair, so emoji and other astral characters survive.
 */

/** If text has more than `limit` code points: its first `keep` plus `…`. */
function cut(text: string, limit: number, keep: number): string {
  let count = 0;
  let end = 0; // UTF-16 length of the first `keep` code points
  for (const ch of text) {
    if (count === limit) return `${text.slice(0, end)}…`;
    count++;
    if (count <= keep) end += ch.length;
  }
  return text;
}

/** Cuts to at most `max` code points, the last one being `…` if cut. */
export const cutChars = (text: string, max: number): string => cut(text, max, max - 1);

/** Keeps the first `n` code points, adding `…` if anything was cut. */
export const keepChars = (text: string, n: number): string => cut(text, n, n);

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Cuts text longer than `maxBytes` UTF-8 bytes to fit, and appends a marker
 * saying how big it was: `… [truncated, 12345 bytes total]`.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  // Each UTF-16 code unit is at most 3 UTF-8 bytes, so short strings can skip the walk.
  if (text.length * 3 <= maxBytes) return text;
  const total = utf8Length(text);
  if (total <= maxBytes) return text;

  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = utf8Length(ch);
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return `${text.slice(0, end)}… [truncated, ${total} bytes total]`;
}
