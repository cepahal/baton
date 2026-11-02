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

## Codex fixtures (`codex/`)

Two Codex Desktop sessions (Codex `0.162.0-alpha`), each as a pair of files.
See "Codex fixtures" in [docs/spec.md](../../../../docs/spec.md) for how they
are used. They live in a subfolder so the replay tools, which load every
top-level `*.jsonl` as a Claude transcript, don't pick them up.

| File | What it is |
|---|---|
| `<name>.rollout.jsonl` | 200 consecutive records of a `~/.codex/sessions/**/rollout-*.jsonl.zst` rollout, decompressed. The parser input. |
| `raw-bytes.json` | Each rollout fixture's size **before** redaction (UTF-8 bytes of the same 200 records). The >90% size test measures Codex against this, because redaction blanks `encrypted_content` and cuts long tool output, roughly halving the raw side. Update it whenever a Codex fixture is re-cut. |
| `<name>.thread-items.jsonl` | The `thread_items` rows from `~/.codex/thread_history_1.sqlite` (opened read-only) whose `rollout_ordinal` falls in the same range, one row per line as JSON, `item_json` kept as a string. One row per `item_completed` item in the rollout; `fixtures.test.ts` checks the ids match. |

| Session | Ordinals | What it exercises |
|---|---|---|
| `speech-tool` | 0–199 (start of the thread) | `session_meta`, a pasted-file prompt, 22 `exec` custom tool calls (duplicated as 9 `CommandExecution` + 13 `FileChange` items), a `wait` function call, signature-only reasoning, `token_count` / `token_usage_record` noise, developer-role instruction messages |
| `forked-frontend` | 3748–3947 (mid-thread) | A continuation segment (`rollout-<time>-<thread>_<segment>.jsonl`) whose `session_meta` repeats the parent thread id and has a `history_base`; reasoning with `summary_text`, `compacted` + `ContextCompaction`, 17 `CommandExecution`, 2 `ImageView`, an `McpToolCall`, `thread_settings_applied`. Its `thread_items` rows are keyed by the segment id, not the thread id. |

Codex redaction follows the table above, plus:

| Category | Replacement |
|---|---|
| `encrypted_content` (reasoning) | `REDACTED_BLOB` |
| `creator_user_id`, `creator_account_id`, account/org ids, git origin URLs | `REDACTED` |
| `user-…` account ids | `user-REDACTED` |
| Hex strings of 32+ chars | `REDACTED_HEX_<n>`, numbered consistently so `call_id`s still pair up |
| Machine hostname | `HOST` |
