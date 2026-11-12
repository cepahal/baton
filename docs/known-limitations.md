# Known limitations (beta)

Things we know about and aren't fixing during the beta. If one of these bites
you, say so in an issue anyway: it tells us what to fix first.

## Trust and identity

- **One shared token, no accounts.** Everyone with the token can see every
  shared session, edit or delete any sticky note, and delete any session for
  everyone. Names on notes and handoffs are what people typed, not verified.
  Rotating the token (restart `baton serve` with a new `BATON_TOKEN`) is the only
  way to remove someone; it signs every browser out.
- **The browser sign-in never expires** until the token changes.
- **A sign-in link (`/?token=…`) puts the token in the URL**, and so in browser
  history. Prefer typing it on the sign-in page.
- **Plain HTTP/WebSocket.** Baton relies on Tailscale for encryption. Don't
  put the server's port on the internet.

## What's shared

- **Credential masking is pattern-based.** Keys with a recognizable shape are
  masked; a password with no telltale shape in a file the agent reads is not.
  See [what Baton shares](what-baton-shares.md).
- **Deleting a session doesn't reach everywhere**: not teammates' memories,
  handoff files already written into someone's checkout, or the last 7 nightly
  backups.
- **The full path of each session's folder is shown** (it usually contains your
  OS username).

## Data

- **Session events live in the team server's memory.** Restarting
  `baton serve` empties the canvas of past activity; sessions come back as
  their daemons send new activity (and, when a daemon restarts, recent history).
  Notes, handoffs, canvas positions and deleted-session ids are kept on disk.
- **Memory caps.** The server keeps about 256 MB of events (`--buffer-mb`); past
  that the oldest are dropped and a gap shows in long-running sessions.
- **Cursor transcript detail depends on what Cursor writes locally.** Baton reads
  the JSONL transcript, which can contain prompts, replies and tool calls while
  omitting tool results or reasoning. Cursor's on-disk format is not versioned
  as a public schema and may change.
- **Backups cover the server's files, not events**, and are kept 7 days. To
  restore: stop `baton serve`, copy the files from a folder in
  `<state>/backups/<time>/` back into `<state>/`, copy the files it lists in
  `blobs.txt` from `<state>/backups/blobs/` into `<state>/team-blobs/`, and start
  it again.

## Setup

- **Everyone must run the same version.** A mismatched daemon stops with a
  "please update" message; there's no auto-update.
- **Two teammates with the same OS username**: the second one is refused
  until they pass `--name`.
- **The "Report issue" link assumes your daemon is on port 7777.** If you
  started it with `--port`, open `http://127.0.0.1:<port>/report` yourself.
- **Linux isn't a supported desktop** for the beta (the daemon runs there, but
  "Start agent" on a handoff opens a terminal only on macOS and Windows).
- **No installer.** It's a git clone and `pnpm build`; see the README.
- **Ollama is the default summarizer.** Without Ollama running, handoff
  summaries fall back to a plain heuristic, which is worse but works.

## Viewer

- **Sticky notes**: at most 500 per canvas, 12 files per note, 10 MB per file,
  1 GB of files in all. Only PNG, JPEG, GIF and WebP are shown inline; HTML and
  SVG files can't be attached.
- **Images in markdown** only show if they're files attached to a note on this
  server. Links to images elsewhere show as `[image: …]`.
- **Deleting a session** updates other viewers live, but someone whose browser
  was offline at the time keeps the old copy until they reload.
