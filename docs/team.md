# Team server mode

`baton start` on its own is a localhost feed (see [daemon.md](daemon.md)). Team
mode puts one **team server** in the middle: each teammate's daemon forwards its
events there, and everyone watches every session in one browser tab.

```sh
# On the server
BATON_TOKEN=<shared secret, 16+ chars> pnpm baton serve [--port 7777]

# On each teammate's machine
BATON_TOKEN=<same secret> pnpm baton start --server ws://team-host:7777 [--name grant]

# In a browser
http://team-host:7777/?token=<same secret>     # or open / and type it on the sign-in page
```

```
machine A: TranscriptWatcher ─▶ RemoteSink ─▶ DiskQueue ─┐
machine B: TranscriptWatcher ─▶ RemoteSink ─▶ DiskQueue ─┤ WebSocket /ingest
...                                                     ▼
                                    baton serve: Hub (dedupes by event id) ─▶ /ws, /sessions, /events ─▶ browsers
```

The watcher is the same one local mode uses; only its `EventSink` changes. The
team server is the same `Hub` and routes as local mode, with different access
rules and an `/ingest` route.

## The daemon side

- `src/remote-sink.ts`: `RemoteSink` implements `EventSink`. `publish` appends
  the events to the disk queue and returns once they're written, so the
  watcher saves its read offset only after the events are safe on disk.
- `src/disk-queue.ts`: `DiskQueue`, an append-only `queue.jsonl` plus a
  `queue.ack` byte offset in `--queue-dir` (default: a `queue` directory next to
  the state file). It survives restarts and crashes: a torn last line is
  dropped on load (that event is read again from the transcript), and acked
  lines are compacted away. It's bounded by `--queue-mb` (default 64): when
  full, `publish` waits for acks, which pauses the watcher. Nothing is dropped;
  the transcript itself is the overflow.
- One batch in flight at a time (up to 500 events or 1 MB), sent as
  `{ type: "publish", batch, backlog?, events }`. The server answers
  `{ type: "ack", batch, accepted }`, and the sink drops the batch from the
  queue. Without an ack within 30 s, or a pong within 10 s of a ping, it
  drops the connection and resends from the head of the queue after a
  jittered backoff (250 ms doubling to 10 s).
- `--name` (default: the OS username, cleaned to letters, digits, `._@-` and
  spaces) is sent as `?name=` on `/ingest`. The server records it as each
  session's `source`.
- After a restart the watcher publishes active sessions' history again, as in
  local mode. The server already holds those ids and skips them.

## The server side

- `baton serve` binds `0.0.0.0` (`--host` to change) and requires
  `BATON_TOKEN` (16+ characters). It serves the viewer from `--web-dir`.
- `GET /ingest?name=<daemon>` (WebSocket, `Authorization: Bearer <token>`):
  each `publish` goes to `hub.accept(events, { backlog, source: name })`. The
  hub's event log skips ids it already holds, so a resent batch is harmless;
  `accepted` counts the new ones. Messages up to 16 MB; a malformed message
  gets `{ type: "error" }` and close code 1008. The server pings every 15 s and
  drops daemons that don't answer.
- Sessions list `source`, and the viewer groups the sidebar by it.
- `/events`, `/ws` and `/sessions` work as in local mode.

### Access

Every route but `/health` and `/login` needs the token, as either:

- `Authorization: Bearer <token>` (daemons, scripts), or
- the `baton_session` cookie, which holds an HMAC of the token (not the token
  itself), `HttpOnly; SameSite=Strict`. A browser gets it from `POST /login`
  with `{ token }` (the sign-in page) or by opening `/?token=<token>`, which
  sets it and redirects to `/` so the token leaves the address bar.

Without it, page loads redirect to `/login` and API calls get 401. A request
whose `Origin` doesn't match its `Host` gets 403, cookie or not, so other sites
can't use a signed-in browser. Tokens are compared in constant time.

Team mode sends events in plain `ws://`. Put it behind a TLS proxy (and use
`wss://` for `--server`) anywhere but a trusted network.

## `GET /events`

Both modes: `GET /events?after=<seq>&limit=<1..5000>` → `{ epoch, firstSeq,
lastSeq, events: [{ seq, backlog?, event }] }`, the hub's log in order. The
multi-machine tests use it to check what arrived.

## Simulating teammates

`baton replay <fixture> --projects-dir <dir> [--speed n] [--as name]
[--max-gap s] [--seed text]` writes a transcript into a fresh file under
`<dir>/<cwd slug>/<new session id>.jsonl`, line by line at the pace of the
recorded timestamps divided by `--speed`. Pauses longer than `--max-gap` (after
scaling) are cut. Every UUID gets a fresh one (consistently, derived from
`--seed`), the username in paths becomes `--as`, and timestamps are rewritten
to the replay's clock, so a daemon watching `<dir>` sees a new, live session.
A record whose timestamp goes backwards is written straight away.

## Multi-machine tests

`docker-compose.test.yml` runs one server and six machines (`alice` … `frank`,
see `scripts/multi/fleet.mjs`), each replaying a different fixture into its
own projects dir while `baton start --server` forwards it
(`docker/machine.sh`). The daemon runs in a restart loop with its pid in
`/data/daemon.pid`, standing in for a supervisor.

- `pnpm test:multi`: brings the stack up, waits until every machine's session
  is complete, then checks via `/sessions` and `/events` that there are six
  sessions, one per daemon name; hub seqs run 1..n with no holes; no id
  repeats; and each session's events have the parser's seqs `0..n-1` in order,
  with the same kinds the parser produces for its fixture. Tears down after.
- `pnpm test:chaos`: the same, with replays slowed so faults land mid-stream.
  It `kill -9`s bob's daemon (it restarts and resends) and disconnects alice's
  container from the network for 30 s (her events queue on disk; the test
  checks none arrive during the outage), and `docker compose pause`s carol's
  container for 30 s, like a laptop with its lid closed: replay and daemon
  freeze, and her socket stays open but silent until she wakes. Then it runs
  the same checks. (`docker compose stop` isn't used: restarting a machine
  restarts its replay from the top, which a real session wouldn't do.)
- Both take `--keep` to leave the stack running, e.g. to open the viewer at
  `http://127.0.0.1:17777/?token=baton-multi-machine-test-token`. Env:
  `BATON_TEST_PORT`, `BATON_TOKEN`, `BATON_TEST_SPEED`, `BATON_TEST_MAX_GAP`.

Both need Docker. They're not part of `pnpm check`.
