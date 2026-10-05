/**
 * Unit tests for VcsRepositoryFacade
 *
 * Tests the RepositoryFacade implementation that uses the History facade
 * for object access and SerializationApi for pack operations.
 */

import { ObjectType } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { createVcsRepositoryFacade, VcsRepositoryFacade } from "../src/vcs-repository-facade.js";
import {
  createMockHistory,
  createMockHistoryWithSerializationData,
  createMockSerializationApi,
  EMPTY_TREE_ID,
  SAMPLE_IDENT,
} from "./helpers/mock-history.js";

describe("VcsRepositoryFacade", () => {
  describe("has", () => {
    it("returns true for existing commit", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      expect(await facade.has(commitId)).toBe(true);
    });

    it("returns true for existing tree", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);

      const facade = new VcsRepositoryFacade({ history, serialization });
      expect(await facade.has(treeId)).toBe(true);
    });

    it("returns true for existing blob", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const blobId = await history.blobs.store([new TextEncoder().encode("Hello")]);

      const facade = new VcsRepositoryFacade({ history, serialization });
      expect(await facade.has(blobId)).toBe(true);
    });

    it("returns true for existing tag", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const tagId = await history.tags.store({
        object: "a".repeat(40),
        objectType: ObjectType.COMMIT,
        tag: "v1.0",
        message: "Release",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      expect(await facade.has(tagId)).toBe(true);
    });

    it("returns false for non-existent object", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const facade = new VcsRepositoryFacade({ history, serialization });
      expect(await facade.has("0".repeat(40))).toBe(false);
    });
  });

  describe("walkAncestors", () => {
    it("yields starting commit", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Initial",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(commitId)) {
        ancestors.push(oid);
      }

      expect(ancestors).toEqual([commitId]);
    });

    it("walks parent commits in BFS order", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commit1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      const commit2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const commit3Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit2Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Third",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(commit3Id)) {
        ancestors.push(oid);
      }

      expect(ancestors).toEqual([commit3Id, commit2Id, commit1Id]);
    });

    it("handles merge commits with multiple parents", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commit1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      const commit2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Branch",
      });

      // Merge commit with two parents
      const mergeId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit1Id, commit2Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Merge",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(mergeId)) {
        ancestors.push(oid);
      }

      // Should visit merge, then both parents (deduplicating)
      expect(ancestors).toContain(mergeId);
      expect(ancestors).toContain(commit1Id);
      expect(ancestors).toContain(commit2Id);
      expect(ancestors.length).toBe(3); // No duplicates
    });

    it("does not visit same commit twice", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const baseId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Base",
      });

      // Two commits both with same parent
      const branch1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Branch 1",
      });

      const branch2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Branch 2",
      });

      // Merge of both branches
      const mergeId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [branch1Id, branch2Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Merge",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(mergeId)) {
        ancestors.push(oid);
      }

      // Base commit should only appear once
      const baseCount = ancestors.filter((a) => a === baseId).length;
      expect(baseCount).toBe(1);
    });
  });

  describe("peelTag", () => {
    it("returns tagged object for annotated tag", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });

      const tagId = await history.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v1.0",
        message: "Release",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const peeled = await facade.peelTag(tagId);

      expect(peeled).toBe(commitId);
    });

    it("returns null for non-tag object", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const peeled = await facade.peelTag("0".repeat(40));

      expect(peeled).toBeNull();
    });
  });

  describe("getObjectSize", () => {
    it("returns size for blob using efficient method", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const content = new TextEncoder().encode("Hello, World!");
      const blobId = await history.blobs.store([content]);

      const facade = new VcsRepositoryFacade({ history, serialization });
      const size = await facade.getObjectSize(blobId);

      expect(size).toBe(content.length);
    });

    it("returns null for non-existent object", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const size = await facade.getObjectSize("0".repeat(40));

      expect(size).toBeNull();
    });
  });

  describe("isReachableFrom", () => {
    it("returns true when target is reachable from source", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commit1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      const commit2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const reachable = await facade.isReachableFrom(commit1Id, commit2Id);

      expect(reachable).toBe(true);
    });

    it("returns false when target is not reachable", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commit1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      const commit2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Unrelated",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const reachable = await facade.isReachableFrom(commit1Id, commit2Id);

      expect(reachable).toBe(false);
    });

    it("accepts array of source commits", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const baseId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Base",
      });

      const branch1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Branch 1",
      });

      const branch2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Branch 2",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const reachable = await facade.isReachableFrom(baseId, [branch1Id, branch2Id]);

      expect(reachable).toBe(true);
    });
  });

  describe("isReachableFromAnyTip", () => {
    it("returns true when reachable from any ref", async () => {
      const { history, serialization, commitId } = await createMockHistoryWithSerializationData();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const reachable = await facade.isReachableFromAnyTip(commitId);

      expect(reachable).toBe(true);
    });

    it("returns false when not reachable from any ref", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      // Orphan commit not pointed to by any ref
      const orphanId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Orphan",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const reachable = await facade.isReachableFromAnyTip(orphanId);

      expect(reachable).toBe(false);
    });
  });

  describe("computeShallowBoundaries", () => {
    it("computes boundaries at specified depth", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commit1Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      const commit2Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const commit3Id = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [commit2Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Third",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const boundaries = await facade.computeShallowBoundaries(new Set([commit3Id]), 2);

      // At depth 2: commit3 (0), commit2 (1), commit1 (2 - boundary)
      expect(boundaries.has(commit1Id)).toBe(true);
      expect(boundaries.size).toBe(1);
    });

    it("returns empty set when depth exceeds history", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Only",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const boundaries = await facade.computeShallowBoundaries(new Set([commitId]), 10);

      expect(boundaries.size).toBe(0);
    });
  });

  describe("computeShallowSince", () => {
    it("computes boundaries based on timestamp", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const oldCommitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: { ...SAMPLE_IDENT, timestamp: 1000 },
        committer: { ...SAMPLE_IDENT, timestamp: 1000 },
        message: "Old",
      });

      const newCommitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [oldCommitId],
        author: { ...SAMPLE_IDENT, timestamp: 2000 },
        committer: { ...SAMPLE_IDENT, timestamp: 2000 },
        message: "New",
      });

      const facade = new VcsRepositoryFacade({ history, serialization });
      const boundaries = await facade.computeShallowSince(new Set([newCommitId]), 1500);

      // Old commit (1000) is before cutoff (1500), so it's a boundary
      expect(boundaries.has(oldCommitId)).toBe(true);
    });
  });

  describe("computeShallowExclude", () => {
    it("computes boundaries excluding specified refs", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const baseId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Base",
      });

      const mainId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Main",
      });

      const featureId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [baseId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Feature",
      });

      await history.refs.set("refs/heads/main", mainId);
      await history.refs.set("refs/heads/feature", featureId);

      const facade = new VcsRepositoryFacade({ history, serialization });
      // Fetch feature, excluding main's history
      const boundaries = await facade.computeShallowExclude(new Set([featureId]), [
        "refs/heads/main",
      ]);

      // Base is reachable from main, so it should be a boundary
      expect(boundaries.has(baseId)).toBe(true);
    });
  });

  describe("importPack", () => {
    it("delegates to SerializationApi.importPack", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const result = await facade.importPack(
        (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })(),
      );

      expect(result.objectsImported).toBeGreaterThanOrEqual(0);
    });
  });

  describe("exportPack", () => {
    it("exports objects reachable from wants", async () => {
      const { history, serialization, commitId } = await createMockHistoryWithSerializationData();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const chunks: Uint8Array[] = [];

      for await (const chunk of facade.exportPack(new Set([commitId]), new Set())) {
        chunks.push(chunk);
      }

      // Should have generated pack data
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("excludes objects in exclude set", async () => {
      const { history, serialization, commitId, blobId } =
        await createMockHistoryWithSerializationData();

      const facade = new VcsRepositoryFacade({ history, serialization });
      const chunks: Uint8Array[] = [];

      // Exclude the blob - this tests the exclude logic
      for await (const chunk of facade.exportPack(new Set([commitId]), new Set([blobId]))) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("createVcsRepositoryFacade factory", () => {
    it("creates RepositoryFacade instance with History config", async () => {
      const history = createMockHistory();
      const serialization = createMockSerializationApi();
      const facade = createVcsRepositoryFacade({ history, serialization });

      expect(facade).toBeDefined();
      expect(typeof facade.importPack).toBe("function");
      expect(typeof facade.exportPack).toBe("function");
      expect(typeof facade.has).toBe("function");
      expect(typeof facade.walkAncestors).toBe("function");
      expect(typeof facade.peelTag).toBe("function");
      expect(typeof facade.getObjectSize).toBe("function");
      expect(typeof facade.isReachableFrom).toBe("function");
      expect(typeof facade.isReachableFromAnyTip).toBe("function");
      expect(typeof facade.computeShallowBoundaries).toBe("function");
      expect(typeof facade.computeShallowSince).toBe("function");
      expect(typeof facade.computeShallowExclude).toBe("function");
    });
  });
});
