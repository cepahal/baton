# Baton daemon (v0)

`baton start` tails Claude Code transcripts and Codex rollouts and streams their `BatonEvent`s
(see [spec.md](spec.md)) to local viewers over WebSocket. It listens on
`127.0.0.1` only.

```sh
pnpm build
pnpm baton start [--port 7777] [--projects-dir ~/.claude/projects] [--codex-dir ~/.codex/sessions]
npx wscat -c ws://127.0.0.1:7777/ws
```

`baton start --help` lists every option: `--state-file`, `--backlog`,
`--buffer-mb`, `--buffer-size`, `--active-minutes`, `--recent`, `--poll`, `--log-level`,
`--web-dir`. Logs are pino JSON on stdout.

With `--server`, the daemon forwards to a team server instead of serving
locally. That mode, `baton serve` and `baton replay` are in [team.md](team.md).

## Pieces

```
TranscriptWatcher ──publish(events)──▶ EventSink ◀── Hub (local) ──▶ Fastify /ws, /sessions, /events
   │  TranscriptTail per file                       ◀── RemoteSink (--server, see team.md)
   │  LineBuffer, @baton/core parser
   └─ StateStore (offsets on disk)
```

- `src/sink.ts`: `EventSink { publish(events, { backlog?, source?, repos? }) }`.
  The watcher only knows this interface.
