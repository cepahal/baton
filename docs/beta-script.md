# Beta test script

About an hour, best done together on a call. One person runs the team server;
everyone else (3 to 6 people, a mix of macOS and Windows, Claude Code, Codex and
Cursor) follows the README quickstart on their own machine first.

For each scenario: do the steps, check what you should see, and if it doesn't
match, use **Report issue** (bottom of the sidebar) and file a bug with what
you did. Note your OS and agent in every report.

## 0. Setup check (everyone, 5 min)

1. `baton doctor --server ws://<server>:7777` with `BATON_TOKEN` set.
2. **Expect** every line to be ✓, apart from "no repos are shared yet" until
   step 1. Anything with ✗ comes with a fix; if the fix doesn't work, report it.

## 1. Share one repo and see yourself appear (everyone, 10 min)

1. In a throwaway or low-stakes repo: `baton share`, then
   `baton start --server ws://<server>:7777 --name <you>`.
2. Open the viewer, sign in with the token.
3. Start a Claude Code, Codex or Cursor session in that repo and ask it something small.
4. **Expect** your session in the sidebar under your name within a few seconds,
   with the right agent badge. Drag it onto the canvas.
5. **Expect** a domain label (frontend, backend, …) on the card after a few
   turns, and your branch.
6. Two people in the **same repo** (different clones are fine): **expect** your
   cards grouped in one box with a link between them showing both branches.

## 2. Things you didn't share stay private (everyone, 5 min)

1. Start a session in a repo you have **not** shared.
2. **Expect** it never to appear for anyone. `baton sharing` shows what is.
3. In your shared repo, ask the agent to run `echo API_KEY=abcd1234efgh5678`.
4. **Expect** teammates to see `API_KEY=[redacted]`.
5. `baton pause`, do a turn in the shared repo, `baton resume`, do another.
6. **Expect** teammates to see the turn after resuming but **not** the paused one.

## 3. Sticky notes (two people, 10 min)

1. Click the note pad on the canvas ("Add a sticky note"). Double-click the note and
   write some markdown: a heading, a **bold** word, a list, a link.
2. Attach a screenshot (the paperclip, or drop the file on the note).
3. **Expect** the other person to see the note with formatting and the image,
   live, without reloading.
4. Try attaching an `.html` or `.svg` file. **Expect** it to be refused.
5. Write `<img src=x onerror=alert(1)>` in a note. **Expect** it to show as
   text, no popup, for everyone.
6. Take the note down. **Expect** it to disappear for everyone.

## 4. Snippet and session handoffs (two people, 10 min)

1. Open your session's feed, drag one event onto a teammate's card, write a
   line, and send.
2. **Teammate**: expect a notification and a "for you" badge in the Handoffs
   tray. Open it: the confirm page is on **your own** `127.0.0.1`.
3. Accept. **Expect** the handoff file written in your checkout under
   `.baton/handoffs/`, and the sender's tray to say "accepted".
4. Press **Start agent**. **Expect** a terminal in your checkout running your
   agent on the handoff (macOS Terminal / Windows Terminal or cmd).
5. Repeat with the card's grip (⠿) for a whole-session handoff, and drag a
   sticky note onto a card to send the note.

## 5. Disconnects (everyone, 10 min)

1. While your agent is working, quit `baton start` (Ctrl+C), wait 30 s, start
   it again. **Expect** your session to keep going on the canvas with no
   repeated or missing turns.
2. Turn Wi-Fi (or Tailscale) off for a minute mid-session, then on.
   **Expect** the same.
3. Close your laptop lid for a few minutes, open it. **Expect** the viewer to
   say it's reconnecting, then catch up.
4. Server person: restart `baton serve`. **Expect** notes, handoffs and card
   positions to survive; past events of finished sessions don't (known
   limitation).

## 6. Mistakes and clean-up (one person, 5 min)

1. Share a repo, do a turn, then decide you shouldn't have.
2. Open the session → 🗑 → **Delete for everyone**. **Expect** it gone for
   everyone at once. `baton unshare` the repo.
3. Restart your daemon. **Expect** the session not to come back.

## 7. Mixed versions (server person, 5 min, optional)

1. Check out the previous commit on one teammate's machine, build, start it.
2. **Expect** it to stop with "too old for this team server … Please update
   Baton", not to keep retrying silently.

## 8. Tell us what you thought (everyone)

- What did you expect to see that you didn't?
- What did you see that you'd rather teammates didn't?
- Would you leave it running all day? Why or why not?
