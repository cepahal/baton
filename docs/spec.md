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
   record) runs to the end of the text. So does an injected tag that opens where
   typed text would start and never closes (a long `<task-notification>` cut by
   truncation): it is a `system` piece, not a prompt.
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

- Paths inside the record's `cwd` are shown relative to it, with `/` separators
  (`C:\proj\src\a.ts` in `C:\proj` → `src/a.ts`). Other paths are shown as is.
- Newlines and runs of whitespace collapse to a single space. Lengths count
  code points, and cuts never split a surrogate pair.
- `meta`: `{ toolName, toolUseId, input }`. `toolUseId` is the block `id`;
  `input` is the full tool input.

### `tool_result` ← `type: "user"`, `tool_result` block

- `text`: a **one-line summary**, at most **120 chars**, built from the result
  text (string content, or `text` blocks joined with `\n`) and the matching
  `tool_call`. `<call>` below is the call's `<tool> <short args>`; "lines" are
  non-empty lines.

  | Result of                  | `text`                                                                                                              |
  | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
  | `Bash`, `PowerShell`       | `Bash → exit 0, 42 lines` (exit code from a leading `Exit code N` line; `error` if failed without one; `no output`) |
  | `Read`                     | `Read src/api.ts (180 lines)` (numbered lines), or `(1 attachment)` for images                                      |
  | `Write`                    | `Write src/a.ts (12 lines)` (lines of `input.content`)                                                              |
  | `Edit`, `NotebookEdit`     | `Edit src/a.ts → ok`                                                                                                |
  | `Grep`, `Glob`             | `Grep TODO → 7 lines`, or `→ no matches`                                                                            |
  | any tool, `is_error: true` | `<call> → error: <first line>` (`<tool_use_error>` tags removed)                                                    |
  | any other tool             | `<call> → <first line> (+N lines)`, or `→ no output`                                                                |
  | a call core never saw      | `<first line> (+N lines)`, or `(no output)`                                                                         |

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
  `informational`): `meta` is `{ source: <subtype>, level? }`.
  System records without content (`turn_duration`, `stop_hook_summary`, …)
  emit nothing.

`text` is always a single line, so the viewer can show system events inline:

- If the trimmed content is one line of at most 120 chars, `text` is that line.
- Otherwise `text` is a recap (the first non-empty line, cut to fit, plus
  ` (+N lines)` if more non-empty lines follow) and the trimmed original is in
  `meta.full`, the same way `tool_result` works.

### Subagent (sidechain) events

Records with `isSidechain: true` come from a subagent started by an `Agent` /
`Task` tool call. They're parsed like any other record, and every event from
them also gets `meta.sidechain: true` and `meta.agentId` (when the record has
one). The viewer shows them as a collapsed group, closed by default, under the
tool call that started them. Compaction drops them (see below).

None of the local transcripts surveyed so far contain sidechain records, so
there's no fixture for them yet. The test uses synthetic records.

### Dropped

These are not human-readable and never produce events:

- `attachment` records (environment, skill listings, deferred-tool deltas,
  edited-file snapshots, hook context, …) and image/document blocks inside messages.
- `api-request`, `api-request-blob`, `api-request-shape`.
- `queue-operation`.
- `cost-state`.
- `redacted_thinking` blocks and every thinking `signature`.
- Bookkeeping records: `file-history-snapshot`, `file-history-delta`,
  `last-prompt`, `ai-title`, `custom-title`, `agent-name`, `summary`, `mode`,
  `permission-mode`, `atis-latch`, `tools-used` (`IGNORED_RECORD_TYPES` in core).
- **Any other record `type` not listed in this document.** New Claude Code
  versions will add more. Core drops them too, but reports each one to the
  `debug` hook (debug mode only) so format changes get noticed.

### Robustness

```ts
const parser = createTranscriptParser({ onWarning?, debug? });
parser.parseLine(raw: string): BatonEvent[]   // one JSONL line → 0..n events
parseTranscript(text, { debug? }): { events, warnings }
```

- `parseLine` never throws. A blank line, a half-written line, invalid JSON, a
  non-object, or a `user` / `assistant` / `system` record that doesn't match the
  schema core expects returns `[]`. Broken lines (everything but blank lines and
  unknown types) also go to `onWarning` as `{ line, reason }`.
- Input schemas are lenient: unknown fields are kept and ignored
  (`z.looseObject`, zod 4's `.passthrough()`), and one malformed or unknown
  content block is skipped without rejecting the rest of its record. Output is
  strict: every event matches `BatonEvent`.
- Assistant messages are streamed as several records sharing one `message.id`,
  usually one content block each. Core handles each record independently. The
  `<uuid>:<n>` id makes repeats harmless.
- Lines can be large (100 KB+, mostly `api-request*` and attachments). The daemon
  must not assume a maximum line length.

## Compaction

`compactForLLM(events, { thinking?: "drop" | "truncate" })` returns a new array
for handing a session to another LLM. It never changes its input. The full
stream the viewer shows is never shortened. These rules apply only to the handoff.

| Kind                            | Compact form                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `system`                        | dropped                                                                                |
| any event with `meta.sidechain` | dropped (the parent's `Agent`/`Task` call and result already say what it did)          |
| `thinking`                      | dropped (default), or with `thinking: "truncate"` cut to the first **500 chars** + `…` |
| `tool_result`                   | kept as the one-line summary; `meta.full` removed                                      |
| `tool_call`                     | kept as `<tool> <short args>`; `meta.input` removed                                    |
| `reply`                         | cut to the first **1000 chars** + `…`                                                  |
| `session_start`, `prompt`       | unchanged                                                                              |

Then, for every event left: a `text` over **4 KB** (4096 UTF-8 bytes) is cut on
a code point boundary and gets the marker `… [truncated, N bytes total]`.

`seq` is not renumbered, so gaps show where events were removed. If removing a
key leaves `meta` empty, `meta` is omitted.

### Size target

The handoff must be **more than 90% smaller than the raw transcript**, measured
as UTF-8 bytes of `compactForLLM` output written as JSONL vs. the raw JSONL.
`measureReduction(raw)` in core computes it. A test enforces it on every fixture,
and `pnpm report` prints it:

| Fixture       | Raw      | Full view | Handoff | Reduction |
| ------------- | -------- | --------- | ------- | --------- |
| api-requests  | 410.9 KB | 48.8 KB   | 22.9 KB | 94.4%     |
| code-review   | 485.0 KB | 50.4 KB   | 18.0 KB | 96.3%     |
| heavy-tools   | 405.5 KB | 80.0 KB   | 33.1 KB | 91.8%     |
| install-debug | 357.7 KB | 41.3 KB   | 16.7 KB | 95.3%     |
| long-build    | 476.4 KB | 56.4 KB   | 19.0 KB | 96.0%     |
| mixed         | 388.6 KB | 75.7 KB   | 29.3 KB | 92.5%     |

## Decided

- Subagent records: shown in the viewer as a closed dropdown under their parent
  tool call. Dropped from the handoff.
- `system` events: shown in the viewer. Ones that are already a single line are
  shown as is; everything else is recapped into one line (full text in `meta.full`).
- Long replies: never shortened in the viewer, but cut in the handoff.

## Open questions

- Should compaction summarize old turns as well, beyond the per-event rules above?
- Should the 4 KB `text` cap also apply to the full view? Today it applies only
  to the handoff, because the full view is meant to never be shortened.
- How does a viewer match a sidechain group to its parent `Agent` call? No real
  sidechain transcript has been captured yet to confirm which field links them.
