const LF = 0x0a;
const CR = 0x0d;

/**
 * Splits a byte stream into complete lines. A trailing partial line is kept,
 * as bytes so a multi-byte character split across chunks survives, until the
 * rest of it arrives.
 */
export class LineBuffer {
  #partial: Buffer = Buffer.alloc(0);

  /** Bytes held back as an incomplete last line. */
  get pendingBytes(): number {
    return this.#partial.length;
  }

  /** Adds a chunk and returns every line it completes, without `\n` / `\r\n`. */
  push(chunk: Buffer): string[] {
    const data = this.#partial.length > 0 ? Buffer.concat([this.#partial, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (let nl = data.indexOf(LF); nl !== -1; nl = data.indexOf(LF, start)) {
      const end = nl > start && data[nl - 1] === CR ? nl - 1 : nl;
      lines.push(data.toString("utf8", start, end));
      start = nl + 1;
    }
    // Copy so a large chunk isn't kept alive by a small tail.
    this.#partial = Buffer.from(data.subarray(start));
    return lines;
  }

  reset(): void {
    this.#partial = Buffer.alloc(0);
  }
}
