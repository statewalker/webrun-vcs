import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectId, ObjectStorage } from "../../src/history/object-storage.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use objectStorageConformanceTests() to run tests.
describe("ObjectStorage conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof objectStorageConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for ObjectStorage implementations
 *
 * Run these tests against any ObjectStorage implementation to verify
 * it correctly implements the interface contract.
 *
 * @param name Name for the test suite
 * @param createStore Factory function to create a store instance
 * @param createValue Factory function to create a test value
 * @param valuesEqual Function to compare two values for equality
 * @param cleanup Cleanup function called after each test
 */
export function objectStorageConformanceTests<V>(
  name: string,
  createStore: () => Promise<ObjectStorage<V>>,
  createValue: (index: number) => V | Promise<V>,
  _valuesEqual: (a: V, b: V) => boolean | Promise<boolean>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} ObjectStorage conformance`, () => {
    let store: ObjectStorage<V>;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("store/load round-trip", () => {
      it("stores value and returns ObjectId", async () => {
        const value = await createValue(0);
        const id = await store.store(value);

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");
        expect(id.length).toBe(40); // SHA-1 hex length
      });

      it("loads stored value by id", async () => {
        const value = await createValue(0);
        const id = await store.store(value);
        const loaded = await store.load(id);

        expect(loaded).toBeDefined();
      });

      it("returns undefined for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        const loaded = await store.load(nonExistentId);

        expect(loaded).toBeUndefined();
      });

      it("returns same id for same value (content-addressed)", async () => {
        const value = await createValue(0);
        const id1 = await store.store(value);
        const id2 = await store.store(value);

        expect(id1).toBe(id2);
      });

      it("returns different ids for different values", async () => {
        const value1 = await createValue(0);
        const value2 = await createValue(1);
        const id1 = await store.store(value1);
        const id2 = await store.store(value2);

        expect(id1).not.toBe(id2);
      });
    });

    describe("has", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.has(nonExistentId)).toBe(false);
      });

      it("returns true for stored value", async () => {
        const value = await createValue(0);
        const id = await store.store(value);

        expect(await store.has(id)).toBe(true);
      });

      it("returns true for multiple stored values", async () => {
        const value1 = await createValue(0);
        const value2 = await createValue(1);
        const id1 = await store.store(value1);
        const id2 = await store.store(value2);

        expect(await store.has(id1)).toBe(true);
        expect(await store.has(id2)).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.remove(nonExistentId)).toBe(false);
      });

      it("removes stored value and returns true", async () => {
        const value = await createValue(0);
        const id = await store.store(value);

        expect(await store.remove(id)).toBe(true);
        expect(await store.has(id)).toBe(false);
      });

      it("returns false when removing already removed value", async () => {
        const value = await createValue(0);
        const id = await store.store(value);

        await store.remove(id);
        expect(await store.remove(id)).toBe(false);
      });

      it("load returns undefined after remove", async () => {
        const value = await createValue(0);
        const id = await store.store(value);

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
        const value1 = await createValue(0);
        const value2 = await createValue(1);
        const value3 = await createValue(2);

        const id1 = await store.store(value1);
        const id2 = await store.store(value2);
        const id3 = await store.store(value3);

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        // Sort for consistent comparison
        keys.sort();
        const expected = [id1, id2, id3].sort();

        expect(keys).toEqual(expected);
      });

      it("does not include removed keys", async () => {
        const value1 = await createValue(0);
        const value2 = await createValue(1);

        const id1 = await store.store(value1);
        const id2 = await store.store(value2);

        await store.remove(id1);

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        expect(keys).toContain(id2);
        expect(keys).not.toContain(id1);
      });
    });
  });
}
