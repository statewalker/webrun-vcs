import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeFilesApi, NodeFilesApi } from "../src/files/index.js";

describe("Node.js Files API", () => {
  describe("createNodeFilesApi", () => {
    it("should create a FilesApi instance", () => {
      const files = createNodeFilesApi({ rootDir: tmpdir() });
      expect(files).toBeDefined();
      expect(files.read).toBeDefined();
      expect(files.write).toBeDefined();
      expect(files.list).toBeDefined();
    });
  });

  describe("NodeFilesApi export", () => {
    it("should export NodeFilesApi class", () => {
      expect(NodeFilesApi).toBeDefined();
      expect(typeof NodeFilesApi).toBe("function");
    });
  });
});

describe("createNodeFilesApi: streaming write", () => {
  it("writes each chunk as it arrives, not after the whole stream", async () => {
    const { mkdtempSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createNodeFilesApi } = await import("../src/files/index.js");
    const dir = mkdtempSync(join(tmpdir(), "stream-write-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      const seen: number[] = [];
      async function* chunks() {
        for (let i = 0; i < 4; i++) {
          if (i > 0) seen.push(statSync(join(dir, "a/b.bin")).size);
          yield new Uint8Array(1024).fill(i);
        }
      }
      await files.write("a/b.bin", chunks());
      expect(seen).toEqual([1024, 2048, 3072]); // on disk before the stream ended
      expect(statSync(join(dir, "a/b.bin")).size).toBe(4096);
      await files.write("a/b.bin", [new Uint8Array(10)]);
      expect(statSync(join(dir, "a/b.bin")).size).toBe(10); // replaced, not appended
      await files.write("../escape", [new Uint8Array(1)]); // clamped to the root
      expect(statSync(join(dir, "escape")).size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
