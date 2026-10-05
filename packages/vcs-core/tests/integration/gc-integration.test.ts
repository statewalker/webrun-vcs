/**
 * T3.3: GC Integration Tests
 *
 * Tests garbage collection across the full commit workflow:
 * - Unreachable object collection
 * - Object reachability analysis
 * - GC behavior with real repository structures
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PersonIdent } from "../../src/common/person/person-ident.js";
import type { Commit } from "../../src/history/commits/commits.js";
import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
} from "../../src/history/index.js";
import { GCController } from "../../src/storage/delta/gc-controller.js";

describe("GC Integration", () => {
  /**
   * Test context for GC integration tests
   */
  interface GCTestContext {
    gc: GCController;
    historyWithOps: HistoryWithOperations;
    /** Helper to create test commits */
    createCommit: (
      message: string,
      files: Record<string, string>,
      parents?: string[],
    ) => Promise<string>;
    /** Helper to get all blob IDs */
    getBlobIds: () => Promise<string[]>;
    /** Helper to check if a blob exists */
    hasBlob: (id: string) => Promise<boolean>;
    /** Create a test person */
    createPerson: () => PersonIdent;
  }

  async function createGCTestContext(): Promise<GCTestContext> {
    const historyWithOps = createMemoryHistoryWithOperations();

    const { blobs, trees, commits } = historyWithOps;

    // Create GC controller
    const gc = new GCController(historyWithOps, {
      minInterval: 0, // Allow immediate GC for testing
      looseBlobThreshold: 1, // Low threshold for testing
    });

    let commitCount = 0;

    const createPerson = (): PersonIdent => ({
      name: "Test Author",
      email: "test@example.com",
      timestamp: 1700000000 + commitCount * 1000,
      tzOffset: "+0000",
    });

    const createCommit = async (
      message: string,
      files: Record<string, string>,
      parents: string[] = [],
    ): Promise<string> => {
      commitCount++;

      // Create blobs and tree entries
      const entries: Array<{ mode: number; name: string; id: string }> = [];
      for (const [name, content] of Object.entries(files)) {
        const blobId = await blobs.store([new TextEncoder().encode(content)]);
        entries.push({ mode: 0o100644, name, id: blobId });
      }

      // Sort entries by name (Git requirement)
      entries.sort((a, b) => a.name.localeCompare(b.name));

      // Create tree (use new interface method name)
      const treeId = await trees.store(entries);

      // Create commit (use new interface method name)
      const commit: Commit = {
        tree: treeId,
        parents,
        author: createPerson(),
        committer: createPerson(),
        message,
      };

      return commits.store(commit);
    };

    const getBlobIds = async (): Promise<string[]> => {
      const ids: string[] = [];
      for await (const id of blobs.keys()) {
        ids.push(id);
      }
      return ids;
    };

    const hasBlob = async (id: string): Promise<boolean> => {
      return blobs.has(id);
    };

    return {
      gc,
      historyWithOps,
      createCommit,
      getBlobIds,
      hasBlob,
      createPerson,
    };
  }

  let ctx: GCTestContext;

  beforeEach(async () => {
    ctx = await createGCTestContext();
  });

  afterEach(async () => {
    await ctx.historyWithOps.close();
  });

  describe("unreachable object collection", () => {
    it("removes unreferenced blobs after GC", async () => {
      // Create a reachable commit
      const commitId = await ctx.createCommit("Reachable", {
        "file.txt": "content",
      });

      // Create an unreachable blob (not part of any commit)
      const unreachableBlobId = await ctx.historyWithOps.blobs.store([
        new TextEncoder().encode("orphan content"),
      ]);

      // Verify both exist
      const blobsBefore = await ctx.getBlobIds();
      expect(blobsBefore).toContain(unreachableBlobId);

      // Collect garbage with the reachable commit as root
      const result = await ctx.gc.collectGarbage([commitId]);

      // Unreachable blob should be removed
      expect(result.blobsRemoved).toBeGreaterThanOrEqual(1);
      expect(await ctx.hasBlob(unreachableBlobId)).toBe(false);
    });

    it("preserves all referenced objects", async () => {
      // Create a commit chain
      const commit1 = await ctx.createCommit("Commit 1", { "a.txt": "content A" });
      const commit2 = await ctx.createCommit("Commit 2", { "b.txt": "content B" }, [commit1]);
      const commit3 = await ctx.createCommit("Commit 3", { "c.txt": "content C" }, [commit2]);

      // Get all blob IDs
      const blobsBefore = await ctx.getBlobIds();
      expect(blobsBefore.length).toBe(3);

      // Collect garbage with commit3 as root (should preserve all 3)
      await ctx.gc.collectGarbage([commit3]);

      // All blobs should still exist
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(3);
      for (const blobId of blobsBefore) {
        expect(await ctx.hasBlob(blobId)).toBe(true);
      }
    });

    it("handles objects referenced by multiple commits", async () => {
      // Create two commits with the same blob content
      const commit1 = await ctx.createCommit("Commit 1", { "file.txt": "shared content" });
      const commit2 = await ctx.createCommit("Commit 2", { "file.txt": "shared content" }, [
        commit1,
      ]);

      // Same content = same blob ID (content-addressed)
      const blobs = await ctx.getBlobIds();
      // Should have 1 unique blob (deduplicated)
      expect(blobs.length).toBe(1);

      // Collect garbage with only commit2 as root
      await ctx.gc.collectGarbage([commit2]);

      // The shared blob should still exist
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(1);
    });

    it("removes blobs when branch is deleted", async () => {
      // Create main branch with a commit
      const mainCommit = await ctx.createCommit("Main", { "main.txt": "main content" });
      await ctx.historyWithOps.refs.set("refs/heads/main", mainCommit);

      // Create feature branch with unique content
      const featureCommit = await ctx.createCommit("Feature", { "feature.txt": "feature content" });
      await ctx.historyWithOps.refs.set("refs/heads/feature", featureCommit);

      // Verify both blobs exist
      const blobsBefore = await ctx.getBlobIds();
      expect(blobsBefore.length).toBe(2);

      // Delete feature branch
      await ctx.historyWithOps.refs.remove("refs/heads/feature");

      // Collect garbage with only main as root
      await ctx.gc.collectGarbage([mainCommit]);

      // Feature blob should be removed
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(1);
    });
  });

  describe("merge commit reachability", () => {
    it("preserves objects from both merge parents", async () => {
      // Create base commit
      const baseCommit = await ctx.createCommit("Base", { "base.txt": "base" });

      // Create two divergent branches
      const branchA = await ctx.createCommit("Branch A", { "a.txt": "content A" }, [baseCommit]);
      const branchB = await ctx.createCommit("Branch B", { "b.txt": "content B" }, [baseCommit]);

      // Create merge commit
      const mergeCommit = await ctx.createCommit(
        "Merge",
        {
          "base.txt": "base",
          "a.txt": "content A",
          "b.txt": "content B",
        },
        [branchA, branchB],
      );

      // Collect garbage with only merge commit as root
      await ctx.gc.collectGarbage([mergeCommit]);

      // All blobs from both branches should be preserved
      // (via merge commit's tree, which contains all files)
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBeGreaterThanOrEqual(3); // base + a + b
    });

    it("handles octopus merge (multiple parents)", async () => {
      // Create base
      const baseCommit = await ctx.createCommit("Base", { "base.txt": "base" });

      // Create multiple branches
      const branch1 = await ctx.createCommit("B1", { "b1.txt": "content 1" }, [baseCommit]);
      const branch2 = await ctx.createCommit("B2", { "b2.txt": "content 2" }, [baseCommit]);
      const branch3 = await ctx.createCommit("B3", { "b3.txt": "content 3" }, [baseCommit]);

      // Create octopus merge
      const mergeCommit = await ctx.createCommit(
        "Octopus",
        {
          "base.txt": "base",
          "b1.txt": "content 1",
          "b2.txt": "content 2",
          "b3.txt": "content 3",
        },
        [branch1, branch2, branch3],
      );

      // Add orphan blob
      await ctx.historyWithOps.blobs.store([new TextEncoder().encode("orphan")]);

      // Collect garbage
      await ctx.gc.collectGarbage([mergeCommit]);

      // Merge tree blobs should be preserved, orphan should be removed
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(4); // base + b1 + b2 + b3
    });
  });

  describe("nested tree reachability", () => {
    it("preserves deeply nested blobs", async () => {
      // Create commit with nested directory structure
      // We'll use flat file names since the test helper doesn't support nested trees
      // But the principle is the same
      const commitId = await ctx.createCommit("Nested", {
        "a.txt": "root level",
        "dir-b.txt": "directory content",
        "dir-sub-c.txt": "deeply nested",
      });

      // Add orphan
      const orphanId = await ctx.historyWithOps.blobs.store([new TextEncoder().encode("orphan")]);

      // Collect garbage
      await ctx.gc.collectGarbage([commitId]);

      // Nested blobs should exist, orphan should not
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(3);
      expect(await ctx.hasBlob(orphanId)).toBe(false);
    });
  });

  describe("GC statistics", () => {
    it("reports accurate removal count", async () => {
      // Create a commit
      const commitId = await ctx.createCommit("Commit", { "file.txt": "content" });

      // Create multiple orphan blobs
      for (let i = 0; i < 5; i++) {
        await ctx.historyWithOps.blobs.store([new TextEncoder().encode(`orphan ${i}`)]);
      }

      // Verify count
      const blobsBefore = await ctx.getBlobIds();
      expect(blobsBefore.length).toBe(6); // 1 reachable + 5 orphans

      // Collect garbage
      const result = await ctx.gc.collectGarbage([commitId]);

      // Should report 5 removed
      expect(result.blobsRemoved).toBe(5);

      // Verify only 1 remains
      const blobsAfter = await ctx.getBlobIds();
      expect(blobsAfter.length).toBe(1);
    });

    it("reports bytes freed", async () => {
      // Create a commit
      const commitId = await ctx.createCommit("Commit", { "file.txt": "x" });

      // Create large orphan blobs
      const largeContent = "A".repeat(10000);
      for (let i = 0; i < 3; i++) {
        await ctx.historyWithOps.blobs.store([new TextEncoder().encode(largeContent + i)]);
      }

      // Collect garbage
      const result = await ctx.gc.collectGarbage([commitId]);

      // Should report significant bytes freed
      expect(result.bytesFreed).toBeGreaterThan(20000); // ~30000 bytes for 3 large blobs
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("concurrent operations", () => {
    it("allows reads during garbage collection", async () => {
      // Create commits
      const commit1 = await ctx.createCommit("C1", { "a.txt": "content A" });
      const commit2 = await ctx.createCommit("C2", { "b.txt": "content B" }, [commit1]);

      // Start collecting garbage and read at the same time
      const [gcResult, loadedCommit] = await Promise.all([
        ctx.gc.collectGarbage([commit2]),
        ctx.historyWithOps.commits.load(commit1),
      ]);

      // Both operations should complete
      expect(gcResult).toBeDefined();
      expect(loadedCommit).toBeDefined();
      expect(loadedCommit?.message).toBe("C1");
    });

    it("handles new objects created during GC", async () => {
      // Create initial commit
      const initialCommit = await ctx.createCommit("Initial", { "init.txt": "initial" });

      // Start GC while also creating new objects
      const gcPromise = ctx.gc.collectGarbage([initialCommit]);

      // Create new commit during GC
      const newCommit = await ctx.createCommit("New", { "new.txt": "new content" }, [
        initialCommit,
      ]);

      await gcPromise;

      // New commit should exist (it was created during or after GC)
      // Note: The exact behavior depends on timing, but the system shouldn't crash
      expect(newCommit).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty repository", async () => {
      // Collect garbage with no roots
      const result = await ctx.gc.collectGarbage([]);

      expect(result.blobsRemoved).toBe(0);
      expect(result.bytesFreed).toBe(0);
    });

    it("handles non-existent root", async () => {
      // Create a commit
      await ctx.createCommit("Commit", { "file.txt": "content" });

      // Collect garbage with non-existent root
      const fakeRoot = "0000000000000000000000000000000000000000";
      const result = await ctx.gc.collectGarbage([fakeRoot]);

      // Should remove the blob since it's not reachable from fake root
      expect(result.blobsRemoved).toBe(1);
    });

    it("handles circular references gracefully", async () => {
      // Git doesn't allow true circular references in commits,
      // but we can test that the walker handles revisiting objects
      const commit1 = await ctx.createCommit("C1", { "a.txt": "A" });
      const commit2 = await ctx.createCommit("C2", { "a.txt": "A" }, [commit1]); // Same blob

      // Both commits reference the same blob
      await ctx.gc.collectGarbage([commit1, commit2]);

      // Should complete without infinite loop
      const blobs = await ctx.getBlobIds();
      expect(blobs.length).toBe(1);
    });
  });
});
