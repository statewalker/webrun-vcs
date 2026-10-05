import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "commands/index": "src/commands/index.ts",
    "errors/index": "src/errors/index.ts",
    "results/index": "src/results/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  external: [/^@statewalker\//],
  treeshake: true,
});
