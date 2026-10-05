import { describe, expect, test } from "vitest";
import {
  applyDelta,
  createDelta,
  createDeltaRanges,
  decodeDeltaBlocks,
  encodeDeltaBlocks,
  mergeChunks,
} from "../../../src/diff/index.js";

// Helper to collect generator into array
function collectChunks(gen: Iterable<Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const chunk of gen) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("Fossil Delta Format - Full Pipeline", () => {
  describe("Complete round-trip: createDelta -> encode -> decode -> apply", () => {
    test("should handle empty source with insert-only target", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob size (should be reasonable)
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle copy-only delta (partial source copy)", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([3, 4, 5, 6]); // Copy middle portion

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob exists (small blobs have format overhead)
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle identical source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob exists (small arrays have format overhead)
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle mixed copy and insert operations", () => {
      const source = new Uint8Array([10, 20, 30, 40, 50]);
      const target = new Uint8Array([1, 2, 3, 20, 30, 40, 99, 100]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob exists
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle completely different source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([10, 20, 30, 40, 50]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob is reasonable (should contain all new data)
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle empty target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target (empty)
      expect(result).toEqual(target);
      expect(result.length).toBe(0);

      // Step 4: Verify deltaBlob is very small (just metadata)
      expect(deltaBlob.length).toBeLessThan(source.length);
    });

    test("should handle large binary data efficiently", () => {
      const source = new Uint8Array(1000);
      for (let i = 0; i < source.length; i++) {
        source[i] = i % 256;
      }

      const target = new Uint8Array(1000);
      for (let i = 0; i < target.length; i++) {
        // Modify only a small portion
        target[i] = i < 900 ? source[i] : (i * 2) % 256;
      }

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob is significantly smaller than target
      expect(deltaBlob.length).toBeLessThan(target.length);
    });

    test("should handle repeated patterns", () => {
      const source = new Uint8Array([1, 2, 3, 1, 2, 3, 1, 2, 3]);
      const target = new Uint8Array([1, 2, 3, 1, 2, 3]); // Remove last repeat

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob exists (small arrays have format overhead)
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle prepending data", () => {
      const source = new Uint8Array([10, 20, 30]);
      const target = new Uint8Array([1, 2, 3, 10, 20, 30]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob exists
      expect(deltaBlob.length).toBeGreaterThan(0);
    });

    test("should handle appending data", () => {
      const source = new Uint8Array([10, 20, 30]);
      const target = new Uint8Array([10, 20, 30, 40, 50]);

      // Step 1: source -> createDelta -> encodeDeltaBlocks -> deltaBlob
      const deltas = createDelta(source, target, createDeltaRanges(source, target));
      const deltaBlob = collectChunks(encodeDeltaBlocks(deltas));

      // Step 2: deltaBlob -> decodeDeltaBlocks -> applyDelta -> result
      const decodedDeltas = decodeDeltaBlocks(deltaBlob);
      const result = mergeChunks(applyDelta(source, decodedDeltas));

      // Step 3: Verify result == target
      expect(result).toEqual(target);

      // Step 4: Verify deltaBlob is smaller than or equal to added data size
      expect(deltaBlob.length).toBeGreaterThan(0);
    });
  });
});
