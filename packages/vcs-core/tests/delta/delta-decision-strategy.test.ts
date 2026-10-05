/**
 * Tests for DeltaDecisionStrategy implementations
 */

import { describe, expect, it } from "vitest";
import { ObjectType } from "../../src/history/objects/object-types.js";
import type { DeltaCandidate, DeltaTarget } from "../../src/storage/delta/candidate-finder.js";
import type { DeltaResult } from "../../src/storage/delta/delta-compressor.js";
import {
  createBlobOnlyStrategy,
  createGitNativeStrategy,
  createNetworkStrategy,
  createPackStrategy,
  DefaultDeltaDecisionStrategy,
} from "../../src/storage/delta/strategy/default-delta-decision-strategy.js";

describe("DefaultDeltaDecisionStrategy", () => {
  describe("shouldAttemptDelta", () => {
    it("returns true for objects within size limits", () => {
      const strategy = new DefaultDeltaDecisionStrategy();

      const target: DeltaTarget = {
        id: "test-id",
        type: ObjectType.BLOB,
        size: 1024,
      };

      expect(strategy.shouldAttemptDelta(target)).toBe(true);
    });

    it("returns false for objects below minimum size", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        minObjectSize: 100,
      });

      const target: DeltaTarget = {
        id: "test-id",
        type: ObjectType.BLOB,
        size: 50,
      };

      expect(strategy.shouldAttemptDelta(target)).toBe(false);
    });

    it("returns false for objects above maximum size", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        maxObjectSize: 1024,
      });

      const target: DeltaTarget = {
        id: "test-id",
        type: ObjectType.BLOB,
        size: 2048,
      };

      expect(strategy.shouldAttemptDelta(target)).toBe(false);
    });

    it("filters by allowed types when specified", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        allowedTypes: [ObjectType.BLOB],
      });

      const blobTarget: DeltaTarget = {
        id: "blob-id",
        type: ObjectType.BLOB,
        size: 1024,
      };

      const treeTarget: DeltaTarget = {
        id: "tree-id",
        type: ObjectType.TREE,
        size: 1024,
      };

      expect(strategy.shouldAttemptDelta(blobTarget)).toBe(true);
      expect(strategy.shouldAttemptDelta(treeTarget)).toBe(false);
    });

    it("allows all types when allowedTypes is empty", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        allowedTypes: [],
      });

      const blobTarget: DeltaTarget = {
        id: "id",
        type: ObjectType.BLOB,
        size: 1024,
      };
      const treeTarget: DeltaTarget = {
        id: "id",
        type: ObjectType.TREE,
        size: 1024,
      };
      const commitTarget: DeltaTarget = {
        id: "id",
        type: ObjectType.COMMIT,
        size: 1024,
      };

      expect(strategy.shouldAttemptDelta(blobTarget)).toBe(true);
      expect(strategy.shouldAttemptDelta(treeTarget)).toBe(true);
      expect(strategy.shouldAttemptDelta(commitTarget)).toBe(true);
    });
  });

  describe("shouldUseDelta", () => {
    const candidate: DeltaCandidate = {
      id: "base-id",
      type: ObjectType.BLOB,
      size: 1000,
      similarity: 0.8,
      reason: "similar-size",
    };

    it("returns true when compression ratio exceeds threshold", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        minCompressionRatio: 1.5,
        minBytesSaved: 0,
      });

      const result: DeltaResult = {
        baseId: "base-id",
        deltaSize: 400,
        originalSize: 1000,
        ratio: 2.5,
        savings: 600,
      };

      expect(strategy.shouldUseDelta(result, candidate)).toBe(true);
    });

    it("returns false when compression ratio is below threshold", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        minCompressionRatio: 2.0,
      });

      const result: DeltaResult = {
        baseId: "base-id",
        deltaSize: 600,
        originalSize: 1000,
        ratio: 1.67,
        savings: 400,
      };

      expect(strategy.shouldUseDelta(result, candidate)).toBe(false);
    });

    it("returns false when bytes saved is below threshold", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        minCompressionRatio: 1.0,
        minBytesSaved: 100,
      });

      const result: DeltaResult = {
        baseId: "base-id",
        deltaSize: 950,
        originalSize: 1000,
        ratio: 1.05,
        savings: 50,
      };

      expect(strategy.shouldUseDelta(result, candidate)).toBe(false);
    });
  });

  describe("maxChainDepth", () => {
    it("returns configured chain depth", () => {
      const strategy = new DefaultDeltaDecisionStrategy({
        maxChainDepth: 25,
      });

      expect(strategy.maxChainDepth).toBe(25);
    });

    it("returns default chain depth when not configured", () => {
      const strategy = new DefaultDeltaDecisionStrategy();
      expect(strategy.maxChainDepth).toBe(50);
    });
  });
});

