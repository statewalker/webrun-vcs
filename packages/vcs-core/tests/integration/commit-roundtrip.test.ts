/**
 * T3.1: Commit Round-Trip Integration Tests
 *
 * Tests complete commit creation and retrieval cycles including:
 * - Single file commits
 * - Nested directory structures
 * - Linear commit chains
 * - Merge commits with multiple parents
 * - Ref management (HEAD, branches)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryHistory, type History, type PersonIdent } from "../../src/history/index.js";

describe("Commit Round-Trip Integration", () => {
  let history: History;

  beforeEach(async () => {
    history = createMemoryHistory();
    await history.initialize();
  });

  afterEach(async () => {
    await history.close();
  });

  describe("single file commit", () => {
    it("creates and retrieves a commit with one file", async () => {
      // 1. Store blob (file content)
      const content = new TextEncoder().encode("Hello, World!\n");
      const blobId = await history.blobs.store([content]);

      // 2. Store tree (directory with one file)
      const treeId = await history.trees.store([{ mode: 0o100644, name: "hello.txt", id: blobId }]);

      // 3. Store commit
      const commitId = await history.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Initial commit",
      });

      // 4. Verify commit retrieval
      const loadedCommit = await history.commits.load(commitId);
      expect(loadedCommit).toBeDefined();
      expect(loadedCommit?.tree).toBe(treeId);
      expect(loadedCommit?.message).toBe("Initial commit");

      // 5. Verify tree retrieval
      const loadedTree = await history.trees.load(treeId);
      expect(loadedTree).toBeDefined();
      const entries = await collectAsyncIterable(loadedTree!);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("hello.txt");

      // 6. Verify blob retrieval
      const loadedBlob = await history.blobs.load(blobId);
      expect(loadedBlob).toBeDefined();
      const loadedContent = await collectAsyncIterableBytes(loadedBlob!);
      expect(loadedContent).toEqual(content);
    });

    it("verifies blob content matches original", async () => {
      const originalContent = "Test content with some data\nLine 2\nLine 3";
      const content = new TextEncoder().encode(originalContent);
      const blobId = await history.blobs.store([content]);

      // Store in a tree and commit
      const treeId = await history.trees.store([{ mode: 0o100644, name: "test.txt", id: blobId }]);
      await history.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Add test file",
      });

      // Retrieve and verify
      const loaded = await history.blobs.load(blobId);
      const loadedBytes = await collectAsyncIterableBytes(loaded!);
      const loadedText = new TextDecoder().decode(loadedBytes);
      expect(loadedText).toBe(originalContent);
    });
  });

  describe("nested directory structure", () => {
    it("creates commit with nested directories", async () => {
      // Create files
      const fileA = await history.blobs.store([new TextEncoder().encode("File A content")]);
      const fileB = await history.blobs.store([new TextEncoder().encode("File B content")]);
      const fileC = await history.blobs.store([new TextEncoder().encode("File C content")]);

      // Create nested tree: src/utils/helper.js
      const utilsTree = await history.trees.store([
        { mode: 0o100644, name: "helper.js", id: fileC },
      ]);

      const srcTree = await history.trees.store([
        { mode: 0o100644, name: "index.js", id: fileA },
        { mode: 0o40000, name: "utils", id: utilsTree },
      ]);

      const rootTree = await history.trees.store([
        { mode: 0o100644, name: "README.md", id: fileB },
        { mode: 0o40000, name: "src", id: srcTree },
      ]);

      // Create commit
      const commitId = await history.commits.store({
        tree: rootTree,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Add project structure",
      });

      // Verify we can walk the tree
      const commit = await history.commits.load(commitId);
      const root = await collectAsyncIterable((await history.trees.load(commit?.tree))!);

      expect(root.find((e) => e.name === "README.md")).toBeDefined();
      const srcEntry = root.find((e) => e.name === "src");
      expect(srcEntry?.mode).toBe(0o40000);

      const src = await collectAsyncIterable((await history.trees.load(srcEntry?.id))!);
      expect(src.find((e) => e.name === "index.js")).toBeDefined();
      const utilsEntry = src.find((e) => e.name === "utils");
      expect(utilsEntry?.mode).toBe(0o40000);

      const utils = await collectAsyncIterable((await history.trees.load(utilsEntry?.id))!);
      expect(utils.find((e) => e.name === "helper.js")).toBeDefined();
    });

    it("retrieves deeply nested file content", async () => {
      // Create: a/b/c/d/file.txt
      const content = new TextEncoder().encode("Deep content");
      const blobId = await history.blobs.store([content]);

      const dTree = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
      const cTree = await history.trees.store([{ mode: 0o40000, name: "d", id: dTree }]);
      const bTree = await history.trees.store([{ mode: 0o40000, name: "c", id: cTree }]);
      const aTree = await history.trees.store([{ mode: 0o40000, name: "b", id: bTree }]);
      const rootTree = await history.trees.store([{ mode: 0o40000, name: "a", id: aTree }]);

      await history.commits.store({
        tree: rootTree,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Add deep structure",
      });

      // Navigate down: root -> a -> b -> c -> d -> file.txt
      const aEntry = await history.trees.getEntry(rootTree, "a");
      expect(aEntry).toBeDefined();

      const bEntry = await history.trees.getEntry(aEntry?.id, "b");
      expect(bEntry).toBeDefined();

      const cEntry = await history.trees.getEntry(bEntry?.id, "c");
      expect(cEntry).toBeDefined();

      const dEntry = await history.trees.getEntry(cEntry?.id, "d");
      expect(dEntry).toBeDefined();

      const fileEntry = await history.trees.getEntry(dEntry?.id, "file.txt");
      expect(fileEntry).toBeDefined();

      // Verify content
      const loaded = await history.blobs.load(fileEntry?.id);
      const bytes = await collectAsyncIterableBytes(loaded!);
      expect(new TextDecoder().decode(bytes)).toBe("Deep content");
    });
  });

  describe("commit chain (linear history)", () => {
    it("creates linear history of 5 commits", async () => {
      const commits: string[] = [];

      // Create 5 commits in a chain
      for (let i = 0; i < 5; i++) {
        const blobId = await history.blobs.store([new TextEncoder().encode(`Version ${i}`)]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: "file.txt", id: blobId },
        ]);
        const commitId = await history.commits.store({
          tree: treeId,
          parents: commits.length > 0 ? [commits[commits.length - 1]] : [],
          author: createTestPerson({ timestamp: 1700000000 + i * 1000 }),
          committer: createTestPerson({ timestamp: 1700000000 + i * 1000 }),
          message: `Commit ${i}`,
        });
        commits.push(commitId);
      }

      // Verify chain by walking parents
      let current: string | undefined = commits[commits.length - 1];
      const walked: string[] = [];

      while (current) {
        walked.push(current);
        const commit = await history.commits.load(current);
        current = commit?.parents[0];
      }

      expect(walked).toHaveLength(5);
      expect(walked).toEqual([...commits].reverse());
    });

    it("verifies ancestry with walkAncestry", async () => {
      const commits: string[] = [];

      for (let i = 0; i < 5; i++) {
        const treeId = await history.trees.store([]);
        const commitId = await history.commits.store({
          tree: treeId,
          parents: commits.length > 0 ? [commits[commits.length - 1]] : [],
          author: createTestPerson(),
          committer: createTestPerson(),
          message: `Commit ${i}`,
        });
        commits.push(commitId);
      }

      // Use walkAncestry to traverse
      const ancestry: string[] = [];
      for await (const id of history.commits.walkAncestry(commits[commits.length - 1])) {
        ancestry.push(id);
      }

      expect(ancestry).toHaveLength(5);
      expect(ancestry[0]).toBe(commits[4]); // Newest
      expect(ancestry[4]).toBe(commits[0]); // Oldest
    });

    it("limits ancestry walk", async () => {
      const commits: string[] = [];

      for (let i = 0; i < 10; i++) {
        const treeId = await history.trees.store([]);
        const commitId = await history.commits.store({
          tree: treeId,
          parents: commits.length > 0 ? [commits[commits.length - 1]] : [],
          author: createTestPerson(),
          committer: createTestPerson(),
          message: `Commit ${i}`,
        });
        commits.push(commitId);
      }

      // Walk with limit
      const ancestry: string[] = [];
      for await (const id of history.commits.walkAncestry(commits[9], {
        limit: 3,
      })) {
        ancestry.push(id);
      }

      expect(ancestry).toHaveLength(3);
    });
  });

  describe("merge commits", () => {
    it("creates merge commit with two parents", async () => {
      // Create base commit
      const baseId = await createSimpleCommit(history, "Base", []);

      // Create two branches
      const branch1 = await createSimpleCommit(history, "Branch 1", [baseId]);
      const branch2 = await createSimpleCommit(history, "Branch 2", [baseId]);

      // Create merge commit
      const mergeId = await createSimpleCommit(history, "Merge", [branch1, branch2]);

      // Verify merge commit has two parents
      const merge = await history.commits.load(mergeId);
      expect(merge?.parents).toHaveLength(2);
      expect(merge?.parents).toContain(branch1);
      expect(merge?.parents).toContain(branch2);
    });

    it("creates octopus merge with multiple parents", async () => {
      const baseId = await createSimpleCommit(history, "Base", []);

      // Create 4 branches from base
      const branches: string[] = [];
      for (let i = 0; i < 4; i++) {
        const branchId = await createSimpleCommit(history, `Branch ${i}`, [baseId]);
        branches.push(branchId);
      }

      // Create octopus merge
      const mergeId = await createSimpleCommit(history, "Octopus merge", branches);

      const merge = await history.commits.load(mergeId);
      expect(merge?.parents).toHaveLength(4);
      for (const branch of branches) {
        expect(merge?.parents).toContain(branch);
      }
    });

    it("finds merge base between diverged branches", async () => {
      // Create: base -> A1 -> A2 (branch A)
      //              -> B1 -> B2 (branch B)
      const baseId = await createSimpleCommit(history, "Base", []);

      const a1 = await createSimpleCommit(history, "A1", [baseId]);
      const a2 = await createSimpleCommit(history, "A2", [a1]);

      const b1 = await createSimpleCommit(history, "B1", [baseId]);
      const b2 = await createSimpleCommit(history, "B2", [b1]);

      // Find merge base
      const mergeBase = await history.commits.findMergeBase(a2, b2);
      expect(mergeBase).toHaveLength(1);
      expect(mergeBase[0]).toBe(baseId);
    });

    it("detects linear ancestry (fast-forward scenario)", async () => {
      const commit1 = await createSimpleCommit(history, "Commit 1", []);
      const commit2 = await createSimpleCommit(history, "Commit 2", [commit1]);
      const commit3 = await createSimpleCommit(history, "Commit 3", [commit2]);

      // commit1 is ancestor of commit3
      expect(await history.commits.isAncestor(commit1, commit3)).toBe(true);

      // commit3 is NOT ancestor of commit1
      expect(await history.commits.isAncestor(commit3, commit1)).toBe(false);

      // commit2 is ancestor of commit3
      expect(await history.commits.isAncestor(commit2, commit3)).toBe(true);
    });
  });

  describe("ref management", () => {
    it("updates HEAD after commit", async () => {
      const commitId = await createSimpleCommit(history, "Test", []);

      // Set HEAD directly
      await history.refs.set("HEAD", commitId);

      // Verify
      const resolved = await history.refs.resolve("HEAD");
      expect(resolved?.objectId).toBe(commitId);
    });

    it("creates and updates branch", async () => {
      const commit1 = await createSimpleCommit(history, "Commit 1", []);
      const commit2 = await createSimpleCommit(history, "Commit 2", [commit1]);

      // Create branch
      await history.refs.set("refs/heads/main", commit1);
      const resolved1 = await history.refs.resolve("refs/heads/main");
      expect(resolved1?.objectId).toBe(commit1);

      // Update branch
      await history.refs.set("refs/heads/main", commit2);
      const resolved2 = await history.refs.resolve("refs/heads/main");
      expect(resolved2?.objectId).toBe(commit2);
    });

    it("manages symbolic HEAD pointing to branch", async () => {
      const commit1 = await createSimpleCommit(history, "Initial", []);
      const commit2 = await createSimpleCommit(history, "Second", [commit1]);

      // Set up main branch
      await history.refs.set("refs/heads/main", commit1);

      // HEAD points to main
      await history.refs.setSymbolic("HEAD", "refs/heads/main");

      // Resolve HEAD -> commit1
      const resolved = await history.refs.resolve("HEAD");
      expect(resolved?.objectId).toBe(commit1);

      // Update main, HEAD should resolve to new commit
      await history.refs.set("refs/heads/main", commit2);
      const resolved2 = await history.refs.resolve("HEAD");
      expect(resolved2?.objectId).toBe(commit2);
    });

    it("lists branches", async () => {
      const commitId = await createSimpleCommit(history, "Initial", []);

      await history.refs.set("refs/heads/main", commitId);
      await history.refs.set("refs/heads/develop", commitId);
      await history.refs.set("refs/heads/feature/test", commitId);

      const refs = await collectAsyncIterable(history.refs.list("refs/heads/"));

      expect(refs).toHaveLength(3);
      const names = refs.map((r) => r.name);
      expect(names).toContain("refs/heads/main");
      expect(names).toContain("refs/heads/develop");
      expect(names).toContain("refs/heads/feature/test");
    });
  });

  describe("content addressability", () => {
    it("deduplicates identical blobs", async () => {
      const content = new TextEncoder().encode("Identical content");

      const id1 = await history.blobs.store([content]);
      const id2 = await history.blobs.store([content]);

      // Same content = same ID (content-addressed)
      expect(id1).toBe(id2);
    });

    it("deduplicates identical trees", async () => {
      const blobId = await history.blobs.store([new TextEncoder().encode("test")]);

      const entries = [{ mode: 0o100644, name: "test.txt", id: blobId }];

      const tree1 = await history.trees.store(entries);
      const tree2 = await history.trees.store(entries);

      // Same entries = same ID
      expect(tree1).toBe(tree2);
    });

    it("generates different IDs for different content", async () => {
      const id1 = await history.blobs.store([new TextEncoder().encode("Content A")]);
      const id2 = await history.blobs.store([new TextEncoder().encode("Content B")]);

      expect(id1).not.toBe(id2);
    });
  });
});

// --- Helper functions ---

function createTestPerson(overrides?: Partial<PersonIdent>): PersonIdent {
  return {
    name: "Test Author",
    email: "test@example.com",
    timestamp: overrides?.timestamp ?? Math.floor(Date.now() / 1000),
    tzOffset: overrides?.tzOffset ?? "+0000",
    ...overrides,
  };
}

async function createSimpleCommit(
  history: History,
  message: string,
  parents: string[],
): Promise<string> {
  const blobId = await history.blobs.store([new TextEncoder().encode(message)]);
  const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
  return history.commits.store({
    tree: treeId,
    parents,
    author: createTestPerson(),
    committer: createTestPerson(),
    message,
  });
}

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function collectAsyncIterableBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
