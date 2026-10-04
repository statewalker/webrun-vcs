import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "history/index": "src/history/index.ts",
    "storage/index": "src/storage/index.ts",
    "backend/index": "src/backend/index.ts",
    "serialization/index": "src/serialization/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  external: [/^@statewalker\/vcs-utils/],
  treeshake: true,
});
