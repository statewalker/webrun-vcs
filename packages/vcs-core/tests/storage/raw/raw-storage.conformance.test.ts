import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawStorage } from "../../../src/storage/raw/index.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use rawStorageConformanceTests() to run tests.
describe("RawStorage conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof rawStorageConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for RawStorage implementations
 *
 * Run these tests against any RawStorage implementation to verify
 * it correctly implements the interface contract.
 */
export function rawStorageConformanceTests(
  name: string,
  createStorage: () => Promise<RawStorage>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} RawStorage conformance`, () => {
    let storage: RawStorage;

    beforeEach(async () => {
      storage = await createStorage();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("store/load round-trip", () => {
      it("stores and loads small content", async () => {
        const key = "abc123";
        const content = new TextEncoder().encode("Hello, World!");

        await storage.store(key, toAsync([content]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key)) {
          loaded.push(chunk);
        }

        const result = concat(loaded);
        expect(new TextDecoder().decode(result)).toBe("Hello, World!");
      });

      it("stores and loads large content in chunks", async () => {
        const key = "large123";
        const chunks = [
          new Uint8Array(1024).fill(1),
          new Uint8Array(1024).fill(2),
          new Uint8Array(1024).fill(3),
        ];

        await storage.store(key, toAsync(chunks));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key)) {
          loaded.push(chunk);
        }

        const result = concat(loaded);
        expect(result.length).toBe(3072);
      });

      it("stores and loads empty content", async () => {
        const key = "empty";
        await storage.store(key, toAsync([]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key)) {
          loaded.push(chunk);
        }

        expect(concat(loaded).length).toBe(0);
      });

      it("overwrites existing content", async () => {
        const key = "overwrite";

        await storage.store(key, toAsync([new TextEncoder().encode("First")]));
        await storage.store(key, toAsync([new TextEncoder().encode("Second")]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key)) {
          loaded.push(chunk);
        }

        expect(new TextDecoder().decode(concat(loaded))).toBe("Second");
      });
    });

    describe("load with range options", () => {
      it("loads partial content with start", async () => {
        const key = "range1";
        await storage.store(key, toAsync([new TextEncoder().encode("Hello, World!")]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key, { start: 7 })) {
          loaded.push(chunk);
        }

        expect(new TextDecoder().decode(concat(loaded))).toBe("World!");
      });

      it("loads partial content with start and end", async () => {
        const key = "range2";
        await storage.store(key, toAsync([new TextEncoder().encode("Hello, World!")]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key, { start: 0, end: 5 })) {
          loaded.push(chunk);
        }

        expect(new TextDecoder().decode(concat(loaded))).toBe("Hello");
      });

      it("loads middle portion", async () => {
        const key = "range3";
        await storage.store(key, toAsync([new TextEncoder().encode("Hello, World!")]));

        const loaded: Uint8Array[] = [];
        for await (const chunk of storage.load(key, { start: 7, end: 12 })) {
          loaded.push(chunk);
        }

        expect(new TextDecoder().decode(concat(loaded))).toBe("World");
      });
    });

    describe("has", () => {
      it("returns false for non-existent key", async () => {
        expect(await storage.has("nonexistent")).toBe(false);
      });

      it("returns true for existing key", async () => {
        await storage.store("exists", toAsync([new Uint8Array([1, 2, 3])]));
        expect(await storage.has("exists")).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false when key does not exist", async () => {
        expect(await storage.remove("nonexistent")).toBe(false);
      });

      it("returns true and removes existing content", async () => {
        await storage.store("toremove", toAsync([new Uint8Array([1, 2, 3])]));
        expect(await storage.remove("toremove")).toBe(true);
        expect(await storage.has("toremove")).toBe(false);
      });
    });

    describe("keys", () => {
      it("returns empty iterable when no keys stored", async () => {
        const keys: string[] = [];
        for await (const key of storage.keys()) {
          keys.push(key);
        }
        expect(keys).toEqual([]);
      });

      it("returns all stored keys", async () => {
        await storage.store("key1", toAsync([new Uint8Array([1])]));
        await storage.store("key2", toAsync([new Uint8Array([2])]));
        await storage.store("key3", toAsync([new Uint8Array([3])]));

        const keys: string[] = [];
        for await (const key of storage.keys()) {
          keys.push(key);
        }

        expect(keys.sort()).toEqual(["key1", "key2", "key3"]);
      });
    });

    describe("size", () => {
      it("returns -1 for non-existent key", async () => {
        expect(await storage.size("nonexistent")).toBe(-1);
      });

      it("returns correct size for stored content", async () => {
        await storage.store("sized", toAsync([new TextEncoder().encode("Hello!")]));
        expect(await storage.size("sized")).toBe(6);
      });

      it("returns 0 for empty content", async () => {
        await storage.store("emptysized", toAsync([]));
        expect(await storage.size("emptysized")).toBe(0);
      });
    });

    describe("error handling", () => {
      it("throws when loading non-existent key", async () => {
        await expect(async () => {
          for await (const _ of storage.load("nonexistent")) {
            // consume
          }
        }).rejects.toThrow();
      });
    });
  });
}

// Test helpers
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
