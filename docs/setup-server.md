# Set up the Baton team server (base machine)

Hand this file to the coding agent on the machine that will host the team
server. It's written for the agent to carry out step by step with its human.
Teammates use [setup-teammate.md](setup-teammate.md).

## Rules for the agent

- **Run each step's check before moving on.** If a check fails, stop and tell
  your human what you saw. Don't improvise workarounds.
- **The team token is a password.** Never write it into a repo, a commit, an
  issue, or a chat message. Show it to your human once, in step 4, so they
  can pass it to teammates privately.
- **Never expose port 7777 to the internet.** Not on the router, not with a
  tunnel, not with `tailscale funnel`. Only the tailnet should reach it.
- **Ask before changing system settings** (installing software, firewall
  rules, shell profile). Say what you're about to change and why.
- Commands are given for **macOS (zsh)** and **Windows (PowerShell)**. Use the
  one for this machine.

## 1. Check the prerequisites

```sh
node -v        # needs v20.19 or newer
git --version
```

If Node is missing or older, ask your human to install the LTS from
<https://nodejs.org>. If git is missing: macOS `xcode-select --install`;
Windows `winget install --id Git.Git -e`.

## 2. Tailscale

Install it (ask first):

- macOS: `brew install --cask tailscale`, or the Mac App Store app.
- Windows: `winget install --id tailscale.tailscale -e`

Your human signs in with the team's Tailscale account. Open the app and sign
in, or run `tailscale up`, which prints a login URL. On macOS, if `tailscale`
isn't on PATH, the CLI is at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

**Check:**

```sh
tailscale status            # this machine is listed, with no "logged out" message
tailscale ip -4             # prints a 100.x.y.z address
```

Note the two things teammates will need:

- the **Tailscale IP** from `tailscale ip -4`;
- the **machine name**: the first column of this machine's line in
  `tailscale status`. With MagicDNS on (the default), teammates can use that
  name instead of the IP.

## 3. Install Baton

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
corepack enable            # if this fails with a permissions error, ask your human to run it in an admin PowerShell
pnpm install
pnpm build
function baton { node $HOME\baton\packages\daemon\dist\index.js @args }
```

**Check:** `baton --version` prints `baton 0.1.0-beta.1` (or newer).

To keep the `baton` shortcut in new terminals, add that `alias`/`function` line
to `~/.zshrc` (macOS) or `$PROFILE` (Windows). Ask first.

## 4. Make the team token

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Show it to your human **once**. They keep it (a password manager is ideal) and
send it to each teammate privately, not in a shared channel. It must be at
least 16 characters; this one is 32.

Set it for this terminal:

```sh
export BATON_TOKEN='<the token>'          # macOS
```

```powershell
$env:BATON_TOKEN = '<the token>'          # Windows
```

## 5. Start the server, on the tailnet only

Bind to the Tailscale address, so nothing outside the tailnet can reach it
even if a firewall is open:

```sh
baton serve --host "$(tailscale ip -4)"                 # macOS
```

```powershell
baton serve --host (tailscale ip -4)                    # Windows
```

Leave this terminal running. It logs `baton team server is running on port 7777`.

**Windows only:** the first time, Windows may ask whether to allow Node.js on
networks. Allow **private** networks only. If teammates can't connect in step 6,
ask your human before adding this rule (admin PowerShell), which opens 7777 to
the Tailscale adapter only:

```powershell
New-NetFirewallRule -DisplayName "Baton (Tailscale only)" -Direction Inbound -Protocol TCP -LocalPort 7777 -InterfaceAlias Tailscale -Action Allow
```

## 6. Check it from the tailnet

In a **second** terminal on this machine:

```sh
curl http://<tailscale-ip>:7777/health          # Windows: curl.exe, not curl
```

**Check:** it answers `{"ok":true,…}`. Then ask your human to open
`http://<machine-name>:7777/` in a browser (on this machine or any machine on
the tailnet) and sign in with the token. They should see the Baton canvas,
empty for now.

With the token set in that second terminal, `baton doctor --server ws://<tailscale-ip>:7777`
should show ✓ for the server, the token and the version.

## 7. Give teammates what they need

Your human sends each teammate, **privately**:

1. The server address: `ws://<machine-name>:7777` (or `ws://<tailscale-ip>:7777`).
2. The viewer address: `http://<machine-name>:7777/`.
3. The token.
4. The file [setup-teammate.md](setup-teammate.md), to give to their own agent.

Teammates must be in the same tailnet. Invite them from the Tailscale admin
console (<https://login.tailscale.com/admin/users>) if they aren't.

## 8. Optional: share this machine's own sessions too

If your human also codes on this machine, they run a daemon like any teammate,
following [setup-teammate.md](setup-teammate.md) part B, **with one change**:
add `--port 7778` to `baton start`. The daemon keeps a local page for
handoffs and issue reports on `127.0.0.1`, and 7778 keeps it clear of the
server. Their "Report issue" page is then `http://127.0.0.1:7778/report`.

## Keeping it running

- The server stops when its terminal closes or the machine sleeps. For the
  beta, keep the machine awake and the terminal open. On macOS,
  `caffeinate -i node ~/baton/packages/daemon/dist/index.js serve --host "$(tailscale ip -4)"`
  keeps it from sleeping while the server runs. (The `baton` alias doesn't work
  after `caffeinate`.) On Windows, set the power plan not to sleep while plugged in.
- After a restart, start it again with step 5. Notes, handoffs and canvas
  positions are kept on disk. Session history isn't: it comes back as
  daemons send new activity (see [known-limitations.md](known-limitations.md)).
- Backups are made daily into the state folder's `backups/`:
  `~/.local/state/baton/backups` on macOS, `%LOCALAPPDATA%\baton\backups` on Windows.

## Updating

Update the server first, then tell teammates to update. Mismatched daemons stop
with a "please update" message.

```sh
cd ~/baton    # Windows: cd $HOME\baton
git pull
pnpm install
pnpm build
```

Then stop the server (Ctrl+C) and start it again (step 5).

## If something's wrong

| Symptom                                        | Likely cause / fix                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `serve needs the team token in BATON_TOKEN`    | Step 4's `export`/`$env:` wasn't run in this terminal                                   |
| `EADDRINUSE` on start                          | Something already uses 7777: an old `baton serve`, or a daemon. Stop it or use `--port` |
| `curl` to the Tailscale IP times out (Windows) | Firewall: step 5's rule                                                                 |
| Teammates can't reach it but you can           | They're not in the tailnet, or Tailscale is off on their machine (`tailscale status`)   |
| `… was written by a newer version of Baton`    | The code is older than the saved data: `git pull` and rebuild                           |

Anything else: run `baton report`, and file an issue with its output
(<https://github.com/cepahal/baton/issues/new?template=bug.md>).
