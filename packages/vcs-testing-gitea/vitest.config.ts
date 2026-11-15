import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 180_000,
    // Starting Gitea (and downloading it once) takes far longer than a unit test.
    hookTimeout: 600_000,
  },
});
