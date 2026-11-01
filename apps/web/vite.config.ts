import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to their TypeScript source (the "source" export condition).
    conditions: ["source", ...defaultClientConditions],
  },
  server: {
    // `pnpm dev`: the daemon serves the API and socket; Vite serves the app.
    proxy: {
      "/sessions": "http://127.0.0.1:7777",
      "/ws": { target: "ws://127.0.0.1:7777", ws: true },
    },
  },
});
