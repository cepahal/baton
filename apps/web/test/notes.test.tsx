import type { Note } from "@baton/core";
import type { NodeProps } from "@xyflow/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cardsMoved, toNoteNodes } from "../src/components/canvas/Canvas.js";
import { NoteNode, type NoteNodeType } from "../src/components/canvas/NoteNode.js";
import { NotePad } from "../src/components/canvas/NotePad.js";
import { applyNotesMessage, applyPatch, mergeNotes } from "../src/hooks/useNotes.js";
import { readHandoffDrag, setHandoffDrag } from "../src/lib/drag.js";
import { blobUrl, NOTE_COLORS, randomNoteColor } from "../src/lib/notes-api.js";

const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 12, min)).toISOString();

function note(id: string, over: Partial<Note> = {}): Note {
  return {
    id,
    x: 0,
    y: 0,
    color: "yellow",
    text: "",
    files: [],
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

const PNG = { sha256: "a".repeat(64), name: "shot.png", mime: "image/png", size: 10 };

describe("note state", () => {
  it("keeps the newer copy of each note", () => {
    const old = note("naaaaaaaaaa", { text: "old", updatedAt: at(1) });
    const fresh = note("naaaaaaaaaa", { text: "new", updatedAt: at(2) });
    expect(mergeNotes([fresh], [old])[0]?.text).toBe("new");
    expect(mergeNotes([old], [fresh])[0]?.text).toBe("new");
    expect(mergeNotes([old], [note("nbbbbbbbbbb")])).toHaveLength(2);
  });

  it("replaces everything on a snapshot and drops removed notes", () => {
    const a = note("naaaaaaaaaa");
    const b = note("nbbbbbbbbbb");
    expect(applyNotesMessage([a], { type: "notes", notes: [b], snapshot: true })).toEqual([b]);
    expect(applyNotesMessage([a, b], { type: "notes", notes: [], removed: [a.id] })).toEqual([b]);
  });

  it("applies a patch only to the fields it sets", () => {
    const a = note("naaaaaaaaaa", { text: "keep", x: 4 });
    expect(applyPatch(a, { x: 9 })).toMatchObject({ x: 9, text: "keep", y: 0 });
    expect(applyPatch(a, { files: [PNG] }).files).toEqual([PNG]);
  });

  it("picks one of the four colors", () => {
    expect(NOTE_COLORS).toEqual(["yellow", "pink", "orange", "blue"]);
    expect(randomNoteColor(() => 0)).toBe("yellow");
    expect(randomNoteColor(() => 0.99)).toBe("blue");
  });

  it("links files with their type and name, as a download when asked", () => {
    expect(blobUrl(PNG)).toBe(`/blobs/${PNG.sha256}?type=image%2Fpng&name=shot.png`);
    expect(blobUrl(PNG, true)).toContain("download=1");
  });
});

describe("notes on the canvas", () => {
  const h = { onText: () => {}, onFiles: () => {}, onPreview: () => {} };

  it("places each note where it was left, above the cards", () => {
    const [n] = toNoteNodes([note("naaaaaaaaaa", { x: 40, y: -8 })], h, "naaaaaaaaaa");
    expect(n).toMatchObject({ id: "note:naaaaaaaaaa", type: "note", position: { x: 40, y: -8 } });
    expect(n?.data.armed).toBe(true);
    expect(n?.zIndex).toBeGreaterThan(0);
  });

  it("doesn't save notes as card positions", () => {
    const nodes = toNoteNodes([note("naaaaaaaaaa")], h);
    expect(cardsMoved(nodes, nodes)).toEqual([]);
  });

  it("draws a note in its color with its text, image and files", () => {
    const n = note("naaaaaaaaaa", { color: "pink", text: "Finish the cart", files: [PNG] });
    const [node] = toNoteNodes([n], h);
    if (!node) throw new Error("no node");
    const html = renderToStaticMarkup(
      createElement(NoteNode, { data: node.data } as unknown as NodeProps<NoteNodeType>),
    );
    expect(html).toContain("note-pink");
    expect(html).toContain("Finish the cart");
    expect(html).toContain(`/blobs/${PNG.sha256}`);
    expect(html).toContain("note-curl");
  });

  it("invites writing on an empty note", () => {
    const [node] = toNoteNodes([note("naaaaaaaaaa")], h);
    if (!node) throw new Error("no node");
    const html = renderToStaticMarkup(
      createElement(NoteNode, { data: node.data } as unknown as NodeProps<NoteNodeType>),
    );
    expect(html).toContain("Double-click to write");
  });

  it("shows the pad as an unlabeled, draggable sticky note", () => {
    const html = renderToStaticMarkup(createElement(NotePad, { onClick: () => {} }));
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="Add a sticky note"');
    // No visible text: only the accessible name.
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
  });

  it("drags a note to a session as a note handoff", () => {
    const data = new Map<string, string>();
    const t = {
      effectAllowed: "none" as DataTransfer["effectAllowed"],
      types: [] as string[],
      setData(type: string, value: string) {
        data.set(type, value);
        this.types = [...data.keys()];
      },
      getData: (type: string) => data.get(type) ?? "",
    };
    setHandoffDrag(t, { kind: "note", sessionId: "s1", noteId: "naaaaaaaaaa" });
    expect(readHandoffDrag(t)).toEqual({ kind: "note", sessionId: "s1", noteId: "naaaaaaaaaa" });
  });
});
