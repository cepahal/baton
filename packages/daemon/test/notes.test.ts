import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Handoff, NOTE_FILE_MAX_BYTES, Note, type NoteFile, NotesResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BlobStore } from "../src/blob-store.js";
import { resolveConfig, resolveServeConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { NoteStore } from "../src/note-store.js";
import { httpBase, remoteBlobFetcher } from "../src/remote-blobs.js";
import { startTeamServer } from "../src/team-server.js";
import { record, SESSION_A, SESSION_B, silent, tempProjects } from "./helpers.js";

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dirs: Awaited<ReturnType<typeof tempProjects>>;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dirs = await tempProjects();
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await dirs.cleanup();
});

async function start(): Promise<Daemon> {
  const config = resolveConfig({
    port: 0,
    logLevel: "silent",
    recent: 0,
    summarizer: "off",
    projectsDir: dirs.projectsDir,
    codexDir: dirs.codexDir,
    stateFile: dirs.stateFile,
  });
  const daemon = await startDaemon(config, silent, { notify: undefined });
  cleanups.push(() => daemon.close());
  return daemon;
}

async function createNote(d: Daemon, body: unknown): Promise<Note> {
  const res = await fetch(`${d.url}/notes`, send("POST", body));
  expect(res.status).toBe(201);
  return Note.parse(((await res.json()) as { note: unknown }).note);
}

