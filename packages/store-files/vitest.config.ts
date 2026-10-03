import path from "node:path";
import { defineConfig } from "vitest/config";


export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 10000,
  },
  resolve: {
    alias: [
      // vcs-utils(-node) expose many subpath exports; resolve them (and the bare
      // entry) to src. The `-node` regex must precede the plain one.
      {
        find: /^@statewalker\/vcs-utils-node\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../utils-node/src/$1/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils-node$/,
        replacement: path.resolve(import.meta.dirname, "../utils-node/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../utils/src/$1/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-utils$/,
        replacement: path.resolve(import.meta.dirname, "../utils/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-core$/,
        replacement: path.resolve(import.meta.dirname, "../core/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-working-tree\/transformation$/,
        replacement: path.resolve(import.meta.dirname, "../working-tree/src/transformation/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-working-tree$/,
        replacement: path.resolve(import.meta.dirname, "../working-tree/src/index.ts"),
      },
      {
        find: /^@statewalker\/vcs-store-files$/,
        replacement: path.resolve(import.meta.dirname, "src/index.ts"),
      },
    ],
  },
});
