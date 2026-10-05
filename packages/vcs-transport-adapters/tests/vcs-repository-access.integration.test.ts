/**
 * Integration tests for VcsRepositoryAccess
 *
 * Tests end-to-end workflows using the History-based API with real in-memory storage.
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import { createMemoryHistory, ObjectType } from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils/streams";
import { describe, expect, it } from "vitest";
import { createVcsRepositoryAccess } from "../src/vcs-repository-access.js";
import { parseGitWireFormat } from "../src/wire-format-utils.js";

const SAMPLE_IDENT = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  tzOffset: "+0000",
};

/**
 * Create an in-memory History instance for integration testing
 */
function createTestHistory(): History {
  return createMemoryHistory();
}

describe("VcsRepositoryAccess Integration Tests", () => {
  describe("Push and clone workflow", () => {
    it("can clone content from source to target", async () => {
      // Set up source repository
      const sourceHistory = createTestHistory();

      // Create content in source
      const blobContent = new TextEncoder().encode("Hello from source!");
      const blobId = await sourceHistory.blobs.store([blobContent]);

      const treeId = await sourceHistory.trees.store([
        { mode: 0o100644, name: "readme.txt", id: blobId },
      ]);

      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Initial commit",
      });

      // Set up refs in source
      await sourceHistory.refs.set("refs/heads/main", commitId);
      await sourceHistory.refs.setSymbolic("HEAD", "refs/heads/main");

      // Create VcsRepositoryAccess for source
      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });

      // Set up target repository
      const targetHistory = createTestHistory();
      const targetAccess = createVcsRepositoryAccess({ history: targetHistory });

      // Simulate fetch: listRefs(), walkObjects(), storeObject()
      // 1. List refs
      const refs: Array<{ name: string; objectId: string }> = [];
      for await (const ref of sourceAccess.listRefs()) {
        refs.push(ref);
      }

      expect(refs.length).toBeGreaterThan(0);
      const mainRef = refs.find((r) => r.name === "refs/heads/main");
      expect(mainRef?.objectId).toBe(commitId);

      // 2. Walk objects from wants and store in target
      const wants = [commitId];
      const haves: ObjectId[] = [];

      for await (const obj of sourceAccess.walkObjects(wants, haves)) {
        await targetAccess.storeObject(obj.type, obj.content);
      }

      // 3. Verify target has all content
      expect(await targetAccess.hasObject(commitId)).toBe(true);
      expect(await targetAccess.hasObject(treeId)).toBe(true);
      expect(await targetAccess.hasObject(blobId)).toBe(true);

      // Verify blob content matches
      const targetBlobContent = await targetHistory.blobs.load(blobId);
      expect(targetBlobContent).toBeDefined();
      const storedContent = await collect(targetBlobContent as AsyncIterable<Uint8Array>);
      expect(storedContent).toEqual(blobContent);
    });
  });

  describe("Incremental fetch (only new objects)", () => {
    it("fetches only new objects when client has base commit", async () => {
      const sourceHistory = createTestHistory();

      // Create initial commit
      const blob1Content = new TextEncoder().encode("version 1");
      const blob1Id = await sourceHistory.blobs.store([blob1Content]);
      const tree1Id = await sourceHistory.trees.store([
        { mode: 0o100644, name: "file.txt", id: blob1Id },
      ]);
      const commit1Id = await sourceHistory.commits.store({
        tree: tree1Id,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First commit",
      });

      // Create second commit
      const blob2Content = new TextEncoder().encode("version 2");
      const blob2Id = await sourceHistory.blobs.store([blob2Content]);
      const tree2Id = await sourceHistory.trees.store([
        { mode: 0o100644, name: "file.txt", id: blob2Id },
      ]);
      const commit2Id = await sourceHistory.commits.store({
        tree: tree2Id,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second commit",
      });

      await sourceHistory.refs.set("refs/heads/main", commit2Id);

      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });

      // Simulate client having the first commit
      const haves = [commit1Id];
      const wants = [commit2Id];

      // Walk should NOT include objects from first commit
      const objects: Array<{ id: string; type: number }> = [];
      for await (const obj of sourceAccess.walkObjects(wants, haves)) {
        objects.push({ id: obj.id, type: obj.type });
      }

      // Should have commit2, tree2, blob2 but NOT commit1, tree1, blob1
      expect(objects.find((o) => o.id === commit2Id)).toBeDefined();
      expect(objects.find((o) => o.id === tree2Id)).toBeDefined();
      expect(objects.find((o) => o.id === blob2Id)).toBeDefined();

      expect(objects.find((o) => o.id === commit1Id)).toBeUndefined();
      expect(objects.find((o) => o.id === tree1Id)).toBeUndefined();
      expect(objects.find((o) => o.id === blob1Id)).toBeUndefined();
    });
  });

  describe("History preservation through clone", () => {
    it("preserves linear history with parent relationships", async () => {
      const sourceHistory = createTestHistory();

      // Create commit1
      const tree1Id = await sourceHistory.trees.store([]);
      const commit1Id = await sourceHistory.commits.store({
        tree: tree1Id,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Commit 1",
      });

      // Create commit2
      const commit2Id = await sourceHistory.commits.store({
        tree: tree1Id,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Commit 2",
      });

      // Create commit3
      const commit3Id = await sourceHistory.commits.store({
        tree: tree1Id,
        parents: [commit2Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Commit 3",
      });

      // Clone via walkObjects
      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });
      const targetHistory = createTestHistory();
      const targetAccess = createVcsRepositoryAccess({ history: targetHistory });

      for await (const obj of sourceAccess.walkObjects([commit3Id], [])) {
        await targetAccess.storeObject(obj.type, obj.content);
      }

      // Verify all commits exist in target
      expect(await targetAccess.hasObject(commit1Id)).toBe(true);
      expect(await targetAccess.hasObject(commit2Id)).toBe(true);
      expect(await targetAccess.hasObject(commit3Id)).toBe(true);

      // Verify parent relationships are preserved
      const commit3 = await targetHistory.commits.load(commit3Id);
      expect(commit3?.parents).toEqual([commit2Id]);

      const commit2 = await targetHistory.commits.load(commit2Id);
      expect(commit2?.parents).toEqual([commit1Id]);

      const commit1 = await targetHistory.commits.load(commit1Id);
      expect(commit1?.parents).toEqual([]);
    });
  });

  describe("Annotated tags handling", () => {
    it("clones tag objects and their referenced commits", async () => {
      const sourceHistory = createTestHistory();

      // Create commit
      const treeId = await sourceHistory.trees.store([]);
      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Release commit",
      });

      // Create annotated tag
      const tagId = await sourceHistory.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: SAMPLE_IDENT,
        message: "Version 1.0.0 release",
      });

      // Set tag ref
      await sourceHistory.refs.set("refs/tags/v1.0.0", tagId);

      // Clone via walkObjects from tag
      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });
      const targetHistory = createTestHistory();
      const targetAccess = createVcsRepositoryAccess({ history: targetHistory });

      for await (const obj of sourceAccess.walkObjects([tagId], [])) {
        await targetAccess.storeObject(obj.type, obj.content);
      }

      // Verify tag object exists
      expect(await targetAccess.hasObject(tagId)).toBe(true);

      // Verify tagged commit exists
      expect(await targetAccess.hasObject(commitId)).toBe(true);

      // Verify tag content
      const tag = await targetHistory.tags.load(tagId);
      expect(tag?.tag).toBe("v1.0.0");
      expect(tag?.message).toBe("Version 1.0.0 release");
      expect(tag?.object).toBe(commitId);
    });

    it("includes peeledId for annotated tag refs", async () => {
      const sourceHistory = createTestHistory();

      // Create commit
      const treeId = await sourceHistory.trees.store([]);
      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Tagged commit",
      });

      // Create annotated tag
      const tagId = await sourceHistory.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger: SAMPLE_IDENT,
        message: "Version 2.0.0",
      });

      // Set tag ref
      await sourceHistory.refs.set("refs/tags/v2.0.0", tagId);

      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });

      // List refs should include peeledId
      const refs: Array<{ name: string; objectId: string; peeledId?: string }> = [];
      for await (const ref of sourceAccess.listRefs()) {
        refs.push(ref);
      }

      const tagRef = refs.find((r) => r.name === "refs/tags/v2.0.0");
      expect(tagRef).toBeDefined();
      expect(tagRef?.objectId).toBe(tagId);
      expect(tagRef?.peeledId).toBe(commitId);
    });
  });

  describe("Wire format round-trip", () => {
    it("loadObject produces parseable wire format", async () => {
      const history = createTestHistory();

      // Store blob
      const blobContent = new TextEncoder().encode("Test content");
      const blobId = await history.blobs.store([blobContent]);

      const access = createVcsRepositoryAccess({ history });

      // Load in wire format
      const wireData = await collect(access.loadObject(blobId));

      // Parse wire format
      const { type, body } = parseGitWireFormat(wireData);

      expect(type).toBe(ObjectType.BLOB);
      expect(body).toEqual(blobContent);
    });

    it("storeObject correctly stores parsed content", async () => {
      const sourceHistory = createTestHistory();
      const targetHistory = createTestHistory();

      // Create content in source
      const originalContent = new TextEncoder().encode("Original data");
      const blobId = await sourceHistory.blobs.store([originalContent]);

      const sourceAccess = createVcsRepositoryAccess({ history: sourceHistory });
      const targetAccess = createVcsRepositoryAccess({ history: targetHistory });

      // Load from source
      const wireData = await collect(sourceAccess.loadObject(blobId));
      const { type, body } = parseGitWireFormat(wireData);

      // Store in target
      const storedId = await targetAccess.storeObject(type, body);

      // Should get same ID (content-addressable)
      expect(storedId).toBe(blobId);

      // Content should match
      const storedBlob = await targetHistory.blobs.load(storedId);
      expect(storedBlob).toBeDefined();
      const storedContent = await collect(storedBlob as AsyncIterable<Uint8Array>);
      expect(storedContent).toEqual(originalContent);
    });
  });

  describe("Ref operations", () => {
    it("supports full ref lifecycle", async () => {
      const history = createTestHistory();
      const access = createVcsRepositoryAccess({ history });

      // Create commit
      const treeId = await history.trees.store([]);
      const commit1Id = await history.commits.store({
        tree: treeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      // Create ref (oldId = null)
      const created = await access.updateRef("refs/heads/test", null, commit1Id);
      expect(created).toBe(true);

      // Verify via listRefs
      const refs1: Array<{ name: string; objectId: string }> = [];
      for await (const ref of access.listRefs()) {
        refs1.push(ref);
      }
      expect(refs1.find((r) => r.name === "refs/heads/test")?.objectId).toBe(commit1Id);

      // Update ref with compare-and-swap
      const commit2Id = await history.commits.store({
        tree: treeId,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const updated = await access.updateRef("refs/heads/test", commit1Id, commit2Id);
      expect(updated).toBe(true);

      // Verify update
      const refs2: Array<{ name: string; objectId: string }> = [];
      for await (const ref of access.listRefs()) {
        refs2.push(ref);
      }
      expect(refs2.find((r) => r.name === "refs/heads/test")?.objectId).toBe(commit2Id);

      // Delete ref
      const deleted = await access.updateRef("refs/heads/test", null, null);
      expect(deleted).toBe(true);

      // Verify deletion
      expect(await history.refs.has("refs/heads/test")).toBe(false);
    });
  });
});
