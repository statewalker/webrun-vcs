import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobContent, Blobs } from "../../../src/history/blobs/blobs.js";
import type { ObjectId } from "../../../src/history/object-storage.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use blobsConformanceTests() to run tests.
describe("Blobs conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof blobsConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Blobs implementations
 *
 * Run these tests against any Blobs implementation to verify
 * it correctly implements the interface contract.
 */
export function blobsConformanceTests(
  name: string,
  createStore: () => Promise<Blobs>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Blobs conformance`, () => {
    let store: Blobs;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("store/load round-trip", () => {
      it("stores and loads small content", async () => {
        const content = new TextEncoder().encode("Hello, World!");
        const id = await store.store(toAsync([content]));

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");
        expect(id.length).toBe(40);

        const loaded = await store.load(id);
        expect(loaded).toBeDefined();

        const result = await collectContent(loaded!);
        expect(new TextDecoder().decode(result)).toBe("Hello, World!");
      });

      it("stores and loads large content in chunks", async () => {
        const chunks = [
          new Uint8Array(1024).fill(1),
          new Uint8Array(1024).fill(2),
          new Uint8Array(1024).fill(3),
        ];

        const id = await store.store(toAsync(chunks));
        const loaded = await store.load(id);

        expect(loaded).toBeDefined();
        const result = await collectContent(loaded!);
        expect(result.length).toBe(3072);
      });

      it("stores and loads empty content", async () => {
        const id = await store.store(toAsync([]));
        const loaded = await store.load(id);

        expect(loaded).toBeDefined();
        const result = await collectContent(loaded!);
        expect(result.length).toBe(0);
      });

      it("accepts sync iterables", async () => {
        const content = [new TextEncoder().encode("Sync content")];
        const id = await store.store(content);

        const loaded = await store.load(id);
        const result = await collectContent(loaded!);
        expect(new TextDecoder().decode(result)).toBe("Sync content");
      });

      it("returns same id for same content (content-addressed)", async () => {
        const content = new TextEncoder().encode("Same content");
        const id1 = await store.store(toAsync([content]));
        const id2 = await store.store(toAsync([content]));

        expect(id1).toBe(id2);
      });

      it("returns different ids for different content", async () => {
        const id1 = await store.store(toAsync([new TextEncoder().encode("Content 1")]));
        const id2 = await store.store(toAsync([new TextEncoder().encode("Content 2")]));

        expect(id1).not.toBe(id2);
      });
    });

    describe("load returns undefined for non-existent", () => {
      it("returns undefined for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        const loaded = await store.load(nonExistentId);

        expect(loaded).toBeUndefined();
      });
    });

    describe("has", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.has(nonExistentId)).toBe(false);
      });

      it("returns true for stored blob", async () => {
        const id = await store.store(toAsync([new Uint8Array([1, 2, 3])]));
        expect(await store.has(id)).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.remove(nonExistentId)).toBe(false);
      });

      it("removes stored blob and returns true", async () => {
        const id = await store.store(toAsync([new Uint8Array([1, 2, 3])]));
        expect(await store.remove(id)).toBe(true);
        expect(await store.has(id)).toBe(false);
      });

      it("load returns undefined after remove", async () => {
        const id = await store.store(toAsync([new Uint8Array([1, 2, 3])]));
        await store.remove(id);
        expect(await store.load(id)).toBeUndefined();
      });
    });

    describe("keys", () => {
      it("returns empty iterable when store is empty", async () => {
        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }
        expect(keys).toHaveLength(0);
      });

      it("returns all stored keys", async () => {
        const id1 = await store.store(toAsync([new TextEncoder().encode("Blob 1")]));
        const id2 = await store.store(toAsync([new TextEncoder().encode("Blob 2")]));
        const id3 = await store.store(toAsync([new TextEncoder().encode("Blob 3")]));

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        keys.sort();
        const expected = [id1, id2, id3].sort();
        expect(keys).toEqual(expected);
      });
    });

    describe("size", () => {
      it("returns -1 for non-existent blob", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.size(nonExistentId)).toBe(-1);
      });

      it("returns correct size for stored blob", async () => {
        const content = new TextEncoder().encode("Hello!");
        const id = await store.store(toAsync([content]));
        expect(await store.size(id)).toBe(6);
      });

      it("returns 0 for empty blob", async () => {
        const id = await store.store(toAsync([]));
        expect(await store.size(id)).toBe(0);
      });

      it("returns correct size for multi-chunk blob", async () => {
        const chunks = [
          new Uint8Array(100).fill(1),
          new Uint8Array(200).fill(2),
          new Uint8Array(50).fill(3),
        ];
        const id = await store.store(toAsync(chunks));
        expect(await store.size(id)).toBe(350);
      });
    });
  });
}

// Test helpers
async function collectContent(content: BlobContent): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
