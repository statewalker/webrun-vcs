/**
 * History integration tests
 *
 * Tests the History facade with in-memory storage to verify:
 * - Lifecycle management (initialize, close, isInitialized)
 * - Store access (blobs, trees, commits, tags, refs)
 * - Round-trip operations (store and retrieve objects)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryHistory, type History } from "../../src/history/index.js";

describe("History integration", () => {
  let history: History;

  beforeEach(async () => {
    history = createMemoryHistory();
    await history.initialize();
  });

  afterEach(async () => {
    await history.close();
  });

  describe("lifecycle", () => {
    it("initializes successfully", () => {
      expect(history.isInitialized()).toBe(true);
    });

    it("can close and reports not initialized", async () => {
      await history.close();
      expect(history.isInitialized()).toBe(false);
    });

    it("initialize is idempotent", async () => {
      await history.initialize();
      await history.initialize();
      expect(history.isInitialized()).toBe(true);
    });
  });

  describe("store access", () => {
    it("provides access to blobs", () => {
      expect(history.blobs).toBeDefined();
      expect(typeof history.blobs.store).toBe("function");
      expect(typeof history.blobs.load).toBe("function");
    });

    it("provides access to trees", () => {
      expect(history.trees).toBeDefined();
      expect(typeof history.trees.store).toBe("function");
      expect(typeof history.trees.load).toBe("function");
    });

    it("provides access to commits", () => {
      expect(history.commits).toBeDefined();
      expect(typeof history.commits.store).toBe("function");
      expect(typeof history.commits.load).toBe("function");
    });

    it("provides access to tags", () => {
      expect(history.tags).toBeDefined();
      expect(typeof history.tags.store).toBe("function");
      expect(typeof history.tags.load).toBe("function");
    });

    it("provides access to refs", () => {
      expect(history.refs).toBeDefined();
      expect(typeof history.refs.set).toBe("function");
      expect(typeof history.refs.resolve).toBe("function");
    });
  });

  describe("blob round-trip", () => {
    it("stores and retrieves a blob", async () => {
      const content = new TextEncoder().encode("Hello, World!");
      const id = await history.blobs.store([content]);

      const stream = await history.blobs.load(id);
      expect(stream).toBeDefined();

      const chunks: Uint8Array[] = [];
      for await (const chunk of stream!) {
        chunks.push(chunk);
      }

      const result = new TextDecoder().decode(concat(chunks));
      expect(result).toBe("Hello, World!");
    });

    it("reports correct size", async () => {
      const content = new TextEncoder().encode("Test content");
      const id = await history.blobs.store([content]);

      const size = await history.blobs.size(id);
      expect(size).toBe(content.length);
    });

    it("checks blob existence", async () => {
      const content = new TextEncoder().encode("Test");
      const id = await history.blobs.store([content]);

      expect(await history.blobs.has(id)).toBe(true);
      expect(await history.blobs.has("0000000000000000000000000000000000000000")).toBe(false);
    });
  });

  describe("tree round-trip", () => {
    it("stores and retrieves a tree", async () => {
      const blobId = await history.blobs.store([new Uint8Array([1, 2, 3])]);

      const entries = [{ name: "file.txt", mode: 0o100644, id: blobId }];
      const treeId = await history.trees.store(entries);

      const loaded = await history.trees.load(treeId);
      expect(loaded).toBeDefined();

      const loadedEntries: Array<{ name: string; mode: number; id: string }> = [];
      for await (const entry of loaded!) {
        loadedEntries.push(entry);
      }

      expect(loadedEntries).toHaveLength(1);
      expect(loadedEntries[0].name).toBe("file.txt");
      expect(loadedEntries[0].mode).toBe(0o100644);
      expect(loadedEntries[0].id).toBe(blobId);
    });

    it("provides empty tree ID", () => {
      const emptyTreeId = history.trees.getEmptyTreeId();
      expect(emptyTreeId).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    });

    it("gets entry by name", async () => {
      const blobId = await history.blobs.store([new Uint8Array([1, 2, 3])]);
      const entries = [
        { name: "a.txt", mode: 0o100644, id: blobId },
        { name: "b.txt", mode: 0o100644, id: blobId },
      ];
      const treeId = await history.trees.store(entries);

      const entry = await history.trees.getEntry(treeId, "b.txt");
      expect(entry).toBeDefined();
      expect(entry?.name).toBe("b.txt");

      const missing = await history.trees.getEntry(treeId, "c.txt");
      expect(missing).toBeUndefined();
    });
  });

  describe("commit round-trip", () => {
    it("stores and retrieves a commit", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commit = {
        tree: treeId,
        parents: [],
        author: {
          name: "Test Author",
          email: "test@example.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        committer: {
          name: "Test Committer",
          email: "test@example.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        message: "Initial commit\n",
      };
      const commitId = await history.commits.store(commit);

      const loaded = await history.commits.load(commitId);
      expect(loaded).toBeDefined();
      expect(loaded?.message).toBe("Initial commit\n");
      expect(loaded?.tree).toBe(treeId);
      expect(loaded?.parents).toHaveLength(0);
    });

    it("gets tree for commit", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commitId = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Test\n",
      });

      const tree = await history.commits.getTree(commitId);
      expect(tree).toBe(treeId);
    });

    it("gets parents for commit", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const parent1 = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Parent 1\n",
      });

      const child = await history.commits.store({
        tree: treeId,
        parents: [parent1],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Child\n",
      });

      const parents = await history.commits.getParents(child);
      expect(parents).toEqual([parent1]);
    });
  });

  describe("ref operations", () => {
    it("sets and resolves refs", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commitId = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Test\n",
      });

      await history.refs.set("refs/heads/main", commitId);

      const resolved = await history.refs.resolve("refs/heads/main");
      expect(resolved).toBeDefined();
      expect(resolved?.objectId).toBe(commitId);
    });

    it("sets and resolves symbolic refs", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commitId = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Test\n",
      });

      await history.refs.set("refs/heads/main", commitId);
      await history.refs.setSymbolic("HEAD", "refs/heads/main");

      const resolved = await history.refs.resolve("HEAD");
      expect(resolved).toBeDefined();
      expect(resolved?.objectId).toBe(commitId);
    });

    it("checks ref existence", async () => {
      expect(await history.refs.has("refs/heads/main")).toBe(false);

      await history.refs.set("refs/heads/main", "0000000000000000000000000000000000000000");

      expect(await history.refs.has("refs/heads/main")).toBe(true);
    });

    it("removes refs", async () => {
      await history.refs.set("refs/heads/temp", "0000000000000000000000000000000000000000");
      expect(await history.refs.has("refs/heads/temp")).toBe(true);

      const removed = await history.refs.remove("refs/heads/temp");
      expect(removed).toBe(true);
      expect(await history.refs.has("refs/heads/temp")).toBe(false);
    });
  });

  describe("ancestry traversal", () => {
    it("walks commit ancestry", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commit1 = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Commit 1\n",
      });

      const commit2 = await history.commits.store({
        tree: treeId,
        parents: [commit1],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Commit 2\n",
      });

      const commit3 = await history.commits.store({
        tree: treeId,
        parents: [commit2],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Commit 3\n",
      });

      const ancestry: string[] = [];
      for await (const id of history.commits.walkAncestry(commit3)) {
        ancestry.push(id);
      }

      expect(ancestry).toEqual([commit3, commit2, commit1]);
    });

    it("checks isAncestor", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const commit1 = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Commit 1\n",
      });

      const commit2 = await history.commits.store({
        tree: treeId,
        parents: [commit1],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Commit 2\n",
      });

      expect(await history.commits.isAncestor(commit1, commit2)).toBe(true);
      expect(await history.commits.isAncestor(commit2, commit1)).toBe(false);
    });

    it("finds merge base", async () => {
      const treeId = await history.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      // Create a simple branch structure:
      // base -> A
      //      -> B
      const base = await history.commits.store({
        tree: treeId,
        parents: [],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Base\n",
      });

      const branchA = await history.commits.store({
        tree: treeId,
        parents: [base],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Branch A\n",
      });

      const branchB = await history.commits.store({
        tree: treeId,
        parents: [base],
        author: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        committer: { name: "Test", email: "test@example.com", timestamp: now, tzOffset: "+0000" },
        message: "Branch B\n",
      });

      const mergeBase = await history.commits.findMergeBase(branchA, branchB);
      expect(mergeBase).toEqual([base]);
    });
  });
});

/**
 * Concatenate multiple Uint8Arrays into one
 */
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
