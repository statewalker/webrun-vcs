import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectId } from "../../../src/history/object-storage.js";
import type { TreeEntry } from "../../../src/history/trees/tree-entry.js";
import type { Trees } from "../../../src/history/trees/trees.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use treesConformanceTests() to run tests.
describe("Trees conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof treesConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Trees implementations
 *
 * Run these tests against any Trees implementation to verify
 * it correctly implements the interface contract.
 */
export function treesConformanceTests(
  name: string,
  createStore: () => Promise<Trees>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Trees conformance`, () => {
    let store: Trees;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    // Helper to create blob-like IDs (40 hex chars)
    function blobId(n: number): ObjectId {
      return n.toString(16).padStart(40, "0");
    }

    describe("store/load round-trip", () => {
      it("stores and loads tree with entries", async () => {
        const entries: TreeEntry[] = [
          { mode: 0o100644, name: "file.txt", id: blobId(1) },
          { mode: 0o040000, name: "dir", id: blobId(2) },
        ];

        const id = await store.store(entries);

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");
        expect(id.length).toBe(40);

        const loaded = await store.load(id);
        expect(loaded).toBeDefined();

        const loadedEntries = await collectEntries(loaded!);
        expect(loadedEntries).toHaveLength(2);
      });

      it("stores and loads empty tree", async () => {
        const entries: TreeEntry[] = [];
        const id = await store.store(entries);

        const loaded = await store.load(id);
        expect(loaded).toBeDefined();

        const loadedEntries = await collectEntries(loaded!);
        expect(loadedEntries).toHaveLength(0);
      });

      it("sorts entries canonically", async () => {
        // Entries in non-canonical order
        const entries: TreeEntry[] = [
          { mode: 0o100644, name: "z.txt", id: blobId(1) },
          { mode: 0o100644, name: "a.txt", id: blobId(2) },
          { mode: 0o040000, name: "m-dir", id: blobId(3) },
        ];

        const id = await store.store(entries);
        const loaded = await store.load(id);
        const loadedEntries = await collectEntries(loaded!);

        // Should be sorted
        expect(loadedEntries[0].name).toBe("a.txt");
        expect(loadedEntries[1].name).toBe("m-dir");
        expect(loadedEntries[2].name).toBe("z.txt");
      });

      it("returns same id for same entries (content-addressed)", async () => {
        const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId(1) }];

        const id1 = await store.store(entries);
        const id2 = await store.store(entries);

        expect(id1).toBe(id2);
      });

      it("returns different ids for different entries", async () => {
        const entries1: TreeEntry[] = [{ mode: 0o100644, name: "file1.txt", id: blobId(1) }];
        const entries2: TreeEntry[] = [{ mode: 0o100644, name: "file2.txt", id: blobId(2) }];

        const id1 = await store.store(entries1);
        const id2 = await store.store(entries2);

        expect(id1).not.toBe(id2);
      });

      it("accepts async iterables", async () => {
        async function* asyncEntries(): AsyncIterable<TreeEntry> {
          yield { mode: 0o100644, name: "async.txt", id: blobId(1) };
        }

        const id = await store.store(asyncEntries());
        const loaded = await store.load(id);
        const loadedEntries = await collectEntries(loaded!);

        expect(loadedEntries).toHaveLength(1);
        expect(loadedEntries[0].name).toBe("async.txt");
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

      it("returns true for stored tree", async () => {
        const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId(1) }];
        const id = await store.store(entries);

        expect(await store.has(id)).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.remove(nonExistentId)).toBe(false);
      });

      it("removes stored tree and returns true", async () => {
        const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId(1) }];
        const id = await store.store(entries);

        expect(await store.remove(id)).toBe(true);
        expect(await store.has(id)).toBe(false);
      });

      it("load returns undefined after remove", async () => {
        const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId(1) }];
        const id = await store.store(entries);

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
        const id1 = await store.store([{ mode: 0o100644, name: "a.txt", id: blobId(1) }]);
        const id2 = await store.store([{ mode: 0o100644, name: "b.txt", id: blobId(2) }]);

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        keys.sort();
        const expected = [id1, id2].sort();
        expect(keys).toEqual(expected);
      });
    });

    describe("getEntry", () => {
      it("returns undefined for non-existent tree", async () => {
        const nonExistentId = "0".repeat(40);
        const entry = await store.getEntry(nonExistentId, "file.txt");

        expect(entry).toBeUndefined();
      });

      it("returns undefined for non-existent entry name", async () => {
        const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId(1) }];
        const id = await store.store(entries);

        const entry = await store.getEntry(id, "nonexistent.txt");
        expect(entry).toBeUndefined();
      });

      it("returns entry by name", async () => {
        const entries: TreeEntry[] = [
          { mode: 0o100644, name: "file1.txt", id: blobId(1) },
          { mode: 0o100644, name: "file2.txt", id: blobId(2) },
          { mode: 0o040000, name: "dir", id: blobId(3) },
        ];
        const id = await store.store(entries);

        const entry = await store.getEntry(id, "file2.txt");
        expect(entry).toBeDefined();
        expect(entry?.name).toBe("file2.txt");
        expect(entry?.id).toBe(blobId(2));
        expect(entry?.mode).toBe(0o100644);
      });
    });

    describe("getEmptyTreeId", () => {
      it("returns well-known empty tree SHA-1", async () => {
        const emptyTreeId = store.getEmptyTreeId();

        // SHA-1 of empty tree is 4b825dc642cb6eb9a060e54bf8d69288fbee4904
        expect(emptyTreeId).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      });

      it("matches stored empty tree id", async () => {
        const emptyTreeId = store.getEmptyTreeId();
        const storedEmptyId = await store.store([]);

        expect(storedEmptyId).toBe(emptyTreeId);
      });
    });
  });
}

// Test helpers
async function collectEntries(tree: AsyncIterable<TreeEntry>): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for await (const entry of tree) {
    entries.push(entry);
  }
  return entries;
}
