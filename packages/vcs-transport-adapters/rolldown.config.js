import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
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
