import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: [
      "lib/**/*.test.ts",
      "workers/**/*.test.ts",
      "scripts/**/*.test.mts",
      "messages/**/*.test.ts",
      "components/**/*.test.ts",
    ],
    // Integration suites (real Mongo/Redis) opt in via AI_INTEGRATION=1 and
    // guard themselves with `describe.skipIf` — no separate config needed.
    environment: "node",
    clearMocks: true,
    // Runs inside each worker process: loads .env.local so integration tests
    // see the same configuration as the app and the workers.
    setupFiles: ["./vitest.setup.mts"],
  },
});
