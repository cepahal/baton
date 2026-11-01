import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to their TypeScript source (the "source" export condition).
    conditions: ["source", ...defaultClientConditions],
  },
});
