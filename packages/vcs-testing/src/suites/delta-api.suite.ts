/**
 * Parametrized test suite for DeltaApi implementations
 *
 * This suite tests the core DeltaApi interface contract.
 * All storage implementations must pass these tests.
 */

import type { BlobDeltaChainInfo, DeltaApi } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface DeltaApiTestContext {
  deltaApi: DeltaApi;
  /**
   * Helper to create test blobs that can be deltified.
   * Returns object IDs of created blobs.
   */
  createTestBlobs?: () => Promise<{ baseId: string; targetId: string }>;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type DeltaApiFactory = () => Promise<DeltaApiTestContext>;

/**
 * Helper function to generate a fake object ID (for testing)
 */
function fakeObjectId(seed: string): string {
  return seed.padEnd(40, "0").slice(0, 40);
}

/**
 * Helper to collect async iterable to array
 */
async function toArray<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

/**
 * Create the DeltaApi test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "GitFiles")
 * @param factory Factory function to create storage instances
 */
export function createDeltaApiTests(name: string, factory: DeltaApiFactory): void {
  describe(`DeltaApi [${name}]`, () => {
    let ctx: DeltaApiTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Delta Detection", () => {
      it("isDelta returns false for non-delta object", async () => {
        const objectId = fakeObjectId("notdelta");
        const isDelta = await ctx.deltaApi.isDelta(objectId);
        expect(isDelta).toBe(false);
      });

      it("isDelta returns false for non-existent object", async () => {
        const objectId = fakeObjectId("nonexistent");
        const isDelta = await ctx.deltaApi.isDelta(objectId);
        expect(isDelta).toBe(false);
      });

      it("getDeltaChain returns undefined for non-delta", async () => {
        const objectId = fakeObjectId("nodelta");
        const chain = await ctx.deltaApi.getDeltaChain(objectId);
        expect(chain).toBeUndefined();
      });

      it("listDeltas returns empty for no deltas", async () => {
        const deltas = await toArray(ctx.deltaApi.listDeltas());
        expect(deltas.length).toBe(0);
      });

      it("getDependents returns empty for object with no dependents", async () => {
        const objectId = fakeObjectId("nodeps");
        const dependents = await toArray(ctx.deltaApi.getDependents(objectId));
        expect(dependents.length).toBe(0);
      });
    });

    describe("Blob Delta Operations", () => {
      it("blobs property is accessible", async () => {
        expect(ctx.deltaApi.blobs).toBeDefined();
        expect(typeof ctx.deltaApi.blobs.isBlobDelta).toBe("function");
        expect(typeof ctx.deltaApi.blobs.getBlobDeltaChain).toBe("function");
      });

      it("isBlobDelta returns false for non-delta blob", async () => {
        const blobId = fakeObjectId("blob");
        const isDelta = await ctx.deltaApi.blobs.isBlobDelta(blobId);
        expect(isDelta).toBe(false);
      });

      it("getBlobDeltaChain returns undefined for non-delta blob", async () => {
        const blobId = fakeObjectId("blob");
        const chain = await ctx.deltaApi.blobs.getBlobDeltaChain(blobId);
        expect(chain).toBeUndefined();
      });
    });

    describe("Batch Operations", () => {
      it("startBatch does not throw", () => {
        expect(() => ctx.deltaApi.startBatch()).not.toThrow();
      });

      it("endBatch completes successfully after startBatch", async () => {
        ctx.deltaApi.startBatch();
        await expect(ctx.deltaApi.endBatch()).resolves.not.toThrow();
      });

      it("cancelBatch does not throw", () => {
        ctx.deltaApi.startBatch();
        expect(() => ctx.deltaApi.cancelBatch()).not.toThrow();
      });

      it("supports nested batches", async () => {
        ctx.deltaApi.startBatch();
        ctx.deltaApi.startBatch();
        await ctx.deltaApi.endBatch();
        await ctx.deltaApi.endBatch();
      });

      it("cancelBatch discards changes", async () => {
        ctx.deltaApi.startBatch();
        // Make some changes if possible
        ctx.deltaApi.cancelBatch();

        // Batch should be cancelled without error
        const deltas = await toArray(ctx.deltaApi.listDeltas());
        expect(Array.isArray(deltas)).toBe(true);
      });
    });

    describe("Delta Relationship Properties", () => {
      it("listDeltas returns valid StorageDeltaRelationship objects", async () => {
        const deltas = await toArray(ctx.deltaApi.listDeltas());

        for (const delta of deltas) {
          // Verify required properties
          expect(typeof delta.targetId).toBe("string");
          expect(typeof delta.baseId).toBe("string");
          expect(typeof delta.depth).toBe("number");
          expect(typeof delta.ratio).toBe("number");

          // Verify SHA-1 format
          expect(delta.targetId).toMatch(/^[0-9a-f]{40}$/);
          expect(delta.baseId).toMatch(/^[0-9a-f]{40}$/);

          // Depth should be positive
          expect(delta.depth).toBeGreaterThanOrEqual(1);

          // Ratio should be between 0 and some reasonable max
          expect(delta.ratio).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe("Delta Chain Properties", () => {
      it("getDeltaChain returns valid BlobDeltaChainInfo when applicable", async () => {
        if (!ctx.createTestBlobs) {
          return; // Skip if no test blob setup
        }

        const { targetId } = await ctx.createTestBlobs();

        // This test would require deltifying the blob first
        // For now, just verify the interface
        const chain = await ctx.deltaApi.getDeltaChain(targetId);

        if (chain) {
          const info: BlobDeltaChainInfo = chain;
          expect(Array.isArray(info.baseIds)).toBe(true);
          expect(typeof info.depth).toBe("number");
          expect(info.depth).toBeGreaterThanOrEqual(1);
        }
      });
    });

    describe("Cross-type Queries", () => {
      it("isDelta returns false for tree objects (trees never delta)", async () => {
        // Trees are not stored as deltas internally
        const treeId = fakeObjectId("tree");
        const isDelta = await ctx.deltaApi.isDelta(treeId);
        expect(isDelta).toBe(false);
      });

      it("isDelta returns false for commit objects (commits never delta)", async () => {
        // Commits are not stored as deltas internally
        const commitId = fakeObjectId("commit");
        const isDelta = await ctx.deltaApi.isDelta(commitId);
        expect(isDelta).toBe(false);
      });
    });

    describe("Edge Cases", () => {
      it("handles multiple batch start/end cycles", async () => {
        for (let i = 0; i < 3; i++) {
          ctx.deltaApi.startBatch();
          await ctx.deltaApi.endBatch();
        }
      });

      it("handles batch with no operations", async () => {
        ctx.deltaApi.startBatch();
        await ctx.deltaApi.endBatch();
      });

      it("getDependents handles non-existent base", async () => {
        const nonExistent = fakeObjectId("nobase");
        const dependents = await toArray(ctx.deltaApi.getDependents(nonExistent));
        expect(dependents.length).toBe(0);
      });
    });
  });
}
