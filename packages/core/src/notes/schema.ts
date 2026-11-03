import { z } from "zod";

/** Note ids are made by the hub: `n` + 10 base-36 characters. See docs/notes.md. */
export const NOTE_ID_PATTERN = /^n[0-9a-z]{10}$/;
export const NoteId = z.string().regex(NOTE_ID_PATTERN);
export type NoteId = z.infer<typeof NoteId>;

/** Most characters of a note's text. */
export const NOTE_TEXT_MAX = 20_000;
/** Most files on one note. */
export const NOTE_FILES_MAX = 12;
/** Most bytes of one uploaded file. */
export const NOTE_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Most notes on one canvas. */
export const NOTES_MAX = 500;

export const NoteColor = z.enum(["yellow", "pink", "orange", "blue"]);
export type NoteColor = z.infer<typeof NoteColor>;

/** A file's content address: the lowercase hex SHA-256 of its bytes. */
export const BlobId = z.string().regex(/^[0-9a-f]{64}$/);
export type BlobId = z.infer<typeof BlobId>;

/** A file pinned to a note (and copied onto a note's handoff). */
export const NoteFile = z.object({
  sha256: BlobId,
  name: z.string().min(1).max(200),
  mime: z.string().max(100),
  size: z.number().int().min(0).max(NOTE_FILE_MAX_BYTES),
});
export type NoteFile = z.infer<typeof NoteFile>;

const coord = z.number().finite().min(-1e6).max(1e6);

export const Note = z.object({
  id: NoteId,
  x: coord,
  y: coord,
  color: NoteColor,
  text: z.string().max(NOTE_TEXT_MAX),
  files: z.array(NoteFile).max(NOTE_FILES_MAX),
  /** Who stuck it up, as typed in their viewer. A label, not proof of identity. */
  author: z.string().min(1).max(64).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Note = z.infer<typeof Note>;

/** The saved notes file. */
export const NotesFile = z.array(Note).max(NOTES_MAX);

// ---- viewer ↔ hub (HTTP) ---------------------------------------------------

/** `POST /notes` body. */
export const NoteCreate = z.object({
  x: coord,
  y: coord,
  color: NoteColor,
  text: z.string().max(NOTE_TEXT_MAX).optional(),
  author: z.string().trim().min(1).max(64).optional(),
});
export type NoteCreate = z.infer<typeof NoteCreate>;

/** `PATCH /notes/:id` body: only the fields that changed. */
export const NotePatch = z
  .object({
    x: coord,
    y: coord,
    color: NoteColor,
    text: z.string().max(NOTE_TEXT_MAX),
    files: z.array(NoteFile).max(NOTE_FILES_MAX),
  })
  .partial()
  .strict();
export type NotePatch = z.infer<typeof NotePatch>;

export const NoteResponse = z.object({ note: Note });
export type NoteResponse = z.infer<typeof NoteResponse>;
export const NotesResponse = z.object({ notes: z.array(Note) });
export type NotesResponse = z.infer<typeof NotesResponse>;

/** `POST /blobs` response. */
export const BlobResponse = z.object({ sha256: BlobId, size: z.number().int().min(0) });
export type BlobResponse = z.infer<typeof BlobResponse>;

/** Types a viewer may show inline. Everything else is served as a download. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGES.has(mime.toLowerCase());
}

/** Plain text a viewer may preview: text/* (not html) and a few text formats. */
export function isPreviewableText(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m === "text/html" || m === "image/svg+xml") return false;
  if (m.startsWith("text/") || m === "application/json") return true;
  return /\.(md|txt|json|ya?ml|csv|log|toml|ts|tsx|js|py|rs|go|java|sql|sh)$/i.test(name);
}

/**
 * A file name safe to write in a folder on any OS: no separators, no reserved
 * characters or device names, no leading dots. Never empty.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let out = [...base]
    .map((c) => ((c.codePointAt(0) ?? 0) < 32 ? "_" : c))
    .join("")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = `_${out}`;
  return out === "" ? "file" : out;
}
