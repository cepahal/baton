# baton

Baton streams your team's live Claude Code and Codex sessions to a shared
canvas: see what everyone's agents are doing, leave sticky notes, and hand work
from one session to another.

- **Nothing is shared until you say so.** Each machine shares only the repos
  its owner runs `baton share` in. Read [what Baton shares](docs/what-baton-shares.md)
  before you start.
- Beta testers: follow the [beta script](docs/beta-script.md) and check the
  [known limitations](docs/known-limitations.md). Report problems with the
  **Report issue** link in the viewer (or `baton report`).

## Setting up with an agent

Two step-by-step guides, written to hand to your coding agent:

- **[setup-server.md](docs/setup-server.md)**: the base machine. Tailscale,
  the team token, `baton serve` bound to the tailnet only, and what to send
  teammates.
- **[setup-teammate.md](docs/setup-teammate.md)**: everyone else. Join the
  tailnet and open the viewer (part A), and optionally share your own
  sessions (part B).

## How it fits together

```
your machine:  Claude Code / Codex ──▶ baton start --server ─┐
teammate's:    Claude Code / Codex ──▶ baton start --server ─┤  (over Tailscale)
                                                              ▼
                              one machine: baton serve ──▶ browsers (everyone)
```

One person runs the **team server** (`baton serve`). Everyone, including that
person, runs a **daemon** (`baton start --server …`) on the machine where their
agents run. Everyone shares one **team token**.

## Before you start (everyone)

- **Node 20.19 or newer** (`node -v`). Install from <https://nodejs.org>.
- **git** (`git --version`).
- **Tailscale**, signed in to the team's tailnet. Baton talks plain HTTP and
  WebSocket and relies on Tailscale to encrypt them; don't expose the server's
  port to the internet.
- The **team token** (16+ characters), from whoever runs the server. Treat it
  like a password: anyone with it sees every shared session.

## Quickstart: macOS

```sh
git clone https://github.com/cepahal/baton.git ~/baton
cd ~/baton
corepack enable          # once; gives you pnpm
pnpm install
pnpm build

# So you can type `baton` anywhere (add to ~/.zshrc to keep it):
alias baton="node ~/baton/packages/daemon/dist/index.js"
export BATON_TOKEN='<team token>'
```

**Server (one person):**

```sh
baton serve                      # listens on port 7777
tailscale ip -4                  # or use the machine's MagicDNS name
```

**Every teammate:**

```sh
cd ~/code/the-repo-to-share
baton share                      # share this repo; repeat per repo
baton doctor --server ws://<server-name>:7777
baton start --server ws://<server-name>:7777 --name "<your name>"
```

Open `http://<server-name>:7777/` in a browser and sign in with the team token.

## Quickstart: Windows (PowerShell)

```powershell
git clone https://github.com/cepahal/baton.git $HOME\baton
cd $HOME\baton
corepack enable          # once; run PowerShell as admin if this fails
pnpm install
pnpm build

# So you can type `baton` anywhere (add to $PROFILE to keep it):
function baton { node $HOME\baton\packages\daemon\dist\index.js @args }
$env:BATON_TOKEN = '<team token>'
```

**Server (one person):**

```powershell
baton serve                      # listens on port 7777; allow it in Windows Firewall for Tailscale
tailscale ip -4
```

**Every teammate:**

```powershell
cd $HOME\code\the-repo-to-share
baton share
baton doctor --server ws://<server-name>:7777
baton start --server ws://<server-name>:7777 --name "<your name>"
```

Open `http://<server-name>:7777/` and sign in with the team token.

## Everyday commands

| Command                        | What it does                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| `baton share [dir]`            | Share sessions in this repo (every checkout of it) or, outside git, folder |
| `baton unshare [dir]`          | Stop sharing it                                                            |
| `baton sharing`                | List what's shared, and whether sharing is paused                          |
| `baton pause` / `baton resume` | Stop sending anything at all / start again. Takes effect in about a second |
| `baton doctor --server <url>`  | Check Node, git, agent folders, sharing, the server, the token, clock skew |
| `baton report`                 | Version info and the last 200 log lines, redacted, for a bug report        |
| `baton start` (no `--server`)  | A private viewer on `http://127.0.0.1:7777/` for this machine only         |

`--name` defaults to your OS username. If two teammates have the same one, the
second is refused with a message asking for `--name`.

To remove a session from the shared canvas for everyone (say you shared
something by mistake), open it and press 🗑 → **Delete for everyone**. Then
`baton unshare` the repo, or it will keep sending new activity.

## Updating

Everyone should run the same version. When the server and a daemon don't
match, the daemon stops with a "please update" message saying which side is
older.

```sh
cd ~/baton            # or $HOME\baton
git pull
pnpm install
pnpm build
# then restart `baton serve` / `baton start`
```

Update the server first, then tell the team. Your sharing settings, notes,
handoffs and canvas are kept across updates; the server also keeps a nightly
backup (see [team.md](docs/team.md#backups)).

## Where things live

| What                                 | macOS / Linux                     | Windows                 |
| ------------------------------------ | --------------------------------- | ----------------------- |
| Daemon state, sharing list, logs     | `~/.local/state/baton/`           | `%LOCALAPPDATA%\baton\` |
| Team server notes, handoffs, backups | same folder on the server machine | same                    |

## For developers

See [CLAUDE.md](CLAUDE.md) for the layout and standards, [docs/spec.md](docs/spec.md)
for the event schema, and [docs/team.md](docs/team.md) for the team server.

```sh
pnpm check        # lint + typecheck + test + build
pnpm test:multi   # Docker: a team server and 9 simulated machines
pnpm test:e2e     # Docker + Playwright: the viewer end to end
```
