import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Force the deterministic hash-64 embedding oracle for tests, even when a dev
    // .env enables the managed embedder for `pnpm dev` (see vitest.setup.ts).
    setupFiles: ["./vitest.setup.ts"],
  },
});
