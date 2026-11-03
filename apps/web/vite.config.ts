import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import { z } from "zod";

// `pnpm dev` proxies to the daemon on BATON_PORT (same default as `baton start`).
const port = z.coerce.number().int().min(1).max(65535).default(7777).parse(process.env.BATON_PORT);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to their TypeScript source (the "source" export condition).
    conditions: ["source", ...defaultClientConditions],
  },
  server: {
    // `pnpm dev`: the daemon serves the API and socket; Vite serves the app.
    proxy: {
      "/sessions": `http://127.0.0.1:${port}`,
      "/canvas": `http://127.0.0.1:${port}`,
      "/handoffs": `http://127.0.0.1:${port}`,
      "/inbox": `http://127.0.0.1:${port}`,
      "/ws": { target: `ws://127.0.0.1:${port}`, ws: true },
    },
  },
});
