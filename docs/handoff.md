# Drag-and-drop handoff

Status: **built.** Text, note and code handoffs, accepted on the team website
by a browser paired to the receiving machine.

A handoff passes work from one session to another person's session by drag and
drop on the canvas. It uses no MCP. The receiver's agent picks the work up from a
markdown file written into a folder on their machine. Sender and receiver may
work in **different repos** (or no repo at all): the handoff is text, and code
travels as a patch the receiving agent adapts.

## The one rule

> **The website can make a daemon do exactly one thing: write a handoff's
> files into a folder.** Only for a handoff addressed to that daemon, and only
> after Accept is pressed in a browser paired to that machine. Applying a
> patch or starting an agent are local commands (`baton handoff apply|start`),
> never triggered remotely.

The server stores and routes handoffs and checks who may answer them. A daemon
treats every other server message as a suggestion: it stores it and raises a
notification. Tests enforce this (see [Tests](#tests)).

## Gestures

| Drag                                   | Drop onto    | Kind      | Packet                                      |
| -------------------------------------- | ------------ | --------- | ------------------------------------------- |
| Card grip (the ⠿ in the card header)   | another card | `full`    | Summarized session                          |
| One event in the side-panel live feed  | a card       | `snippet` | That event's full text + where it came from |
| "Whole chat" bubble (foot of the feed) | a card       | `chat`    | The whole conversation, rendered by code    |

- Moving a card still works by dragging its body. While a handoff drag is in
  progress, other cards highlight as drop targets. Dropping a session on itself
  does nothing.
- Either drop opens the **compose dialog**. Nothing is sent until the sender
  presses Send.

## Packet

### Full handoff

```
events ──summarizerInput (compact view)──▶ summarizer ──▶ HandoffSummary ──renderHandoff──▶ markdown
                                              │
                                  (off / unreachable: heuristic fill)
```

`HandoffSummary` (zod, in core) is the template:

| Field           | Type               | Heuristic fill                                      |
| --------------- | ------------------ | --------------------------------------------------- |
| `goal`          | string             | First real prompt, capped                           |
| `currentState`  | string             | Last reply, capped                                  |
| `decisions`     | string[]           | empty                                               |
| `deadEnds`      | string[]           | Failed tool results' one-liners (last 5)            |
| `openQuestions` | string[]           | Last reply's lines ending in `?`                    |
| `filesTouched`  | `{path, ranges}[]` | `fileTouches` over the session (never from a model) |
| `nextSteps`     | string[]           | empty                                               |

### Summarizer

`BATON_SUMMARIZER` picks the model behind handoff summaries and the domain
tie-break:

| Value              | Behaviour                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ollama` (default) | A local Ollama at `BATON_OLLAMA_URL` (default `http://127.0.0.1:11434`). Uses `BATON_SUMMARIZER_MODEL` if set, else the **fastest installed text model**: fewest parameters, then smallest download, then name. |
| `anthropic`        | The Anthropic API (`ANTHROPIC_API_KEY`), model `BATON_SUMMARIZER_MODEL` or the default.                                                                                                                         |
| `off`              | Heuristic only.                                                                                                                                                                                                 |

- Embedding-only models are never picked. Models that can think get
  `think: false`, since small models are slow when thinking.
- If Ollama is down or has no models, the daemon logs one warning and drafts
  fall back to the heuristic with a note in the dialog. It retries the model
  lookup after a minute, so starting Ollama later works without a restart.
- Requests to one Ollama are sent one at a time.
- The model's JSON is validated with zod. Anything invalid falls back to the
  heuristic.

### Snippet

The event's full text (`meta.full` for tool results), capped at 16 KB, under a
header naming the source session, event kind and time. No summarizer.

### Whole chat

`renderChat` (core `handoff/chat.ts`) turns the compact view (`compactForLLM`)
into markdown, oldest first: prompts, replies, tool calls, tool results (folded
in `<details>`). Thinking, system content and subagent work are left out, as in
the compact view. When the chat is longer than the markdown cap (256 KB), the
newest entries are kept along with the first prompt, and a line says how many
were left out. No summarizer, so it never waits on a model.

### Compose dialog

Shows the rendered markdown in an editable textarea, the recipient, and the
sender's name (kept in `localStorage`). What they send is what they see.

## Server: storage and routing

```
Handoff { id /^h[0-9a-z]{10}$/, kind, status: pending|accepted|declined,
          sender, from: HandoffParty, to: HandoffParty, markdown ≤ 256 KB,
          attachments?, code?: HandoffCode, note?, delivery?: HandoffDelivery,
          createdAt, updatedAt }
HandoffParty    { sessionId, user?, agent, repoId|null, branch|null, daemon? }
HandoffCode     { state: attached|unavailable, sha256?, bytes?, base?, branch?,
                  files?, skipped?, redacted?, reason? }
HandoffDelivery { folder, path, apply: { available, reason? } }
```

- `HandoffStore` (daemon) is shared by the local hub and the team server. It
  persists to `handoffs.json` and keeps the last 500. A patch is not kept in
  the record: it is a blob (content-addressed, like note files), kept while a
  pending handoff needs it.
- **Routing:** the hub knows which daemon published each session (`daemon` in
  `HandoffParty`). Offers go as `{ type: "handoff_offer", handoff }` down that
  daemon's `/ingest` socket and are resent when it reconnects while pending.
  **Local mode:** the hub is the target daemon, so everything goes straight
  to the local inbox.
- **Viewers** get a `handoff` WS message on create and on each status change.

### Routes

Team token required in team mode. "Paired" means the browser's pairing cookie
names the daemon (and machine) in question. In local mode (`baton start`) the
only browser is on the machine itself and counts as paired.

| Route                            | Who                                                            | Does                                                         |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /handoffs/draft`           | any viewer                                                     | `HandoffDraft` to preview                                    |
| `POST /handoffs`                 | any viewer; `attachCode` only from the sender's paired browser | store, fetch the patch, offer                                |
| `GET /handoffs`, `/handoffs/:id` | any viewer                                                     | JSON; `/handoffs/:id` asked for as HTML is the handoff page  |
| `POST /handoffs/:id/accept`      | browser paired to the **recipient**                            | `{ folder? }`: the recipient daemon writes; 200 once written |
| `POST /handoffs/:id/decline`     | browser paired to the **recipient**                            | `{ note? }`: marks it declined                               |
| `GET /me`                        | any viewer                                                     | `{ local, pairing: { name, machine } \| null }`              |
| `POST /pair`                     | daemons (bearer token only)                                    | a one-time pairing code for that daemon                      |
| `POST /pair/claim`               | logged-in browser                                              | `{ code }` → sets the `baton_pair` cookie                    |

Accept and decline answer 403 to an unpaired browser and to one paired to
another machine. The server enforces this, not only the UI.

## Pairing a browser to a machine

```
baton start --server …         team server                      browser (logged in)
  POST /pair {name, machine} ─▶ code (32 random bytes, single use, 10 min)
  prints + opens  <server>/pair#<code>  ─────────────────────────▶ page reads #code
                                     ◀─── POST /pair/claim {code} ───┘
                             Set-Cookie: baton_pair=<id>; HttpOnly; SameSite=Strict
```

- The code rides in the URL **fragment**, which browsers never send, and in a
  POST body; request logging is off, so it is never logged. The server keeps
  only its hash. A code works once and expires after 10 minutes. `baton pair`
  prints a fresh link.
- The cookie holds a random id; the server keeps its hash with the daemon name
  and machine id (`team-pairings.json`). The machine id is the one the daemon
  sends on `/ingest`, so a pairing for `alice` only answers handoffs to
  `alice` on that machine.
- One browser holds one pairing; pairing again replaces it.

## Receiver: notification, inbox, accept

On `handoff_offer` the daemon stores the offer and notifies, linking to
`<team server>/handoffs/<id>` (local mode: the local viewer's
`/handoffs/<id>`). It does nothing else.

The **handoff page** (`/handoffs/:id`; also listed in the HandoffTray's inbox)
shows the markdown, attachments and code summary. A browser paired to the
recipient gets **Accept** and **Decline** (with an optional note). Other
browsers see who it is for; an unpaired one gets a "pair this browser" prompt.

**Accept** sends `{ type: "handoff_write", requestId, id, folder? }` to the
recipient daemon only. The daemon:

1. Checks it holds a pending offer with that id (it was addressed to it).
2. Picks the **destination**: the folder typed on the page if any, else the
   cwd of the receiving session as this daemon saw it in its own transcripts.
   With neither it answers `needFolder` and the page asks for one. A folder
   must exist and be a directory; no repo match, git optional.
3. Writes `.baton/handoffs/<id>.md`, note files into `.baton/handoffs/<id>/`,
   and the sender's patch as `.baton/handoffs/<id>/changes.patch` (with
   `handoff.json`: base, branch, repoId, agent). Adds `/.baton/` to
   `.git/info/exclude` when the folder is in git.
4. Decides whether the patch can be applied: **only** when the folder is a
   checkout of the sender's repo (same repoId) **and** the base commit exists
   locally. Otherwise the reason says why (another repo, not in git, base
   commit missing).
5. Answers `{ type: "handoff_written", requestId, id, ok, folder, path, apply }`.

The server marks the handoff `accepted` with its `delivery`, and the page shows:

- The prompt with **Copy**: `Read .baton/handoffs/<id>.md and continue the work
  it describes.`, plus with a patch `The sender's changes are in
  .baton/handoffs/<id>/changes.patch; adapt them to this codebase.`
- The command: `cd <folder> && claude "<prompt>"`, `codex "<prompt>"` or Cursor's
  Agent CLI, `agent "<prompt>"`.
- When apply is available: `cd <folder> && baton handoff apply <id>`.

**Decline** marks it declined (with the note) on the server and tells the
daemon, which forgets the offer.

### Local commands

- `baton handoff apply <id>` (in the folder the handoff was accepted into):
  refuses a dirty tree or a missing base commit, creates `baton/handoff-<id>`
  from the current `HEAD` and runs `git apply --3way --index`, which uses the
  base commit to merge. Conflicts are left marked; on any other failure it
  switches back and deletes the branch.
- `baton handoff start <id>`: runs `claude`, `codex` or Cursor's `agent` command with the prompt in this
  terminal, in the current folder. Never with permission-bypass flags.

The localhost confirm page is gone; `/inbox/:id` redirects to the handoff page.

## Code attachment

The compose dialog offers **Attach my uncommitted changes** to a browser paired
to the **sender's** machine (the server refuses `attachCode` from anyone else).
The server asks the sender's daemon (`handoff_code_request`); that daemon builds
the patch only for a session it shares (`baton share`):

- a temporary `GIT_INDEX_FILE` over `HEAD`: tracked changes plus untracked,
  non-ignored files; secret-looking files (`.env`, keys) and files over 1 MB
  skipped; key-like strings redacted; 5 MB cap;
- `git diff --binary` against `HEAD`, uploaded as a blob; the daemon answers
  `handoff_code` with the summary (base, files, skipped, redacted).

When there is no patch (no git, clean tree, unshared repo, timeout) the text is
still sent, and `code.reason` says why.

## Notifications

`BATON_NOTIFY` = `banner` (default) | `open` | `off`.

| OS      | `banner`                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | Toast; clicking it opens the handoff URL.                                                                                                 |
| macOS   | `terminal-notifier -open <url>` when installed; otherwise an `osascript` banner ending "Open Baton to review" (clicks do nothing useful). |
| Linux   | `notify-send` with the URL in the body.                                                                                                   |

`open` opens the handoff URL in the default browser instead (`open`, `start`,
`xdg-open`). `off` does neither.

## Protocol (core `protocol.ts`)

- Viewer messages: `HandoffMessage` (`type: "handoff"`).
- `/ingest` server→daemon: `HandoffOfferMessage`, `HandoffWriteMessage`,
  `HandoffCodeRequestMessage`. Daemon→server: `HandoffWrittenMessage`,
  `HandoffCodeMessage`. Requests carry a `requestId`; the server waits for
  the matching answer (30 s for a write, 60 s for a patch).
- All zod-validated in both directions. `INGEST_PROTOCOL_VERSION` is bumped.

## Tests

- Core: template sections, caps, schemas, patch redaction.
- Daemon `handoff.test.ts`: accept into a folder of another repo and into a
  non-git folder (patch written, apply not offered); apply offered and working
  when repoIds match; `applyHandoff` refuses a dirty tree.
- Daemon `pairing.test.ts`: codes single-use and expiring; unpaired and
  other-machine browsers get 403 on accept/decline; write instructions reach
  only the recipient daemon; no server message launches a terminal or applies
  a patch.
- `notify.test.ts`: argument construction per OS with a mocked `execFile`.
- e2e: handoff between replayed sessions in different repos, accepted from
  the recipient's paired browser; the file appears in the destination.

## Not in scope

- Per-user accounts on the team server. Anyone with the team token can pair a
  browser to a daemon name they run.
- Automatic `git fetch`, push or commit.
- Handoff to a session whose daemon isn't running: it waits, `pending`; Accept
  says the machine is offline.
