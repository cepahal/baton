/** The simulated machines in docker-compose.test.yml: compose service = daemon name. */
export const FLEET = [
  { name: "alice", fixture: "heavy-tools.jsonl" },
  { name: "bob", fixture: "api-requests.jsonl" },
  { name: "carol", fixture: "mixed.jsonl" },
  { name: "dave", fixture: "code-review.jsonl" },
  { name: "erin", fixture: "install-debug.jsonl" },
  { name: "frank", fixture: "long-build.jsonl" },
  { name: "grace", fixture: "codex/speech-tool.rollout.jsonl", agent: "codex" },
  { name: "heidi", fixture: "codex/forked-frontend.rollout.jsonl", agent: "codex" },
].map((m) => ({ agent: "claude-code", ...m }));

export const PROJECT = "baton-test";
export const COMPOSE_FILE = "docker-compose.test.yml";
export const TOKEN = process.env.BATON_TOKEN ?? "baton-multi-machine-test-token";
export const PORT = Number(process.env.BATON_TEST_PORT ?? 17777);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
