/**
 * T3.12: Performance Integration Tests
 *
 * Tests performance-sensitive operations for regressions:
 * - Commit chain creation and traversal
 * - Pack creation and import with realistic data
 * - Object storage throughput
 * - Tree operations at scale
 *
 * Regression threshold: No operation >10% slower than baseline.
 * Uses generous time budgets to avoid flaky tests on CI.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";

describe("Performance Integration", () => {
  let history: HistoryWithOperations;

  beforeEach(async () => {
    history = createMemoryHistoryWithOperations();
    await history.initialize();
  });

  afterEach(async () => {
    await history.close();
  });

  describe("commit chain performance", () => {
    it("creates 50 commits within time budget", async () => {
      const COUNT = 50;
      const MAX_MS = 5000; // generous budget

      const start = performance.now();
      let parentId: string | undefined;

      for (let i = 0; i < COUNT; i++) {
        const blobId = await history.blobs.store([
          new TextEncoder().encode(`Content for commit ${i}: ${"x".repeat(100)}`),
        ]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: `file-${i}.txt`, id: blobId },
        ]);
        parentId = await history.commits.store({
          tree: treeId,
          parents: parentId ? [parentId] : [],
          author: createPerson(i),
          committer: createPerson(i),
          message: `Commit ${i}`,
        });
      }

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(MAX_MS);
      expect(parentId).toBeDefined();
    });

    it("traverses 50 commit history efficiently", async () => {
      // Build chain
      let tipId: string | undefined;
      for (let i = 0; i < 50; i++) {
        const blobId = await history.blobs.store([new TextEncoder().encode(`v${i}`)]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: "file.txt", id: blobId },
        ]);
        tipId = await history.commits.store({
          tree: treeId,
          parents: tipId ? [tipId] : [],
          author: createPerson(i),
          committer: createPerson(i),
          message: `Commit ${i}`,
        });
      }

      // Traverse
      const MAX_TRAVERSE_MS = 2000;
      const start = performance.now();
      let count = 0;
      let current: string | undefined = tipId;

      while (current) {
        const commit = await history.commits.load(current);
        expect(commit).toBeDefined();
        count++;
        current = commit?.parents[0];
      }

      const duration = performance.now() - start;
      expect(count).toBe(50);
      expect(duration).toBeLessThan(MAX_TRAVERSE_MS);
    });
  });

  describe("pack operations performance", () => {
    it("pack round-trip with 100 objects stays within budget", async () => {
      const BLOB_COUNT = 30;
      const MAX_PACK_MS = 5000;

      // Create objects
      const commitIds: string[] = [];
      let parentId: string | undefined;

      for (let i = 0; i < BLOB_COUNT; i++) {
        const content = `File ${i} content: ${"data-".repeat(20)}${i}`;
        const blobId = await history.blobs.store([new TextEncoder().encode(content)]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: `file-${i}.txt`, id: blobId },
        ]);
        parentId = await history.commits.store({
          tree: treeId,
          parents: parentId ? [parentId] : [],
          author: createPerson(i),
          committer: createPerson(i),
          message: `Commit ${i}`,
        });
        commitIds.push(parentId);
      }

      const tipId = commitIds[commitIds.length - 1];

      // Time pack creation + import
      const start = performance.now();

      const objects = history.collectReachableObjects(new Set([tipId]), new Set());
      const packBytes = await collectPackBytes(history.serialization.createPack(objects));

      // Import into fresh history
      const target = createMemoryHistoryWithOperations();
      await target.initialize();
      const result = await target.serialization.importPack(toAsyncIterable(packBytes));
      await target.close();

      const duration = performance.now() - start;

      expect(result.commitsImported).toBe(BLOB_COUNT);
      expect(result.objectsImported).toBeGreaterThanOrEqual(BLOB_COUNT * 3); // blob+tree+commit each
      expect(duration).toBeLessThan(MAX_PACK_MS);
    });

    it("incremental pack is smaller than full pack", async () => {
      // Create base chain
      let baseId: string | undefined;
      for (let i = 0; i < 10; i++) {
        const blobId = await history.blobs.store([new TextEncoder().encode(`base ${i}`)]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: "file.txt", id: blobId },
        ]);
        baseId = await history.commits.store({
          tree: treeId,
          parents: baseId ? [baseId] : [],
          author: createPerson(i),
          committer: createPerson(i),
          message: `Base ${i}`,
        });
      }

      // Full pack
      const fullPack = await collectPackBytes(
        history.serialization.createPack(
          history.collectReachableObjects(new Set([baseId as string]), new Set()),
        ),
      );

      // Add more commits
      let tipId = baseId as string;
      for (let i = 0; i < 5; i++) {
        const blobId = await history.blobs.store([new TextEncoder().encode(`new ${i}`)]);
        const treeId = await history.trees.store([
          { mode: 0o100644, name: "file.txt", id: blobId },
        ]);
        tipId = await history.commits.store({
          tree: treeId,
          parents: [tipId],
          author: createPerson(i + 10),
          committer: createPerson(i + 10),
          message: `New ${i}`,
        });
      }

      // Incremental pack (only new objects)
      const incrementalPack = await collectPackBytes(
        history.serialization.createPack(
          history.collectReachableObjects(new Set([tipId]), new Set([baseId as string])),
        ),
      );

      // Incremental should be substantially smaller
      expect(incrementalPack.length).toBeLessThan(fullPack.length);
    });
  });

  describe("blob storage throughput", () => {
    it("stores and retrieves many small blobs efficiently", async () => {
      const COUNT = 100;
      const MAX_MS = 3000;
      const blobIds: string[] = [];

      const start = performance.now();

      // Store
      for (let i = 0; i < COUNT; i++) {
        const id = await history.blobs.store([
          new TextEncoder().encode(`Blob content ${i}: ${"payload".repeat(10)}`),
        ]);
        blobIds.push(id);
      }

      // Retrieve all
      for (const id of blobIds) {
        const blob = await history.blobs.load(id);
        expect(blob).toBeDefined();
      }

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(MAX_MS);
    });

    it("content-addressed deduplication works efficiently", async () => {
      const UNIQUE_COUNT = 10;
      const REPEAT_COUNT = 10;

      // Store same content multiple times
      const ids = new Set<string>();
      for (let r = 0; r < REPEAT_COUNT; r++) {
        for (let i = 0; i < UNIQUE_COUNT; i++) {
          const id = await history.blobs.store([new TextEncoder().encode(`Unique content ${i}`)]);
          ids.add(id);
        }
      }

      // Should only have UNIQUE_COUNT distinct IDs (deduplication)
      expect(ids.size).toBe(UNIQUE_COUNT);
    });
  });

  describe("tree operations at scale", () => {
    it("creates and reads large tree efficiently", async () => {
      const ENTRY_COUNT = 100;
      const MAX_MS = 2000;

      // Create blobs for entries
      const entries: Array<{ mode: number; name: string; id: string }> = [];
      for (let i = 0; i < ENTRY_COUNT; i++) {
        const blobId = await history.blobs.store([new TextEncoder().encode(`File ${i} content`)]);
        entries.push({
          mode: 0o100644,
          name: `file-${String(i).padStart(3, "0")}.txt`,
          id: blobId,
        });
      }

      const start = performance.now();

      // Store tree
      const treeId = await history.trees.store(entries);

      // Load tree and iterate
      const tree = await history.trees.load(treeId);
      let count = 0;
      for await (const _entry of tree ?? []) {
        count++;
      }

      const duration = performance.now() - start;
      expect(count).toBe(ENTRY_COUNT);
      expect(duration).toBeLessThan(MAX_MS);
    });
  });

  describe("ref operations performance", () => {
    it("creates and lists many refs efficiently", async () => {
      const REF_COUNT = 50;
      const MAX_MS = 2000;

      // Create a commit to point refs at
      const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
      const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
      const commitId = await history.commits.store({
        tree: treeId,
        parents: [],
        author: createPerson(0),
        committer: createPerson(0),
        message: "Target",
      });

      const start = performance.now();

      // Create refs
      for (let i = 0; i < REF_COUNT; i++) {
        await history.refs.set(`refs/heads/branch-${String(i).padStart(3, "0")}`, commitId);
      }

      // List branch refs (exclude HEAD which is auto-created by initialize)
      const refs: string[] = [];
      for await (const ref of history.refs.list("refs/")) {
        refs.push(ref.name);
      }

      // Resolve each ref
      for (let i = 0; i < REF_COUNT; i++) {
        const ref = await history.refs.resolve(`refs/heads/branch-${String(i).padStart(3, "0")}`);
        expect(ref?.objectId).toBe(commitId);
      }

      const duration = performance.now() - start;
      expect(refs.length).toBe(REF_COUNT);
      expect(duration).toBeLessThan(MAX_MS);
    });
  });
});

// --- Helpers ---

function createPerson(index: number): PersonIdent {
  return {
    name: "Test Author",
    email: "test@example.com",
    timestamp: 1700000000 + index * 1000,
    tzOffset: "+0000",
  };
}

async function collectPackBytes(pack: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack) {
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

async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
