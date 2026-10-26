import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "modules/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Windows CI runners are slow to start processes and git; a short timeout there produces cascades of false failures.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    // Tests and every process they start must never read or write the real ~/.openagent.
    env: { OPENAGENT_HOME: path.join(os.tmpdir(), `openagent-test-home-${process.pid}`) },
    setupFiles: ["packages/testkit/src/hermetic.ts"],
  },
});
