# Baton event spec (v2)

Baton is agent-agnostic. It turns the session logs that coding agents write to
disk into one stream of **`BatonEvent`s**. Two agents are supported:

| `agent`       | Session log                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/projects/<project-slug>/<sessionId>.jsonl`, one JSON record per line          |
| `codex`       | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, one JSON record per line |

Each agent has an **adapter** in core (`@baton/core`) that converts its records
to events as a pure function, and a **source** in the daemon that finds the
logs and feeds records to the adapter (see [Agents and sources](#agents-and-sources)).
The daemon broadcasts the result. The web viewer only ever sees `BatonEvent`s
and never needs to know which log format they came from.

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
  agent: "claude-code" | "codex";
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

| Field         | Rules                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Deterministic, so re-reading a file produces the same ids: `<record id>:<n>`, where `n` counts the events emitted from that record (0, 1, …). `session_start` uses `<sessionId>:start`. Viewers and hubs dedupe on (`sessionId`, `id`): ids from different sessions may coincide, e.g. a forked Codex thread repeats its parent's item ids. Each adapter says which field is the record id. |
| `agent`       | The adapter that produced the event. Every event of a session has the same `agent`. Viewers may badge or filter on it, but must render every agent's events the same way. Events without `agent` (from older daemons or event logs) are read as `"claude-code"`.                                                                                                                            |
| `sessionId`   | The agent's session id: Claude Code's `sessionId`, Codex's thread id. Unique within an agent; viewers key sessions on `(agent, sessionId)`.                                                                                                                                                                                                                                                 |
| `projectPath` | The working directory (absolute path, as the agent wrote it, Windows or POSIX). Records without one keep the session's last known value.                                                                                                                                                                                                                                                    |
| `ts`          | The record's timestamp, as ISO-8601. Records without one emit nothing.                                                                                                                                                                                                                                                                                                                      |
| `seq`         | Starts at 0 for `session_start` and goes up by exactly 1 for each event emitted in that session. In the full stream, gaps mean the viewer missed events.                                                                                                                                                                                                                                    |
| `kind`        | See the mapping below. Unknown kinds are a schema error.                                                                                                                                                                                                                                                                                                                                    |
| `text`        | Human-readable. Viewers render it as plain text (never HTML).                                                                                                                                                                                                                                                                                                                               |
| `meta`        | Optional, JSON-only. Defined keys are listed per kind below. Viewers must ignore keys they don't know.                                                                                                                                                                                                                                                                                      |

## Agents and sources

Each supported agent has two halves. The **adapter** (in core) knows the log
format, and the **source** (in the daemon) knows how to get the records off disk.

### `AgentAdapter` (core)

```ts
type AgentId = "claude-code" | "codex";
type SourceKind = "jsonl-tail" | "rollout-tail";

interface AgentAdapter {
  id: AgentId;
  source: SourceKind;
  defaultRoots(): string[];             // home-relative, e.g. "~/.claude/projects"
  detect(path: string): boolean;        // is this file one of my session logs?
  parse(record: string): BatonEvent[];  // one raw log line → 0..n events
}

