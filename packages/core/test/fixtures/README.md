# Transcript fixtures

Real Claude Code transcripts (`~/.claude/projects/<slug>/<sessionId>.jsonl`),
cut to their first 200 records and redacted. `baton replay` and the multi-machine
test (`pnpm test:multi`) replay these six as simulated live sessions. Lines are untouched apart from
redaction, so they keep the real record types, field order quirks, and
streamed-assistant structure the parser has to handle. Biome is told to ignore
this directory.

| File | Session | What it exercises |
|---|---|---|
| `heavy-tools.jsonl` | Python backend work (YouTube matching module) | 38 `tool_use` / 38 `tool_result` (Bash, Edit, Read, Write), 18 thinking blocks (4 with text, the rest signature-only), an unclosed `<pasted_content>` cut by redaction, `queue-operation`, `cost-state`, `mode`, 44 attachments, IDE context tags in prompts |
| `api-requests.jsonl` | Installing an npm tool + editing a shell profile | 20 `api-request`, 34 `api-request-blob`, 1 `api-request-shape`, `system`, `permission-mode`, `tools-used`, Bash + PowerShell + Edit tool calls |
| `mixed.jsonl` | yt-dlp downloader module | Ordinary mix: 28 tool calls, a `<pasted_content>` prompt, 5 non-empty thinking blocks, pasted error logs, `edited_text_file` attachments, 2 `is_error` results, and a tool call whose result was cut off by the 200-line truncation |
| `code-review.jsonl` | A `/code-review` run on this repo | Slash command with `local-command-caveat`, a long `<task-notification>` cut open by the 2,000-char truncation, 33 Bash calls, 25 signature-only thinking blocks (so no thinking events), 18 `api-request` |
| `install-debug.jsonl` | Debugging a failed tool install on Windows (137 records, the whole session) | PowerShell + Bash calls, 4 non-empty thinking blocks, `cost-state`, `queue-operation`, a 32-minute span with long pauses |
| `long-build.jsonl` | Building this repo's viewer (first 200 records) | Write/Edit/Read/Bash calls, 2 `is_error` results, `file-history-delta`, signature-only thinking |

## Redaction

Done with a one-off script that isn't committed, because it contains the real
values it searches for. It parses each line as JSON and rewrites only string
values (and keys), so every line is still valid JSON:

| Category | Replacement |
|---|---|
| OS username in paths (`C:\Users\<name>`, `/c/Users/<name>`, `c--Users-<name>-…` slugs) | `dev` |
| Personal name, email | `dev`/`devuser`, `dev@example.com` |
| Every UUID (session, message, org, temp-dir ids) | `00000000-0000-4000-8000-<n>`. The mapping is consistent, so `parentUuid` chains and `sessionId`s still line up |
| `organizationUuid`, `accountUuid`, `emailAddress` fields | `REDACTED` |
| Thinking-block `signature` | `REDACTED_SIGNATURE` |
| Hex strings of 32+ chars (request digests, hashes) | `REDACTED_HEX` |
| Base64-like runs of 60+ chars | `REDACTED_BLOB` |
| API keys / tokens (`sk-…`, `ghp_…`, `AKIA…`, `gsk_…`, `AIza…`, JWTs, `Bearer …`) | `REDACTED_KEY` (none were found) |
| YouTube `?si=` share-tracking params | `si=REDACTED` |
| Any string over 2,000 chars | cut, with `…[truncated N chars]` appended |

`../fixtures.test.ts` checks every fixture for leftovers: non-placeholder home
usernames, emails, un-remapped UUIDs, and key-shaped strings. If you add a
fixture, redact it the same way and make sure that test passes.
