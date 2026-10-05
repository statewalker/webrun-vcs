/**
 * Delta round-trip integration tests
 *
 * Tests the complete delta workflow: create delta and apply to reconstruct target.
 * Validates that applyGitDelta correctly reverses the delta creation process.
 */

import { describe, expect, it } from "vitest";
import {
  applyGitDelta,
  createDeltaRanges,
  createFossilLikeRanges,
  deltaRangesToGitFormat,
  getGitDeltaBaseSize,
  getGitDeltaResultSize,
} from "../../../src/diff/index.js";

// Helper to create deterministic random bytes
function randomBytes(length: number, seed = 42): Uint8Array {
  const result = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    result[i] = state & 0xff;
  }
  return result;
}

// Helper to encode string to Uint8Array
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("Delta round-trip integration tests", () => {
  describe("create delta and apply to reconstruct target", () => {
    it("should reconstruct simple text target", () => {
      const base = encode("Hello, World!");
      const target = encode("Hello, Universe!");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should reconstruct when target is identical to base", () => {
      const base = encode("Identical content");
      const target = encode("Identical content");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should reconstruct with partial overlap", () => {
      const base = encode("AAABBBCCC");
      const target = encode("AAADDDEEE");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should work with both delta range algorithms", () => {
      const base = randomBytes(500, 123);
      const target = new Uint8Array(600);
      // Create target with some overlap from base
      target.set(base.subarray(0, 200), 0);
      target.set(randomBytes(200, 456), 200);
      target.set(base.subarray(300, 500), 400);

      // Test with createDeltaRanges
      const ranges1 = createDeltaRanges(base, target, { windowSize: 64 });
      const delta1 = deltaRangesToGitFormat(base, target, ranges1);
      expect(applyGitDelta(base, delta1)).toEqual(target);

      // Test with createFossilLikeRanges
      const ranges2 = createFossilLikeRanges(base, target);
      const delta2 = deltaRangesToGitFormat(base, target, ranges2);
      expect(applyGitDelta(base, delta2)).toEqual(target);
    });
  });

  describe("large files with many copy instructions", () => {
    it("should handle large file with multiple copy regions", () => {
      // Create base with repeated patterns
      const base = new Uint8Array(10000);
      for (let i = 0; i < base.length; i++) {
        base[i] = i % 256;
      }

      // Create target by rearranging parts of base
      const target = new Uint8Array(12000);
      target.set(base.subarray(5000, 10000), 0); // Copy from middle
      target.set(base.subarray(0, 2000), 5000); // Copy from start
      target.set(randomBytes(5000, 999), 7000); // New data

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should handle 100KB+ files", () => {
      const base = randomBytes(100000, 1);
      // Target is base with some modifications
      const target = new Uint8Array(base);
      // Modify some sections
      for (let i = 10000; i < 20000; i++) {
        target[i] = 0xff;
      }
      for (let i = 50000; i < 60000; i++) {
        target[i] = 0x00;
      }

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });
  });

  describe("pure insert (no common content)", () => {
    it("should handle completely different content", () => {
      const base = encode("AAAAAAAAAA");
      const target = encode("BBBBBBBBBB");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should handle random base and target with no overlap", () => {
      const base = randomBytes(1000, 111);
      const target = randomBytes(1000, 222);

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });

    it("should handle empty base", () => {
      const base = new Uint8Array(0);
      const target = encode("New content from scratch");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
    });
  });

  describe("empty target", () => {
    it("should handle empty target", () => {
      const base = encode("Some base content");
      const target = new Uint8Array(0);

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(0);
    });

    it("should handle both empty base and target", () => {
      const base = new Uint8Array(0);
      const target = new Uint8Array(0);

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);
      const reconstructed = applyGitDelta(base, delta);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(0);
    });
  });

  describe("base size mismatch error", () => {
    it("should throw error when base size does not match delta expectation", () => {
      const base = encode("Short");
      const target = encode("Target text");

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);

      // Verify delta encodes the correct base size
      expect(getGitDeltaBaseSize(delta)).toBe(base.length);

      // Try to apply with wrong base size
      const wrongBase = encode("This is a much longer base");
      expect(() => applyGitDelta(wrongBase, delta)).toThrow(/base length mismatch/i);
    });

    it("should throw error when base is too short", () => {
      const base = randomBytes(100);
      const target = randomBytes(150, 123);

      // Manually create ranges that reference beyond what smaller base can provide
      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);

      // Apply with shorter base
      const shortBase = randomBytes(50);
      expect(() => applyGitDelta(shortBase, delta)).toThrow(/base length mismatch/i);
    });
  });

  describe("delta size utilities", () => {
    it("should correctly report base and result sizes", () => {
      const base = randomBytes(1234);
      const target = randomBytes(5678, 999);

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(getGitDeltaBaseSize(delta)).toBe(1234);
      expect(getGitDeltaResultSize(delta)).toBe(5678);
    });

    it("should handle large sizes correctly", () => {
      // Sizes that require multi-byte varint encoding
      const base = randomBytes(100000);
      const target = randomBytes(150000, 42);

      const ranges = createFossilLikeRanges(base, target);
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(getGitDeltaBaseSize(delta)).toBe(100000);
      expect(getGitDeltaResultSize(delta)).toBe(150000);
    });
  });
});
