# Baton daemon (v0)

`baton start` tails Claude Code transcripts and streams their `BatonEvent`s
(see [spec.md](spec.md)) to local viewers over WebSocket. It listens on
`127.0.0.1` only.

```sh
pnpm build
pnpm baton start [--port 7777] [--projects-dir ~/.claude/projects]
npx wscat -c ws://127.0.0.1:7777/ws
```

`baton start --help` lists every option: `--state-file`, `--backlog`,
`--buffer-mb`, `--buffer-size`, `--active-minutes`, `--poll`, `--log-level`,
`--web-dir`. Logs are pino JSON on stdout.

## Pieces

```
TranscriptWatcher ──publish(events)──▶ EventSink ◀── Hub (local) ──▶ Fastify /ws, /sessions
   │  TranscriptTail per file                       (a remote/team server can implement
   │  LineBuffer, @baton/core parser                 EventSink later; the watcher won't change)
   └─ StateStore (offsets on disk)
```

- `src/sink.ts`: `EventSink { publish(events, { backlog? }) }`. The watcher
  only knows this interface.
- `src/watcher.ts`: chokidar over the projects dir (`*.jsonl`, any depth).
- `src/tail.ts`: one file's byte offset and its incremental parser.
- `src/lines.ts`: splits bytes into lines and holds back a trailing partial
  line as bytes, so a UTF-8 character cut between writes survives.
- `src/state-store.ts`: per-file `{ offset, ino }`, saved (debounced, atomic
  rename) to `%LOCALAPPDATA%\baton\state.json` or
  `$XDG_STATE_HOME/baton/state.json` (`~/.local/state/baton/state.json`).
- `src/event-log.ts`: `EventLog`, the numbered events kept for replay. It owns
  `seq` and `epoch`. `MemoryEventLog` (the default) keeps them in memory up to a
  byte budget.
- `src/hub.ts`: subscriptions, replay with backpressure, `/sessions` data.
- `src/server.ts`: HTTP/WebSocket routes and the local-only request check.

## Watching

- **Start-up.** Every transcript is opened. A file with a saved offset (same
  inode, not shrunk) resumes from it; an unknown file starts at its end. A
  session is _active_ if it changed in the last `--active-minutes` (default
  120) or grew while the daemon was down. For each active session the daemon
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
- **New files** are new sessions; they're read from the start.
- **Truncation and replacement.** If the file is smaller than the offset or its
  inode changed, it's read again from byte 0 with a fresh parser (so event
  `seq`s restart at 0). _Limitation:_ a file truncated and then rewritten past
  the old offset between two reads, in place, looks like growth. Claude Code
  only appends, so this isn't expected in practice.
- **Windows.** Paths are compared case-insensitively. Reads retry briefly on
  `EBUSY`/`EPERM`/`EACCES`. `--poll` is there for network drives or file
  systems where native events don't arrive.
- Deleted files are forgotten, both in memory and in the state file.

## WebSocket protocol

Schemas are in `packages/core/src/protocol.ts` (`PROTOCOL_VERSION = 1`).
Both directions are JSON text frames.

**Connect:** `ws://127.0.0.1:7777/ws?session=all&lastSeq=<n>&epoch=<id>`.
Every query parameter is optional: `session` defaults to `all`, or can be a
`sessionId`.

**Server → client:**

| `type`  | Fields                                         | When                                                          |
| ------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `hello` | `protocol`, `epoch`, `seq` (latest), `session` | First, and again after each `subscribe`                       |
| `event` | `seq`, `event: BatonEvent`, `backlog?: true`   | Replay, then live                                             |
| `gap`   | `fromSeq`, `toSeq`                             | Before a replay, if those seqs already left the ring buffer   |
| `error` | `message`                                      | The client sent something invalid. The connection stays open. |

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

- `GET /sessions` → `{ sessions: [{ sessionId, projectPath, projectName,
  lastActivity, events }] }`. These are sessions the hub received an event for
  within `--active-minutes`, newest `lastActivity` (transcript `ts`) first.
  `events` counts what the hub received since it started, backlog included.
- `GET /health` → `{ ok, epoch, seq }`.
- `GET /` and other paths: the built viewer from `--web-dir` (default
  `apps/web/dist`, found relative to the daemon's own files, so it only works
  when the daemon runs from this repo). If that directory has no `index.html`,
  the daemon logs a warning and `/` returns a plain-text hint to run
  `pnpm build`. The routes above take precedence over viewer files.
- For viewer development, `pnpm --filter @baton/web dev` serves the app with
  Vite and proxies `/sessions` and `/ws` to the daemon on `BATON_PORT`
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
