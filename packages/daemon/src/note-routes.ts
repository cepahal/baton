import {
  BlobId,
  type BlobResponse,
  looksLikeMarkup,
  NOTE_FILE_MAX_BYTES,
  NoteCreate,
  NoteId,
  NotePatch,
  type NoteResponse,
  type NotesResponse,
  sniffImage,
} from "@baton/core";
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { BlobStore } from "./blob-store.js";
import type { Hub } from "./hub.js";

export type NoteRouteOptions = {
  hub: Hub;
  blobs: BlobStore;
  /** Files still needed beyond the notes (pending note handoffs). */
  blobsInUse?: () => ReadonlySet<string>;
};

const IdParams = z.object({ id: NoteId });
const BlobParams = z.object({ sha256: BlobId });
const BlobQuery = z.object({
  /** Ignored: how a file is served comes from its bytes. Kept so older viewers' URLs work. */
  type: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  download: z.literal("1").optional(),
});

/**
 * Sticky notes (`/notes`) and their files (`/blobs`). Every change is
 * broadcast to viewers as a `notes` message. Files are content-addressed.
 * Only PNG, JPEG, GIF and WebP, recognized by their magic bytes (never by
 * what the uploader claims), are shown inline; everything else is a download
 * served with `nosniff` and a sandboxing CSP. HTML and SVG documents are
 * refused at upload.
 */
type BatonApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

export function registerNoteRoutes(app: BatonApp, options: NoteRouteOptions): void {
  const { hub, blobs } = options;
  const notes = hub.notes;

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: NOTE_FILE_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get("/notes", async (): Promise<NotesResponse> => ({ notes: notes.all() }));

  app.post("/notes", async (req, reply) => {
    const body = NoteCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "body must be { x, y, color, text?, author? }" });
    }
    const note = notes.create(body.data);
    if (!note) return reply.code(409).send({ error: "the canvas is full of notes" });
    hub.broadcast({ type: "notes", notes: [note] });
    return reply.code(201).send({ note } satisfies NoteResponse);
  });

  app.patch("/notes/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = NotePatch.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "no such note" });
    if (!body.success) {
      return reply.code(400).send({ error: "body may set x, y, color, text and files" });
    }
    for (const f of body.data.files ?? []) {
      if (!(await blobs.has(f.sha256))) {
        return reply.code(400).send({ error: `file ${f.name} wasn't uploaded` });
      }
    }
    const result = notes.update(params.data.id, body.data);
    if (!result) return reply.code(404).send({ error: "no such note" });
    if (result.changed) {
      hub.broadcast({ type: "notes", notes: [result.note] });
      if (body.data.files !== undefined) void sweep();
    }
    return { note: result.note } satisfies NoteResponse;
  });

  app.delete("/notes/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const removed = params.success ? notes.remove(params.data.id) : undefined;
    if (!removed) return reply.code(404).send({ error: "no such note" });
    hub.broadcast({ type: "notes", notes: [], removed: [removed.id] });
    void sweep();
    return reply.code(204).send();
  });

  app.post("/blobs", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: "send the file as application/octet-stream" });
    }
    if (looksLikeMarkup(req.body)) {
      return reply
        .code(415)
        .send({ error: "HTML and SVG files can't be attached; zip them or paste the text" });
    }
    const sha256 = await blobs.put(req.body);
    if (!sha256) return reply.code(507).send({ error: "the hub's file store is full" });
    const image = sniffImage(req.body);
    const body: BlobResponse = { sha256, size: req.body.length, ...(image ? { image } : {}) };
    return reply.code(201).send(body);
  });

  app.get("/blobs/:sha256", async (req, reply) => {
    const params = BlobParams.safeParse(req.params);
    const query = BlobQuery.safeParse(req.query);
    const bytes = params.success ? await blobs.read(params.data.sha256) : undefined;
    if (!bytes) return reply.code(404).send({ error: "no such file" });
    const image = sniffImage(bytes);
    const inline = image !== undefined && !(query.success && query.data.download);
    const name = (query.success ? query.data.name : undefined) ?? "file";
    return reply
      .header("content-type", inline ? image : "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .header(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(bytes);
  });

  /** Deletes files no note or pending handoff needs. Never fails a request. */
  async function sweep(): Promise<void> {
    const keep = new Set(notes.blobsInUse());
    for (const id of options.blobsInUse?.() ?? []) keep.add(id);
    await blobs.sweep(keep).catch(() => 0);
  }
}
