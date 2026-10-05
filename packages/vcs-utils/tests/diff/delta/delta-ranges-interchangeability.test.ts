import { describe, expect, it } from "vitest";
import {
  applyDelta,
  createDelta,
  createDeltaRanges,
  createFossilLikeRanges,
  type DeltaRange,
  mergeChunks,
} from "../../../src/diff/index.js";

/**
 * This test suite verifies that createDeltaRanges and createFossilLikeRanges
 * can be used interchangeably with createDelta and applyDelta.
 */
describe("Delta Ranges Interchangeability", () => {
  /**
   * Helper to run a complete delta cycle and verify the result
   */
  function testDeltaCycle(
    source: Uint8Array,
    target: Uint8Array,
    rangeGenerator: (source: Uint8Array, target: Uint8Array) => Iterable<DeltaRange>,
  ) {
    const ranges = rangeGenerator(source, target);
    const deltas = createDelta(source, target, ranges);
    const result = mergeChunks(applyDelta(source, deltas));

    expect(result).toEqual(target);
  }

  describe("createDeltaRanges", () => {
    it("should work with createDelta and applyDelta for identical arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      testDeltaCycle(source, target, createDeltaRanges);
    });

    it("should work with createDelta and applyDelta for different arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
      ]);
      testDeltaCycle(source, target, createDeltaRanges);
    });

    it("should work with createDelta and applyDelta for partial matches", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 7, 8, 9, 10, 101, 102, 13, 14, 15, 16]);
      testDeltaCycle(source, target, createDeltaRanges);
    });

    it("should work with createDelta and applyDelta for empty source", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      testDeltaCycle(source, target, createDeltaRanges);
    });

    it("should work with createDelta and applyDelta for empty target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([]);
      testDeltaCycle(source, target, createDeltaRanges);
    });
  });

  describe("createFossilLikeRanges", () => {
    it("should work with createDelta and applyDelta for identical arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      testDeltaCycle(source, target, createFossilLikeRanges);
    });

    it("should work with createDelta and applyDelta for different arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
      ]);
      testDeltaCycle(source, target, createFossilLikeRanges);
    });

    it("should work with createDelta and applyDelta for partial matches", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 7, 8, 9, 10, 101, 102, 13, 14, 15, 16]);
      testDeltaCycle(source, target, createFossilLikeRanges);
    });

    it("should work with createDelta and applyDelta for empty source", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      testDeltaCycle(source, target, createFossilLikeRanges);
    });

    it("should work with createDelta and applyDelta for empty target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([]);
      testDeltaCycle(source, target, createFossilLikeRanges);
    });
  });

  describe("Side-by-side comparison", () => {
    it("both should produce valid deltas for the same input", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 99, 100, 101, 9, 10, 11, 12, 200, 201, 15, 16, 17, 18, 19, 20,
      ]);

      // Test with createDeltaRanges
      const ranges1 = createDeltaRanges(source, target);
      const deltas1 = createDelta(source, target, ranges1);
      const result1 = mergeChunks(applyDelta(source, deltas1));

      // Test with createFossilLikeRanges
      const ranges2 = createFossilLikeRanges(source, target);
      const deltas2 = createDelta(source, target, ranges2);
      const result2 = mergeChunks(applyDelta(source, deltas2));

      // Both should reconstruct the target correctly
      expect(result1).toEqual(target);
      expect(result2).toEqual(target);
    });

    it("both should handle large arrays with minimal changes", () => {
      const size = 1000;
      const source = new Uint8Array(size);
      const target = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        source[i] = i % 256;
        target[i] = i < 900 ? source[i] : (i * 2) % 256;
      }

      // Test with createDeltaRanges
      const ranges1 = createDeltaRanges(source, target);
      const deltas1 = createDelta(source, target, ranges1);
      const result1 = mergeChunks(applyDelta(source, deltas1));

      // Test with createFossilLikeRanges
      const ranges2 = createFossilLikeRanges(source, target);
      const deltas2 = createDelta(source, target, ranges2);
      const result2 = mergeChunks(applyDelta(source, deltas2));

      // Both should reconstruct the target correctly
      expect(result1).toEqual(target);
      expect(result2).toEqual(target);
    });

    it("both should handle text-like data", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("Hello, World! This is a test.");
      const target = encoder.encode("Hello, Universe! This is a test.");

      // Test with createDeltaRanges
      const ranges1 = createDeltaRanges(source, target);
      const deltas1 = createDelta(source, target, ranges1);
      const result1 = mergeChunks(applyDelta(source, deltas1));

      // Test with createFossilLikeRanges
      const ranges2 = createFossilLikeRanges(source, target);
      const deltas2 = createDelta(source, target, ranges2);
      const result2 = mergeChunks(applyDelta(source, deltas2));

      // Both should reconstruct the target correctly
      expect(result1).toEqual(target);
      expect(result2).toEqual(target);
    });
  });
});
