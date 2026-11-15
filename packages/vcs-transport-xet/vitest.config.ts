import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // the reference-xorb streaming test (H4) measures retained memory after forced collections
    execArgv: ["--expose-gc"],
  },
  resolve: {
    alias: [
      {
        find: "@statewalker/vcs-transport-lfs",
        replacement: path.resolve(import.meta.dirname, "../vcs-transport-lfs/src/index.ts"),
      },
    ],
  },
});
