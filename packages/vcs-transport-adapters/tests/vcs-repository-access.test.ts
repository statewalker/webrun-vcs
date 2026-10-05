/**
 * Unit tests for VcsRepositoryAccess
 *
 * Tests the implementation that uses the History facade for object access.
 */

import type { Commit, Tag, TreeEntry } from "@statewalker/vcs-core";
import { ObjectType, serializeCommit, serializeTag, serializeTree } from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils/streams";
import { describe, expect, it } from "vitest";
import { createVcsRepositoryAccess, VcsRepositoryAccess } from "../src/vcs-repository-access.js";
import { parseGitWireFormat } from "../src/wire-format-utils.js";
import {
  createMockHistory,
  createMockHistoryWithData,
  EMPTY_TREE_ID,
  SAMPLE_IDENT,
} from "./helpers/mock-history.js";

describe("VcsRepositoryAccess", () => {
  describe("hasObject", () => {
    it("returns true for existing commit", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });

      const access = new VcsRepositoryAccess({ history });
      expect(await access.hasObject(commitId)).toBe(true);
    });

    it("returns true for existing tree", async () => {
      const history = createMockHistory();
      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);

      const access = new VcsRepositoryAccess({ history });
      expect(await access.hasObject(treeId)).toBe(true);
    });

    it("returns true for existing blob", async () => {
      const history = createMockHistory();
      const blobId = await history.blobs.store([new TextEncoder().encode("Hello")]);

      const access = new VcsRepositoryAccess({ history });
      expect(await access.hasObject(blobId)).toBe(true);
    });

    it("returns true for existing tag", async () => {
      const history = createMockHistory();
      const tagId = await history.tags.store({
        object: "a".repeat(40),
        objectType: ObjectType.COMMIT,
        tag: "v1.0",
        message: "Release",
      });

      const access = new VcsRepositoryAccess({ history });
      expect(await access.hasObject(tagId)).toBe(true);
    });

    it("returns false for non-existent object", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });
      expect(await access.hasObject("0".repeat(40))).toBe(false);
    });
  });

  describe("getObjectInfo", () => {
    it("returns commit type and size", async () => {
      const history = createMockHistory();
      const commit: Commit = {
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test commit",
      };
      const commitId = await history.commits.store(commit);
      const expectedSize = serializeCommit(commit).length;

      const access = new VcsRepositoryAccess({ history });
      const info = await access.getObjectInfo(commitId);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(ObjectType.COMMIT);
      expect(info?.size).toBe(expectedSize);
    });

    it("returns tree type and size", async () => {
      const history = createMockHistory();
      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId }];
      const treeId = await history.trees.store(entries);
      const expectedSize = serializeTree(entries).length;

      const access = new VcsRepositoryAccess({ history });
      const info = await access.getObjectInfo(treeId);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(ObjectType.TREE);
      expect(info?.size).toBe(expectedSize);
    });

    it("returns blob type and size using efficient size() method", async () => {
      const history = createMockHistory();
      const content = new TextEncoder().encode("Hello, World!");
      const blobId = await history.blobs.store([content]);

      const access = new VcsRepositoryAccess({ history });
      const info = await access.getObjectInfo(blobId);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(ObjectType.BLOB);
      expect(info?.size).toBe(content.length);
    });

    it("returns tag type and size", async () => {
      const history = createMockHistory();
      const tag: Tag = {
        object: "a".repeat(40),
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: SAMPLE_IDENT,
        message: "Release v1.0.0",
      };
      const tagId = await history.tags.store(tag);
      const expectedSize = serializeTag(tag).length;

      const access = new VcsRepositoryAccess({ history });
      const info = await access.getObjectInfo(tagId);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(ObjectType.TAG);
      expect(info?.size).toBe(expectedSize);
    });

    it("returns null for non-existent object", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });
      const info = await access.getObjectInfo("0".repeat(40));
      expect(info).toBeNull();
    });
  });

  describe("loadObject", () => {
    it("returns commit in Git wire format", async () => {
      const history = createMockHistory();
      const commit: Commit = {
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test commit",
      };
      const commitId = await history.commits.store(commit);

      const access = new VcsRepositoryAccess({ history });
      const data = await collect(access.loadObject(commitId));

      const { type, body } = parseGitWireFormat(data);
      expect(type).toBe(ObjectType.COMMIT);
      expect(body).toEqual(serializeCommit(commit));
    });

    it("returns tree in Git wire format", async () => {
      const history = createMockHistory();
      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const entries: TreeEntry[] = [{ mode: 0o100644, name: "file.txt", id: blobId }];
      const treeId = await history.trees.store(entries);

      const access = new VcsRepositoryAccess({ history });
      const data = await collect(access.loadObject(treeId));

      const { type, body } = parseGitWireFormat(data);
      expect(type).toBe(ObjectType.TREE);
      expect(body).toEqual(serializeTree(entries));
    });

    it("returns blob in Git wire format with correct content", async () => {
      const history = createMockHistory();
      const content = new TextEncoder().encode("Hello, World!");
      const blobId = await history.blobs.store([content]);

      const access = new VcsRepositoryAccess({ history });
      const data = await collect(access.loadObject(blobId));

      const { type, body } = parseGitWireFormat(data);
      expect(type).toBe(ObjectType.BLOB);
      expect(body).toEqual(content);
    });

    it("returns tag in Git wire format", async () => {
      const history = createMockHistory();
      const tag: Tag = {
        object: "a".repeat(40),
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: SAMPLE_IDENT,
        message: "Release v1.0.0",
      };
      const tagId = await history.tags.store(tag);

      const access = new VcsRepositoryAccess({ history });
      const data = await collect(access.loadObject(tagId));

      const { type, body } = parseGitWireFormat(data);
      expect(type).toBe(ObjectType.TAG);
      expect(body).toEqual(serializeTag(tag));
    });

    it("throws for non-existent object", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });

      await expect(collect(access.loadObject("0".repeat(40)))).rejects.toThrow("Object not found");
    });
  });

  describe("storeObject", () => {
    it("stores blob content and returns valid ObjectId", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });
      const content = new TextEncoder().encode("New blob content");

      const id = await access.storeObject(ObjectType.BLOB, content);

      expect(id).toMatch(/^[0-9a-f]{40}$/);
      expect(await history.blobs.has(id)).toBe(true);
      const blobContent = await history.blobs.load(id);
      expect(blobContent).toBeDefined();
      const stored = await collect(blobContent as AsyncIterable<Uint8Array>);
      expect(stored).toEqual(content);
    });

    it("parses and stores tree from serialized content", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });

      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const entries: TreeEntry[] = [{ mode: 0o100644, name: "test.txt", id: blobId }];
      const serialized = serializeTree(entries);

      const id = await access.storeObject(ObjectType.TREE, serialized);

      expect(id).toMatch(/^[0-9a-f]{40}$/);
      expect(await history.trees.has(id)).toBe(true);
    });

    it("parses and stores commit from serialized content", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });

      const commit: Commit = {
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      };
      const serialized = serializeCommit(commit);

      const id = await access.storeObject(ObjectType.COMMIT, serialized);

      expect(id).toMatch(/^[0-9a-f]{40}$/);
      expect(await history.commits.has(id)).toBe(true);
    });

    it("parses and stores tag from serialized content", async () => {
      const history = createMockHistory();
      const access = new VcsRepositoryAccess({ history });

      const tag: Tag = {
        object: "a".repeat(40),
        objectType: ObjectType.COMMIT,
        tag: "v1.0",
        message: "Release",
      };
      const serialized = serializeTag(tag);

      const id = await access.storeObject(ObjectType.TAG, serialized);

      expect(id).toMatch(/^[0-9a-f]{40}$/);
      expect(await history.tags.has(id)).toBe(true);
    });
  });

  describe("listRefs", () => {
    it("lists all refs with objectIds", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });
      await history.refs.set("refs/heads/main", commitId);
      await history.refs.set("refs/heads/feature", commitId);

      const access = new VcsRepositoryAccess({ history });
      const refs: Array<{ name: string; objectId: string }> = [];
      for await (const ref of access.listRefs()) {
        refs.push(ref);
      }

      expect(refs.length).toBeGreaterThanOrEqual(2);
      const mainRef = refs.find((r) => r.name === "refs/heads/main");
      const featureRef = refs.find((r) => r.name === "refs/heads/feature");
      expect(mainRef?.objectId).toBe(commitId);
      expect(featureRef?.objectId).toBe(commitId);
    });

    it("resolves symbolic refs to objectIds", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });
      await history.refs.set("refs/heads/main", commitId);
      await history.refs.setSymbolic("HEAD", "refs/heads/main");

      const access = new VcsRepositoryAccess({ history });
      const refs: Array<{ name: string; objectId: string }> = [];
      for await (const ref of access.listRefs()) {
        refs.push(ref);
      }

      const headRef = refs.find((r) => r.name === "HEAD");
      expect(headRef?.objectId).toBe(commitId);
    });

    it("includes peeledId for annotated tags", async () => {
      const history = createMockHistory();
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
        tag: "v1.0.0",
        message: "Release",
      });
      await history.refs.set("refs/tags/v1.0.0", tagId);

      const access = new VcsRepositoryAccess({ history });
      const refs: Array<{ name: string; objectId: string; peeledId?: string }> = [];
      for await (const ref of access.listRefs()) {
        refs.push(ref);
      }

      const tagRef = refs.find((r) => r.name === "refs/tags/v1.0.0");
      expect(tagRef?.objectId).toBe(tagId);
      expect(tagRef?.peeledId).toBe(commitId);
    });
  });

  describe("getHead", () => {
    it("returns symbolic head target", async () => {
      const history = createMockHistory();
      await history.refs.setSymbolic("HEAD", "refs/heads/main");

      const access = new VcsRepositoryAccess({ history });
      const head = await access.getHead();

      expect(head).toEqual({ target: "refs/heads/main" });
    });

    it("returns detached head objectId", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });
      await history.refs.set("HEAD", commitId);

      const access = new VcsRepositoryAccess({ history });
      const head = await access.getHead();

      expect(head).toEqual({ objectId: commitId });
    });

    it("returns null if HEAD does not exist", async () => {
      // Create a fresh history without setting HEAD
      const history = createMockHistory();

      const access = new VcsRepositoryAccess({ history });
      const head = await access.getHead();

      expect(head).toBeNull();
    });
  });

  describe("updateRef", () => {
    it("creates new ref when oldId is null", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });

      const access = new VcsRepositoryAccess({ history });
      const result = await access.updateRef("refs/heads/new-branch", null, commitId);

      expect(result).toBe(true);
      const ref = await history.refs.get("refs/heads/new-branch");
      expect(ref).toBeDefined();
      expect(ref && "objectId" in ref && ref.objectId).toBe(commitId);
    });

    it("updates ref with compare-and-swap when oldId provided", async () => {
      const history = createMockHistory();
      const oldCommitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Old",
      });
      const newCommitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [oldCommitId],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "New",
      });
      await history.refs.set("refs/heads/main", oldCommitId);

      const access = new VcsRepositoryAccess({ history });
      const result = await access.updateRef("refs/heads/main", oldCommitId, newCommitId);

      expect(result).toBe(true);
      const ref = await history.refs.get("refs/heads/main");
      expect(ref && "objectId" in ref && ref.objectId).toBe(newCommitId);
    });

    it("fails compare-and-swap if oldId does not match", async () => {
      const history = createMockHistory();
      const actualCommitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Actual",
      });
      const wrongOldId = "1".repeat(40);
      const newCommitId = "2".repeat(40);
      await history.refs.set("refs/heads/main", actualCommitId);

      const access = new VcsRepositoryAccess({ history });
      const result = await access.updateRef("refs/heads/main", wrongOldId, newCommitId);

      expect(result).toBe(false);
      // Ref should not have changed
      const ref = await history.refs.get("refs/heads/main");
      expect(ref && "objectId" in ref && ref.objectId).toBe(actualCommitId);
    });

    it("deletes ref when newId is null", async () => {
      const history = createMockHistory();
      const commitId = await history.commits.store({
        tree: EMPTY_TREE_ID,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Test",
      });
      await history.refs.set("refs/heads/to-delete", commitId);

      const access = new VcsRepositoryAccess({ history });
      const result = await access.updateRef("refs/heads/to-delete", null, null);

      expect(result).toBe(true);
      expect(await history.refs.has("refs/heads/to-delete")).toBe(false);
    });
  });

  describe("walkObjects", () => {
    it("walks commit and all reachable objects", async () => {
      const { history, commitId, treeId, blobId } = await createMockHistoryWithData();

      const access = new VcsRepositoryAccess({ history });
      const objects: Array<{ id: string; type: number }> = [];
      for await (const obj of access.walkObjects([commitId], [])) {
        objects.push({ id: obj.id, type: obj.type });
      }

      // Should have commit, tree, and blob
      expect(objects.length).toBe(3);
      expect(objects.find((o) => o.id === commitId)?.type).toBe(ObjectType.COMMIT);
      expect(objects.find((o) => o.id === treeId)?.type).toBe(ObjectType.TREE);
      expect(objects.find((o) => o.id === blobId)?.type).toBe(ObjectType.BLOB);
    });

    it("excludes objects in haves set", async () => {
      const { history, commitId, blobId } = await createMockHistoryWithData();

      const access = new VcsRepositoryAccess({ history });
      const objects: Array<{ id: string; type: number }> = [];
      // Client already has the blob
      for await (const obj of access.walkObjects([commitId], [blobId])) {
        objects.push({ id: obj.id, type: obj.type });
      }

      // Should have commit and tree, but not blob
      expect(objects.length).toBe(2);
      expect(objects.find((o) => o.id === blobId)).toBeUndefined();
    });

    it("walks parent commits", async () => {
      const history = createMockHistory();

      // Create first commit
      const blobId = await history.blobs.store([new TextEncoder().encode("content1")]);
      const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
      const commit1Id = await history.commits.store({
        tree: treeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });

      // Create second commit with parent
      const blob2Id = await history.blobs.store([new TextEncoder().encode("content2")]);
      const tree2Id = await history.trees.store([
        { mode: 0o100644, name: "file.txt", id: blob2Id },
      ]);
      const commit2Id = await history.commits.store({
        tree: tree2Id,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const access = new VcsRepositoryAccess({ history });
      const objects: Array<{ id: string; type: number }> = [];
      for await (const obj of access.walkObjects([commit2Id], [])) {
        objects.push({ id: obj.id, type: obj.type });
      }

      // Should have both commits, both trees, and both blobs
      expect(objects.length).toBe(6);
      expect(objects.filter((o) => o.type === ObjectType.COMMIT).length).toBe(2);
      expect(objects.filter((o) => o.type === ObjectType.TREE).length).toBe(2);
      expect(objects.filter((o) => o.type === ObjectType.BLOB).length).toBe(2);
    });

    it("walks tag to tagged object", async () => {
      const { history, commitId } = await createMockHistoryWithData();

      // Create tag pointing to commit
      const tagId = await history.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v1.0",
        message: "Release",
      });

      const access = new VcsRepositoryAccess({ history });
      const objects: Array<{ id: string; type: number }> = [];
      for await (const obj of access.walkObjects([tagId], [])) {
        objects.push({ id: obj.id, type: obj.type });
      }

      // Should have tag, commit, tree, and blob
      expect(objects.length).toBe(4);
      expect(objects.find((o) => o.id === tagId)?.type).toBe(ObjectType.TAG);
      expect(objects.find((o) => o.id === commitId)?.type).toBe(ObjectType.COMMIT);
    });

    it("does not visit same object twice (deduplication)", async () => {
      const history = createMockHistory();

      // Create shared blob and tree
      const sharedBlobId = await history.blobs.store([new TextEncoder().encode("shared")]);
      const sharedTreeId = await history.trees.store([
        { mode: 0o100644, name: "shared.txt", id: sharedBlobId },
      ]);

      // Create two commits pointing to the same tree
      const commit1Id = await history.commits.store({
        tree: sharedTreeId,
        parents: [],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "First",
      });
      const commit2Id = await history.commits.store({
        tree: sharedTreeId,
        parents: [commit1Id],
        author: SAMPLE_IDENT,
        committer: SAMPLE_IDENT,
        message: "Second",
      });

      const access = new VcsRepositoryAccess({ history });
      const objectIds: string[] = [];
      for await (const obj of access.walkObjects([commit2Id], [])) {
        objectIds.push(obj.id);
      }

      // Check no duplicates
      const uniqueIds = new Set(objectIds);
      expect(objectIds.length).toBe(uniqueIds.size);

      // Should have 2 commits, 1 tree (shared), 1 blob (shared)
      expect(objectIds.length).toBe(4);
    });
  });

  describe("createVcsRepositoryAccess factory", () => {
    it("creates RepositoryAccess instance with History config", async () => {
      const history = createMockHistory();
      const access = createVcsRepositoryAccess({ history });

      expect(access).toBeDefined();
      expect(typeof access.hasObject).toBe("function");
      expect(typeof access.getObjectInfo).toBe("function");
      expect(typeof access.loadObject).toBe("function");
      expect(typeof access.storeObject).toBe("function");
      expect(typeof access.listRefs).toBe("function");
      expect(typeof access.getHead).toBe("function");
      expect(typeof access.updateRef).toBe("function");
      expect(typeof access.walkObjects).toBe("function");
    });
  });
});
