import { beforeEach, describe, expect, it } from "vitest";
import { ChunkedRawStorage } from "../../../src/storage/chunked/chunked-raw-storage.js";
import { MemoryChunkAccess } from "../../../src/storage/chunked/memory-chunk-access.js";
import { rawStorageConformanceTests } from "../raw/raw-storage.conformance.test.js";

// Run conformance tests with different chunk sizes
describe("ChunkedRawStorage", () => {
  describe("with 1KB chunks", () => {
    let access: MemoryChunkAccess;

    rawStorageConformanceTests(
      "ChunkedRawStorage (1KB chunks)",
      async () => {
        access = new MemoryChunkAccess();
        return new ChunkedRawStorage(access, 1024);
      },
      async () => {
        access.clear();
      },
    );
  });

  describe("with 64 byte chunks (stress test)", () => {
    let access: MemoryChunkAccess;

    rawStorageConformanceTests(
      "ChunkedRawStorage (64B chunks)",
      async () => {
        access = new MemoryChunkAccess();
        return new ChunkedRawStorage(access, 64);
      },
      async () => {
        access.clear();
      },
    );
  });

  describe("chunking behavior", () => {
    let access: MemoryChunkAccess;
    let storage: ChunkedRawStorage;
    const CHUNK_SIZE = 100; // Small for testing

    beforeEach(() => {
      access = new MemoryChunkAccess();
      storage = new ChunkedRawStorage(access, CHUNK_SIZE);
    });

    it("stores small content in single chunk", async () => {
      const content = new Uint8Array(50).fill(1);
      await storage.store("small", toAsync([content]));

      expect(await access.getChunkCount("small")).toBe(1);
    });

    it("stores exactly chunk-sized content in single chunk", async () => {
      const content = new Uint8Array(CHUNK_SIZE).fill(1);
      await storage.store("exact", toAsync([content]));

      expect(await access.getChunkCount("exact")).toBe(1);
    });

    it("stores content larger than chunk size in multiple chunks", async () => {
      const content = new Uint8Array(CHUNK_SIZE * 3 + 50).fill(1);
      await storage.store("large", toAsync([content]));

      expect(await access.getChunkCount("large")).toBe(4);
    });

    it("handles streaming input with small chunks", async () => {
      // Stream 10 small chunks that together exceed chunk size
      const inputChunks = Array.from({ length: 10 }, (_, i) =>
        new Uint8Array(CHUNK_SIZE / 5).fill(i),
      );
      await storage.store("streamed", toAsync(inputChunks));

      // Should be stored in 2 chunks
      expect(await access.getChunkCount("streamed")).toBe(2);

      // Verify content
      const loaded = await collect(storage.load("streamed"));
      expect(loaded.length).toBe(CHUNK_SIZE * 2);
    });
  });

  describe("range queries across chunks", () => {
    let access: MemoryChunkAccess;
    let storage: ChunkedRawStorage;
    const CHUNK_SIZE = 10;

    beforeEach(async () => {
      access = new MemoryChunkAccess();
      storage = new ChunkedRawStorage(access, CHUNK_SIZE);

      // Store content: 0123456789 0123456789 0123456789 (30 bytes, 3 chunks)
      const content = new Uint8Array(30);
      for (let i = 0; i < 30; i++) {
        content[i] = i % 10;
      }
      await storage.store("test", toAsync([content]));
    });

    it("loads from start of first chunk", async () => {
      const data = await collect(storage.load("test", { start: 0, end: 5 }));
      expect(Array.from(data)).toEqual([0, 1, 2, 3, 4]);
    });

    it("loads from middle of single chunk", async () => {
      const data = await collect(storage.load("test", { start: 3, end: 7 }));
      expect(Array.from(data)).toEqual([3, 4, 5, 6]);
    });

    it("loads across chunk boundary", async () => {
      const data = await collect(storage.load("test", { start: 8, end: 13 }));
      expect(Array.from(data)).toEqual([8, 9, 0, 1, 2]);
    });

    it("loads across multiple chunks", async () => {
      const data = await collect(storage.load("test", { start: 5, end: 25 }));
      expect(data.length).toBe(20);
    });

    it("loads last bytes", async () => {
      const data = await collect(storage.load("test", { start: 25, end: 30 }));
      expect(Array.from(data)).toEqual([5, 6, 7, 8, 9]);
    });

    it("handles start at chunk boundary", async () => {
      const data = await collect(storage.load("test", { start: 10, end: 15 }));
      expect(Array.from(data)).toEqual([0, 1, 2, 3, 4]);
    });

    it("handles end at chunk boundary", async () => {
      const data = await collect(storage.load("test", { start: 5, end: 10 }));
      expect(Array.from(data)).toEqual([5, 6, 7, 8, 9]);
    });

    it("returns empty for zero-length range", async () => {
      const data = await collect(storage.load("test", { start: 5, end: 5 }));
      expect(data.length).toBe(0);
    });
  });

  describe("overwrite behavior", () => {
    let access: MemoryChunkAccess;
    let storage: ChunkedRawStorage;

    beforeEach(() => {
      access = new MemoryChunkAccess();
      storage = new ChunkedRawStorage(access, 100);
    });

    it("overwrites with smaller content", async () => {
      await storage.store("key", toAsync([new Uint8Array(500).fill(1)]));
      expect(await access.getChunkCount("key")).toBe(5);

      await storage.store("key", toAsync([new Uint8Array(50).fill(2)]));
      expect(await access.getChunkCount("key")).toBe(1);

      const data = await collect(storage.load("key"));
      expect(data.length).toBe(50);
      expect(data[0]).toBe(2);
    });

    it("overwrites with larger content", async () => {
      await storage.store("key", toAsync([new Uint8Array(50).fill(1)]));
      expect(await access.getChunkCount("key")).toBe(1);

      await storage.store("key", toAsync([new Uint8Array(500).fill(2)]));
      expect(await access.getChunkCount("key")).toBe(5);

      const data = await collect(storage.load("key"));
      expect(data.length).toBe(500);
    });
  });

  describe("error handling", () => {
    it("throws for non-positive chunk size", () => {
      const access = new MemoryChunkAccess();
      expect(() => new ChunkedRawStorage(access, 0)).toThrow();
      expect(() => new ChunkedRawStorage(access, -1)).toThrow();
    });

    it("throws for invalid start offset", async () => {
      const access = new MemoryChunkAccess();
      const storage = new ChunkedRawStorage(access, 100);
      await storage.store("key", toAsync([new Uint8Array(50)]));

      await expect(collect(storage.load("key", { start: -1 }))).rejects.toThrow();
      await expect(collect(storage.load("key", { start: 100 }))).rejects.toThrow();
    });

    it("throws for invalid end offset", async () => {
      const access = new MemoryChunkAccess();
      const storage = new ChunkedRawStorage(access, 100);
      await storage.store("key", toAsync([new Uint8Array(50)]));

      await expect(collect(storage.load("key", { start: 0, end: 100 }))).rejects.toThrow();
      await expect(collect(storage.load("key", { start: 30, end: 20 }))).rejects.toThrow();
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
