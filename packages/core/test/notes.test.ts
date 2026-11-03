import { describe, expect, it } from "vitest";
import { buildHandoffDraft } from "../src/handoff/packet.js";
import { HandoffCreate } from "../src/handoff/schema.js";
import { formatBytes, renderNote } from "../src/notes/render.js";
import {
  isInlineImage,
  isPreviewableText,
  NOTE_FILES_MAX,
  NOTE_TEXT_MAX,
  Note,
  NoteCreate,
  NotePatch,
  safeFileName,
} from "../src/notes/schema.js";
import { NotesMessage, ServerMessage } from "../src/protocol.js";

const note = Note.parse({
  id: "nabcdefghij",
  x: 10,
  y: -20,
  color: "blue",
  text: "Totals are off by one.\nCheck the rounding.",
  files: [
    { sha256: "a".repeat(64), name: "shot.png", mime: "image/png", size: 2048 },
    { sha256: "b".repeat(64), name: "problem.md", mime: "text/markdown", size: 300 },
  ],
  author: "Ada",
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
});

const PARTY = { sessionId: "abc12345", agent: "codex", repoId: null, branch: null } as const;

describe("note schemas", () => {
  it("accepts the four colors only", () => {
    for (const color of ["yellow", "pink", "orange", "blue"]) {
      expect(NoteCreate.safeParse({ x: 0, y: 0, color }).success).toBe(true);
    }
    expect(NoteCreate.safeParse({ x: 0, y: 0, color: "green" }).success).toBe(false);
  });

  it("caps text and files, and rejects unknown patch fields", () => {
    expect(NotePatch.safeParse({ text: "x".repeat(NOTE_TEXT_MAX + 1) }).success).toBe(false);
    const file = note.files[0];
    expect(NotePatch.safeParse({ files: Array(NOTE_FILES_MAX + 1).fill(file) }).success).toBe(
      false,
    );
    expect(NotePatch.safeParse({ id: "nother00000" }).success).toBe(false);
    expect(NotePatch.safeParse({ x: 5 }).success).toBe(true);
  });

  it("travels in a notes message on the socket", () => {
    const m = { type: "notes", notes: [note], removed: ["nzzzzzzzzzz"], snapshot: true };
    expect(NotesMessage.safeParse(m).success).toBe(true);
    expect(ServerMessage.parse(m).type).toBe("notes");
  });
});

describe("note files", () => {
  it("shows only raster images inline (never SVG)", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/webp")).toBe(true);
    expect(isInlineImage("image/svg+xml")).toBe(false);
    expect(isInlineImage("text/html")).toBe(false);
  });

  it("previews text by type or extension", () => {
    expect(isPreviewableText("text/plain", "a.txt")).toBe(true);
    expect(isPreviewableText("", "problem.md")).toBe(true);
    expect(isPreviewableText("application/json", "a.json")).toBe(true);
    expect(isPreviewableText("application/octet-stream", "a.bin")).toBe(false);
  });

  it("cleans names so they can't leave the folder they're written to", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\shot.png")).toBe("shot.png");
    expect(safeFileName("a\u0000b.txt")).not.toContain("\u0000");
    expect(safeFileName("..")).not.toBe("..");
    expect(safeFileName("")).not.toBe("");
  });

  it("formats sizes", () => {
    expect(formatBytes(300)).toBe("300 B");
    expect(formatBytes(2048)).toMatch(/^2(\.0)? KB$/);
  });
});

describe("renderNote", () => {
  it("renders the note's text and lists its files", () => {
    const md = renderNote({ sender: "Grace", to: PARTY, at: note.updatedAt }, note);
    expect(md).toMatch(/^# Sticky note from Grace/);
    expect(md).toContain("Totals are off by one.\nCheck the rounding.");
    expect(md).toContain("Ada");
    expect(md).toContain("someone's Codex session `abc12345`");
    expect(md).toContain("## Attached files");
    expect(md).toContain("shot.png");
    expect(md).toContain("problem.md");
  });

  it("drafts a note handoff without a summarizer", () => {
    const built = buildHandoffDraft(
      [],
      { sender: "Grace", from: PARTY, to: PARTY, at: note.updatedAt },
      {
        kind: "note",
        note,
        filesTouched: [],
      },
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.markdown).toContain("Check the rounding.");
      expect(built.summary).toBeUndefined();
    }
  });

  it("lets senders pick a note to hand off", () => {
    const body = {
      kind: "note",
      noteId: note.id,
      fromSessionId: "s",
      toSessionId: "s",
      markdown: "# n",
      sender: "A",
    };
    expect(HandoffCreate.safeParse(body).success).toBe(true);
    expect(HandoffCreate.safeParse({ ...body, noteId: "bad" }).success).toBe(false);
  });
});
