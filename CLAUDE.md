# Baton

Baton streams live Claude Code sessions to teammates. It tails the JSONL
transcripts Claude Code writes under `~/.claude/projects/`, turns each record
into zero or more `BatonEvent`s, and pushes them to viewers.

Two views of the same events: the **full-fidelity** stream teammates watch
(prompts, replies, thinking, full tool output, injected system content, each
labelled), and a **compact** view (`compactForLLM`) for handing a session off to
another LLM session with fewer tokens. Don't trim the full stream to save
tokens; that's what compaction is for.

**v0 scope:** a localhost live feed — one daemon, one browser viewer, no auth,
no network beyond `127.0.0.1`. The event schema and filtering rules are in
[docs/spec.md](docs/spec.md); that document is the source of truth.

**Team mode** (`baton serve`, `baton start --server`) is the one exception to
localhost-only: a token-protected team server that daemons forward to. It's
described in [docs/team.md](docs/team.md).

## Layout and package boundaries

| Package                             | Role                                                | May do                                                       | Must not do                                                                             |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `packages/core` (`@baton/core`)     | `BatonEvent` types + zod schemas, transcript parser | Pure functions: string/JSON in → events out                  | Any I/O: no `fs`, `net`, `http`, `child_process`, `os`, `process`, timers, `Date.now()` |
| `packages/daemon` (`@baton/daemon`) | File watcher + local server                         | All I/O: watch transcripts, read files, serve HTTP/WebSocket | Parse transcript records itself — call core                                             |
| `apps/web` (`@baton/web`)           | Viewer (Vite + React)                               | Render `BatonEvent`s received from the daemon                | Read transcripts or know their format                                                   |

- Core's purity is enforced by a Biome `noRestrictedImports` rule scoped to
  `packages/core/src/**`. Don't disable it; if core seems to need I/O, the code
  belongs in the daemon.
- Dependencies point one way: `daemon → core`, `web → core` (types/schemas only).
  Core depends on nothing in this repo.
- Transcript format knowledge lives only in core. Event shape changes start in
  `docs/spec.md`, then `packages/core/src/event.ts`.

## Coding standards

- **No `any`.** Use `unknown` and narrow it, usually with a zod schema. Biome
  reports `noExplicitAny` as an error.
- **Use zod at every boundary.** Validate anything that enters a package from
  outside: transcript lines, WebSocket/HTTP messages (both directions), config,
  env vars, CLI args. Inside that boundary, trust the types. Derive types from
  schemas (`z.infer`); don't write them twice.
- **Keep modules small.** One responsibility per file, named exports, no barrels
  beyond each package's `src/index.ts`.
- **Every bug fix gets a test** that fails without the fix. For parser bugs, add
  the smallest offending transcript line to the test (redacted, see below).
- Strict TS settings (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
  stay on. ESM everywhere. Use relative imports with a `.js` extension in core
  and daemon.
- **The watcher only talks to an `EventSink`.** Delivery details (seqs, the
  event log, subscriptions, HTTP) belong in the hub/server, so a remote team
  server can replace the local hub without touching the watcher. The daemon's
  behaviour and the WebSocket protocol are in [docs/daemon.md](docs/daemon.md);
  wire schemas live in `packages/core/src/protocol.ts`.
- **Nothing leaves a machine unless it's shared.** The forwarder's
  `SharingSink` drops sessions outside `baton share`d repos and masks
  credentials; don't add a path from the watcher to a remote sink that skips
  it. User-facing rules are in [docs/what-baton-shares.md](docs/what-baton-shares.md).
- **Saved files are versioned.** Use `loadVersioned`/`saveVersioned`
  (`packages/daemon/src/versioned-file.ts`); changing a file's shape means
  bumping its version and adding a migration, never starting empty.
- Bump `INGEST_PROTOCOL_VERSION` (core `version.ts`) when daemons and servers
  of different builds can no longer talk.
- `baton start` binds `127.0.0.1` only and refuses non-local `Host`/`Origin`.
  Don't loosen that in v0. Only `baton serve` listens beyond localhost, and
  every route there but `/health` and `/login` requires the team token.
- The parser must never throw on bad input. Skip unknown record types and
  malformed lines (the spec lists the dropped types). Empty or missing
  thinking is normal, not an error.

## Test fixtures

`packages/core/test/fixtures/` holds redacted real transcripts (see its
README). Never commit an unredacted transcript. New fixtures must pass
`test/fixtures.test.ts`, which scans for home-directory paths, emails, and
key-like strings.

`test/__snapshots__/` holds per-fixture snapshots of both views
(`*.events.tsv` digest, `*.compact.jsonl` handoff). When a parser change
alters them on purpose, review the diff, then update with `pnpm test -u`.
The handoff must stay **>90% smaller than the raw fixture bytes**; a test
enforces it and `pnpm report` prints the numbers. Codex fixtures
(`fixtures/codex/`) are measured against their pre-redaction size in
`codex/raw-bytes.json`, since redaction cuts most of a rollout's bytes.

## Commands

pnpm is pinned via `packageManager`; if `pnpm` isn't on PATH, use `corepack pnpm`.

```sh
pnpm install
pnpm lint        # biome check .
pnpm format      # biome check --write .
pnpm typecheck   # tsc --noEmit in every package
pnpm test        # vitest run (all packages)
pnpm build       # tsc / vite build
pnpm check       # lint + typecheck + test + build (what CI runs)
pnpm report      # size-reduction report: raw transcript bytes vs. parser output
pnpm coverage    # test coverage of packages/core/src
pnpm baton start # run the built daemon (pnpm build first); --help for options
pnpm test:multi  # Docker: 1 team server + 8 replaying daemons (6 Claude Code, 2 Codex), checks exactly-once delivery
pnpm test:chaos  # same, killing one daemon and cutting another off the network for 30s
pnpm test:e2e    # Docker + Playwright: the viewer end to end (pnpm exec playwright install chromium, once)
```

Daemon integration tests (`packages/daemon/test/integration.test.ts`) run a
real daemon on port 0 against a temp projects dir. They wait on conditions
rather than fixed sleeps; keep it that way, since file events on Windows are
bursty.

**Run `pnpm check` before declaring a task done.** A task isn't done until it
passes.
