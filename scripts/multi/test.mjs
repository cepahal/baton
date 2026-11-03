// pnpm test:multi — 1 team server + 8 simulated machines (6 Claude Code, 2 Codex)
// in docker compose, plus one that shares nothing. Asserts via the server API that all 8 sessions
// appear and that every event arrives exactly once and in order; then the beta checks (nothing
// unshared arrives, legacy state survived the upgrade, version and name refusals). Tears down
// unless --keep.
import { betaChecks } from "./beta-checks.mjs";
import { FLEET } from "./fleet.mjs";
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
  log(`server up; waiting for all ${FLEET.length} sessions to finish streaming`);
  await waitForAll(expected, { timeoutMs: 180_000 });
  // Give late duplicates (resends) a moment to show up if there are any.
  await new Promise((r) => setTimeout(r, 3000));
  const state = await progress();
  const beta = await betaChecks();
  if (beta.length === 0) {
    log(
      "PASS: unshared machine sent nothing; 0.0.0 state kept; old daemon told to update; duplicate name refused; repo grouped",
    );
  }
  return report([...check(state, expected), ...beta], state, expected);
});
process.exit(code);
