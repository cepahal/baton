import type { Note } from "@baton/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteNode, type NoteNodeType } from "../src/components/canvas/NoteNode.js";
import { Markdown, safeUrl } from "../src/components/events/Markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

/**
 * What a teammate (or a prompt-injected agent) could put in a sticky note or
 * a reply. Each must render as inert text: no element that runs script, and
 * no attribute that does.
 */
const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "<iframe src=javascript:alert(1)></iframe>",
  '<a href="javascript:alert(1)">x</a>',
  "<body onload=alert(1)>",
  "<details open ontoggle=alert(1)>",
  "<style>@import 'http://evil.example/x.css'</style>",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](  javascript:alert(1))",
  "[click](java\tscript:alert(1))",
  "[click](&#106;avascript:alert(1))",
  "[click](%6Aavascript:alert(1))",
  "[click](vbscript:msgbox(1))",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[ref]\n\n[ref]: javascript:alert(1)",
  "<javascript:alert(1)>",
  "![x](javascript:alert(1))",
  '![x](x" onerror="alert(1))',
  "![pixel](https://evil.example/track.gif)",
  "![data](data:image/png;base64,iVBORw0KGgo=)",
  "![svg](data:image/svg+xml,<svg onload=alert(1)>)",
  "`<script>alert(1)</script>`",
  "```html\n<script>alert(1)</script>\n```",
  "| a |\n|---|\n| <img src=x onerror=alert(1)> |",
];

describe("Markdown sanitizing", () => {
  it.each(PAYLOADS)("renders %j inertly", (payload) => {
    const html = render(payload);
    // No element that can run script or load a page.
    expect(html).not.toMatch(/<(script|iframe|svg|math|style|object|embed|body|details)\b/i);
    // No event-handler attribute on any real element.
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    // No dangerous URL in any attribute.
    expect(html).not.toMatch(/(href|src)="\s*(javascript|vbscript|data):/i);
    expect(html).not.toMatch(/(href|src)="[^"]*(%6Aavascript|&#106;avascript)/i);
    // No image from anywhere but this hub's note files.
    for (const m of html.matchAll(/<img[^>]*src="([^"]*)"/g)) {
      expect(m[1]).toMatch(/^\/blobs\/[0-9a-f]{64}/);
    }
  });

  it("still renders ordinary markdown", () => {
    const html = render("**bold** _it_ `code`\n\n- [x] done\n\n[docs](https://example.com/a?b=1)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("shows an image from this hub's note files, and a placeholder for others", () => {
    const sha = "a".repeat(64);
    expect(render(`![shot](/blobs/${sha}?type=image/png)`)).toContain(
      `<img src="/blobs/${sha}?type=image/png" alt="shot"`,
    );
    expect(render("![pixel](https://evil.example/t.gif)")).toContain("[image: pixel]");
  });

  it("allows only safe URLs", () => {
    expect(safeUrl("https://ok.example", "href")).toBe("https://ok.example");
    expect(safeUrl("mailto:a@b.c", "href")).toBe("mailto:a@b.c");
    expect(safeUrl("javascript:alert(1)", "href")).toBeNull();
    expect(safeUrl("data:text/html,x", "href")).toBeNull();
    expect(safeUrl("/blobs/../../etc/passwd", "src")).toBeNull();
    expect(safeUrl(`//evil.example/blobs/${"a".repeat(64)}`, "src")).toBeNull();
  });
});

describe("sticky notes render markdown safely", () => {
  const note: Note = {
    id: "n0000000001",
    x: 0,
    y: 0,
    color: "yellow",
    text: "",
    files: [],
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
  };
  const renderNote = (text: string) =>
    renderToStaticMarkup(
      createElement(NoteNode, {
        id: note.id,
        data: {
          note: { ...note, text },
          armed: false,
          onText: () => {},
          onFiles: () => {},
          onPreview: () => {},
        },
      } as unknown as Parameters<typeof NoteNode>[0] & { data: NoteNodeType["data"] }),
    );

  it("formats a note's markdown", () => {
    const html = renderNote("# Ship list\n\n- **API** done\n- [spec](https://example.com)");
    expect(html).toContain("<h1>Ship list</h1>");
    expect(html).toContain("<strong>API</strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it.each(PAYLOADS)("keeps %j inert in a note", (payload) => {
    // The card's own paperclip icon is an <svg>; check only what the note's text became.
    const html = renderNote(payload).replace(/<button[^>]*note-clip[\s\S]*?<\/button>/, "");
    expect(html).toContain('class="note-text"');
    expect(html).not.toMatch(/<(script|iframe|svg|math|style|object|embed|body|details)\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(href|src)="\s*(javascript|vbscript|data):/i);
  });
});
