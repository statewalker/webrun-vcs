import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests-bench/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 60000,
  },
});
