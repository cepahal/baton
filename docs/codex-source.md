# Codex live source: investigation

Which Codex data source Baton should tail while a session is running. The
[spec](spec.md#codex-adapter-codex) follows the recommendation below.

**Recommendation: tail the rollout file**
(`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`). It is written
as each item finishes, always in whole lines. It is at least as fresh as every
other source we checked, and it's the only one that sees sessions from every
Codex front end (Desktop, CLI, `exec`). Baton only reads it.

## Setup

- Machine: Windows 11, Codex Desktop running (its own `codex.exe … app-server`
  child over stdio), Codex CLI `0.166.0-alpha.5.1`.
- A read-only watcher polled `~/.codex` about once a second for 4 minutes. It
  recorded each file's size and mtime, plus row counts from
  `thread_history_1.sqlite` and `state_5.sqlite`, both opened with
  `?mode=ro`. Nothing under `~/.codex` was written by the investigation.
- Session: `codex exec --json --skip-git-repo-check -s workspace-write -C <scratch>`
  with a prompt asking for five separate shell commands, two of them
  `Start-Sleep 5`. It ran for 132 s (thread `01a19ada-…`, 64 rollout records,
  10 `thread_items` rows). Each stdout line was timestamped as it arrived.

## What changed under `~/.codex` during the session

| Path                                                                                                  | What happened                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/2026/11/02/rollout-…-<threadId>.jsonl`                                                      | **Created as plain `.jsonl`** 1.5 s after start (first write: `session_meta`, 19 KB). Grew 23 times during the run, from 19,479 to 149,524 bytes. **Every observed size ended on `\n`**, so a reader never sees half a record. No `.zst` was written. |
| `thread_history_1.sqlite-wal`                                                                         | Grew right after each rollout append. `thread_items` went from 1,905 to 1,915 rows. `thread_history_projection_state` for the thread ended at `next_rollout_byte_offset = 149524` (the rollout's final size) and `next_rollout_ordinal = 64`.         |
| `state_5.sqlite-wal`                                                                                  | New `threads` row (`source = "exec"`, `originator = "codex_exec"`, `rollout_path` = the plain `.jsonl`). `updated_at_ms` changed on most appends.                                                                                                     |
| `thread-writer-locks/<threadId>.lock`                                                                 | Created at session start.                                                                                                                                                                                                                             |
| `logs_2.sqlite-wal`                                                                                   | 4 writes, none about the rollout.                                                                                                                                                                                                                     |
| `goals_1`, `memories_1` `-wal`/`-shm`, `.sandbox/sandbox.<date>.log`, `tmp/arg0-windows/…`, `cap_sid` | Side files that don't hold transcript content.                                                                                                                                                                                                        |

The `.jsonl.zst` files come later. All 12 older rollouts on this machine are
`.zst`, while `state_5.threads.rollout_path` still names the `.jsonl`.
`logs_2.sqlite` shows the Desktop app sending `rollout/compress` requests,
which `codex_rollout::compression::worker` handles in the background
(`rollout compression worker finished: scanned=0, compressed=0, …`). So a
rollout is plain while it's live and gets swapped for a `.zst` some time after
it goes idle. The new session's file was still uncompressed when the
investigation ended.

## Freshness: rollout vs. the other sources

The rollout is written first. Each `item_completed` record's own `timestamp` is
slightly earlier than the moment the matching `exec --json` line reached
stdout:

| Item                     | Rollout `timestamp` | `exec --json` stdout | Rollout lead |
| ------------------------ | ------------------- | -------------------- | ------------ |
| first `AgentMessage`     | 06:03:30.054        | 06:03:30.205         | 151 ms       |
| first `CommandExecution` | 06:05:08.687        | 06:05:08.849         | 162 ms       |
| final `AgentMessage`     | 06:05:38.191        | 06:05:38.351         | 160 ms       |

`thread_items` rows showed up in the same watcher poll as the rollout bytes
they come from. They never showed up earlier, which fits the projection-state
table: SQLite is built _from_ the rollout and records how far it has read.

One limit applies to every file-based source. A running command shows up in
the rollout only when it **completes** (`item_completed` /
`CommandExecution`). `exec --json` also sends `item.started` with
`status: "in_progress"`, and the app-server sends `item/started`. The rollout
does have the model's tool call earlier, as a `response_item`
`custom_tool_call` (the `exec` script). The adapter ignores that today because
it duplicates the item that follows.

## The event streams

### `codex exec --json`

[Documented](https://learn.chatgpt.com/docs/non-interactive-mode): "stdout
becomes a JSON Lines (JSONL) stream so you can capture every event Codex emits
while it's running". Events are `thread.started`, `turn.started`,
`item.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`.
Items are snake_case (`agent_message`, `command_execution`, …) with ids like
`item_0`, which don't match the rollout's `msg_…` / `exec-…` ids. The page
makes no stability or versioning promise. In the observed stream,
`reasoning` items didn't appear even though the rollout has two `Reasoning`
items.

**Why not:** it only streams the session that `exec` itself starts. Baton
would have to _be_ the Codex front end. It can't watch a teammate's Desktop or
TUI session, which is the whole point of Baton.

### `codex app-server`

[Documented](https://learn.chatgpt.com/docs/app-server) as the JSON-RPC
protocol behind the rich clients. In the docs' words, "The app-server command
and WebSocket transport are experimental and aren't supported for production
workloads." `codex app-server generate-json-schema` on this version lists 106
client methods and 85 notifications, including `thread/list`, `thread/read`,
`thread/resume`, `thread/items/list`, `thread/turns/list`,
`thread/unsubscribe`, `item/started`, `item/completed`, and the
`item/*/delta` streams. Schemas are "specific to the Codex version you ran".
Breaking removals happen (`thread/rollback` is gone).

**Why not, for now:**

- The Desktop app runs its own app-server as a child process over **stdio**.
  There's no socket to attach to: `codex app-server daemon version` fails with
  `failed to connect to …\.codex\app-server-control\app-server-control.sock`,
  and that directory doesn't exist. The docs don't describe a way to subscribe
  to a live thread owned by _another_ app-server process. `thread/loaded/list`
  covers only threads loaded in the server you're connected to.
- A second app-server that Baton starts could `thread/read` stored threads, but
  those reads come from the same rollout/SQLite files, so they'd be no fresher
  than tailing. `thread/resume` subscribes the caller in order to _append_
  turns, which is more than an observer should do.
- It's experimental and versioned per release, and the "client" would be
  talking to the user's account. That's a heavier dependency than reading a
  file.

### SQLite (`thread_history_1.sqlite`, `state_5.sqlite`)

`thread_items` has the cleanest shape (one row per item, camelCase
`item_json`, a `rollout_ordinal` to page on). But:

- It's a projection of the rollout and is never ahead of it (see above).
- It's in WAL mode and written continuously, so polling means reopening or
  re-querying a database that another process holds open. The schema has
  migrated 8 times (`_sqlx_migrations`) in `thread_history_1` and 62 times in
  `state_5`, and the file names carry a version number (`_1`, `_5`). Both will
  change.
- Rows are keyed by **rollout segment** id, not thread id, for continued
  threads (see the spec's Codex fixtures), so mapping them back is extra
  work.

It stays useful as a cross-check. The fixtures pair each rollout with its
`thread_items` rows, and a test asserts the item ids match.

## Recommendation

| Source           | Live?                                            | Sees every front end              | Documented                   | Stability                                                       | Baton writes to Codex? |
| ---------------- | ------------------------------------------------ | --------------------------------- | ---------------------------- | --------------------------------------------------------------- | ---------------------- |
| **Rollout tail** | yes, ~150 ms ahead of `exec --json`; whole lines | **yes**                           | file format no; location yes | internal, but append-only JSONL with `type` tags, like Claude's | no                     |
| SQLite poll      | yes, same poll as rollout                        | yes                               | no                           | versioned file names, frequent migrations, WAL                  | no (read-only)         |
| `exec --json`    | yes                                              | **no**, only its own run          | yes, no stability promise    | unversioned                                                     | runs the session       |
| app-server       | yes, plus `item/started` and deltas              | **no** for Desktop's stdio server | yes, "experimental"          | per-version schemas, breaking removals                          | is a client            |

Use **`rollout-tail`**, as the spec says. The daemon should:

1. Watch `~/.codex/sessions/**` for `rollout-*.jsonl` and tail it like a
   Claude transcript (whole lines only, keep a byte offset).
2. Expect the live `.jsonl` to be **replaced by `.jsonl.zst`** after the
   session goes idle. When the `.jsonl` disappears, stop tailing. Don't
   re-read the `.zst` if the offset already reached the end. On a cold start,
   read `.zst` files once for backfill.
3. Treat each segment of a continued thread (`…-<threadId>_<segmentId>.jsonl`)
   as the same session.

The daemon does this in `packages/daemon/src/watcher.ts` and `tail.ts`
(sources built from core's `AGENT_REGISTRY`). It has **no SQLite source**:
SQLite is a projection of the rollout with no freshness advantage, and polling it
by `rollout_ordinal` or `created_at_ms` would tie Baton to an undocumented,
versioned schema. Reconsider only if rollouts stop being written.

Revisit the app-server if Codex documents a stable way to observe threads
owned by another process, or if Baton needs `item/started` for long-running
commands.
