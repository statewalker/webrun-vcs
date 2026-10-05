/**
 * T4.4: Memory Backend Isolation Tests
 *
 * Tests that verify memory backend instances are properly isolated:
 * - Separate instances have separate data
 * - Clearing one instance does not affect others
 * - Memory cleanup patterns work correctly
 * - Lifecycle management (initialize/close)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ChunkedRawStorage } from "../../src/storage/chunked/chunked-raw-storage.js";
import { MemoryChunkAccess } from "../../src/storage/chunked/memory-chunk-access.js";
import { MemoryRawStorage } from "../../src/storage/raw/memory-raw-storage.js";

// Helper to convert string to async iterable
async function* toAsyncIterable(data: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(data);
}

// Helper to collect async iterable to string
async function collectToString(iterable: AsyncIterable<Uint8Array>): Promise<string> {
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
  return new TextDecoder().decode(result);
}

describe("Memory Backend Isolation", () => {
  describe("MemoryRawStorage isolation", () => {
    it("separate instances have separate data", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("key1", toAsyncIterable("Only in storage1"));

      expect(await storage1.has("key1")).toBe(true);
      expect(await storage2.has("key1")).toBe(false);
    });

    it("storing same key in both instances keeps separate data", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("shared-key", toAsyncIterable("data in storage1"));
      await storage2.store("shared-key", toAsyncIterable("data in storage2"));

      const data1 = await collectToString(storage1.load("shared-key"));
      const data2 = await collectToString(storage2.load("shared-key"));

      expect(data1).toBe("data in storage1");
      expect(data2).toBe("data in storage2");
    });

    it("clearing one instance does not affect others", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("key1", toAsyncIterable("data1"));
      await storage2.store("key2", toAsyncIterable("data2"));

      // Clear storage1
      storage1.clear();

      // storage1 should be empty
      expect(storage1.count).toBe(0);
      expect(await storage1.has("key1")).toBe(false);

      // storage2 should be unaffected
      expect(storage2.count).toBe(1);
      expect(await storage2.has("key2")).toBe(true);
      expect(await collectToString(storage2.load("key2"))).toBe("data2");
    });

    it("removing key from one instance does not affect same key in other", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("key", toAsyncIterable("data1"));
      await storage2.store("key", toAsyncIterable("data2"));

      // Remove from storage1
      await storage1.remove("key");

      // storage1 key should be gone
      expect(await storage1.has("key")).toBe(false);

      // storage2 key should still exist
      expect(await storage2.has("key")).toBe(true);
      expect(await collectToString(storage2.load("key"))).toBe("data2");
    });

    it("keys() iteration is isolated per instance", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("a", toAsyncIterable("1"));
      await storage1.store("b", toAsyncIterable("2"));
      await storage2.store("c", toAsyncIterable("3"));

      const keys1: string[] = [];
      for await (const key of storage1.keys()) {
        keys1.push(key);
      }

      const keys2: string[] = [];
      for await (const key of storage2.keys()) {
        keys2.push(key);
      }

      expect(keys1.sort()).toEqual(["a", "b"]);
      expect(keys2).toEqual(["c"]);
    });

    it("count property is isolated per instance", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("a", toAsyncIterable("1"));
      await storage1.store("b", toAsyncIterable("2"));
      await storage1.store("c", toAsyncIterable("3"));
      await storage2.store("x", toAsyncIterable("4"));

      expect(storage1.count).toBe(3);
      expect(storage2.count).toBe(1);
    });
  });

  describe("MemoryChunkAccess isolation", () => {
    it("separate instances have separate chunks", async () => {
      const chunks1 = new MemoryChunkAccess();
      const chunks2 = new MemoryChunkAccess();

      await chunks1.storeChunk("key1", 0, new TextEncoder().encode("chunk1"));

      expect(await chunks1.hasKey("key1")).toBe(true);
      expect(await chunks2.hasKey("key1")).toBe(false);
    });

    it("clearing one instance does not affect others", async () => {
      const chunks1 = new MemoryChunkAccess();
      const chunks2 = new MemoryChunkAccess();

      await chunks1.storeChunk("key1", 0, new TextEncoder().encode("chunk1"));
      await chunks2.storeChunk("key2", 0, new TextEncoder().encode("chunk2"));

      // Clear chunks1
      chunks1.clear();

      // chunks1 should be empty
      expect(chunks1.keyCount).toBe(0);
      expect(await chunks1.hasKey("key1")).toBe(false);

      // chunks2 should be unaffected
      expect(chunks2.keyCount).toBe(1);
      expect(await chunks2.hasKey("key2")).toBe(true);
    });

    it("chunk counts are isolated", async () => {
      const chunks1 = new MemoryChunkAccess();
      const chunks2 = new MemoryChunkAccess();

      await chunks1.storeChunk("key", 0, new TextEncoder().encode("a"));
      await chunks1.storeChunk("key", 1, new TextEncoder().encode("b"));
      await chunks2.storeChunk("key", 0, new TextEncoder().encode("c"));

      expect(await chunks1.getChunkCount("key")).toBe(2);
      expect(await chunks2.getChunkCount("key")).toBe(1);
    });
  });

  describe("ChunkedRawStorage isolation", () => {
    it("separate instances using separate chunk access are isolated", async () => {
      const chunks1 = new MemoryChunkAccess();
      const chunks2 = new MemoryChunkAccess();
      const storage1 = new ChunkedRawStorage(chunks1, 64);
      const storage2 = new ChunkedRawStorage(chunks2, 64);

      await storage1.store("key1", toAsyncIterable("data in storage1"));

      expect(await storage1.has("key1")).toBe(true);
      expect(await storage2.has("key1")).toBe(false);
    });

    it("same key stored in different instances remains isolated", async () => {
      const chunks1 = new MemoryChunkAccess();
      const chunks2 = new MemoryChunkAccess();
      const storage1 = new ChunkedRawStorage(chunks1, 64);
      const storage2 = new ChunkedRawStorage(chunks2, 64);

      const largeData1 = "A".repeat(100); // More than chunk size
      const largeData2 = "B".repeat(100);

      await storage1.store("shared", toAsyncIterable(largeData1));
      await storage2.store("shared", toAsyncIterable(largeData2));

      const data1 = await collectToString(storage1.load("shared"));
      const data2 = await collectToString(storage2.load("shared"));

      expect(data1).toBe(largeData1);
      expect(data2).toBe(largeData2);
    });
  });

  describe("memory cleanup patterns", () => {
    let storage: MemoryRawStorage;

    beforeEach(() => {
      storage = new MemoryRawStorage();
    });

    it("clear() removes all data", async () => {
      await storage.store("a", toAsyncIterable("1"));
      await storage.store("b", toAsyncIterable("2"));
      await storage.store("c", toAsyncIterable("3"));

      expect(storage.count).toBe(3);

      storage.clear();

      expect(storage.count).toBe(0);
      expect(await storage.has("a")).toBe(false);
      expect(await storage.has("b")).toBe(false);
      expect(await storage.has("c")).toBe(false);
    });

    it("clear() allows reuse of storage", async () => {
      await storage.store("key", toAsyncIterable("old data"));
      storage.clear();

      await storage.store("key", toAsyncIterable("new data"));

      expect(await storage.has("key")).toBe(true);
      expect(await collectToString(storage.load("key"))).toBe("new data");
    });

    it("remove() cleans up individual entries", async () => {
      await storage.store("keep", toAsyncIterable("keep this"));
      await storage.store("remove", toAsyncIterable("remove this"));

      await storage.remove("remove");

      expect(storage.count).toBe(1);
      expect(await storage.has("keep")).toBe(true);
      expect(await storage.has("remove")).toBe(false);
    });

    it("load() throws after remove()", async () => {
      await storage.store("key", toAsyncIterable("data"));
      await storage.remove("key");

      await expect(async () => {
        for await (const _ of storage.load("key")) {
          // Should throw
        }
      }).rejects.toThrow("Key not found");
    });

    it("load() throws after clear()", async () => {
      await storage.store("key", toAsyncIterable("data"));
      storage.clear();

      await expect(async () => {
        for await (const _ of storage.load("key")) {
          // Should throw
        }
      }).rejects.toThrow("Key not found");
    });
  });

  describe("MemoryChunkAccess cleanup", () => {
    let chunks: MemoryChunkAccess;

    beforeEach(() => {
      chunks = new MemoryChunkAccess();
    });

    it("removeChunks() removes all chunks for a key", async () => {
      await chunks.storeChunk("key", 0, new TextEncoder().encode("a"));
      await chunks.storeChunk("key", 1, new TextEncoder().encode("b"));
      await chunks.storeChunk("key", 2, new TextEncoder().encode("c"));

      expect(chunks.totalChunks).toBe(3);

      await chunks.removeChunks("key");

      expect(chunks.totalChunks).toBe(0);
      expect(await chunks.hasKey("key")).toBe(false);
    });

    it("removeChunks() does not affect other keys", async () => {
      await chunks.storeChunk("key1", 0, new TextEncoder().encode("a"));
      await chunks.storeChunk("key2", 0, new TextEncoder().encode("b"));
      await chunks.storeChunk("key2", 1, new TextEncoder().encode("c"));

      await chunks.removeChunks("key1");

      expect(await chunks.hasKey("key1")).toBe(false);
      expect(await chunks.hasKey("key2")).toBe(true);
      expect(await chunks.getChunkCount("key2")).toBe(2);
    });

    it("loadChunk() throws after removeChunks()", async () => {
      await chunks.storeChunk("key", 0, new TextEncoder().encode("data"));
      await chunks.removeChunks("key");

      await expect(chunks.loadChunk("key", 0)).rejects.toThrow("Chunk not found");
    });
  });

  describe("concurrent access patterns", () => {
    it("concurrent stores to different instances are isolated", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      // Simulate concurrent stores
      await Promise.all([
        storage1.store("key", toAsyncIterable("from1")),
        storage2.store("key", toAsyncIterable("from2")),
      ]);

      const data1 = await collectToString(storage1.load("key"));
      const data2 = await collectToString(storage2.load("key"));

      expect(data1).toBe("from1");
      expect(data2).toBe("from2");
    });

    it("concurrent operations on same instance maintain consistency", async () => {
      const storage = new MemoryRawStorage();

      // Store multiple keys concurrently
      await Promise.all([
        storage.store("a", toAsyncIterable("1")),
        storage.store("b", toAsyncIterable("2")),
        storage.store("c", toAsyncIterable("3")),
      ]);

      expect(storage.count).toBe(3);
      expect(await collectToString(storage.load("a"))).toBe("1");
      expect(await collectToString(storage.load("b"))).toBe("2");
      expect(await collectToString(storage.load("c"))).toBe("3");
    });
  });

  describe("size tracking", () => {
    it("size() is isolated per instance", async () => {
      const storage1 = new MemoryRawStorage();
      const storage2 = new MemoryRawStorage();

      await storage1.store("key", toAsyncIterable("short"));
      await storage2.store("key", toAsyncIterable("much longer content"));

      expect(await storage1.size("key")).toBe(5);
      expect(await storage2.size("key")).toBe(19); // "much longer content".length
    });

    it("size() returns -1 after remove()", async () => {
      const storage = new MemoryRawStorage();

      await storage.store("key", toAsyncIterable("data"));
      expect(await storage.size("key")).toBe(4);

      await storage.remove("key");
      expect(await storage.size("key")).toBe(-1);
    });

    it("size() returns -1 for non-existent keys", async () => {
      const storage = new MemoryRawStorage();

      expect(await storage.size("nonexistent")).toBe(-1);
    });
  });
});
