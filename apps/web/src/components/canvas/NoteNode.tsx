import { formatBytes, isInlineImage, NOTE_TEXT_MAX, type Note } from "@baton/core";
import type { Node, NodeProps } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { blobUrl } from "../../lib/notes-api.js";
import { Markdown } from "../events/Markdown.js";

export type NoteNodeData = {
  note: Note;
  /** The note is over a session card mid-drag: letting go hands it off. */
  armed: boolean;
  onText(id: string, text: string): void;
  onFiles(id: string, files: File[]): void;
  onPreview(id: string): void;
};
export type NoteNodeType = Node<NoteNodeData, "note">;

/** How long a click waits to see if it's the first half of a double-click. */
const CLICK_DELAY_MS = 220;

/**
 * A sticky note on the canvas. Click to open it; double-click to write on it;
 * drop files on it (or use the clip) to pin them; drag it onto a session card
 * to send that session a copy. The note itself stays put.
 */
export function NoteNode({ data }: NodeProps<NoteNodeType>) {
  const { note, armed } = data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [over, setOver] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(note.text);
  }, [note.text, editing]);
  useEffect(() => {
    if (editing) textArea.current?.focus();
  }, [editing]);
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  const finish = () => {
    setEditing(false);
    if (draft !== note.text) data.onText(note.id, draft);
  };
  const image = note.files.find((f) => isInlineImage(f.mime));
  const others = note.files.filter((f) => f !== image);

  return (
    <article
      className={`note note-${note.color}${over ? " is-drop-target" : ""}${armed ? " is-armed" : ""}${editing ? " is-editing" : ""}`}
      aria-label="Sticky note"
      onClick={() => {
        if (editing) return;
        clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => data.onPreview(note.id), CLICK_DELAY_MS);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        clearTimeout(clickTimer.current);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (!editing && e.key === "Enter") data.onPreview(note.id);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        data.onFiles(note.id, Array.from(e.dataTransfer.files));
      }}
    >
      {editing ? (
        <textarea
          ref={textArea}
          className="note-edit nodrag nowheel"
          value={draft}
          maxLength={NOTE_TEXT_MAX}
          placeholder="Write something…"
          aria-label="Note text"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={finish}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setDraft(note.text);
              setEditing(false);
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish();
          }}
        />
      ) : (
        <>
          {image && (
            <img className="note-thumb" src={blobUrl(image)} alt={image.name} draggable={false} />
          )}
          {note.text ? (
            <div className="note-text">
              <Markdown text={note.text} />
            </div>
          ) : (
            !image &&
            others.length === 0 && <p className="note-hint">Double-click to write, or drop files</p>
          )}
          {others.length > 0 && (
            <ul className="note-files">
              {others.slice(0, 3).map((f) => (
                <li key={`${f.sha256}/${f.name}`} title={`${f.name} · ${formatBytes(f.size)}`}>
                  {f.name}
                </li>
              ))}
              {others.length > 3 && <li className="note-more">+{others.length - 3} more</li>}
            </ul>
          )}
        </>
      )}
      <button
        type="button"
        className="note-clip nodrag"
        aria-label="Attach files"
        title="Attach files"
        onClick={(e) => {
          e.stopPropagation();
          clearTimeout(clickTimer.current);
          fileInput.current?.click();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <ClipIcon />
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) data.onFiles(note.id, files);
        }}
      />
      <span className="note-curl" aria-hidden />
    </article>
  );
}

function ClipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5.2 5.2a4.2 4.2 0 0 0 6 6l4.2-4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
