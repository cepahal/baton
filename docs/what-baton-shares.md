# What Baton shares

Read this before you run `baton start --server`. It describes what leaves your
machine, who can see it, and how to stop it.

## Nothing, until you share a repo

A daemon connected to a team server sends **nothing** until you run
`baton share` in a repo (or, outside git, a folder):

- **A git repo** is identified by its remote (`origin`, normalized: e.g.
  `github.com/acme/shop`). Sharing it shares sessions in **every checkout** of
  that repo on your machine, including worktrees.
- **A folder outside git** shares sessions whose working directory is that
  folder or inside it.
- Sessions anywhere else are read by the daemon (it has to, to know where they
  ran) but **never sent**. The daemon logs each unshared folder once, locally.
- **The session is the unit.** Once a session has been seen working in a shared
  repo, the rest of that session is sent, even if the agent then works in
  another folder. (Logs spell one folder several ways, e.g. `C:\…` and `/c/…`
  on Windows; this keeps a shared session whole.) `baton unshare` or
  `baton pause` ends that at once.

`baton sharing` lists what's shared. The list is in `sharing.json` in your
state folder (see the README) and is re-read about once a second, so changes
apply to a running daemon without a restart.

`baton start` _without_ `--server` is a private viewer on `127.0.0.1` and shows
everything on your machine to you alone; sharing settings don't apply to it.

## What a shared session sends

Everything the agent's log has, labelled, at full fidelity. That's the point:
teammates see what the agent actually did.

| Sent                                                                         | Example                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| Your prompts, and the agent's replies and visible thinking                   | "fix the login bug"                           |
| Every tool call, with its input                                              | `bash: npm test`, `edit: src/auth.ts`         |
| **Full tool output**                                                         | test output, **file contents the agent read** |
| Content injected into the session (system reminders, hook output, CLAUDE.md) | labelled as such                              |
| The session's working directory, **as a full path**                          | `/Users/alice/code/shop`                      |
| Git remote, branch, and path within the repo                                 | `github.com/acme/shop`, `main`, `api/`        |
| Files the agent touched, and line ranges                                     | `src/auth.ts: 10-42`                          |
| Your daemon's name (`--name`, default your OS username) and timestamps       |                                               |

So: if the agent `cat`s a `.env` file, prints a stack trace with customer data,
or reads a private key, that output is sent.

### Credential masking (a safety net, not a guarantee)

Before anything leaves your machine, the daemon masks text that looks like a
credential, replacing it with `[redacted]`:

- API keys with a known shape (Anthropic, OpenAI, GitHub, GitLab, AWS, Google,
  Slack, Stripe, npm), JWTs, PEM private keys, `Bearer` tokens, and passwords in
  URLs (`postgres://user:pass@…`);
- `NAME=value` where the name says secret (`*_TOKEN`, `*_SECRET`, `*PASSWORD*`,
  `*API_KEY*`, …), and quoted values of keys like `"apiKey": "…"`.

It can't recognize a secret with no telltale shape (a random password in a
config file, a customer's email, an internal hostname). **Don't share repos
whose sessions routinely touch production secrets or customer data.**

## When history is sent

- A daemon that's **already running** when you share a repo sends that repo's
  activity from then on. A session that was already under way shows up from
  that point, not from its start.
- A daemon that **starts** (or restarts) with a repo shared sends the history
  of recent sessions in it: those active in the last 2 hours
  (`--active-minutes`), and the 5 newest per agent however old (`--recent`).
  Use `--backlog <n>` to send at most `n` past events per session.
- While **paused**, nothing is sent, and what happens meanwhile is never sent
  later: the daemon reads past it.

## Stopping

| You want to…                     | Do this                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| Stop sending anything, right now | `baton pause` (takes effect within a second); `baton resume` to restart |
| Stop sharing one repo            | `baton unshare` in it                                                   |
| Remove something already sent    | open the session in the viewer → 🗑 → **Delete for everyone**            |
| Stop entirely                    | stop `baton start` (Ctrl+C)                                             |

Deleting a session removes its events from the server and from every open
viewer, and the server refuses anything later sent for that session (it keeps
the session's id, nothing else). It can't unsee what a teammate already read,
and it doesn't remove copies made by handoffs or nightly backups. Backups are
pruned after 7 days.

## Who can see it

Everyone with the team token, which is everyone on the beta. There are no
per-person permissions:

- anyone can read every shared session, note and handoff;
- anyone can edit or delete any sticky note, and delete any session;
- names on notes and handoffs are what each person typed, not verified.

The server stores notes, their files, handoffs and canvas positions on disk
(and backs them up nightly). Session events are kept **in the server's memory
only** and are gone when it restarts, apart from what daemons send again.

## What else leaves your machine

- **Sticky notes and their files** go to the server when you add them. Images
  must be PNG, JPEG, GIF or WebP to be shown; other files are downloads; HTML
  and SVG files are refused. Files are kept until no note or pending handoff
  uses them.
- **Handoffs** you send contain what you typed, plus (for session handoffs) a
  summary of the session. In team mode the **team server** drafts summaries,
  with the model set by `BATON_SUMMARIZER` where `baton serve` runs: `ollama`
  (default; stays on the server machine), `anthropic` (session text goes to the
  Anthropic API under the server's `ANTHROPIC_API_KEY`), or `off`. Ask whoever
  runs the server which it uses.
- **Code with a handoff**, only if you tick _Attach my uncommitted changes_
  when sending, from a browser paired with your machine. Your daemon then
  sends a diff of the session's checkout against `HEAD` (tracked and untracked
  files, in a shared repo only), with secret-looking files (`.env`, keys,
  credentials) skipped and credential-shaped lines masked. Nothing is attached
  by default.
- **Nothing goes anywhere else.** No telemetry, no analytics. The "Report issue"
  page and `baton report` only _show_ you a redacted log excerpt; you choose
  whether to paste it into an issue.

## What never leaves

- Your logs (`logs/daemon.log` in the state folder). They're redacted of the
  team token and auth headers when written.
- Sessions in repos you haven't shared, and anything while paused.
- Your machine id (a random value the server uses to tell your daemon from
  another with the same name) is sent, but identifies only the install.

## What the team server can make your machine do

Exactly one thing: write a handoff's files. When someone accepts a handoff
addressed to you on the team website, from a browser **paired with your
machine** (`baton start --server` prints the pairing link; `baton pair` gives
a new one), the server asks your daemon to write
`.baton/handoffs/<id>.md`, its attached files and `changes.patch` into the
folder you chose (or the receiving session's folder), excluded from git. The
server checks the pairing; your daemon also only writes handoffs it was
offered.

Nothing else runs remotely. Starting an agent (`baton handoff start <id>`) and
applying a patch (`baton handoff apply <id>`) are commands you type on your
own machine; no button on the website does either. Pairing links work once,
expire after 10 minutes, and aren't written to any log; the server stores only
a hash of them and of the browser's pairing cookie.
