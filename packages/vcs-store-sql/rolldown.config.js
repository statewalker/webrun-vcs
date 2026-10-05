import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "adapters/sql-js-adapter": "src/adapters/sql-js-adapter.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  external: [
    "@statewalker/vcs-core",
    /^@statewalker\/vcs-core\//,
    "@statewalker/vcs-utils",
    /^@statewalker\/vcs-utils\//,
    "@statewalker/vcs-working-tree",
    /^@statewalker\/vcs-working-tree\//,
    "sql.js",
  ],
  treeshake: true,
});