async function upload(d: Daemon, bytes: Uint8Array, name: string, mime: string): Promise<NoteFile> {
  const res = await fetch(`${d.url}/blobs`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(res.status).toBe(201);
  const { sha256, size } = (await res.json()) as { sha256: string; size: number };
  return { sha256, size, name, mime };
}

describe("sticky notes on a daemon", () => {
  it("creates, edits, moves and takes down notes, and keeps them across restarts", async () => {
    let d = await start();
    const note = await createNote(d, { x: 10, y: 20, color: "pink", author: "Ada" });
    expect(note).toMatchObject({ x: 10, y: 20, color: "pink", text: "", files: [] });

    const patched = await fetch(
      `${d.url}/notes/${note.id}`,
      send("PATCH", { text: "Finish the cart" }),
    );
    expect(patched.status).toBe(200);
    expect((await fetch(`${d.url}/notes/${note.id}`, send("PATCH", { bogus: 1 }))).status).toBe(
      400,
    );
    expect((await fetch(`${d.url}/notes/nzzzzzzzzzz`, send("PATCH", { x: 1 }))).status).toBe(404);
    expect(
      (await fetch(`${d.url}/notes`, send("POST", { x: 1, y: 1, color: "green" }))).status,
    ).toBe(400);

    await d.close();
    cleanups.pop();
    d = await start();
    const listed = NotesResponse.parse(await (await fetch(`${d.url}/notes`)).json()).notes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: note.id, text: "Finish the cart", author: "Ada" });

    expect((await fetch(`${d.url}/notes/${note.id}`, { method: "DELETE" })).status).toBe(204);
    expect(NotesResponse.parse(await (await fetch(`${d.url}/notes`)).json()).notes).toEqual([]);
  });

  it("sends every viewer a snapshot on connect and each change after", async () => {
    const d = await start();
    const before = await createNote(d, { x: 0, y: 0, color: "yellow" });
    const ws = new WebSocket(`${d.url.replace("http", "ws")}/ws`, { origin: d.url });
    cleanups.push(async () => ws.close());
    const got: { type: string; notes?: Note[]; removed?: string[]; snapshot?: boolean }[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", session: "*" }));
    await until(() => got.some((m) => m.type === "notes" && m.snapshot), "notes snapshot");
    expect(got.find((m) => m.type === "notes")?.notes?.map((n) => n.id)).toEqual([before.id]);

    const later = await createNote(d, { x: 5, y: 5, color: "blue" });
    await until(
      () => got.some((m) => m.type === "notes" && m.notes?.[0]?.id === later.id),
      "created note",
    );
    await fetch(`${d.url}/notes/${before.id}`, { method: "DELETE" });
    await until(() => got.some((m) => m.removed?.includes(before.id)), "removal");
  });

  it("stores files by content, serves images inline and everything else as a download", async () => {
    const d = await start();
    const note = await createNote(d, { x: 0, y: 0, color: "orange" });
    const png = await upload(d, PNG, "shot.png", "image/png");
    expect(png.sha256).toBe(sha(PNG));
    // Not an image whatever it claims: text with a .png name and type.
    const fake = await upload(
      d,
      new TextEncoder().encode("GIF?? not really"),
      "x.png",
      "image/png",
    );

    // Files must be uploaded before a note can point at them.
    const missing = { ...png, sha256: "0".repeat(64) };
    expect(
      (await fetch(`${d.url}/notes/${note.id}`, send("PATCH", { files: [missing] }))).status,
    ).toBe(400);
    expect(
      (await fetch(`${d.url}/notes/${note.id}`, send("PATCH", { files: [png, fake] }))).status,
    ).toBe(200);

    // The type in the URL is ignored: a real PNG is inline even when called text.
    const img = await fetch(`${d.url}/blobs/${png.sha256}?type=text/html&name=shot.png`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toMatch(/^inline/);
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    // ...and a non-image is a sandboxed download even when called a PNG.
    const page = await fetch(`${d.url}/blobs/${fake.sha256}?type=image/png&name=x.png`);
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
    expect(page.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await fetch(`${d.url}/blobs/nothex`)).status).toBe(404);

    // Taking the note down drops files nothing else needs.
    await fetch(`${d.url}/notes/${note.id}`, { method: "DELETE" });
    await until(async () => (await fetch(`${d.url}/blobs/${png.sha256}`)).status === 404, "sweep");
  });

  it("refuses HTML and SVG uploads, and says which image type it found", async () => {
    const d = await start();
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const markup of [
      "<script>alert(1)</script>",
      "<!doctype html><html><body onload=alert(1)>",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "﻿  <HTML><iframe src=javascript:alert(1)>",
    ]) {
      const res = await fetch(`${d.url}/blobs`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: enc(markup),
      });
      expect(res.status, markup).toBe(415);
    }
    const res = await fetch(`${d.url}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG,
    });
    expect(await res.json()).toMatchObject({ image: "image/png" });
    const text = await fetch(`${d.url}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: enc("# just markdown"),
    });
    expect(await text.json()).not.toHaveProperty("image");
  });

  it("refuses uploads over the size cap", async () => {
    const d = await start();
    const big = new Uint8Array(NOTE_FILE_MAX_BYTES + 1);
    // The hub answers 413 and closes as soon as the body is too big; under load
    // the client can see that close (a reset) before it reads the answer.
    const outcome = await fetch(`${d.url}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: big,
    }).then(
      (res) => res.status,
      () => "reset",
    );
    expect([413, "reset"]).toContain(outcome);
    const id = createHash("sha256").update(big).digest("hex");
    expect((await fetch(`${d.url}/blobs/${id}`)).status).toBe(404);
  });

  it("refuses notes from other sites", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/notes`, {
      ...send("POST", { x: 0, y: 0, color: "yellow" }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("handing off a sticky note", () => {
  it("copies the note and its files into the receiving checkout; the note stays", async () => {
    await dirs.append(
      dirs.transcript(SESSION_A),
      `${record(SESSION_A, "user", "Build the cart")}\n`,
    );
    await dirs.append(dirs.transcript(SESSION_B), `${record(SESSION_B, "user", "Fix the API")}\n`);
    const d = await start();
    await until(() => d.hub.session(SESSION_B) !== undefined, "session B");

    const note = await createNote(d, { x: 0, y: 0, color: "yellow", author: "Ada" });
    const png = await upload(d, PNG, "../../evil shot.png", "image/png");
    await fetch(
      `${d.url}/notes/${note.id}`,
      send("PATCH", { text: "Problem: totals are off by one", files: [png] }),
    );

    const req = { kind: "note", noteId: note.id, fromSessionId: SESSION_B, toSessionId: SESSION_B };
    const draft = await fetch(`${d.url}/handoffs/draft`, send("POST", { ...req, sender: "Ada" }));
    expect(draft.status).toBe(200);
    const { markdown } = (await draft.json()) as { markdown: string };
    expect(markdown).toContain("Problem: totals are off by one");

    const gone = await fetch(
      `${d.url}/handoffs/draft`,
      send("POST", { ...req, noteId: "nzzzzzzzzzz", sender: "Ada" }),
    );
    expect(gone.status).toBe(404);

    const res = await fetch(`${d.url}/handoffs`, send("POST", { ...req, markdown, sender: "Ada" }));
    expect(res.status).toBe(201);
    const h = Handoff.parse(((await res.json()) as { handoff: unknown }).handoff);
    expect(h.kind).toBe("note");
    expect(h.attachments).toEqual([png]);

    // Taking the note down now must not lose the file the pending handoff needs.
    await fetch(`${d.url}/notes/${note.id}`, { method: "DELETE" });
    expect((await fetch(`${d.url}/blobs/${png.sha256}`)).status).toBe(200);

    const folder = await mkdtemp(join(tmpdir(), "baton-note-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const url = `${d.url}/handoffs/${h.id}/accept`;
    const ok = await fetch(url, send("POST", { folder }));
    expect(ok.status).toBe(200);
    const dir = join(folder, ".baton", "handoffs");
    const written = await readFile(join(dir, `${h.id}.md`), "utf8");
    expect(written).toContain("Problem: totals are off by one");
    expect(written).toContain("Files saved with this handoff");
    // The file name is cleaned: it can't climb out of the handoff folder.
    const saved = await readFile(join(dir, h.id, "evil shot.png"));
    expect(new Uint8Array(saved)).toEqual(PNG);
  });

  it("keeps the note on the canvas after it's sent", async () => {
    await dirs.append(dirs.transcript(SESSION_B), `${record(SESSION_B, "user", "Fix the API")}\n`);
    const d = await start();
    await until(() => d.hub.session(SESSION_B) !== undefined, "session B");
    const note = await createNote(d, { x: 0, y: 0, color: "blue", text: "Ship it" });
    const req = { kind: "note", noteId: note.id, fromSessionId: SESSION_B, toSessionId: SESSION_B };
    const res = await fetch(
      `${d.url}/handoffs`,
      send("POST", { ...req, markdown: "# n", sender: "A" }),
    );
    expect(res.status).toBe(201);
    expect(d.hub.notes.get(note.id)?.text).toBe("Ship it");
  });
});

describe("NoteStore", () => {
  it("caps text and file counts through its schema and reports unchanged patches", () => {
    const store = new NoteStore();
    const n = store.create({ x: 0, y: 0, color: "yellow" });
    expect(n).toBeDefined();
    if (!n) return;
    expect(store.update(n.id, { x: 0 })?.changed).toBe(false);
    expect(store.update(n.id, { x: 3 })?.changed).toBe(true);
    expect(store.update("nzzzzzzzzzz", { x: 3 })).toBeUndefined();
    expect(store.remove(n.id)?.id).toBe(n.id);
    expect(store.all()).toEqual([]);
  });
});

describe("BlobStore", () => {
  it("dedupes by content, refuses when full, and sweeps what's unused", async () => {
    let now = 0;
    const blobs = new BlobStore({ maxTotalBytes: 20, graceMs: 1000, now: () => now });
    const a = await blobs.put(Buffer.from("hello"));
    expect(a).toBe(sha(new TextEncoder().encode("hello")));
    expect(await blobs.put(Buffer.from("hello"))).toBe(a);
    expect(await blobs.put(Buffer.alloc(100))).toBeUndefined();
    const b = await blobs.put(Buffer.from("world"));
    if (!a || !b) throw new Error("no ids");
    now = 5000;
    await blobs.sweep(new Set([b]));
    expect(await blobs.has(a)).toBe(false);
    expect(await blobs.has(b)).toBe(true);
  });

  it("spares a fresh upload from someone else's sweep until it's attached", async () => {
    let now = 0;
    const blobs = new BlobStore({ graceMs: 60_000, now: () => now });
    const fresh = await blobs.put(Buffer.from("just uploaded"));
    if (!fresh) throw new Error("no id");
    // Another viewer takes a note down before this upload is pinned to its note.
    await blobs.sweep(new Set());
    expect(await blobs.has(fresh)).toBe(true);
    // Pinned (a sweep sees it in use), then its note is taken down: gone at once.
    await blobs.sweep(new Set([fresh]));
    now = 1;
    await blobs.sweep(new Set());
    expect(await blobs.has(fresh)).toBe(false);
  });

  it("keeps files on disk when given a folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-blobs-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const id = await new BlobStore({ dir }).put(Buffer.from("persist"));
    if (!id) throw new Error("no id");
    expect(Buffer.from((await new BlobStore({ dir }).read(id)) ?? []).toString()).toBe("persist");
  });
});

describe("remote blobs", () => {
  it("turns a --server URL into the team server's HTTP base", () => {
    expect(httpBase("ws://team.local:7900/ingest")).toBe("http://team.local:7900");
    expect(httpBase("wss://team.example.com/")).toBe("https://team.example.com");
    expect(httpBase("https://team.example.com")).toBe("https://team.example.com");
  });

  it("sends the token and rejects bytes that aren't the file asked for", async () => {
    const good = new TextEncoder().encode("note file");
    const id = sha(good);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(good),
    );
    const get = remoteBlobFetcher("ws://team:7900/ingest", "tok", fetchImpl as typeof fetch);
    expect(await get(id)).toEqual(good);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`http://team:7900/blobs/${id}?download=1`);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer tok" });
    expect(await get("f".repeat(64))).toBeUndefined();
    expect(await get("../etc")).toBeUndefined();
  });
});

describe("sticky notes on a team server", () => {
  it("shares notes and files with every token holder, and nobody else", async () => {
    const TOKEN = "team-token-0123456789";
    const server = await startTeamServer(
      resolveServeConfig({
        host: "127.0.0.1",
        port: 0,
        token: TOKEN,
        logLevel: "silent",
        summarizer: "off",
        webDir: join(import.meta.dirname, "no-viewer"),
      }),
      silent,
    );
    cleanups.push(() => server.close());
    const auth = { authorization: `Bearer ${TOKEN}` };

    for (const path of ["/notes", "/notes/nabcdefghij", `/blobs/${"a".repeat(64)}`]) {
      expect((await fetch(`${server.url}${path}`, { redirect: "manual" })).status).toBe(401);
    }
    const created = await fetch(`${server.url}/notes`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ x: 1, y: 2, color: "pink", text: "for everyone" }),
    });
    expect(created.status).toBe(201);
    const up = await fetch(`${server.url}/blobs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: PNG,
    });
    expect(up.status).toBe(201);
    const { sha256 } = (await up.json()) as { sha256: string };

    // A second machine sees the same notes and fetches the same file.
    const listed = await fetch(`${server.url}/notes`, { headers: auth });
    expect(NotesResponse.parse(await listed.json()).notes[0]?.text).toBe("for everyone");
    const get = remoteBlobFetcher(server.url.replace("http", "ws"), TOKEN);
    expect(await get(sha256)).toEqual(PNG);
    expect(await remoteBlobFetcher(server.url, "wrong-token-0123456789")(sha256)).toBeUndefined();
  });
});
