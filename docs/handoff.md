# Drag-and-drop handoff

Status: **built, text only.** Code attachment (patch of the sender's working
tree, applied on a branch at the receiver) was designed and built, then pulled
before release so text handoffs could ship first. It is kept as a git stash
(`handoff-code-sharing snapshot 2026-11-03`); see [Code attachment
(later)](#code-attachment-later).

A handoff passes work from one session to another person's session by drag and
drop on the canvas. It uses no MCP. The receiver's agent picks the work up from a
markdown file written into their checkout.

## The one rule

> **Nothing the shared server sends can make a daemon act on its machine.**
> Writing files or opening a terminal happen only after a person clicks a
> button on that daemon's own localhost page.

The server stores and routes handoffs, and nothing more. A daemon treats every
server message as a suggestion: it stores the message, raises a notification,
and waits. Tests enforce this (see [Tests](#tests)).

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
          createdAt, updatedAt }
HandoffParty { sessionId, user?, agent, repoId|null, branch|null }
```

- `HandoffStore` (daemon) is shared by the local hub and the team server. It
  persists to `handoffs.json` and keeps the last 500.
- **Routing:** the hub knows which daemon published each session. A handoff is
  sent as `{ type: "handoff_offer", handoff, dir? }` down that daemon's
  `/ingest` socket. If the daemon is offline, the offer is resent when it next
  connects, until it is answered.
- **Local mode:** the hub is the target daemon, so the offer goes straight to
  the local inbox.
- **Viewers** get a `handoff` WS message on create and on each status change.
- **Routes** (team token required in team mode):
  - `POST /handoffs/draft` `{ kind, fromSessionId, toSessionId, eventId?, sender? }` → `HandoffDraft`
  - `POST /handoffs` `{ kind, fromSessionId, toSessionId, eventId?, markdown, sender }` → `201 { handoff }`
  - `GET /handoffs`
- **Status changes come only from the target daemon:** `{ type:
  "handoff_status", id, status }` on `/ingest`, only from the connection with
  the target's daemon name, only from `pending`. No HTTP route lets a browser
  accept or decline on the server.

### Identity

Team mode has one shared token, not per-person logins. The sender's name is a
label typed in the viewer. The receiver is identified by daemon name
(`--name`). Every action needs the receiver's own click on their own machine,
which is why unverified names are acceptable.

## Receiver: inbox and confirm page

On `handoff_offer` the daemon stores the offer and raises an OS notification
linking to `http://127.0.0.1:<port>/inbox/<id>`. It does nothing else.

The **confirm page** shows the markdown read-only, with **Accept** and
**Decline**. Decline is plain: it reports `declined` and closes the entry.

After **Accept**, the daemon writes `.baton/handoffs/<id>.md` into the checkout
(adding `/.baton/` to `.git/info/exclude`), reports `accepted`, and the page
offers:

| Action                | What it does                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| **Copy prompt**       | Copies `Read .baton/handoffs/<id>.md and continue the work it describes.`           |
| **Start new session** | Opens a terminal in the checkout running `claude "<prompt>"` or `codex "<prompt>"`. |

- **Finding the checkout:** the receiving session's folder if its repoId
  matches, else a folder remembered for that repoId in `repo-folders.json`,
  else a folder field on the page (checked to be a checkout of the same repo).
- **Start new session** spawns with an argv array, never a shell string. The
  prompt holds only `[A-Za-z0-9 ./-]`. It never passes permission-bypass flags.
- **Every action** is a `POST` from the confirm page itself (local `Host`,
  `Origin` equal to it) carrying a random per-handoff token embedded only in
  that page. Anything else gets 403. The team server never serves `/inbox`.

## Protocol (core `protocol.ts`)

- Viewer messages: `HandoffMessage` (`type: "handoff"`).
- `/ingest` server→daemon: `HandoffOfferMessage`. Daemon→server:
  `HandoffStatusMessage`.
- All zod-validated in both directions.

## Tests

- Core (`packages/core/test/handoff.test.ts`): template sections, caps,
  sidechains ignored, snippets, fences, ids, schemas strip `code`/`note`.
- Daemon (`packages/daemon/test/handoff.test.ts`, `ollama.test.ts`): local
  send → offer → accept writes the file; plain decline; routing on a team
  server to the right daemon only, resend on reconnect, wrong-daemon answers
  ignored; confirm routes reject missing tokens and foreign origins; model
  picking and Ollama fallbacks.

## Code attachment (later)

The removed design: build a patch on the sender's machine with a temporary
`GIT_INDEX_FILE` (untracked files included, ignored and secret-looking files
skipped, key-like strings redacted, 1 MB/file and 5 MB/patch caps); in team mode
ask the sender to confirm sharing on their own localhost page; at the receiver,
apply with `git apply --3way --index` on `baton/handoff-<id>`, refusing a dirty
tree. To restore: `git stash list`, then apply the snapshot and resolve against
the text-only code.

## Not in scope

- Per-user accounts on the team server.
- Automatic `git fetch`, push or commit.
- Handoff to a session whose daemon isn't running: it waits, `pending`.
