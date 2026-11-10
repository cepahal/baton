// pnpm test:e2e — the viewer end to end, in Chromium, against the Docker stack:
// a team server, three sharing machines (alice and bob in one repo, grace on
// Codex in another) and one that shares nothing. Replays run slowly so bob is still
// streaming when the last test drops his daemon. Tears down unless --keep.
//
// Needs Docker, and Playwright's Chromium once: pnpm --filter @baton/e2e exec playwright install chromium
import { spawn } from "node:child_process";
import { join } from "node:path";
import { keepFlag, log, waitForServer, withStack } from "./lib.mjs";

const ROOT = join(import.meta.dirname, "../..");
const env = { BATON_TEST_SPEED: process.env.BATON_TEST_SPEED ?? "3", BATON_TEST_MAX_GAP: "3" };

function playwright() {
  const extra = process.argv.slice(2).filter((a) => a !== "--keep");
  return new Promise((resolve) => {
    // One command string: on Windows pnpm is a .cmd, which needs a shell.
    const child = spawn(["pnpm --filter @baton/e2e exec playwright test", ...extra].join(" "), {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const code = await withStack(
  { env, keep: keepFlag, machines: ["alice", "bob", "grace"] },
  async () => {
    await waitForServer();
    log("server up; running Playwright");
    return playwright();
  },
);
process.exit(code);
