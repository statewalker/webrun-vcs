import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
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
  ],
  treeshake: true,
});
