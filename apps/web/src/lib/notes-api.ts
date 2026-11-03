import {
  BlobResponse,
  NOTE_FILE_MAX_BYTES,
  type Note,
  type NoteColor,
  type NoteCreate,
  type NoteFile,
  type NotePatch,
  NoteResponse,
  NotesResponse,
} from "@baton/core";

export const NOTE_COLORS: readonly NoteColor[] = ["yellow", "pink", "orange", "blue"];

/** A note's color when it's stuck up: any of the four, at random. */
export function randomNoteColor(random: () => number = Math.random): NoteColor {
  return NOTE_COLORS[Math.floor(random() * NOTE_COLORS.length) % NOTE_COLORS.length] ?? "yellow";
}

async function failure(res: Response, what: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  const reason =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
  return new Error(`${what}: ${reason}`);
}

export async function fetchNotes(signal?: AbortSignal): Promise<Note[]> {
  const res = await fetch("/notes", signal ? { signal } : {});
  if (!res.ok) throw await failure(res, "Couldn't load sticky notes");
  return NotesResponse.parse(await res.json()).notes;
}

export async function createNote(body: NoteCreate): Promise<Note> {
  const res = await fetch("/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, "Couldn't add the note");
  return NoteResponse.parse(await res.json()).note;
}

export async function patchNote(id: string, patch: NotePatch): Promise<Note> {
  const res = await fetch(`/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await failure(res, "Couldn't save the note");
  return NoteResponse.parse(await res.json()).note;
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await failure(res, "Couldn't remove the note");
}

/** Uploads one file to the hub; returns it as a note file. */
export async function uploadFile(file: File): Promise<NoteFile> {
  if (file.size > NOTE_FILE_MAX_BYTES) {
    throw new Error(`${file.name} is over ${NOTE_FILE_MAX_BYTES / (1024 * 1024)} MB`);
  }
  const res = await fetch("/blobs", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw await failure(res, `Couldn't upload ${file.name}`);
  const { sha256, size, image } = BlobResponse.parse(await res.json());
  // The hub read the bytes: use its image type, and never label a non-image as one.
  const claimed = (file.type || "application/octet-stream").slice(0, 100);
  const mime =
    image ?? (claimed.toLowerCase().startsWith("image/") ? "application/octet-stream" : claimed);
  return { sha256, name: (file.name || "file").slice(0, 200), mime, size };
}

/** Where a note file is served: inline for images, a download otherwise. */
export function blobUrl(f: NoteFile, download = false): string {
  const q = new URLSearchParams({ type: f.mime, name: f.name });
  if (download) q.set("download", "1");
  return `/blobs/${f.sha256}?${q}`;
}
