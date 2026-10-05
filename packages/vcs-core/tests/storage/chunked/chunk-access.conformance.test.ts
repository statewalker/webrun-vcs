import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChunkAccess } from "../../../src/storage/chunked/index.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use chunkAccessConformanceTests() to run tests.
describe("ChunkAccess conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof chunkAccessConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for ChunkAccess implementations
 */
export function chunkAccessConformanceTests(
  name: string,
  createAccess: () => Promise<ChunkAccess>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} ChunkAccess conformance`, () => {
    let access: ChunkAccess;

    beforeEach(async () => {
      access = await createAccess();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("storeChunk/loadChunk", () => {
      it("stores and loads a single chunk", async () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        await access.storeChunk("key1", 0, data);

        const loaded = await access.loadChunk("key1", 0);
        expect(loaded).toEqual(data);
      });

      it("stores multiple chunks for same key", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1, 2]));
        await access.storeChunk("key1", 1, new Uint8Array([3, 4]));
        await access.storeChunk("key1", 2, new Uint8Array([5, 6]));

        expect(await access.loadChunk("key1", 0)).toEqual(new Uint8Array([1, 2]));
        expect(await access.loadChunk("key1", 1)).toEqual(new Uint8Array([3, 4]));
        expect(await access.loadChunk("key1", 2)).toEqual(new Uint8Array([5, 6]));
      });

      it("stores chunks for different keys independently", async () => {
        await access.storeChunk("keyA", 0, new Uint8Array([1]));
        await access.storeChunk("keyB", 0, new Uint8Array([2]));

        expect(await access.loadChunk("keyA", 0)).toEqual(new Uint8Array([1]));
        expect(await access.loadChunk("keyB", 0)).toEqual(new Uint8Array([2]));
      });

      it("overwrites existing chunk", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1, 2, 3]));
        await access.storeChunk("key1", 0, new Uint8Array([4, 5, 6]));

        expect(await access.loadChunk("key1", 0)).toEqual(new Uint8Array([4, 5, 6]));
      });

      it("throws when loading non-existent chunk", async () => {
        await expect(access.loadChunk("nonexistent", 0)).rejects.toThrow();
      });

      it("throws when loading chunk with wrong index", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        await expect(access.loadChunk("key1", 1)).rejects.toThrow();
      });
    });

    describe("getChunkCount", () => {
      it("returns 0 for non-existent key", async () => {
        expect(await access.getChunkCount("nonexistent")).toBe(0);
      });

      it("returns correct count after storing chunks", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        expect(await access.getChunkCount("key1")).toBe(1);

        await access.storeChunk("key1", 1, new Uint8Array([2]));
        expect(await access.getChunkCount("key1")).toBe(2);

        await access.storeChunk("key1", 2, new Uint8Array([3]));
        expect(await access.getChunkCount("key1")).toBe(3);
      });

      it("handles sparse chunk indices correctly", async () => {
        // Store chunks with gaps - count should reflect highest index + 1
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        await access.storeChunk("key1", 5, new Uint8Array([6]));

        // Implementation may either:
        // - Track exact count (6) based on highest index + 1
        // - Track only stored chunks (2)
        // Either behavior is acceptable, but must be consistent
        const count = await access.getChunkCount("key1");
        expect(count).toBeGreaterThanOrEqual(2);
      });
    });

    describe("removeChunks", () => {
      it("returns false for non-existent key", async () => {
        expect(await access.removeChunks("nonexistent")).toBe(false);
      });

      it("removes all chunks and returns true", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        await access.storeChunk("key1", 1, new Uint8Array([2]));
        await access.storeChunk("key1", 2, new Uint8Array([3]));

        expect(await access.removeChunks("key1")).toBe(true);
        expect(await access.getChunkCount("key1")).toBe(0);
        expect(await access.hasKey("key1")).toBe(false);
      });

      it("does not affect other keys", async () => {
        await access.storeChunk("keyA", 0, new Uint8Array([1]));
        await access.storeChunk("keyB", 0, new Uint8Array([2]));

        await access.removeChunks("keyA");

        expect(await access.hasKey("keyA")).toBe(false);
        expect(await access.hasKey("keyB")).toBe(true);
      });
    });

    describe("hasKey", () => {
      it("returns false for non-existent key", async () => {
        expect(await access.hasKey("nonexistent")).toBe(false);
      });

      it("returns true when chunks exist", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        expect(await access.hasKey("key1")).toBe(true);
      });

      it("returns false after removal", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        await access.removeChunks("key1");
        expect(await access.hasKey("key1")).toBe(false);
      });
    });

    describe("keys", () => {
      it("returns empty iterable when no keys", async () => {
        const keys: string[] = [];
        for await (const key of access.keys()) {
          keys.push(key);
        }
        expect(keys).toEqual([]);
      });

      it("returns all keys with chunks", async () => {
        await access.storeChunk("key1", 0, new Uint8Array([1]));
        await access.storeChunk("key2", 0, new Uint8Array([2]));
        await access.storeChunk("key3", 0, new Uint8Array([3]));

        const keys: string[] = [];
        for await (const key of access.keys()) {
          keys.push(key);
        }

        expect(keys.sort()).toEqual(["key1", "key2", "key3"]);
      });
    });

    describe("large chunks", () => {
      it("handles large chunk data", async () => {
        // 100KB chunk
        const largeData = new Uint8Array(100 * 1024);
        for (let i = 0; i < largeData.length; i++) {
          largeData[i] = i % 256;
        }

        await access.storeChunk("large", 0, largeData);
        const loaded = await access.loadChunk("large", 0);

        expect(loaded.length).toBe(largeData.length);
        expect(loaded).toEqual(largeData);
      });
    });
  });
}
