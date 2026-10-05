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
      // vcs-utils(-node) have many subpath exports (`./files`, `./hash/sha1`,
      // `./compression`, …), each mapping `./X → dist/X`; resolve them (and the
      // bare entry) to src. The `-node` regex must precede the plain one.
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
        find: /^@statewalker\/vcs-transport$/,
        replacement: path.resolve(import.meta.dirname, "../vcs-transport/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-store-mem",
        replacement: path.resolve(import.meta.dirname, "../vcs-store-mem/src/index.ts"),
      },
    ],
  },
});
