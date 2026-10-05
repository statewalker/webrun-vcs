import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "staging/index": "src/staging/index.ts",
    "transformation/index": "src/transformation/index.ts",
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
  ],
  treeshake: true,
});
