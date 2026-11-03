import { describe, expect, it } from "vitest";
import { looksLikeMarkup, sniffImage } from "../src/index.js";

const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
const text = (s: string) => new TextEncoder().encode(s);

describe("sniffImage", () => {
  it("recognizes the four inline types by magic bytes", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(text("GIF89a...."))).toBe("image/gif");
    expect(sniffImage(text("GIF87a...."))).toBe("image/gif");
    expect(sniffImage(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
  });

  it("rejects everything else, SVG included", () => {
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
    expect(sniffImage(text("<html><script>alert(1)</script>"))).toBeUndefined();
    expect(sniffImage(text("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBeUndefined();
    expect(sniffImage(text("GIF8"))).toBeUndefined();
    expect(sniffImage(new Uint8Array())).toBeUndefined();
  });
});

describe("looksLikeMarkup", () => {
  it.each([
    "<!DOCTYPE html><html></html>",
    "  <html><body>hi</body></html>",
    "﻿<script>alert(1)</script>",
    '<svg onload="alert(1)"/>',
    '<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ""><svg/>',
    "<IFRAME src=x>",
  ])("flags %j", (s) => {
    expect(looksLikeMarkup(text(s))).toBe(true);
  });

  it.each([
    "# Notes\n\nSome <b>bold</b> text",
    'export const Icon = () => <svg viewBox="0 0 16 16" />;',
    '<?xml version="1.0"?>\n<project><modelVersion>4.0.0</modelVersion></project>',
    "plain text",
  ])("allows %j", (s) => {
    expect(looksLikeMarkup(text(s))).toBe(false);
  });

  it("sees through a UTF-16 byte-order mark", () => {
    const utf16le = (s: string) =>
      new Uint8Array([0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(looksLikeMarkup(utf16le("<html><script>alert(1)</script>"))).toBe(true);
    expect(looksLikeMarkup(utf16le("hello"))).toBe(false);
  });
});
