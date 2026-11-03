import {
  NOTE_FILES_MAX,
  type Note,
  type NoteCreate,
  type NotePatch,
  type NotesMessage,
} from "@baton/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { createNote, deleteNote, fetchNotes, patchNote, uploadFile } from "../lib/notes-api.js";

export type NotesState = {
  notes: Note[];
  onMessage(message: NotesMessage): void;
  create(body: NoteCreate): Promise<Note | undefined>;
  update(id: string, patch: NotePatch): void;
  remove(id: string): void;
  /** Uploads files and pins them to the note. */
  attach(id: string, files: readonly File[]): Promise<void>;
  error: string | undefined;
  clearError(): void;
};

/** The canvas's sticky notes, shared with everyone on the hub and kept live by the socket. */
export function useNotes(): NotesState {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  useEffect(() => {
    const controller = new AbortController();
    fetchNotes(controller.signal).then(
      (loaded) => setNotes((current) => mergeNotes(loaded, current)),
      (err: unknown) => {
        if (!controller.signal.aborted) setError(message(err));
      },
    );
    return () => controller.abort();
  }, []);

  const onMessage = useCallback((m: NotesMessage) => setNotes((n) => applyNotesMessage(n, m)), []);
  const fail = useCallback((err: unknown) => setError(message(err)), []);

  const create = useCallback(
    async (body: NoteCreate) => {
      try {
        const note = await createNote(body);
        setNotes((n) => mergeNotes(n, [note]));
        return note;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    [fail],
  );

  const update = useCallback(
    (id: string, patch: NotePatch) => {
      // Shown at once; the hub's echo (or the response) confirms it.
      setNotes((n) => n.map((x) => (x.id === id ? applyPatch(x, patch) : x)));
      patchNote(id, patch).then((note) => setNotes((n) => mergeNotes(n, [note])), fail);
    },
    [fail],
  );

  const remove = useCallback(
    (id: string) => {
      setNotes((n) => n.filter((x) => x.id !== id));
      deleteNote(id).catch(fail);
    },
    [fail],
  );

  const attach = useCallback(
    async (id: string, files: readonly File[]) => {
      const note = notesRef.current.find((n) => n.id === id);
      if (!note || files.length === 0) return;
      const room = NOTE_FILES_MAX - note.files.length;
      if (room <= 0) return fail(new Error(`A note holds at most ${NOTE_FILES_MAX} files`));
      try {
        const uploaded = await Promise.all(files.slice(0, room).map(uploadFile));
        const latest = notesRef.current.find((n) => n.id === id) ?? note;
        const known = new Set(latest.files.map((f) => `${f.sha256}/${f.name}`));
        const added = uploaded.filter((f) => !known.has(`${f.sha256}/${f.name}`));
        const next = [...latest.files, ...added].slice(0, NOTE_FILES_MAX);
        const saved = await patchNote(id, { files: next });
        setNotes((n) => mergeNotes(n, [saved]));
        if (files.length > room) fail(new Error(`Only ${room} more file(s) fit on that note`));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  return {
    notes,
    onMessage,
    create,
    update,
    remove,
    attach,
    error,
    clearError: () => setError(undefined),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `current` with `incoming` notes added or replaced (the newer `updatedAt` wins). */
export function mergeNotes(current: readonly Note[], incoming: readonly Note[]): Note[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) {
    const prev = byId.get(n.id);
    if (!prev || prev.updatedAt <= n.updatedAt) byId.set(n.id, n);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The notes after a `notes` message: a snapshot replaces them; otherwise merged, removals dropped. */
export function applyNotesMessage(current: readonly Note[], m: NotesMessage): Note[] {
  const base = m.snapshot ? [] : current;
  const removed = new Set(m.removed ?? []);
  return mergeNotes(
    base.filter((n) => !removed.has(n.id)),
    m.notes.filter((n) => !removed.has(n.id)),
  );
}

/** `note` with the fields `patch` sets (undefined fields are left alone). */
export function applyPatch(note: Note, patch: NotePatch): Note {
  return {
    ...note,
    x: patch.x ?? note.x,
    y: patch.y ?? note.y,
    color: patch.color ?? note.color,
    text: patch.text ?? note.text,
    files: patch.files ?? note.files,
  };
}
