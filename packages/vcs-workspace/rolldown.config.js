import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "net/index": "src/net/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  external: [
    "@statewalker/webrun-files-sync",
    /^@statewalker\/files-sync\//,
    "@statewalker/webrun-content-store",
    "@statewalker/webrun-files",
    /^@statewalker\/webrun-files\//,
    /^@statewalker\/vcs-core(\/.*)?$/,
    /^@statewalker\/vcs-transport(\/.*)?$/,
    /^@statewalker\/vcs-utils(\/.*)?$/,
    /^@statewalker\/vcs-working-tree(\/.*)?$/,
  ],
  treeshake: true,
});