createAdapter(id: AgentId, opts?: { onWarning?, debug? }): AgentAdapter;
detectAgent(path: string): AgentId | undefined;  // which adapter's detect() matches
parseSession(id: AgentId, text: string, opts?: { debug? }): { events, warnings };
```

- Adapters are pure, like the rest of core. `defaultRoots()` returns paths that
  start with `~/`. The daemon expands `~` to the home directory. `detect()` only
  looks at the path string and never touches the file.
- `parse()` is stateful: it tracks the session, `seq`, the cwd, and the tool
  calls it has seen. So the daemon creates one adapter instance per session
  (`createAdapter`) and feeds it that session's lines in order.
- `parse()` follows the same [robustness](#robustness) rules for every agent:
  it never throws, drops records it doesn't know, and reports broken lines to
  `onWarning`.
- Every event an adapter emits has `agent` set to the adapter's `id`.
- `createTranscriptParser` and `parseTranscript` stay as the Claude Code
  adapter's API, so existing callers keep working.

### Sources (daemon)

The daemon owns all I/O. Its watcher builds one source per entry in core's
`AGENT_REGISTRY` (`id`, `source`, `defaultRoots()`, `detect`), rooted at
`defaultRoots()` unless the user overrides them (`--projects-dir`,
`--codex-dir`). A root that doesn't exist is skipped; the daemon refuses to start
only if none exist. The watcher still only talks to an `EventSink`.

| Source         | Used by       | How it reads                                                                                                                                                                                                                                        |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonl-tail`   | `claude-code` | Watch the roots for `*.jsonl` and tail each file from a saved byte offset. A line is passed to `parse` only once it ends with `\n`. See [daemon.md](daemon.md).                                                                                     |
| `rollout-tail` | `codex`       | `jsonl-tail` over `~/.codex/sessions/**/rollout-*.jsonl` (the date folders are nested), with all files of one thread fed to one adapter instance, plus `rollout-*.jsonl.zst` read whole when needed. Described under [Codex](#codex-adapter-codex). |

#### Why Codex is tailed from the rollout

Codex keeps three copies of a thread, and an event stream can be had two
more ways. [codex-source.md](codex-source.md) has the investigation, including
a live session watched file by file. In short:

- **Rollout file (chosen).** A live thread is a plain `rollout-….jsonl` that
  grows as each item completes, always by whole lines, about 150 ms before the
  same item reaches `codex exec --json` stdout. It sees sessions from every
  Codex front end. A background job (`codex_rollout::compression::worker`)
  later replaces idle rollouts with `.jsonl.zst`.
- **SQLite poll (rejected).** `thread_history_1.sqlite` `thread_items` is a
  projection of the rollout (`thread_history_projection_state` records the
  rollout byte offset it has reached), so it is never fresher. It is a WAL
  database another process writes, with versioned file names and frequent
  migrations. Baton only uses its rows to check the parser (see
  [Codex fixtures](#codex-fixtures)).
- **`exec --json` / app-server (rejected).** `exec --json` streams only the run
  it starts. The app-server is documented but "experimental", versioned per
  release, and Codex Desktop runs its own over stdio, so there's nothing to
  attach to for a session someone else started.

A running command appears in the rollout only when it completes. The
app-server's `item/started` would show it earlier; that's the main thing the
file source gives up.

## Claude Code adapter (`claude-code`)

Source: `jsonl-tail`. Default root: `~/.claude/projects`. `detect`: a
`<sessionId>.jsonl` file in a project folder under the root. Event ids use the
record's `uuid`.

### Labelling user-side content

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

### Mapping transcript records → events

Every transcript line is a JSON object with a `type`. Core handles `user`,
`assistant` and `system` records and drops everything else (see [Dropped](#dropped)).

#### `session_start`

Emitted once, before the first other event of a session (i.e. when core first
sees a record that yields an event for an unseen `sessionId`).

- `text`: `projectPath`
- `meta`: `{ gitBranch?, version? }` (Claude Code version) from that record.

#### `prompt` ← `type: "user"`, labelled `prompt`

- `text`: the merged prompt, trimmed.
- `meta`: `{ sources }`: which of `typed`, `pasted`, `slash_command`, `bash`
  went into it, in order of first appearance.
- `image` and other non-text blocks are dropped.

#### `reply` ← `type: "assistant"`, `text` block

- One event per non-empty `text` block. Its `text` is the block's text, unchanged.
- `meta`: `{ model }` from `message.model`.

#### `thinking` ← `type: "assistant"`, `thinking` block

- One event per `thinking` block with non-empty `thinking` text, unchanged.
- `meta`: `{ model }`.
- **Missing or empty thinking is normal**, not an error. Most `thinking` blocks
  in real transcripts carry only a `signature` (thinking not stored, or summarized
  away), and smaller or lower-effort models often think little or not at all.
  These emit nothing. `redacted_thinking` blocks emit nothing.
- The `signature` is never sent.

#### `tool_call` ← `type: "assistant"`, `tool_use` block

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

#### `tool_result` ← `type: "user"`, `tool_result` block

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

#### `system` ← injected user content, or `type: "system"` with content

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

#### Subagent (sidechain) events

Records with `isSidechain: true` come from a subagent started by an `Agent` /
`Task` tool call. They're parsed like any other record, and every event from
them also gets `meta.sidechain: true` and `meta.agentId` (when the record has
one). The viewer shows them as a collapsed group, closed by default, under the
tool call that started them. Compaction drops them (see below).

None of the local transcripts surveyed so far contain sidechain records, so
there's no fixture for them yet. The test uses synthetic records.

#### Dropped

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

#### Robustness

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

## Codex adapter (`codex`)

Source: `rollout-tail`. Default root: `~/.codex/sessions`, searched
recursively (`YYYY/MM/DD/`). `detect`: a file whose name matches
`rollout-*.jsonl` or `rollout-*.jsonl.zst`.

The daemon tails `.jsonl` rollouts live. Codex compresses an idle rollout to
`.jsonl.zst` and deletes the `.jsonl`; the daemon then carries on with the
`.zst` file at the same offset rather than treating it as a new session. A
`.jsonl.zst` is decompressed (whole, in memory) only when its history is
needed: an active thread's backlog at start-up, or a thread that wakes up. An
idle compressed thread isn't read at all. Node's `zlib` has zstd from 22.15;
on older Node the daemon logs a warning and skips `.zst` files. The adapter only
ever sees decompressed lines. When both versions of a rollout exist, the
`.jsonl` one wins.

### Rollout records

Each line is `{ timestamp, ordinal, type, payload }`. `ordinal` counts the
thread's records from 0. A record with no `timestamp` emits nothing.

Codex writes most turns twice: once as model-facing `response_item`s, and once
as `event_msg` / `item_completed` items, which are the same items its UI shows.
Baton reads the **`item_completed` items** and ignores the duplicate
`response_item`s, except for injected user-role context (see `system` below).

### Sessions and continuations

- `sessionId` is the thread id, `session_meta.payload.id`.
- A thread can span several rollout files. A **segment** is named
  `rollout-<time>-<threadId>_<segmentId>.jsonl` and is written after the user
  rewinds or edits an earlier turn. Its `session_meta` repeats the thread id and
  has a `history_base { thread_id, end_ordinal_exclusive, end_byte_offset }`:
  the segment continues from the previous file's first
  `end_ordinal_exclusive` records, and that file's later records are an
  abandoned branch. `history_base.thread_id` names the previous file (the
  thread, or an earlier segment).
- The daemon feeds every file of a thread to the same adapter instance, oldest
  first (by name), so `seq` stays continuous and only one `session_start` is
  emitted. Abandoned records stay in the stream: viewers saw them live. A
  segment's `session_meta` emits `system` "Conversation rewound to record N;
  continuing from there" (`source: "rewind"`), N being `end_ordinal_exclusive`.
- `projectPath` is `session_meta.payload.cwd`, then the latest
  `turn_context.payload.cwd`. The `file://` cwd inside command items is not used.
- The model is the latest `turn_context.payload.model`.

### Ids

- From an `item_completed` record: `<item.id>:<n>`. The item id matches
  `thread_items.item_id` in `~/.codex/thread_history_1.sqlite`, which lets the
  fixture test check the parser against Codex's own projection.
- From any other record: `<sessionId>:<ordinal>:<n>`. After a rewind,
  ordinals repeat, so records from then on use `<sessionId>:b<N>:<ordinal>:<n>`
  (N = `end_ordinal_exclusive`). Item ids are unique across branches.
- `session_start`: `<sessionId>:start`, as for Claude Code.

### Mapping

| Rollout record                                                | Event(s)                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_meta`                                                | `session_start`. `text`: cwd. `meta`: `{ version: cli_version, gitBranch?, originator, subagent?, parentSessionId? }`                                       |
| later `session_meta` with `history_base` (a segment)          | `system` "Conversation rewound to record N; continuing from there", `source: "rewind"`                                                                      |
| `item_completed` / `UserMessage`                              | `prompt`: `text` parts joined with `\n`, trimmed. `meta`: `{ sources: ["typed"] }`. Images and other parts are dropped.                                     |
| `item_completed` / `AgentMessage`                             | `reply`: each `Text` part, unchanged. `meta`: `{ model, phase }` (`phase` is `commentary` or `final_answer`).                                               |
| `item_completed` / `Reasoning`                                | `thinking`: `summary_text` and `raw_content` joined with `\n\n`. Empty is normal and emits nothing. `meta`: `{ model }`. `encrypted_content` is never sent. |
| `item_completed` / `CommandExecution`                         | `tool_call` + `tool_result`, tool name `Shell` (see below)                                                                                                  |
| `item_completed` / `FileChange`                               | `tool_call` + `tool_result`, tool name `Patch`                                                                                                              |
| `item_completed` / `McpToolCall`                              | `tool_call` + `tool_result`, tool name `mcp__<server>__<tool>`                                                                                              |
| `item_completed` / `ImageView`                                | `tool_call` + `tool_result`, tool name `ViewImage`                                                                                                          |
| `item_completed` / `ContextCompaction`                        | `system` "Conversation compacted", `source: "compaction"`                                                                                                   |
| `event_msg` / `turn_aborted`                                  | `system` "Turn interrupted", `source: "interrupt"`                                                                                                          |
| `response_item` / `message`, `role: "user"`, injected context | `system`, one per text part that is a single tagged element such as `<environment_context>…</environment_context>`. `source` is the tag name.               |

Codex reports a tool's call and its result in one completed item, so a tool
item emits both events at once, `tool_call` first. They share
`meta.toolUseId` = `item.id`. The `tool_call` / `tool_result` rules for Claude
Code apply (120-char one-liners, paths relative to the cwd, `meta.full`,
`meta.lines`, `meta.isError`), with these per-tool inputs:

| Tool        | `tool_call` short args                                                                                              | `tool_result`                                                             | `meta.input` / `meta.full`               |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `Shell`     | the script (first line) when `command` is a shell with `-Command` / `-c` / `-lc`, else `command` joined with spaces | like `Bash`: `Shell → exit N, M lines` from `exit_code`, or `→ no output` | `{ command, cwd }` / `aggregated_output` |
| `Patch`     | first changed path, plus ` (+N files)` if there are more                                                            | `Patch src/a.ts → ok`, or `→ error: <first stderr line>`                  | `changes` / `stdout` + `stderr`          |
| `mcp__…`    | `JSON.stringify(arguments)`                                                                                         | like "any other tool": first line of the result text                      | `arguments` / result `text` parts joined |
| `ViewImage` | `path` (`file://` stripped)                                                                                         | `ViewImage <path> (1 attachment)`                                         | `{ path }` / none                        |

`isError` is true when `status` isn't `completed`, or a `Shell` `exit_code` isn't 0.

`session_start.meta.subagent` is set for rollouts whose `session_meta.source` is
`{ subagent: … }` (e.g. Codex's `guardian` auto-reviewer). These are separate
threads, so they are their own sessions and not sidechains.
`session_meta.session_id` names the thread that started them (it equals `id`
for an ordinary thread); when it differs, `session_start.meta.parentSessionId`
carries it.

### Dropped (Codex)

- Every other `response_item` (`message` from `developer` or `assistant`,
  `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `function_call`,
  `function_call_output`, `compaction`). They duplicate `item_completed` items,
  or are Codex's own instructions to the model. `encrypted_content` is never sent.
- `event_msg` types other than `item_completed` and `turn_aborted`
  (`task_started`, `task_complete`, `token_count`, `thread_settings_applied`, …).
- `turn_context` and `world_state` (their state is read, nothing is emitted),
  `token_usage_record`, `compacted` (its `replacement_history` repeats earlier
  items).
- `item_completed` item types not listed above (such as the `sleep` item).
- Any other record `type`: dropped and reported to the `debug` hook, as for
  Claude Code.

### Codex fixtures

`packages/core/test/fixtures/codex/` holds two redacted sessions, each as a
pair of files:

- `<name>.rollout.jsonl`: 200 consecutive records of a decompressed
  `.jsonl.zst` rollout. This is the parser input.
- `<name>.thread-items.jsonl`: rows of `thread_items` from
  `~/.codex/thread_history_1.sqlite` (opened read-only) whose `rollout_ordinal`
  falls in the same range, one row per line, with `item_json` kept as a string.
  These are the expected-items oracle: every `item_completed` item in the
  rollout should have a row with the same `item_id`.

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

The handoff must be **more than 90% smaller than the raw session log**, measured
as UTF-8 bytes of `compactForLLM` output written as JSONL vs. the raw JSONL.
`measureReduction(raw, { agent?, originalBytes? })` in core computes it. A test
enforces it on every fixture, and `pnpm report` prints it.

For Codex fixtures, "raw" is the size of the same records **before redaction**,
read from `codex/raw-bytes.json` and passed as `originalBytes`. Codex rollouts
carry large `encrypted_content` blobs and long tool outputs that redaction
replaces or cuts at 2,000 chars, so the redacted file understates what Codex
actually wrote (`speech-tool`: 196.9 KB redacted vs. 407.9 KB real). Claude
fixtures are measured on their redacted bytes, as before.

| Fixture               | Agent       | Raw       | Full view | Handoff | Reduction |
| --------------------- | ----------- | --------- | --------- | ------- | --------- |
| api-requests          | claude-code | 410.9 KB  | 50.0 KB   | 24.0 KB | 94.2%     |
| code-review           | claude-code | 485.0 KB  | 51.4 KB   | 16.6 KB | 96.6%     |
| heavy-tools           | claude-code | 405.5 KB  | 82.0 KB   | 35.0 KB | 91.4%     |
| install-debug         | claude-code | 357.7 KB  | 42.1 KB   | 17.4 KB | 95.1%     |
| long-build            | claude-code | 476.4 KB  | 57.6 KB   | 20.1 KB | 95.8%     |
| mixed                 | claude-code | 388.6 KB  | 77.3 KB   | 30.8 KB | 92.1%     |
| codex/forked-frontend | codex       | 9852.2 KB | 55.0 KB   | 19.2 KB | 99.8%     |
| codex/speech-tool     | codex       | 407.9 KB  | 55.9 KB   | 20.5 KB | 95.0%     |

The `agent` field costs every handoff event about 22 bytes, which is why the
Claude numbers dropped 0.1–0.4 points from v1.


## Decided

- Subagent records: shown in the viewer as a closed dropdown under their parent
  tool call. Dropped from the handoff.
- `system` events: shown in the viewer. Ones that are already a single line are
  shown as is; everything else is recapped into one line (full text in `meta.full`).
- Long replies: never shortened in the viewer, but cut in the handoff.
- Codex size target: measured against the fixture's pre-redaction bytes
  (`codex/raw-bytes.json`), because redaction shrinks Codex rollouts far more
  than the handoff.

## Open questions

- Should compaction summarize old turns as well, beyond the per-event rules above?
- Should the 4 KB `text` cap also apply to the full view? Today it applies only
  to the handoff, because the full view is meant to never be shortened.
- How does a viewer match a sidechain group to its parent `Agent` call? No real
  sidechain transcript has been captured yet to confirm which field links them.
- Should Codex `guardian` reviewer threads be shown at all, or folded under the
  thread they reviewed (`meta.parentSessionId`)?