describe("Pre-configured strategies", () => {
  describe("createGitNativeStrategy", () => {
    it("allows all object types", () => {
      const strategy = createGitNativeStrategy();

      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 1024,
        }),
      ).toBe(true);
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.TREE,
          size: 1024,
        }),
      ).toBe(true);
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.COMMIT,
          size: 1024,
        }),
      ).toBe(true);
    });

    it("has max chain depth of 50", () => {
      const strategy = createGitNativeStrategy();
      expect(strategy.maxChainDepth).toBe(50);
    });
  });

  describe("createBlobOnlyStrategy", () => {
    it("only allows specified types", () => {
      const strategy = createBlobOnlyStrategy([ObjectType.BLOB]);

      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 1024,
        }),
      ).toBe(true);
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.TREE,
          size: 1024,
        }),
      ).toBe(false);
    });

    it("has shorter chain depth for random access", () => {
      const strategy = createBlobOnlyStrategy([ObjectType.BLOB]);
      expect(strategy.maxChainDepth).toBe(10);
    });

    it("has higher compression ratio threshold", () => {
      const strategy = createBlobOnlyStrategy([ObjectType.BLOB]);

      const candidate: DeltaCandidate = {
        id: "base",
        type: ObjectType.BLOB,
        size: 1000,
        similarity: 0.8,
        reason: "similar-size",
      };

      // Ratio 1.8 should be rejected (threshold is 2.0)
      expect(
        strategy.shouldUseDelta(
          {
            baseId: "base",
            deltaSize: 555,
            originalSize: 1000,
            ratio: 1.8,
            savings: 445,
          },
          candidate,
        ),
      ).toBe(false);

      // Ratio 2.5 should be accepted
      expect(
        strategy.shouldUseDelta(
          {
            baseId: "base",
            deltaSize: 400,
            originalSize: 1000,
            ratio: 2.5,
            savings: 600,
          },
          candidate,
        ),
      ).toBe(true);
    });
  });

  describe("createPackStrategy", () => {
    it("has lower compression ratio threshold", () => {
      const strategy = createPackStrategy();

      const candidate: DeltaCandidate = {
        id: "base",
        type: ObjectType.BLOB,
        size: 1000,
        similarity: 0.8,
        reason: "similar-size",
      };

      // Any savings helps - ratio 1.1 should be accepted
      expect(
        strategy.shouldUseDelta(
          {
            baseId: "base",
            deltaSize: 900,
            originalSize: 1000,
            ratio: 1.11,
            savings: 100,
          },
          candidate,
        ),
      ).toBe(true);
    });

    it("has smaller minimum object size", () => {
      const strategy = createPackStrategy();
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 40,
        }),
      ).toBe(true);
    });
  });

  describe("createNetworkStrategy", () => {
    it("skips very small objects", () => {
      const strategy = createNetworkStrategy();
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 64,
        }),
      ).toBe(false);
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 256,
        }),
      ).toBe(true);
    });

    it("skips very large objects", () => {
      const strategy = createNetworkStrategy();
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 10 * 1024 * 1024,
        }),
      ).toBe(true);
      expect(
        strategy.shouldAttemptDelta({
          id: "id",
          type: ObjectType.BLOB,
          size: 20 * 1024 * 1024,
        }),
      ).toBe(false);
    });

    it("has shorter chain depth for streaming", () => {
      const strategy = createNetworkStrategy();
      expect(strategy.maxChainDepth).toBe(10);
    });
  });
});
