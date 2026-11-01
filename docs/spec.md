# Baton event spec (v1)

Baton turns Claude Code transcript files (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`,
one JSON record per line) into a stream of **`BatonEvent`s**. Core
(`@baton/core`) does the conversion as a pure function. The daemon feeds it
lines and broadcasts the result. The web viewer only ever sees `BatonEvent`s.

There are two views of the same stream:

- **Full fidelity** (`parseTranscript` / `createTranscriptParser`): everything a
  human can read, including thinking, full tool output and injected system
  content. This is what teammates watch live.
- **Compact** (`compactForLLM`): a token-saving view for handing a session off
  to another LLM session. See [Compaction](#compaction).

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
  kind: "session_start" | "prompt" | "reply" | "thinking"
      | "tool_call" | "tool_result" | "system";
  text: string;
  meta?: Record<string, JsonValue>;
}
```

| Field         | Rules                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Deterministic, so re-reading a file produces the same ids: `<record uuid>:<n>`, where `n` counts the events emitted from that record (0, 1, …). `session_start` uses `<sessionId>:start`. Viewers dedupe on `id`. |
| `sessionId`   | The transcript record's `sessionId` (equals the file name without `.jsonl`).                                                                                                                                      |
| `projectPath` | The record's `cwd` (absolute path, as written by Claude Code, Windows or POSIX). Records without `cwd` keep the session's last known value.                                                                       |
| `ts`          | The record's `timestamp`. Records without one emit nothing.                                                                                                                                                       |
| `seq`         | Starts at 0 for `session_start` and goes up by exactly 1 for each event emitted in that session. In the full stream, gaps mean the viewer missed events.                                                          |
| `kind`        | See the mapping below. Unknown kinds are a schema error.                                                                                                                                                          |
| `text`        | Human-readable. Viewers render it as plain text (never HTML).                                                                                                                                                     |
| `meta`        | Optional, JSON-only. Defined keys are listed per kind below. Viewers must ignore keys they don't know.                                                                                                            |

## Labelling user-side content

`type: "user"` records mix three very different things. Core labels every piece
before emitting it:

| Label         | What it is                                                                             | Emitted as    |
| ------------- | -------------------------------------------------------------------------------------- | ------------- |
| `prompt`      | Something the person actually typed, pasted, ran as a slash command, or ran with `!`.  | `prompt`      |
| `tool_result` | A `tool_result` content block: output of a tool Claude called.                         | `tool_result` |
| `system`      | Content Claude Code injected that the person did not type (reminders, IDE context, …). | `system`      |

The rules, applied to each `text` block (or string `content`) of a user record:

1. If the record has `isCompactSummary: true`, the whole text is `system`
   (`source: "compact_summary"`). If it has `isMeta: true`, the whole text is
   `system` (`source: "meta"`).
2. Otherwise the text is split on known tags:

   | Tag                                                                                                                                                                                                                                                  | Label    | `source`        | Becomes                            |
   | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------- | ---------------------------------- |
   | `<pasted_content …>…</pasted_content …>`                                                                                                                                                                                                             | `prompt` | `pasted`        | inner text, verbatim               |
   | `<bash-input>`                                                                                                                                                                                                                                       | `prompt` | `bash`          | `!<command>`                       |
   | `<command-name>`, `<command-args>`, `<command-message>`                                                                                                                                                                                              | `prompt` | `slash_command` | `/<name> <args>` (message dropped) |
   | `<system-reminder>`, `<ide_opened_file>`, `<ide_selection>`, `<ide_diagnostics>`, `<local-command-caveat>`, `<local-command-stdout>`, `<local-command-stderr>`, `<bash-stdout>`, `<bash-stderr>`, `<task-notification>`, `<user-prompt-submit-hook>` | `system` | the tag name    | inner text                         |
   | untagged text                                                                                                                                                                                                                                        | `prompt` | `typed`         | as is                              |
   | untagged text that is exactly `[Request interrupted by user…]`                                                                                                                                                                                       | `system` | `interrupt`     | as is                              |

   Anything inside `<pasted_content>` stays verbatim, even if it looks like an
   injected tag. A `<pasted_content>` opener with no closing tag (e.g. a truncated
   record) runs to the end of the text.
3. All `prompt` pieces of one record merge into **one** `prompt` event, placed
   where its first non-empty piece was. Each `system` piece is its own event.
   Empty pieces emit nothing.

Unknown tags are left in the prompt text as typed. Adding a tag to the table is
a spec change.

## Mapping transcript records → events

Every transcript line is a JSON object with a `type`. Core handles `user`,
`assistant` and `system` records and drops everything else (see [Dropped](#dropped)).

### `session_start`

Emitted once, before the first other event of a session (i.e. when core first
sees a record that yields an event for an unseen `sessionId`).

- `text`: `projectPath`
- `meta`: `{ gitBranch?, version? }` (Claude Code version) from that record.

### `prompt` ← `type: "user"`, labelled `prompt`

- `text`: the merged prompt, trimmed.
- `meta`: `{ sources }`: which of `typed`, `pasted`, `slash_command`, `bash`
  went into it, in order of first appearance.
- `image` and other non-text blocks are dropped.

### `reply` ← `type: "assistant"`, `text` block

- One event per non-empty `text` block. Its `text` is the block's text, unchanged.
- `meta`: `{ model }` from `message.model`.

### `thinking` ← `type: "assistant"`, `thinking` block

- One event per `thinking` block with non-empty `thinking` text, unchanged.
- `meta`: `{ model }`.
- **Missing or empty thinking is normal**, not an error. Most `thinking` blocks
  in real transcripts carry only a `signature` (thinking not stored, or summarized
  away), and smaller or lower-effort models often think little or not at all.
  These emit nothing. `redacted_thinking` blocks emit nothing.
- The `signature` is never sent.

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
- `meta`: `{ toolName, toolUseId, input }`. `toolUseId` is the block `id`;
  `input` is the full tool input.

### `tool_result` ← `type: "user"`, `tool_result` block

- `text`: a **one-line summary**: the first non-empty line of the result text
  (string content, or `text` blocks joined with `\n`), at most **120 chars**. If
  more non-empty lines follow, append ` (+N lines)`. If there is no text, use
  `(no output)`.
- `meta`: `{ toolUseId, toolName?, isError, lines, nonText?, full }`.
  - `toolName`: from the matching `tool_call`, if core saw it.
  - `isError`: the block's `is_error` (default `false`).
  - `lines`: total line count of `full`.
  - `nonText`: number of non-text parts (images, …) dropped, if any.
  - `full`: the complete result text.
- The `toolUseResult` sidecar field on the record is ignored.

### `system` ← injected user content, or `type: "system"` with content

- From user records: one event per piece labelled `system` (see
  [Labelling](#labelling-user-side-content)). `meta`: `{ source }`.
- From `type: "system"` records that have a non-empty `content` (e.g.
  `compact_boundary` → "Conversation compacted", `local_command`,
  `informational`): `text` is `content`, `meta` is `{ source: <subtype>, level? }`.
  System records without content (`turn_duration`, `stop_hook_summary`, …)
  emit nothing.

### Dropped

These are not human-readable and never produce events:

- `attachment` records (environment, skill listings, deferred-tool deltas,
  edited-file snapshots, hook context, …) and image/document blocks inside messages.
- `api-request`, `api-request-blob`, `api-request-shape`.
- `queue-operation`.
- `cost-state`.
- `redacted_thinking` blocks and every thinking `signature`.
- **Any record `type` not listed in this document.** Types seen in real
  transcripts that fall under this rule today: `file-history-snapshot`,
  `file-history-delta`, `last-prompt`, `ai-title`, `custom-title`, `agent-name`,
  `mode`, `permission-mode`, `atis-latch`, `tools-used`. New Claude Code versions
  will add more, and core must drop them silently.

### Robustness

- A line that isn't valid JSON, or a `user` / `assistant` / `system` record that
  doesn't match the schema core expects, is skipped. It's reported to the
  caller as a parse warning (`{ line, reason }`) and never thrown. Unknown record
  types are dropped without a warning.
- Assistant messages are streamed as several records sharing one `message.id`,
  usually one content block each. Core handles each record independently. The
  `<uuid>:<n>` id makes repeats harmless.
- Lines can be large (100 KB+, mostly `api-request*` and attachments). The daemon
  must not assume a maximum line length.

## Compaction

`compactForLLM(events, { thinking?: "drop" | "truncate" })` returns a new array
for handing a session to another LLM. It never changes its input.

| Kind                               | Compact form                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `system`                           | dropped                                                                                |
| `thinking`                         | dropped (default), or with `thinking: "truncate"` cut to the first **500 chars** + `…` |
| `tool_result`                      | kept as the one-line summary; `meta.full` removed                                      |
| `tool_call`                        | kept as `<tool> <short args>`; `meta.input` removed                                    |
| `session_start`, `prompt`, `reply` | unchanged                                                                              |

`seq` is not renumbered, so gaps show where events were removed. If removing a
key leaves `meta` empty, `meta` is omitted.

## Open questions

- Sidechain (subagent) records (`isSidechain: true`): show them, or show them
  grouped under their parent tool call? For now they are treated like any other record.
- Should `system` events be hidden by default in the viewer (shown on demand)?
- Should compaction also shorten long `reply` text, or summarize old turns?
