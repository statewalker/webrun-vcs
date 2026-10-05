import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "compression/index": "src/compression/index.ts",
    "files/index": "src/files/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  treeshake: true,
  external: [
    "@statewalker/vcs-utils",
    "@statewalker/vcs-utils/compression",
    "@statewalker/webrun-files-node",
    /^node:/,
  ],
});
