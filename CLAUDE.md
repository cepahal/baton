# Baton

Baton streams live Claude Code sessions to teammates. It tails the JSONL
transcripts Claude Code writes under `~/.claude/projects/`, turns each record
into zero or more `BatonEvent`s, and pushes them to viewers.

**v0 scope:** a localhost live feed — one daemon, one browser viewer, no auth,
no network beyond `127.0.0.1`. The event schema and filtering rules are in
[docs/spec.md](docs/spec.md); that document is the source of truth.

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
- The parser must never throw on bad input. Skip unknown record types and
  malformed lines (the spec lists the dropped types).

## Test fixtures

`packages/core/test/fixtures/` holds redacted real transcripts (see its
README). Never commit an unredacted transcript. New fixtures must pass
`test/fixtures.test.ts`, which scans for home-directory paths, emails, and
key-like strings.

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
```

**Run `pnpm check` before declaring a task done.** A task isn't done until it
passes.
