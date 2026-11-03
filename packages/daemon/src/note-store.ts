import { randomBytes } from "node:crypto";
import { NOTES_MAX, Note, type NoteCreate, type NotePatch } from "@baton/core";
import type { Logger } from "pino";
import {
  loadVersioned,
  parseRecords,
  saveVersioned,
  type VersionedSpec,
} from "./versioned-file.js";

/** The notes file. Version 0 was a bare array of notes. */
export const NOTES_FILE: VersionedSpec<Note[]> = {
  what: "notes",
  version: 1,
  migrations: [(data) => data],
  parse: parseRecords(Note, NOTES_MAX),
};

/** Ids: "n" + 10 base-36 characters. */
export function newNoteId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "n";
  for (const byte of randomBytes(10)) id += alphabet[byte % 36];
  return id;
}

export type NoteStoreOptions = {
  /** Where notes are saved (debounced). Default: in memory only. */
  file?: string;
  logger?: Logger;
  saveDelayMs?: number;
  now?: () => Date;
  newId?: () => string;
};

/**
 * The canvas's sticky notes, shared by everyone on the hub. A JSON file, not a
 * database: notes are few (NOTES_MAX) and small; their files live in the
 * BlobStore.
 */
export class NoteStore {
  readonly #notes = new Map<string, Note>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: NoteStoreOptions = {}) {}

  /**
   * Reads the saved file, if any, upgrading older versions. Never loses data
   * (see `loadVersioned`); throws if the file is newer than this build.
   */
  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    const notes = await loadVersioned(file, NOTES_FILE, this.options.logger);
    for (const n of notes ?? []) this.#notes.set(n.id, n);
  }

  all(): Note[] {
    return [...this.#notes.values()];
  }

  get(id: string): Note | undefined {
    return this.#notes.get(id);
  }

  get size(): number {
    return this.#notes.size;
  }

  /** A new note, or undefined when the canvas already holds NOTES_MAX. */
  create(body: NoteCreate): Note | undefined {
    if (this.#notes.size >= NOTES_MAX) return undefined;
    const at = this.#now();
    const note: Note = {
      id: (this.options.newId ?? newNoteId)(),
      x: body.x,
      y: body.y,
      color: body.color,
      text: body.text ?? "",
      files: [],
      ...(body.author === undefined ? {} : { author: body.author }),
      createdAt: at,
      updatedAt: at,
    };
    this.#notes.set(note.id, note);
    this.#scheduleSave();
    return note;
  }

  /** The changed note, the same note when nothing changed, or undefined if it's gone. */
  update(id: string, patch: NotePatch): { note: Note; changed: boolean } | undefined {
    const prev = this.#notes.get(id);
    if (!prev) return undefined;
    const next: Note = { ...prev };
    if (patch.x !== undefined) next.x = patch.x;
    if (patch.y !== undefined) next.y = patch.y;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.text !== undefined) next.text = patch.text;
    if (patch.files !== undefined) next.files = patch.files.map((f) => ({ ...f }));
    if (JSON.stringify(next) === JSON.stringify(prev)) return { note: prev, changed: false };
    next.updatedAt = this.#now();
    this.#notes.set(id, next);
    this.#scheduleSave();
    return { note: next, changed: true };
  }

  /** Takes a note down; returns it, or undefined if it wasn't there. */
  remove(id: string): Note | undefined {
    const note = this.#notes.get(id);
    if (!note) return undefined;
    this.#notes.delete(id);
    this.#scheduleSave();
    return note;
  }

  /** Every file some note holds. */
  blobsInUse(): Set<string> {
    const out = new Set<string>();
    for (const n of this.#notes.values()) for (const f of n.files) out.add(f.sha256);
    return out;
  }

  /** Writes any pending change now. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#save();
    }
    await this.#saving;
  }

  #now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  #scheduleSave(): void {
    if (this.options.file === undefined || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#save();
    }, this.options.saveDelayMs ?? 300);
    this.#timer.unref?.();
  }

  #save(): void {
    const file = this.options.file;
    if (file === undefined) return;
    const data = this.all();
    this.#saving = this.#saving.then(async () => {
      try {
        await saveVersioned(file, NOTES_FILE.version, data);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save the notes file");
      }
    });
  }
}
