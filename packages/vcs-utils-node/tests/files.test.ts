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
    const { mkdtempSync, readdirSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createNodeFilesApi } = await import("../src/files/index.js");
    const dir = mkdtempSync(join(tmpdir(), "stream-write-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      const seen: number[] = [];
      const onDisk = () => {
        const tmp = readdirSync(join(dir, "a")).find((n) => n.startsWith(".b.bin."));
        return tmp ? statSync(join(dir, "a", tmp)).size : 0;
      };
      async function* chunks() {
        for (let i = 0; i < 4; i++) {
          if (i > 0) seen.push(onDisk());
          yield new Uint8Array(64 * 1024).fill(i);
        }
      }
      await files.write("a/b.bin", chunks());
      // each 64 KiB chunk was on disk (in the temporary) before the next was pulled
      expect(seen).toEqual([65536, 131072, 196608]);
      expect(statSync(join(dir, "a/b.bin")).size).toBe(4 * 65536);
      await files.write("a/b.bin", [new Uint8Array(10)]);
      expect(statSync(join(dir, "a/b.bin")).size).toBe(10); // replaced, not appended
      await expect(files.write("../escape", [new Uint8Array(1)])).rejects.toThrow(/outside/);
      await expect(files.write("a/../../x", [new Uint8Array(1)])).rejects.toThrow(/outside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createNodeFilesApi: write keeps the old file until the new one is complete", () => {
  it("a failing source leaves the old content; a file can be rewritten from its own read", async () => {
    const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createNodeFilesApi } = await import("../src/files/index.js");
    const dir = mkdtempSync(join(tmpdir(), "stream-keep-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      await files.write("f.txt", [new TextEncoder().encode("ORIGINAL")]);
      async function* failing() {
        yield new TextEncoder().encode("A");
        throw new Error("source failed");
      }
      await expect(files.write("f.txt", failing())).rejects.toThrow("source failed");
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("ORIGINAL");
      await files.write("f.txt", files.read("f.txt"));
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("ORIGINAL");
      expect(readdirSync(dir)).toEqual(["f.txt"]); // no temporaries left
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
