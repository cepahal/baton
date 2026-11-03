import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Handoff, HandoffsResponse, type Note, NotesResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CANVAS_FILE, CanvasStore } from "../src/canvas-store.js";
import { resolveServeConfig } from "../src/config.js";
import { HandoffStore } from "../src/handoff-store.js";
import { NoteStore } from "../src/note-store.js";
import { startTeamServer } from "../src/team-server.js";
import { loadVersioned, NewerFileError, saveVersioned } from "../src/versioned-file.js";
import { silent } from "./helpers.js";

const TOKEN = "upgrade-test-token-0123456789";
const AT = "2026-10-30T09:00:00.000Z";

const note: Note = {
  id: "n0000000001",
  x: 10,
  y: 20,
  color: "pink",
  text: "**ship it** on Friday",
  files: [],
  author: "alice",
  createdAt: AT,
  updatedAt: AT,
};

const handoff: Handoff = {
  id: "h0000000001",
  kind: "snippet",
  status: "pending",
  sender: "bob",
  from: {
    sessionId: "s-from",
    user: "bob",
    agent: "codex",
    repoId: "github.com/acme/app",
    branch: "main",
  },
  to: {
    sessionId: "s-to",
    user: "carol",
    agent: "claude-code",
    repoId: "github.com/acme/app",
    branch: null,
  },
  markdown: "# Snippet\n\nLook at this.",
  createdAt: AT,
  updatedAt: AT,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baton-upgrade-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The files exactly as Baton wrote them before versioning (0.0.0, commit 360bfda). */
async function writeLegacyFiles() {
  const files = {
    notesFile: join(dir, "team-notes.json"),
    handoffsFile: join(dir, "team-handoffs.json"),
    canvasFile: join(dir, "team-canvas.json"),
    blobsDir: join(dir, "team-blobs"),
  };
  await writeFile(files.notesFile, JSON.stringify([note]));
  await writeFile(
    files.handoffsFile,
    JSON.stringify({ records: [{ handoff, fromDaemon: "bob", toDaemon: "carol" }] }),
  );
  await writeFile(files.canvasFile, JSON.stringify({ "session:s-to": { x: 5, y: 6 } }));
  return files;
}

describe("upgrading from the unversioned files", () => {
  it("keeps every note, handoff and canvas position, and keeps the old files", async () => {
    const files = await writeLegacyFiles();
    const server = await startTeamServer(
      resolveServeConfig({ token: TOKEN, port: 0, host: "127.0.0.1", summarizer: "off" }),
      silent,
      files,
    );
    try {
      const get = async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
        const res = await fetch(`${server.url}${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        return schema.parse(await res.json());
      };
      expect((await get("/notes", NotesResponse)).notes).toEqual([note]);
      expect((await get("/handoffs", HandoffsResponse)).handoffs).toEqual([handoff]);
      const canvas = await get("/canvas", z.object({ positions: z.unknown() }));
      expect(canvas.positions).toEqual({ "session:s-to": { x: 5, y: 6 } });
    } finally {
      await server.close();
    }
    // The pre-upgrade copies are kept next to each file.
    for (const f of [files.notesFile, files.handoffsFile, files.canvasFile]) {
      await expect(access(`${f}.v0.bak`)).resolves.toBeUndefined();
    }
  });

  it("writes the new format on the next save, and reads it back", async () => {
    const files = await writeLegacyFiles();
    const notes = new NoteStore({ file: files.notesFile, logger: silent });
    await notes.load();
    notes.update(note.id, { text: "edited" });
    await notes.flush();
    const saved: unknown = JSON.parse(await readFile(files.notesFile, "utf8"));
    expect(saved).toMatchObject({ version: 1, data: [{ id: note.id, text: "edited" }] });

    const again = new NoteStore({ file: files.notesFile, logger: silent });
    await again.load();
    expect(again.get(note.id)?.text).toBe("edited");

    const handoffs = new HandoffStore({ file: files.handoffsFile, logger: silent });
    await handoffs.load();
    handoffs.put({ handoff: { ...handoff, status: "accepted" } });
    await handoffs.flush();
    const reread = new HandoffStore({ file: files.handoffsFile, logger: silent });
    await reread.load();
    expect(reread.get(handoff.id)?.handoff.status).toBe("accepted");
  });
});

describe("loadVersioned", () => {
  it("keeps the good records when some are invalid, and saves the original aside", async () => {
    const file = join(dir, "team-notes.json");
    await writeFile(file, JSON.stringify([note, { ...note, id: "not-an-id" }]));
    const store = new NoteStore({ file, logger: silent });
    await store.load();
    expect(store.all()).toEqual([note]);
    const names = await readdir(dir);
    expect(names.some((n) => n.startsWith("team-notes.json.dropped-"))).toBe(true);
  });

  it("moves an unreadable file aside instead of overwriting it", async () => {
    const file = join(dir, "team-canvas.json");
    await writeFile(file, "{ this is not json");
    const store = new CanvasStore({ file, logger: silent, saveDelayMs: 0 });
    await store.load();
    store.set({ "repo:x": { x: 1, y: 1 } });
    await store.flush();
    const aside = (await readdir(dir)).find((n) => n.startsWith("team-canvas.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(await readFile(join(dir, aside ?? ""), "utf8")).toBe("{ this is not json");
  });

  it("refuses a file written by a newer Baton, and leaves it alone", async () => {
    const file = join(dir, "team-canvas.json");
    const newer = JSON.stringify({ version: 99, data: { future: true } });
    await writeFile(file, newer);
    await expect(loadVersioned(file, CANVAS_FILE, silent)).rejects.toBeInstanceOf(NewerFileError);
    await expect(new CanvasStore({ file }).load()).rejects.toThrow(/newer version of Baton/);
    expect(await readFile(file, "utf8")).toBe(newer);
  });

  it("round-trips the current version without making a backup", async () => {
    const file = join(dir, "c.json");
    await saveVersioned(file, CANVAS_FILE.version, { "repo:a": { x: 2, y: 3 } });
    expect(await loadVersioned(file, CANVAS_FILE, silent)).toEqual({ "repo:a": { x: 2, y: 3 } });
    expect(await readdir(dir)).toEqual(["c.json"]);
  });
});
