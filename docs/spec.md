# Baton event spec (v0)

Baton turns Claude Code transcript files (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`,
one JSON record per line) into a stream of **`BatonEvent`s**. Core
(`@baton/core`) does the conversion as a pure function. The daemon feeds it
lines and broadcasts the result. The web viewer only ever sees `BatonEvent`s.

The zod schema in [`packages/core/src/event.ts`](../packages/core/src/event.ts)
implements this document. When they disagree, fix one of them in the same change.

## `BatonEvent`

```ts
{
  id: string;          // stable, unique within a session
  sessionId: string;
  projectPath: string;
  ts: string;          // ISO-8601 with offset
  seq: number;         // 0, 1, 2, … per session
  kind: "session_start" | "prompt" | "reply" | "tool_call" | "tool_result";
  text: string;
  meta?: Record<string, JsonValue>;
}
```

| Field         | Rules                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Deterministic, so re-reading a file produces the same ids: `<record uuid>:<content block index>`. `session_start` uses `<sessionId>:start`. Viewers dedupe on `id`. |
| `sessionId`   | The transcript record's `sessionId` (equals the file name without `.jsonl`).                                                                                        |
| `projectPath` | The record's `cwd` (absolute path, as written by Claude Code, Windows or POSIX).                                                                                    |
| `ts`          | The record's `timestamp`. Records without one emit nothing.                                                                                                         |
| `seq`         | Starts at 0 for `session_start` and goes up by exactly 1 for each event emitted in that session. Gaps mean the viewer missed events.                                |
| `kind`        | See the mapping below. Unknown kinds are a schema error.                                                                                                            |
| `text`        | Human-readable, already filtered and truncated by core. Viewers render it as plain text (never HTML).                                                               |
| `meta`        | Optional, JSON-only, small. Defined keys are listed per kind below. Viewers must ignore keys they don't know.                                                       |

## Mapping transcript records → events

Every transcript line is a JSON object with a `type`. Core handles the
types listed here and drops everything else (see "Dropped").

### `session_start`

Emitted once, before the first other event of a session (i.e. when core first
sees a record that yields an event for an unseen `sessionId`).
- `text`: `projectPath`
- `meta`: `{ gitBranch?, version? }` (Claude Code version) from that record.

### `prompt` ← `type: "user"` with human text

- `message.content` is a string, or an array whose `text` blocks are joined with
  `\n`. One event per record.
- Drop `<system-reminder>…</system-reminder>` spans from the text, then trim. If
  nothing is left, emit nothing.
- Skip records with `isMeta: true` (injected by Claude Code, not typed by the user).
- `image` and other non-text blocks are dropped. `meta.attachments` holds the
  number dropped, if any.

### `reply` ← `type: "assistant"`, `text` block

- One event per `text` block. Its `text` is the block's text, unchanged.
- `meta`: `{ model }` from `message.model`.

### `tool_call` ← `type: "assistant"`, `tool_use` block

- `text`: `<tool name> <short args>`, on one line, at most **120 chars** (cut with `…`).
- Short args are picked per tool, falling back to compact JSON of `input`:

  | Tool                                    | Short args                        |
  | --------------------------------------- | --------------------------------- |
  | `Bash`, `PowerShell`                    | `command` (first line)            |
  | `Read`, `Write`, `Edit`, `NotebookEdit` | `file_path`                       |
  | `Grep`, `Glob`                          | `pattern` (+ ` in <path>` if set) |
  | `WebFetch`                              | `url`                             |
  | `WebSearch`                             | `query`                           |
  | `Agent` / `Task`                        | `description`                     |
  | anything else                           | `JSON.stringify(input)`           |

- Newlines and runs of whitespace collapse to a single space.
- `meta`: `{ toolName, toolUseId }` (`toolUseId` = block `id`).

### `tool_result` ← `type: "user"`, `tool_result` block

- Collapse the result to a **one-line summary**: the first non-empty line of the
  result text (string content, or `text` blocks joined), at most **120 chars**.
  If the result has more lines, append ` (+N lines)`. If it has no text (e.g. only
  an image), use `(no output)`.
- `meta`: `{ toolUseId, isError, lines }`. `isError` comes from the block's
  `is_error` (default `false`). `lines` is the total line count.
- The full result is never sent. The `toolUseResult` sidecar field on the record
  is ignored.

### Dropped

These never produce events:

- `thinking` and `redacted_thinking` content blocks (and their `signature`s).
- `attachment` records (environment, skill listings, deferred-tool deltas, edited-file
  snapshots, hook context, …) and image/document blocks inside messages.
- `api-request`, `api-request-blob`, `api-request-shape`.
- `queue-operation`.
- `cost-state`.
- System reminders: `<system-reminder>` spans inside user text are removed as
  described above.
- **Any record `type` not listed in this document.** Types seen in real
  transcripts that fall under this rule today: `file-history-snapshot`,
  `file-history-delta`, `last-prompt`, `ai-title`, `custom-title`, `agent-name`,
  `mode`, `permission-mode`, `atis-latch`, `tools-used`, `system`. New Claude Code
  versions will add more, and core must drop them silently.

### Robustness

- A line that isn't valid JSON, or doesn't match the record schema core expects,
  is skipped. It's reported to the caller as a parse warning and never thrown.
- Assistant messages are streamed as several records sharing one `message.id`,
  usually one content block each. Core handles each record independently. The
  `<uuid>:<index>` id makes repeats harmless.
- Lines can be large (100 KB+, mostly `api-request*` and attachments). The daemon
  must not assume a maximum line length.

## Open questions (not decided for v0)

- Sidechain (subagent) records (`isSidechain: true`): show them, or show them
  grouped under their parent tool call? For v0 they are treated like any other record.
- IDE context tags in prompts (`<ide_opened_file>`, `<ide_selection>`): strip them
  like system reminders, or show them as a dim line?
- Slash-command records (`<command-name>`…): map them to `prompt`, or add a new kind?
