import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 30000,
  },
  resolve: {
    alias: [
      // vcs-utils(-node) expose many subpath exports; resolve them (and the bare
      // entry) to src. The `-node` regex must precede the plain one.
      {
        find: /^@statewalker\/vcs-utils-node\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-utils-node/src/$1/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils-node$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-utils-node/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-utils/src/$1/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-utils/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-core$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-core/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-working-tree$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-working-tree/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-commands",
        replacement: path.resolve(import.meta.dirname, "../vcs-commands/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-store-files",
        replacement: path.resolve(import.meta.dirname, "../vcs-store-files/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-store-mem",
        replacement: path.resolve(import.meta.dirname, "../vcs-store-mem/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-store-sql/adapters/sql-js",
        replacement: path.resolve(
          import.meta.dirname,
          "../vcs-store-sql/src/adapters/sql-js-adapter.ts",
        ),
      },
      {
        find: "@statewalker/vcs-store-sql",
        replacement: path.resolve(import.meta.dirname, "../vcs-store-sql/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-transport",
        replacement: path.resolve(import.meta.dirname, "../vcs-transport/src/index.ts"),
      },
    ],
  },
});
