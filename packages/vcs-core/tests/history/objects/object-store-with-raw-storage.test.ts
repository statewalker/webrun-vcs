import { beforeEach, describe, expect, it } from "vitest";
import { createGitObjectStore } from "../../../src/history/objects/index.js";
import type { GitObjectStore } from "../../../src/history/objects/object-store.js";
import { ChunkedRawStorage } from "../../../src/storage/chunked/chunked-raw-storage.js";
import { MemoryChunkAccess } from "../../../src/storage/chunked/memory-chunk-access.js";
import { CompressedRawStorage } from "../../../src/storage/raw/compressed-raw-storage.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

describe("GitObjectStore with RawStorage backends", () => {
  describe("with MemoryRawStorage", () => {
    let store: GitObjectStore;
    let storage: MemoryRawStorage;

    beforeEach(() => {
      storage = new MemoryRawStorage();
      store = createGitObjectStore(storage);
    });

    it("stores and loads blob content", async () => {
      const content = new TextEncoder().encode("Hello, World!");
      const id = await store.store("blob", [content]);

      expect(id).toHaveLength(40); // SHA-1 hex

      const loaded = await collect(store.load(id));
      expect(new TextDecoder().decode(loaded)).toBe("Hello, World!");
    });

    it("stores and loads commit content", async () => {
      const content = new TextEncoder().encode(
        "tree 1234567890123456789012345678901234567890\n" +
          "author Test <test@example.com> 1234567890 +0000\n" +
          "committer Test <test@example.com> 1234567890 +0000\n\n" +
          "Test commit message",
      );
      const id = await store.store("commit", [content]);

      const [header] = await store.loadWithHeader(id);
      expect(header.type).toBe("commit");
      expect(header.size).toBe(content.length);
    });

    it("stores and loads tree content", async () => {
      // Simple tree entry: mode SP name NUL sha (20 bytes)
      const entry = new Uint8Array([
        ...new TextEncoder().encode("100644 file.txt\0"),
        ...new Uint8Array(20).fill(0xab),
      ]);
      const id = await store.store("tree", [entry]);

      const [header] = await store.loadWithHeader(id);
      expect(header.type).toBe("tree");
    });

    it("checks object existence with has()", async () => {
      const content = new TextEncoder().encode("test");
      const id = await store.store("blob", [content]);

      expect(await store.has(id)).toBe(true);
      expect(await store.has("0000000000000000000000000000000000000000")).toBe(false);
    });

    it("removes objects with remove()", async () => {
      const content = new TextEncoder().encode("to be deleted");
      const id = await store.store("blob", [content]);

      expect(await store.has(id)).toBe(true);
      expect(await store.remove(id)).toBe(true);
      expect(await store.has(id)).toBe(false);
      expect(await store.remove(id)).toBe(false); // Already deleted
    });

    it("lists all stored objects", async () => {
      const id1 = await store.store("blob", [new TextEncoder().encode("one")]);
      const id2 = await store.store("blob", [new TextEncoder().encode("two")]);
      const id3 = await store.store("blob", [new TextEncoder().encode("three")]);

      const ids = await collectIds(store.list());
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).toContain(id3);
    });

    it("getHeader returns object metadata without content", async () => {
      const content = new TextEncoder().encode("test content");
      const id = await store.store("blob", [content]);

      const header = await store.getHeader(id);
      expect(header.type).toBe("blob");
      expect(header.size).toBe(content.length);
    });

    it("loadRaw returns header and content", async () => {
      const content = new TextEncoder().encode("raw test");
      const id = await store.store("blob", [content]);

      const raw = await collect(store.loadRaw(id));
      const rawString = new TextDecoder().decode(raw);

      // Should start with "blob size\0"
      expect(rawString).toMatch(/^blob \d+\0/);
      expect(rawString).toContain("raw test");
    });
  });

  describe("with ChunkedRawStorage", () => {
    let store: GitObjectStore;
    let access: MemoryChunkAccess;

    beforeEach(() => {
      access = new MemoryChunkAccess();
      const storage = new ChunkedRawStorage(access, 1024); // 1KB chunks
      store = createGitObjectStore(storage);
    });

    it("stores and loads small blob", async () => {
      const content = new TextEncoder().encode("small");
      const id = await store.store("blob", [content]);

      const loaded = await collect(store.load(id));
      expect(new TextDecoder().decode(loaded)).toBe("small");
    });

    it("handles large blob spanning multiple chunks", async () => {
      // Create content larger than chunk size (1KB)
      const largeContent = new Uint8Array(5000);
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }
      const id = await store.store("blob", [largeContent]);

      const [header] = await store.loadWithHeader(id);
      expect(header.type).toBe("blob");
      expect(header.size).toBe(5000);

      const loaded = await collect(store.load(id));
      expect(loaded.length).toBe(5000);
      for (let i = 0; i < loaded.length; i++) {
        expect(loaded[i]).toBe(i % 256);
      }
    });

    it("stores streaming content correctly", async () => {
      // Stream multiple small chunks
      const chunks = [
        new TextEncoder().encode("chunk1"),
        new TextEncoder().encode("chunk2"),
        new TextEncoder().encode("chunk3"),
      ];
      const id = await store.store("blob", toAsync(chunks));

      const loaded = await collect(store.load(id));
      expect(new TextDecoder().decode(loaded)).toBe("chunk1chunk2chunk3");
    });

    it("removes objects stored across multiple chunks", async () => {
      const largeContent = new Uint8Array(3000).fill(42);
      const id = await store.store("blob", [largeContent]);

      expect(await store.has(id)).toBe(true);
      expect(await store.remove(id)).toBe(true);
      expect(await store.has(id)).toBe(false);
    });
  });

  describe("with compression enabled", () => {
    let store: GitObjectStore;
    let storage: MemoryRawStorage;

    beforeEach(() => {
      storage = new MemoryRawStorage();
      store = createGitObjectStore(new CompressedRawStorage(storage));
    });

    it("compresses content on store", async () => {
      // Highly compressible content
      const content = new Uint8Array(1000).fill(65); // All 'A's
      const id = await store.store("blob", [content]);

      // Verify compressed storage size is smaller
      const storedSize = await storage.size(id);
      expect(storedSize).toBeLessThan(1000);
    });

    it("decompresses content on load", async () => {
      const content = new TextEncoder().encode("compressed test");
      const id = await store.store("blob", [content]);

      const loaded = await collect(store.load(id));
      expect(new TextDecoder().decode(loaded)).toBe("compressed test");
    });

    it("handles getHeader correctly with compressed storage", async () => {
      const content = new TextEncoder().encode("header test");
      const id = await store.store("blob", [content]);

      const header = await store.getHeader(id);
      expect(header.type).toBe("blob");
      expect(header.size).toBe(content.length);
    });

    it("handles loadWithHeader correctly with compressed storage", async () => {
      const content = new TextEncoder().encode("load with header test");
      const id = await store.store("blob", [content]);

      const [header, contentStream] = await store.loadWithHeader(id);
      expect(header.type).toBe("blob");

      const loaded = await collect(contentStream);
      expect(new TextDecoder().decode(loaded)).toBe("load with header test");
    });
  });

  describe("integration: ChunkedRawStorage with compression", () => {
    let store: GitObjectStore;
    let access: MemoryChunkAccess;

    beforeEach(() => {
      access = new MemoryChunkAccess();
      const storage = new ChunkedRawStorage(access, 512); // Small chunks for testing
      store = createGitObjectStore(new CompressedRawStorage(storage));
    });

    it("handles large compressed content across chunks", async () => {
      // Large highly compressible content
      const largeContent = new Uint8Array(10000).fill(66); // All 'B's
      const id = await store.store("blob", [largeContent]);

      const [header] = await store.loadWithHeader(id);
      expect(header.type).toBe("blob");
      expect(header.size).toBe(10000);

      const loaded = await collect(store.load(id));
      expect(loaded.length).toBe(10000);
      expect(loaded[0]).toBe(66);
      expect(loaded[9999]).toBe(66);
    });
  });
});

// Test helpers
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function collectIds(iterable: AsyncIterable<string>): Promise<string[]> {
  const ids: string[] = [];
  for await (const id of iterable) {
    ids.push(id);
  }
  return ids;
}