- `src/repo-sink.ts`: `RepoTaggingSink` wraps the hub (or `RemoteSink`) and
  adds `repos`, the git identity of each event's `projectPath`, so the watcher
  never runs git. `src/repo-info.ts` looks it up (`RepoResolver`, cached per
  directory for 60 s; see [Repo identity](#repo-identity-and-domain)).
- `src/sources.ts`: one `LogSource { agent, kind, dir, detect }` per entry in
  core's `AGENT_REGISTRY`; which files belong to which session (a Codex thread's
  segment files share one).
- `src/watcher.ts`: chokidar over every source's dir (any depth), files
  filtered by the adapter's `detect`.
- `src/tail.ts`: one session's files (usually one), each with its byte offset,
  and the adapter's incremental parser.
- `src/log-file.ts`: opens a log, plain or `.zst` (decompressed whole, Node
  22.15+).
- `src/lines.ts`: splits bytes into lines and holds back a trailing partial
  line as bytes, so a UTF-8 character cut between writes survives.
- `src/state-store.ts`: per-file `{ offset, ino }`, saved (debounced, atomic
  rename) to `%LOCALAPPDATA%\baton\state.json` or
  `$XDG_STATE_HOME/baton/state.json` (`~/.local/state/baton/state.json`).
- `src/event-log.ts`: `EventLog`, the numbered events kept for replay. It owns
  `seq` and `epoch`. `MemoryEventLog` (the default) keeps them in memory up to a
  byte budget.
- `src/hub.ts`: subscriptions, replay with backpressure, `/sessions` data.
- `src/event-log.ts`: the hub's in-memory log. It drops an event whose `id` it
  already holds **for the same session**; ids are only unique per session (a
  forked Codex thread repeats its parent's item ids).
- `src/server.ts`: HTTP/WebSocket routes and the local-only request check
  (or, for `baton serve`, the team token check and `/ingest`).
- `src/merge.ts`: `mergeByTime`, which interleaves sessions by timestamp for
  start-up publishing without reordering any one session (transcript
  timestamps can go backwards).

## Watching

- **Sources.** The Claude Code (`--projects-dir`) and Codex (`--codex-dir`)
  directories come from the core adapter registry. A missing directory is
  skipped; the daemon refuses to start only if none exists. Codex specifics
  (segments, `.zst`) are in [spec.md](spec.md#codex-adapter-codex) and
  [codex-source.md](codex-source.md).
- **Start-up.** Every transcript is opened. A file with a saved offset (same
  inode, not shrunk) resumes from it; an unknown file starts at its end. A
  session is _active_ if it changed in the last `--active-minutes` (default
  120), is one of its agent's `--recent` (default 5) most recently modified
  sessions, or grew while the daemon was down. For each active session the daemon
  parses the history up to the saved offset and publishes **all of it (or the
  last `--backlog <n>` events) with `backlog: true`**, then publishes anything
  written while it was down as normal events.
- **Idle sessions waking up.** An inactive session isn't parsed at start-up.
  The first time it grows, its history goes out (with `backlog: true`) before
  the new events, so viewers always see a session from its start.
- **Changes.** Only bytes after the offset are read. An incomplete last line
  waits for its newline. Reads of one file never overlap; changes during a read
  trigger one more read. Up to 8 files are read at once.
- **chokidar drops change events** that come within 50 ms of the previous
  one for the same file, with no trailing event. After each read the file is
  checked again 150 ms later, and keeps being checked while those checks find
  new bytes, so the end of a burst isn't left waiting for the next write.
- **Appends with no change event.** Codex Desktop appends to a rollout it
  keeps open, and on Windows that leaves the file's mtime unchanged, so
  chokidar reports nothing. Every second the watcher compares each followed
  file's size with its read offset and reads any that differ.
- **New files** are new sessions; they're read from the start.
- **Truncation and replacement.** If the file is smaller than the offset or its
  inode changed, it's read again from byte 0 with a fresh parser (so event
  `seq`s restart at 0). _Limitation:_ a file truncated and then rewritten past
  the old offset between two reads, in place, looks like growth. Claude Code
  only appends, so this isn't expected in practice.
- **Windows.** Paths are compared case-insensitively. Reads retry briefly on
  `EBUSY`/`EPERM`/`EACCES`. `--poll` is there for network drives or file
  systems where native events don't arrive.
- Deleted files are forgotten, both in memory and in the state file, except a
  Codex `x.jsonl` replaced by `x.jsonl.zst`: the session continues in the `.zst`
  file at the same offset. An idle `.zst` session isn't decompressed until its
  thread changes.

## WebSocket protocol

Schemas are in `packages/core/src/protocol.ts` (`PROTOCOL_VERSION = 1`).
Both directions are JSON text frames.

**Connect:** `ws://127.0.0.1:7777/ws?session=all&lastSeq=<n>&epoch=<id>`.
Every query parameter is optional: `session` defaults to `all`, or can be a
`sessionId`.

**Server → client:**

| `type`   | Fields                                                       | When                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`  | `protocol`, `epoch`, `seq` (latest), `session`               | First, and again after each `subscribe`                                                                                                                                                      |
| `event`  | `seq`, `event: BatonEvent`, `backlog?: true`                 | Replay, then live                                                                                                                                                                            |
| `gap`    | `fromSeq`, `toSeq`                                           | Before a replay, if those seqs already left the ring buffer                                                                                                                                  |
| `error`  | `message`                                                    | The client sent something invalid. The connection stays open.                                                                                                                                |
| `canvas` | `positions` (`{ [key]: { x, y } }`), `removed?`, `snapshot?` | After `hello`, always, with `snapshot: true` and every saved position (the viewer replaces what it held, so nodes removed while it was away disappear); then each change (only what changed) |
| `notes`  | `notes` (`Note[]`), `removed?`, `snapshot?`                  | After the `canvas` snapshot, with `snapshot: true` and every note; then each change. See [notes.md](notes.md)                                                                                |

**Client → server:** `{ "type": "subscribe", "session": "all" | "<id>",
"lastSeq"?: n, "epoch"?: "<id>" }` switches subscription on the same socket
and replays as if it had just connected.

**Seqs.** The hub numbers every event it receives (`seq`, 1, 2, …) across all
sessions. This is separate from `event.seq`, the event's position within its
own transcript. A client remembers the last hub `seq` it saw and the `epoch`
from `hello`.

**Reconnect.** The client sends `lastSeq` and `epoch`, and receives every
buffered event after `lastSeq` that matches its subscription. With no
`lastSeq`, a different epoch (the daemon restarted), or a `lastSeq` ahead of
the hub, it gets the whole buffer, which is every session's history plus
everything since. If some events the client missed are gone, a `gap` comes
first.

**Memory.** The buffer is bounded by `--buffer-mb` (default 256 MB, measured
as the events' JSON size); `--buffer-size <n>` adds an event-count cap. When it
is full the oldest events are dropped and one warning is logged. Clients that
need them get a `gap`. Events are de-duplicated by `event.id`, so history read
again (an idle session waking, a restart) isn't stored twice.

**Replay backpressure.** Replay pauses while a client has more than 1 MB
unsent, so a big history doesn't trip the slow-client limit. Live events that
arrive meanwhile wait in the log and follow the history in order. A replay
that makes no progress for 30 s drops the client (1013).

**Slow clients.** A live client with more than 16 MB unsent is closed with
code 1013. An invalid query closes it with 1008.

## HTTP

- `GET /sessions` → `{ sessions: [{ sessionId, agent, projectPath, projectName,
  lastActivity, events, source? }] }`. `agent` (`claude-code` or `codex`) comes
  from the session's first event; clients default it to `claude-code` when an
  older server leaves it out. These are sessions the hub received an event for
  within `--active-minutes`, newest `lastActivity` (transcript `ts`) first.
  `events` counts what the hub received since it started, backlog included.
  `repo` and `domain` are described under
  [Repo identity and domain](#repo-identity-and-domain). `user` is who runs the
  session: the forwarding daemon's name on a team server (`source`), else the
  daemon's OS user. `files` (left out when empty) lists the files the session
  wrote, repo-relative when the repo root is known, as
  `{ path, ranges: [[first, last], …] }`; see [Touched files](#touched-files).
  `contractIssues` (left out when empty) lists possible I/O mismatches with
  other sessions in the same repo; see [Conflicts](#conflicts).
- `PUT /sessions/:sessionId/domain` with `{ "label": "<label>" | null }` sets
  (or clears, with `null`) a manual domain label; answers the session's new
  `domain`, 400 for a bad body, 404 for a session the hub doesn't know.
  Overrides live in memory and win over everything else.
- `/notes` and `/blobs`: sticky notes and their files; see [notes.md](notes.md).
- `GET /canvas` → `{ positions }`: where viewers put each canvas node.
- `PUT /canvas/positions` with `{ positions: { [key]: { x, y } }, removed?: [key] }`
  saves moved nodes, forgets removed ones, and broadcasts what changed as a
  `canvas` message to every viewer (204; 400 for a bad body). The viewer keys
  cards `session:<sessionId>`, at their absolute top-left corner; a session is
  on the canvas exactly when it has a position, and its repo's box is drawn
  around its cards. (`repo:<group>` keys are accepted too.) Positions are
  shared by everyone on the hub and saved, debounced, to `canvas.json` next to
  the state file (`team-canvas.json` for `baton serve`), so they survive
  restarts. At most 5000 are kept; the least recently moved go first.
- `GET /health` → `{ ok, epoch, seq }`.
- `GET /events?after=<seq>&limit=<n>` → the hub's log in order (see
  [team.md](team.md#get-events)).
- `GET /` and other paths: the built viewer from `--web-dir` (default
  `apps/web/dist`, found relative to the daemon's own files, so it only works
  when the daemon runs from this repo). If that directory has no `index.html`,
  the daemon logs a warning and `/` returns a plain-text hint to run
  `pnpm build`. The routes above take precedence over viewer files.
- For viewer development, `pnpm --filter @baton/web dev` serves the app with
  Vite and proxies `/sessions`, `/canvas` and `/ws` to the daemon on `BATON_PORT`
  (default 7777).

## Local-only

The server binds `127.0.0.1`. Any request whose `Host` isn't
`127.0.0.1`/`localhost`/`[::1]` (stops DNS rebinding), or whose `Origin` is set
and isn't a local origin (stops other websites in your browser), gets a 403.
That covers WebSocket upgrades too. Local origins get CORS headers, so a Vite
dev server on another port can call `/sessions`.

## Open questions

## Later: resuming across restarts

For v0 the log is in memory. A daemon restart starts a new epoch, so viewers
get the whole buffer again (as backlog). That's fine for now, but not for a
polished version. The seam for fixing it is already there:

- Write a persistent `EventLog` (append-only JSONL or SQLite next to
  `state.json`) that loads its `epoch`, `seq` and entries on start-up.
- Pass it to `new Hub({ log })` in `src/daemon.ts`. The hub, the watcher and
  the protocol don't change: a client's `lastSeq` + `epoch` then still match
  after a restart.
- History published again at start-up is skipped because `append` ignores ids
  it already holds.

## Open questions

- When the buffer is full, should whole old sessions be dropped instead of
  the oldest events across all sessions?

## Repo identity and domain

Each session in `/sessions` carries:

- `repo: { repoId, branch, relativeCwd }` for its `projectPath` (cwd), looked
  up by the daemon with git: `repoId` is the remote URL normalized by core's
  `normalizeRemoteUrl` (`origin`, else the first remote), so ssh, https,
  `.git`, credentials, ports and case all map to one string, e.g.
  `github.com/org/repo`. With no usable remote it is the repo's root commit
  hash. `branch` is null on a detached HEAD; `relativeCwd` is the cwd relative
  to the repo root (`""` at the root). Outside a git repo all three are null.
  Missing when the hub never got repo info (an older forwarding daemon).
- `domain: { label, confidence, reasons, source }`, `label` one of
  `frontend`, `backend`, `ml`, `data`, `infra`, `unknown`. The hub keeps each
  session's last 50 events and runs core's `classifyDomain` over them: files
  edited (Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, Codex file
  changes) weigh most, then the repo-relative cwd, then prompt keywords. The
  rules are the `DOMAIN_RULES` table in `packages/core/src/domain/rules.ts`.
  `source` says where the label came from:
  - `override`: set with `PUT /sessions/:id/domain`; always wins.
  - `llm`: the rules were under 0.5 confident and the optional LLM tie-break
    answered (reported with confidence 0.5).
  - `rules`: everything else.

### LLM tie-break

Off by default. `BATON_SUMMARIZER=anthropic` (on `baton start` or `baton
serve`) turns it on; it calls the Claude API with the SDK's usual credentials
(`ANTHROPIC_API_KEY` etc.) and `BATON_SUMMARIZER_MODEL` (default
`claude-opus-5-5`, low effort). It runs only for sessions whose rule-based
confidence is below 0.5, at most once per session every 5 minutes, in the
background; until it answers, the rules' label is shown. Failures are logged
and ignored. It sends the session's recent prompts (trimmed) and edited
paths, nothing else.

## Touched files

The hub records, per session, the files its tool calls wrote (`fileTouches`
in `packages/core/src/files/touches.ts`): Claude `Edit`/`MultiEdit`/`Write`/
`NotebookEdit` and Codex patches. Line ranges are only what the events carry: a
`Write`'s whole content, a Codex added file, or a Codex diff's hunk headers
(new-side lines). Claude `Edit` results don't say where the edit landed, so
those files have no ranges. Ranges are merged per file; at most 500 files per
session are kept (oldest dropped) and more than 64 ranges in one file collapse
into one span.

The viewer's canvas links every pair of sessions in the same repo with an
orange line. When both wrote a file, the line turns red, glows, and is split in
the middle (a likely merge conflict); it glows harder when written line ranges
overlap. The label counts the shared files; hovering lists them. When the two domains form a flow (frontend → backend,
backend → data, backend → ml, data → ml) the line carries an arrow pointing
downstream.

## Conflicts

Two kinds, both per repo (`repoId`, else the session folder):

- **Same files.** From [Touched files](#touched-files), computed in the viewer:
  the glowing red split line above.
- **I/O contracts.** Core's `extractContracts` reads what each write says about
  the code's interface: HTTP routes it serves (Express/Fastify-style
  `app.get("/x")`, FastAPI/Flask decorators, Next.js `app/**/route.ts` and
  `pages/api/**`), endpoints it calls (`fetch`, `axios.*`, `api.*`,
  `requests.*`), and data shapes it declares (TS interfaces and object types,
  `z.object`, pydantic/dataclass classes, Go structs with their `json` tags).
  Paths are normalized (`/items/:id`, `{id}`, `[id]`, `${id}`, `42` →
  `/items/:param`). `contractIssues` then compares sessions: a call to a route
  no session serves while another session serves that namespace, a call with
  a method the route lacks, and shapes with the same (or same-base, e.g.
  `CartItem` / `CartItemResponse`) name that differ in field count, field names
  (camelCase vs snake_case are named as such) or kinds. Shapes in the same file,
  UI props/state, and shapes sharing under a third of their fields are skipped.
  At most 5 issues per session, each one line (≤240 chars), shown on the card
  as a caution sign.

These are heuristics over regexes, tuned to stay quiet rather than complete:
expect misses (dynamic routes, generated clients, GraphQL) more than false
alarms. The daemon keeps contracts for at most 300 files per session; a
whole-file write replaces a file's contracts, an edit adds to them.

## Bounds

A long-running hub forgets the least recently seen sessions beyond
`maxSessions` (default 5000) along with their domain, files and contracts
state; their events stay in the log until it rolls over. Domain
classification is cached per session until its next event.
