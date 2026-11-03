# Join a Baton team (teammates)

Hand this file to your coding agent. It sets you up to **view** the team's
Baton canvas (part A), and optionally to **share your own sessions** (part B).
Whoever runs the team server follows [setup-server.md](setup-server.md) and
gives you three things privately: the **server name** (e.g. `baton-host`), the
**team token**, and an invite to the team's **Tailscale** network.

## Rules for the agent

- **Run each step's check before moving on.** If a check fails, stop and tell
  your human what you saw.
- **The team token is a password.** Ask your human for it when needed; never
  write it into a repo, commit, issue or chat log, and don't echo it back.
- **Share nothing without asking.** In part B, share only the repos your human
  names, one by one. Read [what-baton-shares.md](what-baton-shares.md) with them
  first: shared sessions send prompts, replies and full tool output (including
  files the agent reads) to everyone on the team.
- **Ask before changing system settings** (installing software, shell profile).
- Commands are given for **macOS (zsh)** and **Windows (PowerShell)**. Use the
  one for this machine. In Windows PowerShell use `curl.exe`, not `curl`.

---

## Part A: view the canvas (everyone)

### A1. Tailscale

Install it (ask first):

- macOS: `brew install --cask tailscale`, or the Mac App Store app.
- Windows: `winget install --id tailscale.tailscale -e`

Your human accepts the tailnet invite and signs in: open the Tailscale app and
sign in, or run `tailscale up` and follow the URL. On macOS, if `tailscale`
isn't on PATH, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

**Check:**

```sh
tailscale status                       # lists this machine and the server's name
tailscale ping <server-name>           # gets a pong
curl http://<server-name>:7777/health  # {"ok":true,...}
```

If the name doesn't resolve, MagicDNS is off: ask the server's owner for its
`100.x.y.z` address and use that wherever this guide says `<server-name>`.

### A2. Open the viewer

Your human opens `http://<server-name>:7777/` in a browser and types the team
token on the sign-in page. Prefer the sign-in page to a `?token=` link, which
leaves the token in browser history.

**Check:** the Baton canvas loads, and the sidebar lists teammates' sessions
under their names (it may be empty if nobody is sharing yet).

That's all you need to watch. To send your own sessions, continue.

---

## Part B: share your sessions (optional)

### B1. Prerequisites

```sh
node -v        # needs v20.19 or newer
git --version
```

If Node is missing or older, ask your human to install the LTS from
<https://nodejs.org>. Missing git: macOS `xcode-select --install`; Windows
`winget install --id Git.Git -e`.

### B2. Install Baton

macOS:

```sh
git clone https://github.com/cepahal/baton.git ~/baton
cd ~/baton
corepack enable
pnpm install
pnpm build
alias baton="node ~/baton/packages/daemon/dist/index.js"
```

Windows:

```powershell
git clone https://github.com/cepahal/baton.git $HOME\baton
cd $HOME\baton
corepack enable            # on a permissions error, ask your human to run it in an admin PowerShell
pnpm install
pnpm build
function baton { node $HOME\baton\packages\daemon\dist\index.js @args }
```

**Check:** `baton --version` prints a version. It should match the server's:
`baton doctor` (B4) compares them.

To keep the `baton` shortcut in new terminals, add the `alias`/`function` line
to `~/.zshrc` (macOS) or `$PROFILE` (Windows). Ask first.

### B3. Choose what to share

Ask your human which repos to share. For each one:

```sh
cd <path to the repo>
baton share
```

It shares sessions in **every checkout of that repo** on this machine
(identified by its git remote). Outside git, it shares that folder.

**Check:** `baton sharing` lists exactly the repos your human chose.

### B4. Check the setup

Set the token for this terminal (ask your human for it):

```sh
export BATON_TOKEN='<team token>'          # macOS
```

```powershell
$env:BATON_TOKEN = '<team token>'          # Windows
```

Then:

```sh
baton doctor --server ws://<server-name>:7777
```

**Check:** every line is ✓. Each ✗ comes with a fix. Common ones:

- _can't reach the team server_: Tailscale is off, or the name is wrong (A1).
- *the team server rejected BATON_TOKEN*: wrong or old token.
- _team server runs Baton … (protocol …)_: versions differ; whichever side is
  older updates (see Updating below).
- _clock is … s ahead/behind_: turn on automatic time sync.

### B5. Start sharing

In the same terminal (it needs `BATON_TOKEN`):

```sh
baton start --server ws://<server-name>:7777 --name "<your name>"
```

`--name` is what teammates see; it defaults to the OS username. Leave this
terminal running while you want to share. Ctrl+C stops it.

**Check:** it logs `connected to team server`. Start a Claude Code or Codex
session in a shared repo and send one message. Within a few seconds it appears
in the viewer under your name. A session in a repo you didn't share never
appears.

If it exits with _Another machine is already connected as "…"_, pick a
different `--name`. If it exits with _too old for this team server_, update.

### Everyday use

| You want to…                      | Run                                                                       |
| --------------------------------- | ------------------------------------------------------------------------- |
| Stop sending anything for a while | `baton pause` (then `baton resume`)                                       |
| Share another repo / stop one     | `baton share` / `baton unshare` inside it                                 |
| See what's shared                 | `baton sharing`                                                           |
| Remove a session already sent     | Open it in the viewer → 🗑 → **Delete for everyone**, then `baton unshare` |
| Report a problem                  | "Report issue" at the bottom of the viewer's sidebar, or `baton report`   |

When a teammate sends you a handoff, you get a notification. The confirm page
opens on your own `127.0.0.1`, and nothing is written or started until you
accept there.

### Updating

When the server's owner says to update (or a "please update" message appears):

```sh
cd ~/baton    # Windows: cd $HOME\baton
git pull
pnpm install
pnpm build
```

Then stop `baton start` (Ctrl+C) and run B5 again. Your sharing list is kept.

---

Something not working? Run `baton report` and file an issue with its output
at <https://github.com/cepahal/baton/issues/new?template=bug.md>. The
[beta script](beta-script.md) lists what to try, and
[known-limitations.md](known-limitations.md) what's already known.
