import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = path.resolve(import.meta.dirname || __dirname);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts", "**/src/**/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: [
      // Subpath aliases MUST come before base package aliases for correct matching
      // Utils-node subpath aliases
      {
        find: "@statewalker/vcs-utils-node/compression",
        replacement: path.resolve(rootDir, "packages/vcs-utils-node/src/compression"),
      },
      {
        find: "@statewalker/vcs-utils-node/files",
        replacement: path.resolve(rootDir, "packages/vcs-utils-node/src/files"),
      },
      // Utils subpath aliases
      {
        find: "@statewalker/vcs-utils/compression",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/compression/compression"),
      },
      {
        find: "@statewalker/vcs-utils/hash/crc32",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/crc32"),
      },
      {
        find: "@statewalker/vcs-utils/hash/sha1",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/sha1"),
      },
      {
        find: "@statewalker/vcs-utils/hash/utils",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/utils"),
      },
      {
        find: "@statewalker/vcs-utils/hash/fossil-checksum",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/fossil-checksum"),
      },
      {
        find: "@statewalker/vcs-utils/hash/rolling-checksum",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/rolling-checksum"),
      },
      {
        find: "@statewalker/vcs-utils/hash/strong-checksum",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash/strong-checksum"),
      },
      {
        find: "@statewalker/vcs-utils/hash",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/hash"),
      },
      {
        find: "@statewalker/vcs-utils/diff",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/diff"),
      },
      {
        find: "@statewalker/vcs-utils/streams",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/streams"),
      },
      {
        find: "@statewalker/vcs-utils/cache",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src/cache"),
      },
      // Store-sql subpath aliases
      {
        find: "@statewalker/vcs-store-sql/adapters/sql-js",
        replacement: path.resolve(rootDir, "packages/vcs-store-sql/src/adapters/sql-js-adapter"),
      },
      // Core subpath aliases
      {
        find: "@statewalker/vcs-core/transformation",
        replacement: path.resolve(rootDir, "packages/vcs-core/src/workspace/transformation"),
      },
      // Base package aliases (must come after subpath aliases)
      {
        find: "@statewalker/vcs-commands",
        replacement: path.resolve(rootDir, "packages/vcs-commands/src"),
      },
      {
        find: "@statewalker/vcs-core",
        replacement: path.resolve(rootDir, "packages/vcs-core/src"),
      },
      {
        find: "@statewalker/vcs-store-kv",
        replacement: path.resolve(rootDir, "packages/vcs-store-kv/src"),
      },
      {
        find: "@statewalker/vcs-store-mem",
        replacement: path.resolve(rootDir, "packages/vcs-store-mem/src"),
      },
      {
        find: "@statewalker/vcs-store-files",
        replacement: path.resolve(rootDir, "packages/vcs-store-files/src"),
      },
      {
        find: "@statewalker/vcs-store-sql",
        replacement: path.resolve(rootDir, "packages/vcs-store-sql/src"),
      },
      {
        find: "@statewalker/vcs-testing",
        replacement: path.resolve(rootDir, "packages/vcs-testing/src"),
      },
      {
        find: "@statewalker/vcs-transport-adapters",
        replacement: path.resolve(rootDir, "packages/vcs-transport-adapters/src"),
      },
      {
        find: "@statewalker/vcs-transport",
        replacement: path.resolve(rootDir, "packages/vcs-transport/src"),
      },
      {
        find: "@statewalker/vcs-utils",
        replacement: path.resolve(rootDir, "packages/vcs-utils/src"),
      },
      {
        find: "@statewalker/vcs-utils-node",
        replacement: path.resolve(rootDir, "packages/vcs-utils-node/src"),
      },
    ],
  },
});
