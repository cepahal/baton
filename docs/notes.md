# Sticky notes

Sticky notes put small things on the canvas for everyone on the hub to see: a
screenshot, a problem statement, what's left to finish. You can drag a note
onto a session to hand it off. The session gets a copy, and the note stays
where it was.

## Using them

- **Make one.** Drag the small yellow pad (top left of the canvas) to where you
  want the note, or click it to drop one near the middle. Each note comes up
  yellow, pink, orange or baby blue at random. Dropping files on an empty part
  of the canvas also makes a note that holds them.
- **Fill it.** Double-click to write plain text (Esc cancels; clicking away or
  Ctrl+Enter saves). Drop files on the note, or use its paperclip to pick them
  from the file explorer.
- **Open it.** A single click opens the preview. It shows the full text, images
  inline, text files as text and everything else as a download, plus color
  swatches, Attach files and Take down.
- **Hand it off.** Drag the note onto a session card; the card glows when the
  drop will land. The note jumps back to its spot and the handoff dialog opens
  with the note's markdown, which you can edit. When the receiver accepts, the
  markdown goes to `.baton/handoffs/<id>.md` and the files to
  `.baton/handoffs/<id>/`.

## Storage (no database)

Notes are one JSON file. Files are kept by content in a folder:

|                    | `baton start` (this machine)        | `baton serve` (the team)                 |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| Notes              | `notes.json` next to the state file | `team-notes.json` next to the state file |
| Files (`<sha256>`) | `blobs/`                            | `team-blobs/`                            |

Every viewer of a hub sees the same notes, so on a team server everyone with
the token sees them from any machine. Files are named by their SHA-256, so the
same screenshot is stored once. A file is deleted once no note and no pending
handoff needs it. Writes are debounced and atomic, like `canvas.json`.

These caps come from `packages/core/src/notes/schema.ts`: 500 notes, 20,000
characters of text and 12 files per note, 10 MB per file, and 1 GB of files per
hub. Past a cap the hub answers 409 (notes) or 507 (files).

## HTTP and socket

| Route                | Body / answer                                                                    |
| -------------------- | -------------------------------------------------------------------------------- |
| `GET /notes`         | `{ notes }`                                                                      |
| `POST /notes`        | `{ x, y, color, text?, author? }` → 201 `{ note }`                               |
| `PATCH /notes/:id`   | any of `{ x, y, color, text, files }` → `{ note }`; files must be uploaded first |
| `DELETE /notes/:id`  | 204                                                                              |
| `POST /blobs`        | raw bytes, `application/octet-stream`, ≤ 10 MB → 201 `{ sha256, size }`          |
| `GET /blobs/:sha256` | `?type=&name=&download=1`; see below                                             |

Every change goes to every viewer as `{ type: "notes", notes, removed? }`.
After `hello` (and the `canvas` snapshot) each viewer gets
`{ type: "notes", notes, snapshot: true }`, which replaces what it held.

Files are served with `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`. Only PNG, JPEG, GIF and
WebP are sent inline with their type. Everything else, SVG and HTML included,
is sent as an `application/octet-stream` attachment, so a note can't run script
in the viewer's origin.

On a team server these routes need the token, like every other route. When a
daemon accepts a note handoff from the team server, it fetches each file from
`GET /blobs/:sha256` with its bearer token and checks the SHA-256 before
writing it.

## Handoff kind

A note handoff is `kind: "note"` with `noteId`. The note isn't tied to a
session, so `fromSessionId` is the receiving session too. The handoff copies
the note's files into `attachments` when it's sent. Later edits to the note, or
taking it down, don't change a handoff already sent.
