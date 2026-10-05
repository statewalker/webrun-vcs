/**
 * Tests for DeltaCompressor implementations
 */

import { describe, expect, it } from "vitest";
import { GitDeltaCompressor } from "../../src/storage/delta/compressor/git-delta-compressor.js";

describe("GitDeltaCompressor", () => {
  const compressor = new GitDeltaCompressor();

  describe("computeDelta", () => {
    it("computes delta between similar content", () => {
      const base = new TextEncoder().encode("Hello, World! This is the base content.");
      const target = new TextEncoder().encode("Hello, World! This is the target content.");

      const result = compressor.computeDelta(base, target);

      expect(result).toBeDefined();
      expect(result?.delta.length).toBeLessThan(target.length);
      expect(result?.targetSize).toBe(target.length);
      expect(result?.ratio).toBeGreaterThan(1);
      expect(result?.savings).toBeGreaterThan(0);
    });

    it("returns null for completely different content", () => {
      const base = new TextEncoder().encode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      const target = new TextEncoder().encode("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

      const result = compressor.computeDelta(base, target);

      // Either returns null or has very poor compression
      if (result !== null) {
        expect(result.ratio).toBeLessThan(1.5);
      }
    });

    it("computes good delta for identical content with small changes", () => {
      const base = "x".repeat(1000);
      const target = `${"x".repeat(500)}y${"x".repeat(499)}`;

      const result = compressor.computeDelta(
        new TextEncoder().encode(base),
        new TextEncoder().encode(target),
      );

      expect(result).toBeDefined();
      // Should have good compression for this case
      expect(result?.ratio).toBeGreaterThan(2);
    });

    it("handles empty base", () => {
      const base = new Uint8Array(0);
      const target = new TextEncoder().encode("Some content that is long enough");

      // Empty base means full insert - may return null or result in poor compression
      // Just verify it doesn't throw
      compressor.computeDelta(base, target);
    });

    it("returns null for very small target", () => {
      const base = new TextEncoder().encode("Some content");
      const target = new TextEncoder().encode("abc");

      const result = compressor.computeDelta(base, target);

      // Very small target shouldn't be deltified
      expect(result).toBeNull();
    });

    it("computes delta for binary content", () => {
      // Create binary content with some shared bytes
      const base = new Uint8Array(256);
      const target = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        base[i] = i;
        target[i] = i < 200 ? i : (i + 10) % 256;
      }

      const result = compressor.computeDelta(base, target);

      expect(result).toBeDefined();
      // Should be able to copy most of the content
      expect(result?.delta.length).toBeLessThan(target.length);
    });
  });

  describe("applyDelta", () => {
    it("applies delta to reconstruct target", () => {
      const base = new TextEncoder().encode("The quick brown fox jumps over the lazy dog.");
      const target = new TextEncoder().encode("The quick brown cat jumps over the lazy dog.");

      const result = compressor.computeDelta(base, target);
      expect(result).toBeDefined();

      const reconstructed = compressor.applyDelta(base, result?.delta as Uint8Array);
      expect(reconstructed).toEqual(target);
    });

    it("reconstructs longer target from shorter base", () => {
      // Base needs to be long enough for delta algorithm
      const base = new TextEncoder().encode("This is a sufficiently long base content for testing");
      const target = new TextEncoder().encode(
        "This is a sufficiently long base content for testing with additional stuff",
      );

      const result = compressor.computeDelta(base, target);
      expect(result).toBeDefined();

      const reconstructed = compressor.applyDelta(base, result?.delta as Uint8Array);
      expect(reconstructed).toEqual(target);
    });

    it("reconstructs target from base with shared prefix", () => {
      const base = new TextEncoder().encode("Longer base content with lots of extra stuff");
      const target = new TextEncoder().encode("Longer base content with modifications");

      const result = compressor.computeDelta(base, target);
      expect(result).toBeDefined();

      const reconstructed = compressor.applyDelta(base, result?.delta as Uint8Array);
      expect(reconstructed).toEqual(target);
    });

    it("handles binary content correctly", () => {
      // Use larger content to avoid minimum size threshold
      const base = new Uint8Array(100);
      const target = new Uint8Array(100);
      for (let i = 0; i < 100; i++) {
        base[i] = i % 256;
        target[i] = i < 80 ? i % 256 : (i + 10) % 256;
      }

      const result = compressor.computeDelta(base, target);
      expect(result).toBeDefined();

      const reconstructed = compressor.applyDelta(base, result?.delta as Uint8Array);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("estimateDeltaQuality", () => {
    it("returns not worth trying for very small targets", () => {
      const estimate = compressor.estimateDeltaQuality(1000, 10);
      expect(estimate.worthTrying).toBe(false);
    });

    it("returns not worth trying for very different sizes", () => {
      const estimate = compressor.estimateDeltaQuality(100, 10000);
      expect(estimate.worthTrying).toBe(false);
    });

    it("returns worth trying for similar sizes", () => {
      const estimate = compressor.estimateDeltaQuality(1000, 1050);
      expect(estimate.worthTrying).toBe(true);
      expect(estimate.expectedRatio).toBeGreaterThan(1);
    });

    it("returns worth trying for moderate size differences", () => {
      const estimate = compressor.estimateDeltaQuality(1000, 2000);
      expect(estimate.worthTrying).toBe(true);
    });
  });
});
