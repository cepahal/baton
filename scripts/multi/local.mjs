// pnpm demo — eight simulated teammates (six Claude Code, two Codex) on this
// machine, no Docker, no Claude, no Codex.
//
// Starts `baton serve`, then for each of alice … heidi: its own fake projects
// and Codex sessions dirs, a `baton start --server … --name <name>` daemon watching it, and a
// `baton replay` writing a fixture into it at the recorded pace. Partway
// through, bob's daemon is killed and restarted (a reconnect with a resend).
// When every session is complete it checks that each event arrived exactly
// once and in order. With --keep it then stays up (Ctrl+C to stop) so you can
// keep browsing the viewer.
//
//   pnpm demo [--speed 10x] [--max-gap 8] [--port 17778] [--keep] [--no-kill]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    speed: { type: "string", default: "10x" },
    "max-gap": { type: "string", default: "8" },
    port: { type: "string", default: "17778" },
    keep: { type: "boolean", default: false },
    "no-kill": { type: "boolean", default: false },
  },
});
process.env.BATON_TEST_PORT = args.port;

// lib.mjs reads the port from the environment when it loads.
const { FLEET, TOKEN, BASE_URL } = await import("./fleet.mjs");
const { check, expectedKinds, log, progress, report, sleep, waitForAll, waitForServer } =
  await import("./lib.mjs");

const ROOT = join(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/daemon/dist/index.js");
const FIXTURES = join(ROOT, "packages/core/test/fixtures");
const KILL = "bob";

const work = mkdtempSync(join(tmpdir(), "baton-demo-"));
const children = new Set();

function baton(label, argv, env = {}) {
  const out = openSync(join(work, `${label}.log`), "a");
  const child = spawn(process.execPath, [CLI, ...argv], {
    env: { ...process.env, BATON_TOKEN: TOKEN, ...env },
    stdio: ["ignore", out, out],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function daemon(m) {
  const dir = join(work, m.name);
  return baton(`${m.name}-daemon`, [
    "start",
    "--server",
    `ws://127.0.0.1:${args.port}`,
    "--name",
    m.name,
    "--projects-dir",
    join(dir, "projects"),
    "--codex-dir",
    join(dir, "codex"),
    "--state-file",
    join(dir, "state.json"),
    "--queue-dir",
    join(dir, "queue"),
    "--log-level",
    "warn",
  ]);
}

function replay(m) {
  return baton(`${m.name}-replay`, [
    "replay",
    join(FIXTURES, m.fixture),
    "--projects-dir",
    join(work, m.name, "projects"),
    "--codex-dir",
    join(work, m.name, "codex"),
    "--speed",
    args.speed,
    "--max-gap",
    args["max-gap"],
    "--as",
    m.name,
    "--seed",
    `${m.name}-${Date.now()}`,
    "--log-level",
    "warn",
  ]);
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      log(`left ${work} behind (files still in use)`);
    }
    process.exit(code);
  }, 500);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

log(`work dir ${work}`);
baton("server", ["serve", "--host", "127.0.0.1", "--port", args.port, "--log-level", "warn"]);
await waitForServer();
log(`viewer: ${BASE_URL}/?token=${TOKEN}`);

const daemons = new Map();
for (const m of FLEET) {
  mkdirSync(join(work, m.name, "projects"), { recursive: true });
  mkdirSync(join(work, m.name, "codex"), { recursive: true });
  daemons.set(m.name, daemon(m));
}
await sleep(1500); // let the watchers start before the transcripts appear
for (const m of FLEET) replay(m);
log(`${FLEET.length} replays running at ${args.speed} (pauses capped at ${args["max-gap"]}s)`);

const expected = expectedKinds();

async function killAndRestart() {
  const want = expected.get(KILL)?.length ?? 0;
  for (;;) {
    const have = (await progress()).perMachine.get(KILL)?.length ?? 0;
    if (have >= want * 0.3) break;
    await sleep(500);
  }
  log(`${KILL}: killing its daemon mid-stream, restarting in 10s`);
  daemons.get(KILL)?.kill("SIGKILL");
  await sleep(10_000);
  const m = FLEET.find((f) => f.name === KILL);
  if (m) daemons.set(KILL, daemon(m));
  log(`${KILL}: daemon restarted`);
}

const fault = args["no-kill"] ? Promise.resolve() : killAndRestart();
await waitForAll(expected, { timeoutMs: 30 * 60_000 });
await fault;
await sleep(3000);
const state = await progress();
const code = report(check(state, expected), state, expected);

if (args.keep) {
  log(`still serving ${BASE_URL}/?token=${TOKEN} — Ctrl+C to stop`);
} else {
  stop(code);
}
