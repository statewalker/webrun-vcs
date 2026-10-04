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
      // The moved tests import `@statewalker/vcs-core`; core's dist isn't built,
      // so resolve it to core's src entrypoint (which in turn imports
      // vcs-utils/storage/webrun-files — hence the aliases below).
      {
        find: /^@statewalker\/vcs-core$/,
        replacement: path.resolve(import.meta.dirname, "../core/src/index.ts"),
      },
      {
        find: "@statewalker/vcs-store-mem",
        replacement: path.resolve(import.meta.dirname, "../store-mem/src/index.ts"),
      },
    ],
  },
});
