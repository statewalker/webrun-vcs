import { describe, expect, it } from "vitest";
import { createFossilLikeRanges, type DeltaRange } from "../../../src/diff/index.js";

/**
 * Helper function to collect all delta ranges from the generator
 */
function collectRanges(source: Uint8Array, target: Uint8Array, blockSize?: number): DeltaRange[] {
  return Array.from(createFossilLikeRanges(source, target, blockSize));
}

/**
 * Helper function to reconstruct target from source and delta ranges
 */
function applyDelta(source: Uint8Array, target: Uint8Array, ranges: DeltaRange[]): Uint8Array {
  const result: number[] = [];
  for (const range of ranges) {
    if (range.from === "source") {
      for (let i = 0; i < range.len; i++) {
        result.push(source[range.start + i]);
      }
    } else {
      for (let i = 0; i < range.len; i++) {
        result.push(target[range.start + i]);
      }
    }
  }
  return new Uint8Array(result);
}

describe("createFossilLikeRanges", () => {
  describe("Edge Cases", () => {
    it("should handle empty source and empty target", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([]);
    });

    it("should handle empty source with non-empty target", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([{ from: "target", start: 0, len: 5 }]);
    });

    it("should handle non-empty source with empty target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([]);
    });

    it("should handle arrays smaller than blockSize", () => {
      const source = new Uint8Array([1, 2, 3]);
      const target = new Uint8Array([1, 2, 3]);
      const ranges = collectRanges(source, target, 16); // blockSize > array length
      // Should fall back to literal copy since blockSize is too large
      expect(ranges).toEqual([{ from: "target", start: 0, len: 3 }]);
    });

    it("should handle single-byte arrays", () => {
      const source = new Uint8Array([42]);
      const target = new Uint8Array([42]);
      const ranges = collectRanges(source, target, 1);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 1 }]);
    });

    it("should handle blockSize of 1", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      const ranges = collectRanges(source, target, 1);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 5 }]);
    });

    it("should handle single-byte arrays with different values", () => {
      const source = new Uint8Array([42]);
      const target = new Uint8Array([43]);
      const ranges = collectRanges(source, target, 1);
      expect(ranges).toEqual([{ from: "target", start: 0, len: 1 }]);
    });
  });

  describe("Basic Functionality", () => {
    it("should recognize identical source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should handle completely different source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
      ]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([{ from: "target", start: 0, len: 16 }]);
    });

    it("should handle target as a subset of source (at beginning)", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should handle target as a subset of source (in middle)", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const target = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const ranges = collectRanges(source, target);
      // Note: createFossilLikeRanges uses aligned blocks, so may not find unaligned matches
      // It should still reconstruct correctly though
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle target as a subset of source (at end)", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const target = new Uint8Array([
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const ranges = collectRanges(source, target);
      // Note: createFossilLikeRanges uses aligned blocks, so may not find unaligned matches
      // It should still reconstruct correctly though
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle source as a subset of target", () => {
      const source = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const ranges = collectRanges(source, target);
      // Should copy 1,2,3,4 from target, then 5-20 from source, then 21-24 from target
      expect(ranges).toEqual([
        { from: "target", start: 0, len: 4 },
        { from: "source", start: 0, len: 16 },
        { from: "target", start: 20, len: 4 },
      ]);
    });

    it("should handle partial match with additional bytes", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([
        { from: "source", start: 0, len: 16 },
        { from: "target", start: 16, len: 4 },
      ]);
    });

    it("should reconstruct target correctly from ranges", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([1, 2, 99, 3, 4, 5, 6, 100, 101]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Rolling Hash Behavior", () => {
    it("should respect different blockSize values", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const ranges4 = collectRanges(source, target, 4);
      const ranges8 = collectRanges(source, target, 8);
      const ranges16 = collectRanges(source, target, 16);

      // All should successfully match (or fall back appropriately)
      expect(ranges4).toEqual([{ from: "source", start: 0, len: 10 }]);
      expect(ranges8).toEqual([{ from: "source", start: 0, len: 10 }]);
      // blockSize 16 is larger than arrays, should fall back to literal
      expect(ranges16).toEqual([{ from: "target", start: 0, len: 10 }]);
    });

    it("should find matches at aligned block offsets", () => {
      const source = new Uint8Array([
        10,
        20,
        30,
        40,
        50,
        60,
        70,
        80,
        90,
        100,
        110,
        120,
        130,
        140,
        150,
        160, // Block at 0
        170,
        180,
        190,
        200,
        210,
        220,
        230,
        240,
        250,
        255,
        1,
        2,
        3,
        4,
        5,
        6, // Block at 16
      ]);
      const target = new Uint8Array([
        170, 180, 190, 200, 210, 220, 230, 240, 250, 255, 1, 2, 3, 4, 5, 6,
      ]);
      const ranges = collectRanges(source, target);
      // Should find match at aligned offset 16 in source
      expect(ranges).toEqual([{ from: "source", start: 16, len: 16 }]);
    });
  });

  describe("Range Merging", () => {
    it("should merge consecutive source ranges", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target);
      // Should produce a single merged range
      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should merge consecutive target ranges", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const target = new Uint8Array([
        10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
      ]);
      const ranges = collectRanges(source, target);
      // Should produce a single merged range from target
      expect(ranges).toEqual([{ from: "target", start: 0, len: 16 }]);
    });

    it("should not merge ranges from different sources", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 99, 18, 19, 20,
      ]);
      const ranges = collectRanges(source, target);
      // Should have separate ranges for the two source copies and the literal
      expect(ranges.length).toBeGreaterThan(1);
      expect(ranges.some((r) => r.from === "target")).toBe(true);
      expect(ranges.some((r) => r.from === "source")).toBe(true);
    });

    it("should not merge non-consecutive source ranges", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 99, 100, 101, 102, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31, 32,
      ]);
      const ranges = collectRanges(source, target);
      // Should have multiple ranges due to the inserted bytes breaking the match
      expect(ranges.length).toBeGreaterThan(1);
      // Verify correct reconstruction
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Backward and Forward Extension", () => {
    it("should extend matches backward when possible", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      // Target has the same sequence but hash might initially match at offset
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target, 8);
      // Should extend to cover the entire match
      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should extend matches forward when possible", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const ranges = collectRanges(source, target, 8);
      // Should find and extend the match
      expect(ranges).toEqual([{ from: "source", start: 4, len: 16 }]);
    });

    it("should not extend beyond array boundaries", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const ranges = collectRanges(source, target, 4);
      // Should match exactly without going out of bounds
      expect(ranges).toEqual([{ from: "source", start: 0, len: 8 }]);
      // Verify by reconstruction
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle backward extension at start of arrays", () => {
      const source = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const target = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const ranges = collectRanges(source, target, 4);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 8 }]);
    });

    it("should handle forward extension at end of arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target, 4);
      expect(ranges).toEqual([{ from: "source", start: 8, len: 8 }]);
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle multiple non-overlapping matches", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 31, 32, 33, 34, 35,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 99, 100, 20, 21, 22, 23, 24, 25, 26,
        27, 28, 29, 30, 31, 32, 33, 34, 35,
      ]);
      const ranges = collectRanges(source, target);
      // Verify reconstruction
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle repeated patterns", () => {
      const source = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
      const target = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
      const ranges = collectRanges(source, target, 4);
      // Should match the entire sequence
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle partial repeated patterns", () => {
      const source = new Uint8Array([
        10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
      ]);
      const target = new Uint8Array([
        10, 20, 30, 40, 50, 60, 70, 80, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140,
        150, 160,
      ]);
      const ranges = collectRanges(source, target, 4);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle interleaved matches and literals", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 7, 8, 9, 10, 101, 102, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle large identical arrays", () => {
      const size = 10000;
      const source = new Uint8Array(size);
      const target = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        source[i] = i % 256;
        target[i] = i % 256;
      }
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle large different arrays", () => {
      const size = 1000;
      const source = new Uint8Array(size);
      const target = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        source[i] = (i * 7) % 256; // Use different pattern
        target[i] = (i * 11) % 256; // Use different pattern
      }
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle arrays with mixed matches and differences", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 99, 100, 101, 9, 10, 11, 12, 200, 201, 15, 16, 17, 18, 19, 20,
      ]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle hash collisions gracefully", () => {
      // Create a scenario where different blocks might have same hash
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([5, 6, 7, 8, 1, 2, 3, 4]);
      const ranges = collectRanges(source, target, 4);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle single byte differences", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 99, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle alternating matches and mismatches", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        1, 2, 99, 100, 5, 6, 101, 102, 9, 10, 103, 104, 13, 14, 105, 106,
      ]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle target larger than source with matches", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([
        99, 100, 101, 1, 2, 3, 4, 5, 6, 7, 8, 102, 103, 104, 1, 2, 3, 4, 5, 6, 7, 8, 105, 106,
      ]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle binary data with null bytes", () => {
      const source = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0]);
      const target = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle binary data with all values 0-255", () => {
      const source = new Uint8Array(256);
      const target = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        source[i] = i;
        target[i] = i;
      }
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Generator Behavior", () => {
    it("should work as an iterator", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const gen = createFossilLikeRanges(source, target);

      const ranges: Range[] = [];
      for (const range of gen) {
        ranges.push(range);
      }

      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should allow manual iteration with next()", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 101, 102, 9, 10, 11, 12, 13, 14, 15, 16]);
      const gen = createFossilLikeRanges(source, target);

      const ranges: Range[] = [];
      let result = gen.next();
      while (!result.done) {
        ranges.push(result.value);
        result = gen.next();
      }

      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should support early termination", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 99, 100, 101, 102, 13, 14, 15, 16]);
      const gen = createFossilLikeRanges(source, target);

      const firstRange = gen.next();
      expect(firstRange.done).toBe(false);
      expect(firstRange.value).toBeDefined();
      // Don't consume the rest - generator should be garbage collected safely
    });
  });

  describe("Performance Characteristics", () => {
    it("should handle very small blockSize efficiently", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const ranges = collectRanges(source, target, 1);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 20 }]);
    });

    it("should handle very large blockSize", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const ranges = collectRanges(source, target, 100);
      // blockSize larger than array, should fall back to literals
      expect(ranges).toEqual([{ from: "target", start: 0, len: 16 }]);
    });

    it("should handle sparse matches efficiently", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
      ]);
      const target = new Uint8Array([99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 1, 2, 3, 4]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Real-world Scenarios", () => {
    it("should handle text-like data (ASCII)", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("Hello, World! This is a test.");
      const target = encoder.encode("Hello, Universe! This is a test.");
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle code file with small change", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode('function hello() {\n  console.log("Hello");\n}\n');
      const target = encoder.encode('function hello() {\n  console.log("Hi");\n}\n');
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle appending data", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([
        { from: "source", start: 0, len: 16 },
        { from: "target", start: 16, len: 8 },
      ]);
    });

    it("should handle prepending data", () => {
      const source = new Uint8Array([
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([
        { from: "target", start: 0, len: 8 },
        { from: "source", start: 0, len: 16 },
      ]);
    });

    it("should handle inserting data in middle", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 20, 21, 22, 23, 24]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle deleting data", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 20, 21, 22, 23, 24]);
      const ranges = collectRanges(source, target);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Fossil-specific Characteristics", () => {
    it("should use aligned block boundaries for indexing", () => {
      // Fossil uses aligned blocks - test that it finds matches on block boundaries
      const source = new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0, // First block (0-15)
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16, // Second block (16-31)
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const ranges = collectRanges(source, target, 16);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });

    it("should handle weak checksum matches with strong checksum verification", () => {
      // The algorithm uses weak + strong checksums to avoid false positives
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const ranges = collectRanges(source, target);
      expect(ranges).toEqual([{ from: "source", start: 0, len: 16 }]);
    });

    it("should handle unaligned matches with backward extension", () => {
      // Test that backward extension works for unaligned matches
      const source = new Uint8Array([
        0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const ranges = collectRanges(source, target, 8);
      expect(ranges).toEqual([{ from: "source", start: 4, len: 16 }]);
    });

    it("should efficiently handle rolling window sliding", () => {
      // Test that the rolling window works correctly
      const source = new Uint8Array([
        100, 100, 100, 100, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const ranges = collectRanges(source, target, 4);
      const reconstructed = applyDelta(source, target, ranges);
      expect(reconstructed).toEqual(target);
    });
  });
});
