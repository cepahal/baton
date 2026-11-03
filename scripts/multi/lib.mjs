// Shared pieces of the multi-machine tests: driving docker compose, reading the
// team server's API, and checking that every event arrived exactly once and in
// order. Needs the built core package (`pnpm build`), for the parser and the
// wire schemas.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventsResponse, parseSession, SessionsResponse } from "../../packages/core/dist/index.js";
import { BASE_URL, COMPOSE_FILE, FLEET, PRIVATE_MACHINE, PROJECT, TOKEN } from "./fleet.mjs";

const ROOT = join(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "packages/core/test/fixtures");

export const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command, streaming its output unless `quiet`; resolves with stdout. */
export function run(cmd, args, { quiet = false, env = {}, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (!quiet) process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFail) resolve(out.trim());
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}\n${err.trim()}`));
    });
  });
}

export const compose = (args, options) =>
  run("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], options);

/** Brings the stack up, runs `body`, and always tears it down unless `keep`. */
export async function withStack(
  { env = {}, keep = false, machines = FLEET.map((m) => m.name) },
  body,
) {
  log(`building and starting 1 server + ${machines.length + 1} machines (1 shares nothing)`);
  try {
    await compose(["up", "-d", "--build", "--wait", "server"], { env, quiet: true });
    await compose(["up", "-d", ...machines, PRIVATE_MACHINE], { env, quiet: true });
    return await body();
  } catch (error) {
    log("failed; last server and machine logs:");
    await compose(["logs", "--tail", "40"], { allowFail: true });
    throw error;
  } finally {
    if (keep) {
      log(`left running (--keep). Viewer: ${BASE_URL}/?token=${TOKEN}`);
      log(`tear down with: docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`);
    } else {
      log("tearing down");
      await compose(["down", "-v", "--remove-orphans"], { quiet: true, allowFail: true });
    }
  }
}

export async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function sessions() {
  return SessionsResponse.parse(await api("/sessions")).sessions;
}

/** Every event the server holds, in hub order, read page by page. */
export async function allEvents() {
  const out = [];
  let after = 0;
  let first;
  for (;;) {
    const page = EventsResponse.parse(await api(`/events?after=${after}&limit=5000`));
    first ??= page.firstSeq;
    out.push(...page.events);
    if (page.events.length === 0 || after >= page.lastSeq) return { firstSeq: first, events: out };
    after = page.events.at(-1)?.seq ?? page.lastSeq;
    if (after >= page.lastSeq) return { firstSeq: first, events: out };
  }
}

/** What the parser makes of each fixture: the event kinds a replay must deliver, in order. */
export function expectedKinds() {
  return new Map(
    FLEET.map((m) => {
      const { events } = parseSession(m.agent, readFileSync(join(FIXTURES, m.fixture), "utf8"));
      return [m.name, events.map((e) => e.kind)];
    }),
  );
}

/** Events per machine, by the daemon name the server recorded for each session. */
export async function progress() {
  const bySession = new Map((await sessions()).map((s) => [s.sessionId, s]));
  const { firstSeq, events } = await allEvents();
  const perMachine = new Map(FLEET.map((m) => [m.name, []]));
  const strays = [];
  for (const msg of events) {
    const source = bySession.get(msg.event.sessionId)?.source;
    const list = source === undefined ? undefined : perMachine.get(source);
    if (list) list.push(msg);
    else strays.push(msg);
  }
  return { firstSeq, events, perMachine, strays, sessions: [...bySession.values()] };
}

/**
 * Checks the server's view against the fixtures. Returns problems as strings;
 * none means every machine's session is there and every event arrived exactly
 * once, in order.
 */
export function check(state, expected) {
  const problems = [];
  const { firstSeq, events, perMachine, strays, sessions: list } = state;

  for (const m of FLEET) {
    const own = list.filter((s) => s.source === m.name);
    if (own.length !== 1) problems.push(`${m.name}: ${own.length} sessions, expected 1`);
    for (const s of own) {
      if (s.agent !== m.agent) problems.push(`${m.name}: agent ${s.agent}, expected ${m.agent}`);
    }
  }
  if (list.length !== FLEET.length)
    problems.push(`${list.length} sessions, expected ${FLEET.length}`);
  if (strays.length) problems.push(`${strays.length} events from sessions with no known machine`);

  // Hub order: seqs 1..n with no holes means nothing was evicted or skipped.
  if (firstSeq > 1) problems.push(`server evicted events (firstSeq ${firstSeq})`);
  events.forEach((msg, i) => {
    if (msg.seq !== i + 1 && problems.length < 20)
      problems.push(`hub seq ${msg.seq} at position ${i + 1}`);
  });
  // Ids are unique per session; forked Codex threads repeat item ids across sessions.
  const ids = events.map((m) => `${m.event.sessionId} ${m.event.id}`);
  const dupes = ids.length - new Set(ids).size;
  if (dupes) problems.push(`${dupes} duplicate event ids`);

  // Per machine: the parser's seqs 0..n-1, in order, with the fixture's kinds.
  for (const m of FLEET) {
    const got = perMachine.get(m.name) ?? [];
    const want = expected.get(m.name) ?? [];
    if (got.length !== want.length) {
      problems.push(`${m.name}: ${got.length} events, expected ${want.length}`);
    }
    const n = Math.min(got.length, want.length);
    for (let i = 0; i < n; i++) {
      const e = got[i]?.event;
      if (e?.seq !== i || e.kind !== want[i]) {
        problems.push(`${m.name}: event ${i} is #${e?.seq} ${e?.kind}, expected #${i} ${want[i]}`);
        break;
      }
    }
  }
  return problems;
}

export const done = (state, expected) =>
  FLEET.every(
    (m) => (state.perMachine.get(m.name)?.length ?? 0) >= (expected.get(m.name)?.length ?? 0),
  );

export function counts(state, expected) {
  return FLEET.map(
    (m) => `${m.name} ${state.perMachine.get(m.name)?.length ?? 0}/${expected.get(m.name)?.length}`,
  ).join("  ");
}

/** Polls the server until every machine has delivered its whole session, or times out. */
export async function waitForAll(expected, { timeoutMs, everyMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const state = await progress();
    const line = counts(state, expected);
    if (line !== last) log(line);
    last = line;
    if (done(state, expected)) return state;
    if (Date.now() > deadline) return state;
    await sleep(everyMs);
  }
}

/** Waits until the server responds, the stack being up. */
export async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`no answer from ${BASE_URL}/health`);
    await sleep(500);
  }
}

/** Prints the verdict and returns the exit code. */
export function report(problems, state, expected) {
  const total = FLEET.reduce((n, m) => n + (expected.get(m.name)?.length ?? 0), 0);
  if (problems.length === 0) {
    log(
      `PASS: ${FLEET.length} sessions, ${state.events.length}/${total} events, each exactly once, in order`,
    );
    return 0;
  }
  log(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) log(`  - ${p}`);
  return 1;
}

export const keepFlag = process.argv.includes("--keep");
