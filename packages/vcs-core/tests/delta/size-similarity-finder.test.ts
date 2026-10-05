/**
 * Tests for SizeSimilarityCandidateFinder
 */

import { describe, expect, it } from "vitest";
import type { Blobs } from "../../src/history/blobs/blobs.js";
import { ObjectType } from "../../src/history/objects/object-types.js";
import { SizeSimilarityCandidateFinder } from "../../src/storage/delta/candidate-finder/size-similarity-finder.js";
import type { DeltaTarget } from "../../src/storage/delta/candidate-finder.js";

/**
 * Create a mock Blobs for testing
 */
function createMockBlobStore(blobs: { id: string; size: number }[]): Blobs {
  const blobMap = new Map(blobs.map((b) => [b.id, b.size]));

  return {
    has: async (id) => blobMap.has(id),
    keys: async function* () {
      for (const id of blobMap.keys()) {
        yield id;
      }
    },
    size: async (id) => {
      const size = blobMap.get(id);
      if (size === undefined) throw new Error(`Blob not found: ${id}`);
      return size;
    },
    load: () => {
      throw new Error("Not implemented");
    },
    store: async () => "",
    remove: async () => false,
  };
}

describe("SizeSimilarityCandidateFinder", () => {
  describe("findCandidates", () => {
    it("finds candidates with similar sizes within tolerance", async () => {
      const blobs = [
        { id: "obj100", size: 100 },
        { id: "obj105", size: 105 },
        { id: "obj110", size: 110 },
        { id: "obj200", size: 200 },
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.2 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      // Within 20% of 100: 80-120
      expect(candidates).toContain("obj100");
      expect(candidates).toContain("obj105");
      expect(candidates).toContain("obj110");
      expect(candidates).not.toContain("obj200");
    });

    it("excludes objects outside tolerance range", async () => {
      const blobs = [
        { id: "obj50", size: 50 },
        { id: "obj100", size: 100 },
        { id: "obj200", size: 200 },
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.1 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      // Within 10% of 100: 90-110
      expect(candidates).toContain("obj100");
      expect(candidates).not.toContain("obj50");
      expect(candidates).not.toContain("obj200");
    });

    it("calculates similarity based on size difference", async () => {
      const blobs = [
        { id: "exact", size: 100 },
        { id: "close", size: 105 },
        { id: "far", size: 140 },
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.5 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: { id: string; similarity: number }[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push({ id: c.id, similarity: c.similarity });
      }

      // Exact match should have highest similarity (1.0)
      const exact = candidates.find((c) => c.id === "exact");
      expect(exact?.similarity).toBe(1.0);

      // Close match should have high similarity
      const close = candidates.find((c) => c.id === "close");
      expect(close?.similarity).toBeGreaterThan(0.9);

      // Far match should have lower similarity
      const far = candidates.find((c) => c.id === "far");
      expect(far?.similarity).toBeLessThan(close?.similarity ?? 0);
    });

    it("respects maxCandidates limit", async () => {
      const blobs = Array.from({ length: 20 }, (_, i) => ({
        id: `obj${i}`,
        size: 100 + i,
      }));

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, {
        tolerance: 0.5,
        maxCandidates: 5,
      });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      expect(candidates).toHaveLength(5);
    });

    it("returns candidates sorted by similarity", async () => {
      const blobs = [
        { id: "far", size: 150 },
        { id: "exact", size: 100 },
        { id: "close", size: 105 },
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.5 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidateIds: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidateIds.push(c.id);
      }

      // Should be sorted: exact, close, far
      expect(candidateIds[0]).toBe("exact");
      expect(candidateIds[1]).toBe("close");
      expect(candidateIds[2]).toBe("far");
    });

    it("sets reason to 'similar-size' and type to BLOB", async () => {
      const blobs = [{ id: "obj100", size: 100 }];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.5 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      for await (const c of finder.findCandidates(target)) {
        expect(c.reason).toBe("similar-size");
        expect(c.type).toBe(ObjectType.BLOB);
      }
    });

    it("handles empty storage", async () => {
      const blobStore = createMockBlobStore([]);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.5 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      expect(candidates).toHaveLength(0);
    });

    it("excludes target object from candidates", async () => {
      const blobs = [
        { id: "target", size: 100 },
        { id: "other", size: 100 },
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, { tolerance: 0.5 });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      expect(candidates).not.toContain("target");
      expect(candidates).toContain("other");
    });

    it("respects minSimilarity threshold", async () => {
      const blobs = [
        { id: "exact", size: 100 },
        { id: "far", size: 140 }, // 60% similarity
      ];

      const blobStore = createMockBlobStore(blobs);
      const finder = new SizeSimilarityCandidateFinder(blobStore, {
        tolerance: 0.5,
        minSimilarity: 0.7,
      });

      const target: DeltaTarget = { id: "target", type: ObjectType.BLOB, size: 100 };
      const candidates: string[] = [];
      for await (const c of finder.findCandidates(target)) {
        candidates.push(c.id);
      }

      expect(candidates).toContain("exact");
      expect(candidates).not.toContain("far");
    });
  });
});
