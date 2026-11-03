/** Image types a viewer shows inline, told apart by their first bytes. */
export type InlineImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

/**
 * The image type a file's magic bytes say it is, or undefined. Only PNG, JPEG,
 * GIF and WebP: SVG is markup (it can carry script) and is never an image here.
 */
export function sniffImage(bytes: Uint8Array): InlineImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    if (bytes[5] === 0x61) return "image/gif";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * The first `max` characters of a file as ASCII, past any byte-order mark;
 * UTF-16 files are read every other byte. Enough to spot markup tags, which
 * are ASCII. (Core has no TextDecoder: it's pure and environment-free.)
 */
function asciiHead(bytes: Uint8Array, max: number): string {
  let start = 0;
  let step = 1;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  else if (startsWith(bytes, [0xff, 0xfe])) [start, step] = [2, 2];
  else if (startsWith(bytes, [0xfe, 0xff])) [start, step] = [3, 2];
  let out = "";
  for (let i = start; i < bytes.length && out.length < max; i += step) {
    const b = bytes[i] ?? 0;
    out += b < 0x80 ? String.fromCharCode(b) : "�";
  }
  return out;
}

/**
 * Whether a file starts as an HTML or SVG document, which a browser could
 * render as a page. Such uploads are refused outright: even served as a
 * download there's no reason a sticky note needs one. Plain XML, and source
 * files that merely mention `<svg>`, are fine.
 */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = asciiHead(bytes, 1024).trimStart().toLowerCase();
  if (/^<(?:!doctype\s+html|html|head|body|script|svg|iframe)\b/.test(head)) return true;
  // An XML prolog (and comments) followed by an SVG root.
  const body = head.replace(/^(?:<\?xml[^>]*>|<!--[\s\S]*?-->|\s)+/, "");
  return /^<(?:!doctype\s+svg|svg)\b/.test(body);
}
