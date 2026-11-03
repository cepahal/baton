import { defineConfig, devices } from "@playwright/test";

/**
 * `pnpm test:e2e` brings the Docker stack up (scripts/multi/e2e.mjs) and runs
 * these against it. To run them against a stack you started yourself with
 * `node scripts/multi/e2e.mjs --keep`: `pnpm --filter @baton/e2e exec playwright test`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../.e2e-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${process.env.BATON_TEST_PORT ?? "17777"}`,
    trace: "retain-on-failure",
    viewport: { width: 1600, height: 1000 },
  },
});
