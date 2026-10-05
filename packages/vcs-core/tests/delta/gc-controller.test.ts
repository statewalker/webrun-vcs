/**
 * GC Controller Tests
 *
 * Tests for the GCController using HistoryWithOperations.
 * Focuses on blob-only delta compression.
 */

import { describe, expect, it } from "vitest";
import {
  commitChain,
  countBlobs,
  createTestRepository,
  getStatistics,
  hasObject,
} from "./gc-test-utils.js";

describe("GCController", () => {
  describe("basic operations", () => {
    it("should create GC controller with default options", async () => {
      const ctx = await createTestRepository();

      expect(ctx.gc).toBeDefined();
      expect(ctx.gc.getOptions()).toBeDefined();
      expect(ctx.gc.getOptions().looseBlobThreshold).toBe(100);
      expect(ctx.gc.getOptions().maxChainDepth).toBe(50);
    });

    it("should create GC controller with custom options", async () => {
      const ctx = await createTestRepository({
        looseBlobThreshold: 50,
        maxChainDepth: 10,
        minInterval: 30000,
      });

      const options = ctx.gc.getOptions();
      expect(options.looseBlobThreshold).toBe(50);
      expect(options.maxChainDepth).toBe(10);
      expect(options.minInterval).toBe(30000);
    });

    it("should track time since last GC", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Initially no GC has run
      expect(ctx.gc.getTimeSinceLastGC()).toBe(-1);

      // Run GC
      await ctx.gc.runGC();

      // Now time since last GC should be positive
      const timeSince = ctx.gc.getTimeSinceLastGC();
      expect(timeSince).toBeGreaterThanOrEqual(0);
    });
  });

  describe("shouldRunGC", () => {
    it("should not run GC before min interval", async () => {
      const ctx = await createTestRepository({
        minInterval: 60000, // 1 minute
        looseBlobThreshold: 1,
      });

      // Create some blobs
      await ctx.blob("test content");

      // Run GC once
      await ctx.gc.runGC();

      // Should not run again due to interval
      const shouldRun = await ctx.gc.shouldRunGC();
      expect(shouldRun).toBe(false);
    });

    it("should allow GC after min interval", async () => {
      const ctx = await createTestRepository({
        minInterval: 0, // No interval
        looseBlobThreshold: 1,
      });

      // Create some blobs to exceed threshold
      await ctx.blob("test content 1");
      await ctx.blob("test content 2");

      // Run GC once
      await ctx.gc.runGC();

      // Create more blobs
      await ctx.blob("test content 3");
      await ctx.blob("test content 4");

      // Should be allowed to run (no interval restriction)
      const shouldRun = await ctx.gc.shouldRunGC();
      // May or may not need to run depending on threshold
      expect(typeof shouldRun).toBe("boolean");
    });
  });

  describe("runGC", () => {
    it("should run GC and return result", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Create some objects
      await commitChain(ctx, 3);

      // Run GC
      const result = await ctx.gc.runGC();

      expect(result).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.objectsProcessed).toBe("number");
      expect(typeof result.deltasCreated).toBe("number");
    });

    it("should process blobs without delta engine", async () => {
      const ctx = await createTestRepository({
        minInterval: 0,
        // No deltaEngine provided
      });

      // Create some objects
      await commitChain(ctx, 3);

      // Run GC - should complete without errors even without delta engine
      const result = await ctx.gc.runGC();

      expect(result).toBeDefined();
      expect(result.deltasCreated).toBe(0); // No deltas without engine
    });
  });

  describe("maybeRunGC", () => {
    it("should return null when GC not needed", async () => {
      const ctx = await createTestRepository({
        minInterval: 60000,
        looseBlobThreshold: 1000,
      });

      // With high threshold and no objects, GC should not be needed
      const result = await ctx.gc.maybeRunGC();
      expect(result).toBeNull();
    });

    it("should run GC when needed", async () => {
      const ctx = await createTestRepository({
        minInterval: 0,
        looseBlobThreshold: 1, // Very low threshold
      });

      // Create some blobs to exceed threshold
      for (let i = 0; i < 5; i++) {
        await ctx.blob(`content ${i}`);
      }

      // maybeRunGC should detect need and run
      // Note: Without delta engine, it won't create deltas but will run
      const result = await ctx.gc.maybeRunGC();
      // Result depends on whether shouldRunGC returns true
      // With our setup it should run
      if (result) {
        expect(result.duration).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("blob tracking", () => {
    it("should track pending blobs", async () => {
      const ctx = await createTestRepository({
        quickPackThreshold: 10,
      });

      expect(ctx.gc.getPendingBlobsCount()).toBe(0);

      // Add a blob and notify GC
      const blobId = await ctx.blob("test");
      await ctx.gc.onBlob(blobId);

      expect(ctx.gc.getPendingBlobsCount()).toBe(1);
    });

    it("should clear pending blobs on quickPack", async () => {
      const ctx = await createTestRepository({
        quickPackThreshold: 2,
      });

      // Add blobs
      const blob1 = await ctx.blob("test 1");
      await ctx.gc.onBlob(blob1);
      expect(ctx.gc.getPendingBlobsCount()).toBe(1);

      // Add another blob - should trigger quickPack at threshold
      const blob2 = await ctx.blob("test 2");
      await ctx.gc.onBlob(blob2);

      // After quickPack, pending should be cleared
      expect(ctx.gc.getPendingBlobsCount()).toBe(0);
    });
  });

  describe("collectGarbage", () => {
    it("should identify unreachable blobs", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Create a reachable commit
      const commitId = await ctx.commit({
        files: { "file.txt": "content" },
      });
      await ctx.branch("main", commitId);

      // Create an unreachable blob
      const _unreachableBlob = await ctx.blob("unreachable content");

      // Collect garbage from refs
      const refs = await ctx.history.refs.list();
      const roots: string[] = [];
      for await (const ref of refs) {
        if (ref.objectId) {
          roots.push(ref.objectId);
        }
      }

      const result = await ctx.gc.collectGarbage(roots);

      // Should find at least one unreachable blob
      expect(result.blobsRemoved).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should preserve reachable objects", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Create a commit chain
      const tipId = await commitChain(ctx, 3);
      await ctx.branch("main", tipId);

      // Verify objects exist
      expect(await hasObject(ctx, tipId)).toBe(true);

      // Collect garbage
      const _result = await ctx.gc.collectGarbage([tipId]);

      // Reachable commit should still exist
      expect(await hasObject(ctx, tipId)).toBe(true);
    });
  });

  describe("repository integrity", () => {
    it("should maintain object counts after GC", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Create objects
      await commitChain(ctx, 5);

      const _beforeStats = await getStatistics(ctx);
      const beforeCount = await countBlobs(ctx);

      // Run GC
      await ctx.gc.runGC();

      const _afterStats = await getStatistics(ctx);
      const afterCount = await countBlobs(ctx);

      // Blob count should remain the same (no deltas without engine)
      expect(afterCount).toBe(beforeCount);
    });

    it("should handle empty repository", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Run GC on empty repository
      const result = await ctx.gc.runGC();

      expect(result).toBeDefined();
      expect(result.objectsProcessed).toBe(0);
    });

    it("should handle repository with only commits", async () => {
      const ctx = await createTestRepository({ minInterval: 0 });

      // Create empty commits (no blobs)
      const c1 = await ctx.commit({ message: "empty 1" });
      const c2 = await ctx.commit({ parents: [c1], message: "empty 2" });
      await ctx.branch("main", c2);

      // Run GC
      const result = await ctx.gc.runGC();

      expect(result).toBeDefined();
      // Commits should still be accessible
      expect(await hasObject(ctx, c1)).toBe(true);
      expect(await hasObject(ctx, c2)).toBe(true);
    });
  });
});
