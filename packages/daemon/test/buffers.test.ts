import { describe, expect, it } from "vitest";
import { limitConcurrency } from "../src/limit.js";
import { LineBuffer } from "../src/lines.js";
import { fileKey, isTranscript } from "../src/paths.js";

describe("LineBuffer", () => {
  it("returns complete lines and holds back the rest", () => {
    const b = new LineBuffer();
    expect(b.push(Buffer.from("one\ntwo\nthr"))).toEqual(["one", "two"]);
    expect(b.pendingBytes).toBe(3);
    expect(b.push(Buffer.from("ee\n"))).toEqual(["three"]);
    expect(b.pendingBytes).toBe(0);
  });

  it("strips CRLF, including a CR and LF split across chunks", () => {
    const b = new LineBuffer();
    expect(b.push(Buffer.from("a\r\nb\r"))).toEqual(["a"]);
    expect(b.push(Buffer.from("\n"))).toEqual(["b"]);
  });

  it("keeps a multi-byte character split across chunks intact", () => {
    const bytes = Buffer.from("héllo ✓ 😀\n");
    for (let cut = 1; cut < bytes.length; cut++) {
      const b = new LineBuffer();
      const lines = [...b.push(bytes.subarray(0, cut)), ...b.push(bytes.subarray(cut))];
      expect(lines).toEqual(["héllo ✓ 😀"]);
    }
  });

  it("returns empty lines and forgets the partial line on reset", () => {
    const b = new LineBuffer();
    expect(b.push(Buffer.from("\n\npart"))).toEqual(["", ""]);
    b.reset();
    expect(b.pendingBytes).toBe(0);
    expect(b.push(Buffer.from("new\n"))).toEqual(["new"]);
  });
});

describe("paths", () => {
  it("compares Windows paths case-insensitively and POSIX paths exactly", () => {
    expect(fileKey(String.raw`C:\Users\Dev\A.jsonl`, "win32")).toBe(
      fileKey(String.raw`c:\users\dev\a.jsonl`, "win32"),
    );
    expect(fileKey("/home/Dev/a.jsonl", "linux")).not.toBe(fileKey("/home/dev/a.jsonl", "linux"));
  });

  it.each([
    ["s.jsonl", true],
    ["S.JSONL", true],
    ["s.json", false],
    ["s.jsonl.tmp", false],
  ])("isTranscript(%s) = %s", (path, expected) => {
    expect(isTranscript(path)).toBe(expected);
  });
});

describe("limitConcurrency", () => {
  it("never runs more than n tasks at once, and runs them all", async () => {
    const limit = limitConcurrency(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("keeps going after a task fails", async () => {
    const limit = limitConcurrency(1);
    await expect(limit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });
});
