// pnpm test:chaos — the multi-machine test, with faults injected mid-stream:
//   - bob's daemon is killed with SIGKILL (its supervisor loop restarts it), and
//   - alice's machine is cut off the network for 30 s, and
//   - carol's machine is paused for 30 s (a laptop lid closed: every process
//     frozen, sockets left open but silent), then resumed.
// Replays run slower here so the faults land while sessions are still live.
// Afterwards it checks that no event was lost or duplicated.
import { PROJECT } from "./fleet.mjs";
import {
  check,
  compose,
  expectedKinds,
  keepFlag,
  log,
  progress,
  report,
  run,
  sleep,
  waitForAll,
  waitForServer,
  withStack,
} from "./lib.mjs";

const KILL = "bob";
const CUT = "alice";
const SLEEP = "carol";
const OUTAGE_MS = 30_000;
const env = { BATON_TEST_SPEED: "2", BATON_TEST_MAX_GAP: "5" };

const expected = expectedKinds();
const want = (name) => expected.get(name)?.length ?? 0;
const have = async (name) => (await progress()).perMachine.get(name)?.length ?? 0;

/** Waits until `name` has delivered at least `fraction` of its session. */
async function waitForShare(name, fraction) {
  for (;;) {
    const n = await have(name);
    if (n >= want(name) * fraction) return n;
    await sleep(500);
  }
}

const replayDone = async (name) =>
  (await compose(["exec", "-T", name, "sh", "-c", "test -f /data/replay.done && echo yes"], {
    quiet: true,
    allowFail: true,
  })) === "yes";

async function killDaemon() {
  const before = await waitForShare(KILL, 0.2);
  const pid = await compose(["exec", "-T", KILL, "cat", "/data/daemon.pid"], { quiet: true });
  log(`${KILL}: ${before}/${want(KILL)} events in; kill -9 daemon pid ${pid}`);
  await compose(["exec", "-T", KILL, "sh", "-c", `kill -9 ${pid}`], { quiet: true });
  if (await replayDone(KILL)) throw new Error(`${KILL}'s replay finished before the kill`);
  for (;;) {
    await sleep(500);
    const now = await compose(["exec", "-T", KILL, "cat", "/data/daemon.pid"], {
      quiet: true,
      allowFail: true,
    });
    if (now && now !== pid) {
      log(`${KILL}: daemon restarted as pid ${now}`);
      return;
    }
  }
}

async function cutNetwork() {
  const before = await waitForShare(CUT, 0.15);
  const container = await compose(["ps", "-q", CUT], { quiet: true });
  const network = `${PROJECT}_default`;
  log(`${CUT}: ${before}/${want(CUT)} events in; disconnecting from ${network} for 30s`);
  await run("docker", ["network", "disconnect", network, container], { quiet: true });
  const start = Date.now();
  await sleep(5000);
  const frozen = await have(CUT);
  await sleep(OUTAGE_MS - (Date.now() - start));
  const during = await have(CUT);
  if (during !== frozen) {
    throw new Error(`${CUT} kept delivering while disconnected (${frozen} → ${during})`);
  }
  if (await replayDone(CUT)) log(`${CUT}: replay finished during the outage (all of it queued)`);
  await run("docker", ["network", "connect", network, container], { quiet: true });
  log(`${CUT}: reconnected after ${Math.round((Date.now() - start) / 1000)}s at ${during} events`);
  for (;;) {
    await sleep(500);
    const n = await have(CUT);
    if (n > during || n >= want(CUT)) {
      log(`${CUT}: delivering again (${n} events)`);
      return;
    }
  }
}

async function sleepMachine() {
  const before = await waitForShare(SLEEP, 0.25);
  log(`${SLEEP}: ${before}/${want(SLEEP)} events in; pausing the machine for 30s (lid closed)`);
  await compose(["pause", SLEEP], { quiet: true });
  const start = Date.now();
  try {
    await sleep(5000);
    const frozen = await have(SLEEP);
    await sleep(OUTAGE_MS - (Date.now() - start));
    const during = await have(SLEEP);
    if (during !== frozen) {
      throw new Error(`${SLEEP} kept delivering while paused (${frozen} → ${during})`);
    }
  } finally {
    await compose(["unpause", SLEEP], { quiet: true, allowFail: true });
  }
  const at = await have(SLEEP);
  log(`${SLEEP}: woke after ${Math.round((Date.now() - start) / 1000)}s at ${at} events`);
  for (;;) {
    await sleep(500);
    const n = await have(SLEEP);
    if (n > at || n >= want(SLEEP)) {
      log(`${SLEEP}: delivering again (${n} events)`);
      return;
    }
  }
}

const code = await withStack({ env, keep: keepFlag }, async () => {
  await waitForServer();
  log(
    `server up; faults: kill ${KILL}'s daemon, cut ${CUT} off and put ${SLEEP} to sleep for ${OUTAGE_MS / 1000}s`,
  );
  await Promise.all([killDaemon(), cutNetwork(), sleepMachine()]);
  log("faults over; waiting for every session to finish");
  await waitForAll(expected, { timeoutMs: 300_000 });
  await sleep(3000);
  const state = await progress();
  return report(check(state, expected), state, expected);
});
process.exit(code);
