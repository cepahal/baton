import { defineConfig } from "vitest/config";

// Test against @baton/core's TypeScript source (its "source" export condition),
// not a possibly stale or missing dist: `pnpm check` tests before it builds.
// The rest is Vite's default server conditions (vite isn't a daemon dependency).
const conditions = ["source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
