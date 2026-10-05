import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Commit, Commits } from "../../../src/history/commits/commits.js";
import type { ObjectId } from "../../../src/history/object-storage.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use commitsConformanceTests() to run tests.
describe("Commits conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof commitsConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Commits implementations
 *
 * Run these tests against any Commits implementation to verify
 * it correctly implements the interface contract.
 */
export function commitsConformanceTests(
  name: string,
  createStore: () => Promise<Commits>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Commits conformance`, () => {
    let store: Commits;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    // Helper to create tree IDs (40 hex chars)
    function treeId(n: number): ObjectId {
      return n.toString(16).padStart(40, "0");
    }

    // Helper to create a commit
    function createCommit(options: {
      tree?: ObjectId;
      parents?: ObjectId[];
      message?: string;
      timestamp?: number;
    }): Commit {
      const now = options.timestamp ?? Date.now();
      return {
        tree: options.tree ?? treeId(1),
        parents: options.parents ?? [],
        author: {
          name: "Test Author",
          email: "author@test.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        committer: {
          name: "Test Committer",
          email: "committer@test.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        message: options.message ?? "Test commit",
      };
    }

    describe("store/load round-trip", () => {
      it("stores and loads commit", async () => {
        const commit = createCommit({ message: "Initial commit" });
        const id = await store.store(commit);

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");
        expect(id.length).toBe(40);

        const loaded = await store.load(id);
        expect(loaded).toBeDefined();
        expect(loaded?.message).toBe("Initial commit");
        expect(loaded?.tree).toBe(commit.tree);
      });

      it("stores commit with parents", async () => {
        const parent = createCommit({ message: "Parent", timestamp: 1000 });
        const parentId = await store.store(parent);

        const child = createCommit({
          message: "Child",
          parents: [parentId],
          timestamp: 2000,
        });
        const childId = await store.store(child);

        const loaded = await store.load(childId);
        expect(loaded?.parents).toEqual([parentId]);
      });

      it("stores merge commit with multiple parents", async () => {
        const parent1 = createCommit({ message: "Parent 1", timestamp: 1000 });
        const parent2 = createCommit({ message: "Parent 2", timestamp: 1001 });
        const parentId1 = await store.store(parent1);
        const parentId2 = await store.store(parent2);

        const merge = createCommit({
          message: "Merge commit",
          parents: [parentId1, parentId2],
          timestamp: 2000,
        });
        const mergeId = await store.store(merge);

        const loaded = await store.load(mergeId);
        expect(loaded?.parents).toHaveLength(2);
        expect(loaded?.parents).toContain(parentId1);
        expect(loaded?.parents).toContain(parentId2);
      });

      it("returns same id for same commit (content-addressed)", async () => {
        const commit = createCommit({ message: "Same", timestamp: 12345 });
        const id1 = await store.store(commit);
        const id2 = await store.store(commit);

        expect(id1).toBe(id2);
      });

      it("returns different ids for different commits", async () => {
        const commit1 = createCommit({ message: "Commit 1", timestamp: 1000 });
        const commit2 = createCommit({ message: "Commit 2", timestamp: 1001 });
        const id1 = await store.store(commit1);
        const id2 = await store.store(commit2);

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

      it("returns true for stored commit", async () => {
        const commit = createCommit({});
        const id = await store.store(commit);

        expect(await store.has(id)).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent id", async () => {
        const nonExistentId = "0".repeat(40);
        expect(await store.remove(nonExistentId)).toBe(false);
      });

      it("removes stored commit and returns true", async () => {
        const commit = createCommit({});
        const id = await store.store(commit);

        expect(await store.remove(id)).toBe(true);
        expect(await store.has(id)).toBe(false);
      });

      it("load returns undefined after remove", async () => {
        const commit = createCommit({});
        const id = await store.store(commit);

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
        const id1 = await store.store(createCommit({ message: "C1", timestamp: 1 }));
        const id2 = await store.store(createCommit({ message: "C2", timestamp: 2 }));

        const keys: ObjectId[] = [];
        for await (const key of store.keys()) {
          keys.push(key);
        }

        keys.sort();
        const expected = [id1, id2].sort();
        expect(keys).toEqual(expected);
      });
    });

    describe("getParents", () => {
      it("returns empty array for root commit", async () => {
        const root = createCommit({ message: "Root" });
        const rootId = await store.store(root);

        const parents = await store.getParents(rootId);
        expect(parents).toEqual([]);
      });

      it("returns parent ids for commit with parents", async () => {
        const parent = createCommit({ message: "Parent", timestamp: 1 });
        const parentId = await store.store(parent);

        const child = createCommit({
          message: "Child",
          parents: [parentId],
          timestamp: 2,
        });
        const childId = await store.store(child);

        const parents = await store.getParents(childId);
        expect(parents).toEqual([parentId]);
      });

      it("returns empty array for non-existent commit", async () => {
        const nonExistentId = "0".repeat(40);
        const parents = await store.getParents(nonExistentId);
        expect(parents).toEqual([]);
      });
    });

    describe("getTree", () => {
      it("returns tree id for commit", async () => {
        const tree = treeId(42);
        const commit = createCommit({ tree });
        const id = await store.store(commit);

        const result = await store.getTree(id);
        expect(result).toBe(tree);
      });

      it("returns undefined for non-existent commit", async () => {
        const nonExistentId = "0".repeat(40);
        const tree = await store.getTree(nonExistentId);
        expect(tree).toBeUndefined();
      });
    });

    describe("walkAncestry", () => {
      it("walks single commit", async () => {
        const commit = createCommit({ message: "Single" });
        const id = await store.store(commit);

        const walked: ObjectId[] = [];
        for await (const commitId of store.walkAncestry(id)) {
          walked.push(commitId);
        }

        expect(walked).toEqual([id]);
      });

      it("walks linear history", async () => {
        const c1 = createCommit({ message: "C1", timestamp: 1 });
        const id1 = await store.store(c1);

        const c2 = createCommit({ message: "C2", parents: [id1], timestamp: 2 });
        const id2 = await store.store(c2);

        const c3 = createCommit({ message: "C3", parents: [id2], timestamp: 3 });
        const id3 = await store.store(c3);

        const walked: ObjectId[] = [];
        for await (const commitId of store.walkAncestry(id3)) {
          walked.push(commitId);
        }

        expect(walked).toHaveLength(3);
        expect(walked[0]).toBe(id3);
        expect(walked).toContain(id1);
        expect(walked).toContain(id2);
      });

      it("respects limit option", async () => {
        const c1 = createCommit({ message: "C1", timestamp: 1 });
        const id1 = await store.store(c1);

        const c2 = createCommit({ message: "C2", parents: [id1], timestamp: 2 });
        const id2 = await store.store(c2);

        const c3 = createCommit({ message: "C3", parents: [id2], timestamp: 3 });
        const id3 = await store.store(c3);

        const walked: ObjectId[] = [];
        for await (const commitId of store.walkAncestry(id3, { limit: 2 })) {
          walked.push(commitId);
        }

        expect(walked).toHaveLength(2);
      });
    });

    describe("isAncestor", () => {
      it("returns true when commit is ancestor", async () => {
        const ancestor = createCommit({ message: "Ancestor", timestamp: 1 });
        const ancestorId = await store.store(ancestor);

        const descendant = createCommit({
          message: "Descendant",
          parents: [ancestorId],
          timestamp: 2,
        });
        const descendantId = await store.store(descendant);

        expect(await store.isAncestor(ancestorId, descendantId)).toBe(true);
      });

      it("returns false when commit is not ancestor", async () => {
        const commit1 = createCommit({ message: "C1", timestamp: 1 });
        const id1 = await store.store(commit1);

        const commit2 = createCommit({ message: "C2", timestamp: 2 });
        const id2 = await store.store(commit2);

        expect(await store.isAncestor(id1, id2)).toBe(false);
      });

      it("commit is its own ancestor", async () => {
        const commit = createCommit({ message: "Self" });
        const id = await store.store(commit);

        expect(await store.isAncestor(id, id)).toBe(true);
      });
    });

    describe("findMergeBase", () => {
      it("finds merge base for diverged branches", async () => {
        // Create: base -> a1 -> a2
        //              \-> b1 -> b2
        const base = createCommit({ message: "Base", timestamp: 1 });
        const baseId = await store.store(base);

        const a1 = createCommit({ message: "A1", parents: [baseId], timestamp: 2 });
        const a1Id = await store.store(a1);

        const a2 = createCommit({ message: "A2", parents: [a1Id], timestamp: 3 });
        const a2Id = await store.store(a2);

        const b1 = createCommit({ message: "B1", parents: [baseId], timestamp: 4 });
        const b1Id = await store.store(b1);

        const b2 = createCommit({ message: "B2", parents: [b1Id], timestamp: 5 });
        const b2Id = await store.store(b2);

        const mergeBase = await store.findMergeBase(a2Id, b2Id);
        expect(mergeBase).toContain(baseId);
      });

      it("returns empty array for unrelated commits", async () => {
        const commit1 = createCommit({ message: "C1", timestamp: 1 });
        const id1 = await store.store(commit1);

        const commit2 = createCommit({ message: "C2", timestamp: 2 });
        const id2 = await store.store(commit2);

        const mergeBase = await store.findMergeBase(id1, id2);
        expect(mergeBase).toEqual([]);
      });
    });
  });
}
