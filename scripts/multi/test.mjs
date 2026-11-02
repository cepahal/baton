// pnpm test:multi — 1 team server + 6 simulated machines in docker compose.
// Asserts via the server API that all 6 sessions appear and that every event
// arrives exactly once and in order, then tears down (unless --keep).
import {
  check,
  expectedKinds,
  keepFlag,
  log,
  progress,
  report,
  waitForAll,
  waitForServer,
  withStack,
} from "./lib.mjs";

const expected = expectedKinds();

const code = await withStack({ keep: keepFlag }, async () => {
  await waitForServer();
  log("server up; waiting for all six sessions to finish streaming");
  await waitForAll(expected, { timeoutMs: 180_000 });
  // Give late duplicates (resends) a moment to show up if there are any.
  await new Promise((r) => setTimeout(r, 3000));
  const state = await progress();
  return report(check(state, expected), state, expected);
});
process.exit(code);
