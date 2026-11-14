import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests-bench/**/*.test.ts"],
    environment: "node",
    testTimeout: 300000,
    pool: "forks",
    // The memory benchmark forces full collections to sample live memory.
    execArgv: ["--expose-gc"],
  },
});
