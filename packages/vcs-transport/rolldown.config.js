import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "protocol/index": "src/protocol/index.ts",
    "operations/index": "src/operations/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  external: [
    /^@statewalker\/vcs-core/,
    /^@statewalker\/vcs-utils/,
    /^@statewalker\/webrun-http-streams/,
    /^@statewalker\/webrun-streams/,
  ],
  treeshake: true,
});
