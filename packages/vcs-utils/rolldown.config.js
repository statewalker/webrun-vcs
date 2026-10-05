import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "compression/index": "src/compression/index.ts",
    "hash/index": "src/hash/index.ts",
    "hash/crc32/index": "src/hash/crc32/index.ts",
    "hash/sha1/index": "src/hash/sha1/index.ts",
    "hash/utils/index": "src/hash/utils/index.ts",
    "hash/fossil-checksum/index": "src/hash/fossil-checksum/index.ts",
    "hash/rolling-checksum/index": "src/hash/rolling-checksum/index.ts",
    "hash/strong-checksum/index": "src/hash/strong-checksum/index.ts",
    "diff/index": "src/diff/index.ts",
    "encoding/index": "src/encoding/index.ts",
    "streams/index": "src/streams/index.ts",
    "ports/index": "src/ports/index.ts",
    "cache/index": "src/cache/index.ts",
    "files/index": "src/files/index.ts",
    "pack/index": "src/pack/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  treeshake: true,
});
