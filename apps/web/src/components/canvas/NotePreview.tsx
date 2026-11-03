import {
  formatBytes,
  isInlineImage,
  isPreviewableText,
  NOTE_TEXT_MAX,
  type Note,
  type NoteColor,
  type NoteFile,
} from "@baton/core";
import { useEffect, useRef, useState } from "react";
import { blobUrl, NOTE_COLORS } from "../../lib/notes-api.js";

type Props = {
  note: Note;
  onText(text: string): void;
  onColor(color: NoteColor): void;
  onFiles(files: File[]): void;
  onRemoveFile(file: NoteFile): void;
  onDelete(): void;
  onClose(): void;
};

const COLOR_NAMES: Record<NoteColor, string> = {
  yellow: "Yellow",
  pink: "Pink",
  orange: "Orange",
  blue: "Baby blue",
};

/** Largest text file shown in the preview; bigger ones are cut. */
const TEXT_PREVIEW_MAX = 200_000;

/** A sticky note opened up: its text (editable), its files, and its color. */
export function NotePreview({
  note,
  onText,
  onColor,
  onFiles,
  onRemoveFile,
  onDelete,
  onClose,
}: Props) {
  const [text, setText] = useState(note.text);
  const textRef = useRef(text);
  textRef.current = text;
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => dialog.current?.focus(), []);
  // Someone else changed the note while it's open: show theirs unless we're typing.
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(note.text);
  }, [note.text]);

  const save = () => {
    typing.current = false;
    if (textRef.current !== note.text) onText(textRef.current);
  };
  const close = () => {
    save();
    onClose();
  };

  return (
    <div className="handoff-backdrop">
      <div
        ref={dialog}
        tabIndex={-1}
        className={`note-preview note-${note.color}`}
        role="dialog"
        aria-modal="true"
        aria-label="Sticky note"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          onFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <header className="note-preview-head">
          <fieldset className="note-swatches" aria-label="Note color">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={note.color === c}
                aria-label={COLOR_NAMES[c]}
                title={COLOR_NAMES[c]}
                className={`note-swatch note-${c}${note.color === c ? " is-on" : ""}`}
                onClick={() => onColor(c)}
              />
            ))}
          </fieldset>
          <span className="note-preview-meta">
            {note.author ? `${note.author} · ` : ""}
            {new Date(note.updatedAt).toLocaleString()}
          </span>
          <button type="button" className="handoff-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <textarea
          className="note-preview-text"
          value={text}
          maxLength={NOTE_TEXT_MAX}
          placeholder="Write something…"
          aria-label="Note text"
          onChange={(e) => {
            typing.current = true;
            setText(e.target.value);
          }}
          onBlur={save}
        />
        {note.files.length > 0 && (
          <ul className="note-preview-files">
            {note.files.map((f) => (
              <li key={`${f.sha256}/${f.name}`}>
                <FilePreview file={f} />
                <div className="note-file-row">
                  <a className="note-file-name" href={blobUrl(f, true)} download={f.name}>
                    {f.name}
                  </a>
                  <span>{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    className="note-file-remove"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => onRemoveFile(f)}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <footer className="note-preview-foot">
          <button type="button" className="note-btn" onClick={() => fileInput.current?.click()}>
            Attach files
          </button>
          <span className="note-preview-tip">Drag the note onto a session to send it a copy.</span>
          <button type="button" className="note-btn is-danger" onClick={onDelete}>
            Take down
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) onFiles(files);
            }}
          />
        </footer>
      </div>
    </div>
  );
}

function FilePreview({ file }: { file: NoteFile }) {
  if (isInlineImage(file.mime)) {
    return <img className="note-preview-image" src={blobUrl(file)} alt={file.name} />;
  }
  if (isPreviewableText(file.mime, file.name)) return <TextPreview file={file} />;
  return null;
}

function TextPreview({ file }: { file: NoteFile }) {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    fetch(blobUrl(file, true), { signal: abort.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (t) => setText(t.length > TEXT_PREVIEW_MAX ? `${t.slice(0, TEXT_PREVIEW_MAX)}\n…` : t),
        () => {
          if (!abort.signal.aborted) setText("(couldn't load this file)");
        },
      );
    return () => abort.abort();
  }, [file]);
  return <pre className="note-preview-pre">{text ?? "Loading…"}</pre>;
}
