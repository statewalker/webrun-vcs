import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectId } from "../../../src/history/object-storage.js";
import { ObjectType } from "../../../src/history/objects/object-types.js";
import type { Tag, Tags } from "../../../src/history/tags/tags.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use tagsConformanceTests() to run tests.
describe("Tags conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof tagsConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Tags implementations
 *
 * Run these tests against any Tags implementation to verify
 * it correctly implements the interface contract.
 */
export function tagsConformanceTests(
  name: string,
  createStore: () => Promise<Tags>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Tags conformance`, () => {
    let store: Tags;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    // Helper to create object IDs (40 hex chars)
    function objectId(n: number): ObjectId {
      return n.toString(16).padStart(40, "0");
    }

    // Helper to create a tag
    function createTag(options: {
      targetId?: ObjectId;
      name?: string;
      message?: string;
      timestamp?: number;
    }): Tag {
      const now = options.timestamp ?? Date.now();
      return {
        object: options.targetId ?? objectId(1),
        objectType: ObjectType.COMMIT,
        tag: options.name ?? "v1.0.0",
        tagger: {
          name: "Test Tagger",
          email: "tagger@test.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        message: options.message ?? "Release tag",
      };
    }

    describe("store/load round-trip", () => {
      it("stores and loads tag", async () => {
        const tag = createTag({ name: "v1.0.0", message: "First release" });
        const id = await store.store(tag);

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");
        expect(id.length).toBe(40);

        const loaded = await store.load(id);
        expect(loaded).toBeDefined();
        expect(loaded?.tag).toBe("v1.0.0");
        expect(loaded?.message).toBe("First release");
      });

      it("stores tag pointing to commit", async () => {
        const commitId = objectId(42);
        const tag = createTag({ targetId: commitId, name: "v2.0.0" });
        const tagId = await store.store(tag);

        const loaded = await store.load(tagId);
        expect(loaded?.object).toBe(commitId);
        expect(loaded?.objectType).toBe(ObjectType.COMMIT);
      });

      it("returns same id for same tag (content-addressed)", async () => {
        const tag = createTag({ name: "same", timestamp: 12345 });
        const id1 = await store.store(tag);
        const id2 = await store.store(tag);

        expect(id1).toBe(id2);
      });

      it("returns different ids for different tags", async () => {
        const tag1 = createTag({ name: "v1.0.0", timestamp: 1000 });
        const tag2 = createTag({ name: "v2.0.0", timestamp: 1001 });
        const id1 = await store.store(tag1);
        const id2 = await store.store(tag2);

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

      it("returns true for stored tag", async () => {
        const tag = createTag({});
        const id = await store.store(tag);

        expect(await store.has(id)).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.remove(nonExistentId)).toBe(false);
      });

      it("removes stored tag and returns true", async () => {
        const tag = createTag({});
        const id = await store.store(tag);

        expect(await store.remove(id)).toBe(true);
        expect(await store.has(id)).toBe(false);
      });

      it("load returns undefined after remove", async () => {
        const tag = createTag({});
        const id = await store.store(tag);

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
        const id1 = await store.store(createTag({ name: "v1", timestamp: 1 }));
        const id2 = await store.store(createTag({ name: "v2", timestamp: 2 }));

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        keys.sort();
        const expected = [id1, id2].sort();
        expect(keys).toEqual(expected);
      });
    });

    describe("getTarget", () => {
      it("returns target id for tag", async () => {
        const targetId = objectId(99);
        const tag = createTag({ targetId });
        const id = await store.store(tag);

        const target = await store.getTarget(id);
        expect(target).toBe(targetId);
      });

      it("returns undefined for non-existent tag", async () => {
        const nonExistentId = "0".repeat(40);
        const target = await store.getTarget(nonExistentId);
        expect(target).toBeUndefined();
      });

      it("follows tag chains when peel=true", async () => {
        // Create a tag pointing to a commit
        const commitId = objectId(1);
        const innerTag = createTag({ targetId: commitId, name: "inner", timestamp: 1 });
        const innerTagId = await store.store(innerTag);

        // Create a tag pointing to the inner tag
        const outerTag: Tag = {
          object: innerTagId,
          objectType: ObjectType.TAG,
          tag: "outer",
          tagger: {
            name: "Test",
            email: "test@test.com",
            timestamp: 2,
            tzOffset: "+0000",
          },
          message: "Outer tag",
        };
        const outerTagId = await store.store(outerTag);

        // Without peel, should return inner tag
        const unpeeledTarget = await store.getTarget(outerTagId, false);
        expect(unpeeledTarget).toBe(innerTagId);

        // With peel, should return commit
        const peeledTarget = await store.getTarget(outerTagId, true);
        expect(peeledTarget).toBe(commitId);
      });
    });
  });
}
