import { describe, expect, it } from "vitest";
import {
  applyDelta,
  createDelta,
  createDeltaRanges,
  type Delta,
  mergeChunks,
} from "../src/index.js";
import { checksum } from "./checksum.js";

/**
 * Helper function to collect all deltas from the generator (excluding start and finish)
 */
function collectDeltas(
  source: Uint8Array,
  target: Uint8Array,
  blockSize?: number,
  minMatch?: number,
): Delta[] {
  return Array.from(createDelta(source, target, blockSize, minMatch)).filter(
    (d) => d.type !== "start" && d.type !== "finish",
  );
}

/**
 * Helper function to add start, finish (checksum) to deltas based on expected output
 */
function addChecksum(source: Uint8Array, deltas: Delta[]): Delta[] {
  // If already has finish, return as-is
  if (deltas.length > 0 && deltas[deltas.length - 1].type === "finish") {
    return deltas;
  }

  // Calculate what the output would be
  const chunks: Uint8Array[] = [];
  let targetLen = 0;
  for (const d of deltas) {
    if (d.type === "insert") {
      if (d.data.length > 0) {
        chunks.push(d.data);
        targetLen += d.data.length;
      }
    } else if (d.type === "copy") {
      chunks.push(source.subarray(d.start, d.start + d.len));
      targetLen += d.len;
    }
  }

  const output = mergeChunks(chunks);
  const checksumValue = checksum(output);

  return [{ type: "start", targetLen }, ...deltas, { type: "finish", checksum: checksumValue }];
}

/**
 * Helper function to apply deltas and reconstruct target
 */
function reconstructTarget(source: Uint8Array, deltas: Delta[]): Uint8Array {
  const deltasWithChecksum = addChecksum(source, deltas);
  return mergeChunks(applyDelta(source, deltasWithChecksum));
}

/**
 * Helper to check if a delta is a COPY delta
 */
function isCopyDelta(delta: Delta): delta is { type: "copy"; start: number; len: number } {
  return delta.type === "copy";
}

/**
 * Helper to check if a delta is a LITERAL delta
 */
function isLiteralDelta(delta: Delta): delta is { type: "insert"; data: Uint8Array } {
  return delta.type === "insert";
}

describe("createDelta", () => {
  describe("Edge Cases", () => {
    it("should handle empty source and empty target", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([]);
      const deltas = collectDeltas(source, target);
      expect(deltas).toEqual([]);
    });

    it("should handle empty source with non-empty target", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      expect(isLiteralDelta(deltas[0])).toBe(true);
      if (isLiteralDelta(deltas[0])) {
        expect(deltas[0].data).toEqual(target);
      }
    });

    it("should handle non-empty source with empty target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([]);
      const deltas = collectDeltas(source, target);
      expect(deltas).toEqual([]);
    });

    it("should throw error when blockSize < 1", () => {
      const source = new Uint8Array([1, 2, 3]);
      const target = new Uint8Array([1, 2, 3]);
      expect(() => collectDeltas(source, target, 0)).toThrow("blockSize must be >= 1");
      expect(() => collectDeltas(source, target, -1)).toThrow("blockSize must be >= 1");
    });

    it("should handle arrays smaller than blockSize", () => {
      const source = new Uint8Array([1, 2, 3]);
      const target = new Uint8Array([1, 2, 3]);
      const deltas = collectDeltas(source, target, 16);

      // Should fall back to literal copy since blockSize is too large
      expect(deltas).toHaveLength(1);
      expect(isLiteralDelta(deltas[0])).toBe(true);
    });

    it("should handle single-byte arrays", () => {
      const source = new Uint8Array([42]);
      const target = new Uint8Array([42]);
      const deltas = collectDeltas(source, target, 1, 1);

      expect(deltas).toHaveLength(1);
      expect(isCopyDelta(deltas[0])).toBe(true);
      if (isCopyDelta(deltas[0])) {
        expect(deltas[0].start).toBe(0);
        expect(deltas[0].len).toBe(1);
      }
    });

    it("should handle blockSize of 1", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      const deltas = collectDeltas(source, target, 1, 1);

      expect(deltas).toHaveLength(1);
      expect(isCopyDelta(deltas[0])).toBe(true);
      if (isCopyDelta(deltas[0])) {
        expect(deltas[0].start).toBe(0);
        expect(deltas[0].len).toBe(5);
      }
    });
  });

  describe("Basic Functionality", () => {
    it("should recognize identical source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      expect(isCopyDelta(deltas[0])).toBe(true);
      if (isCopyDelta(deltas[0])) {
        expect(deltas[0].start).toBe(0);
        expect(deltas[0].len).toBe(16);
      }
    });

    it("should handle completely different source and target", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
      ]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      expect(isLiteralDelta(deltas[0])).toBe(true);
      if (isLiteralDelta(deltas[0])) {
        expect(deltas[0].data).toEqual(target);
      }
    });

    it("should create COPY delta for matched regions", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      expect(isCopyDelta(deltas[0])).toBe(true);
      if (isCopyDelta(deltas[0])) {
        expect(deltas[0].start).toBe(4);
        expect(deltas[0].len).toBe(16);
      }
    });

    it("should create LITERAL delta for new bytes", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([99, 100, 101, 102]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      expect(isLiteralDelta(deltas[0])).toBe(true);
      if (isLiteralDelta(deltas[0])) {
        expect(deltas[0].data).toEqual(target);
      }
    });

    it("should create mixed COPY and LITERAL deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(2);
      expect(isCopyDelta(deltas[0])).toBe(true);
      expect(isLiteralDelta(deltas[1])).toBe(true);

      if (isCopyDelta(deltas[0]) && isLiteralDelta(deltas[1])) {
        expect(deltas[0].start).toBe(0);
        expect(deltas[0].len).toBe(16);
        expect(deltas[1].data).toEqual(new Uint8Array([17, 18, 19, 20]));
      }
    });

    it("should handle source as a subset of target", () => {
      const source = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(3);
      expect(isLiteralDelta(deltas[0])).toBe(true);
      expect(isCopyDelta(deltas[1])).toBe(true);
      expect(isLiteralDelta(deltas[2])).toBe(true);
    });
  });

  describe("Delta Format Validation", () => {
    it("should create COPY delta with correct start and len fields", () => {
      const source = new Uint8Array([
        10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
      ]);
      const target = new Uint8Array([
        50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
      ]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      const delta = deltas[0];
      expect(isCopyDelta(delta)).toBe(true);
      expect("start" in delta).toBe(true);
      expect("len" in delta).toBe(true);
      expect("data" in delta).toBe(false);
    });

    it("should create LITERAL delta with correct data field", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const target = new Uint8Array([99, 100, 101, 102, 103, 104]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      const delta = deltas[0];
      expect(isLiteralDelta(delta)).toBe(true);
      expect("data" in delta).toBe(true);
      expect("start" in delta).toBe(false);
      expect("len" in delta).toBe(false);
    });

    it("should ensure LITERAL delta data is a Uint8Array", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3, 4, 5]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      const delta = deltas[0];
      expect(isLiteralDelta(delta)).toBe(true);
      if (isLiteralDelta(delta)) {
        expect(delta.data).toBeInstanceOf(Uint8Array);
        expect(delta.data.length).toBe(5);
      }
    });

    it("should ensure COPY delta has valid numeric fields", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const deltas = collectDeltas(source, target);

      expect(deltas).toHaveLength(1);
      const delta = deltas[0];
      expect(isCopyDelta(delta)).toBe(true);
      if (isCopyDelta(delta)) {
        expect(typeof delta.start).toBe("number");
        expect(typeof delta.len).toBe("number");
        expect(delta.start).toBeGreaterThanOrEqual(0);
        expect(delta.len).toBeGreaterThan(0);
        expect(delta.start + delta.len).toBeLessThanOrEqual(source.length);
      }
    });
  });

  describe("Round-trip Testing", () => {
    it("should reconstruct identical arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should reconstruct completely different arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const target = new Uint8Array([10, 20, 30, 40]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should reconstruct arrays with mixed changes", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([1, 2, 99, 3, 4, 5, 6, 100, 101]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle appending data", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle prepending data", () => {
      const source = new Uint8Array([
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle inserting data in middle", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 20, 21, 22, 23, 24]);
      const target = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle deleting data", () => {
      const source = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 20]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle large arrays", () => {
      const size = 1000;
      const source = new Uint8Array(size);
      const target = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        source[i] = i % 256;
        // Make target mostly the same with a few differences
        target[i] = i < 100 || i >= 900 ? (i + 1) % 256 : i % 256;
      }
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
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
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
      expect(deltas.length).toBeGreaterThanOrEqual(3);
    });

    it("should handle repeated patterns", () => {
      const source = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
      const target = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
      const deltas = collectDeltas(source, target, 4, 4);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle interleaved matches and literals", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 7, 8, 9, 10, 101, 102, 13, 14, 15, 16]);

      // Use smaller blockSize to find shorter matches
      const deltas = collectDeltas(source, target, 4, 4);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);

      // Verify mixed types
      const hasCopy = deltas.some((d) => isCopyDelta(d));
      const hasLiteral = deltas.some((d) => isLiteralDelta(d));
      expect(hasCopy).toBe(true);
      expect(hasLiteral).toBe(true);
    });

    it("should handle target larger than source with matches", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([
        99, 100, 101, 1, 2, 3, 4, 5, 6, 7, 8, 102, 103, 104, 1, 2, 3, 4, 5, 6, 7, 8, 105, 106,
      ]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle single byte differences", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 99, 9, 10, 11, 12, 13, 14, 15, 16]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle binary data with null bytes", () => {
      const source = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0]);
      const target = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle binary data with all values 0-255", () => {
      const source = new Uint8Array(256);
      const target = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        source[i] = i;
        target[i] = i;
      }
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Generator Behavior", () => {
    it("should work as an iterator", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const gen = createDelta(source, target);

      const deltas: Delta[] = [];
      for (const delta of gen) {
        deltas.push(delta);
      }

      expect(deltas.length).toBeGreaterThan(0);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should allow manual iteration with next()", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 99, 100, 101, 102, 9, 10, 11, 12, 13, 14, 15, 16]);
      const gen = createDelta(source, target);

      const deltas: Delta[] = [];
      let result = gen.next();
      while (!result.done) {
        deltas.push(result.value);
        result = gen.next();
      }

      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle middle insertion with appropriate blockSize", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 99, 100, 101, 102, 13, 14, 15, 16]);

      // Test with default blockSize (16)
      const rangesDefault = Array.from(createDeltaRanges(source, target));

      // With blockSize=16, the algorithm needs at least 16 consecutive matching bytes
      // to find a pattern. In this case:
      // - First 8 bytes match (1-8)
      // - Next 4 bytes don't match (99, 100, 101, 102 vs 9, 10, 11, 12)
      // - Last 4 bytes match (13-16)
      // Since no 16-byte block matches, it falls back to treating everything as literal
      expect(rangesDefault).toHaveLength(1);
      expect(rangesDefault[0].from).toBe("target");
      expect(rangesDefault[0].len).toBe(16);

      // Test with smaller blockSize=4 to find the pattern
      const ranges = Array.from(createDeltaRanges(source, target, 4, 4));

      // With blockSize=4, the algorithm can find shorter matching blocks:
      // 1. COPY from source: bytes 1-8 (positions 0-7)
      // 2. LITERAL from target: bytes 99, 100, 101, 102 (positions 8-11)
      // 3. COPY from source: bytes 13-16 (positions 12-15)
      expect(ranges).toHaveLength(3);
      expect(ranges[0]).toEqual({ from: "source", start: 0, len: 8 });
      expect(ranges[1]).toEqual({ from: "target", start: 8, len: 4 });
      expect(ranges[2]).toEqual({ from: "source", start: 12, len: 4 });

      // Verify reconstruction works correctly regardless of blockSize
      const reconstructedDefault = mergeChunks(
        applyDelta(source, Array.from(createDelta(source, target))),
      );
      const reconstructedSmall = mergeChunks(
        applyDelta(source, Array.from(createDelta(source, target, 4, 4))),
      );

      expect(reconstructedDefault).toEqual(target);
      expect(reconstructedSmall).toEqual(target);
    });

    it("should support early termination", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 99, 100, 101, 102, 13, 14, 15, 16]);
      const gen = createDelta(source, target);

      const firstDelta = gen.next();
      expect(firstDelta.done).toBe(false);
      expect(firstDelta.value).toBeDefined();
      // Don't consume the rest - generator should be garbage collected safely
    });

    it("should create deltas lazily", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 99, 100, 13, 14, 15, 16]);

      // Creating generator should not throw
      const gen = createDelta(source, target);
      expect(gen).toBeDefined();

      // Consuming it should work
      const deltas = Array.from(gen);
      expect(deltas.length).toBeGreaterThan(0);
    });
  });

  describe("Real-world Scenarios", () => {
    it("should handle text-like data (ASCII)", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("Hello, World! This is a test.");
      const target = encoder.encode("Hello, Universe! This is a test.");
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle code file with small change", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode('function hello() {\n  console.log("Hello");\n}\n');
      const target = encoder.encode('function hello() {\n  console.log("Hi");\n}\n');
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);

      // Should have at least one COPY delta for the common parts
      const hasCopy = deltas.some((d) => isCopyDelta(d));
      expect(hasCopy).toBe(true);
    });

    it("should handle multiline text changes", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("Line 1\nLine 2\nLine 3\nLine 4\n");
      const target = encoder.encode("Line 1\nNew Line\nLine 3\nLine 4\n");
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should handle UTF-8 encoded text", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("Hello 世界");
      const target = encoder.encode("Hello 世界!");
      const deltas = collectDeltas(source, target);
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });

    it("should efficiently handle mostly unchanged files", () => {
      const encoder = new TextEncoder();
      const longText = `${"A".repeat(1000)}B${"C".repeat(1000)}`;
      const source = encoder.encode(longText);
      const target = encoder.encode(`${longText}!`);
      const deltas = collectDeltas(source, target);

      // Should have mostly COPY deltas
      const copyDeltas = deltas.filter((d) => isCopyDelta(d));
      const literalDeltas = deltas.filter((d) => isLiteralDelta(d));
      expect(copyDeltas.length).toBeGreaterThan(0);
      expect(literalDeltas.length).toBeGreaterThan(0);

      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("Parameter Variations", () => {
    it("should respect different blockSize values", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const deltas4 = collectDeltas(source, target, 4, 4);
      const deltas8 = collectDeltas(source, target, 8, 8);
      const deltas16 = collectDeltas(source, target, 16, 16);

      // All should reconstruct correctly
      expect(reconstructTarget(source, deltas4)).toEqual(target);
      expect(reconstructTarget(source, deltas8)).toEqual(target);
      expect(reconstructTarget(source, deltas16)).toEqual(target);
    });

    it("should respect minMatch parameter", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const target = new Uint8Array([99, 1, 2, 3, 100]);

      // With minMatch=3, should find the match
      const deltas1 = collectDeltas(source, target, 3, 3);
      const hasCopy1 = deltas1.some((d) => isCopyDelta(d));
      expect(hasCopy1).toBe(true);

      // With minMatch=4, match is too small, should be all literal
      const deltas2 = collectDeltas(source, target, 3, 4);
      const hasCopy2 = deltas2.some((d) => isCopyDelta(d));
      expect(hasCopy2).toBe(false);

      // Both should reconstruct correctly
      expect(reconstructTarget(source, deltas1)).toEqual(target);
      expect(reconstructTarget(source, deltas2)).toEqual(target);
    });
  });
});

describe("applyDelta", () => {
  describe("Edge Cases", () => {
    it("should handle empty deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const deltas: Delta[] = [];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([]));
    });

    it("should handle empty source with LITERAL deltas only", () => {
      const source = new Uint8Array([]);
      const deltas: Delta[] = [{ type: "insert", data: new Uint8Array([1, 2, 3, 4, 5]) }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("should handle single COPY delta", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const deltas: Delta[] = [{ type: "copy", start: 0, len: 5 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(source);
    });

    it("should handle single LITERAL delta", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const deltas: Delta[] = [{ type: "insert", data: new Uint8Array([10, 20, 30]) }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([10, 20, 30]));
    });
  });

  describe("Basic Functionality", () => {
    it("should apply COPY delta correctly", () => {
      const source = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const deltas: Delta[] = [{ type: "copy", start: 2, len: 4 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([30, 40, 50, 60]));
    });

    it("should apply LITERAL delta correctly", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const deltas: Delta[] = [{ type: "insert", data: new Uint8Array([99, 100, 101]) }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([99, 100, 101]));
    });

    it("should apply multiple COPY deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 3 },
        { type: "copy", start: 7, len: 3 },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 2, 3, 8, 9, 10]));
    });

    it("should apply multiple LITERAL deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4]);
      const deltas: Delta[] = [
        { type: "insert", data: new Uint8Array([10, 20]) },
        { type: "insert", data: new Uint8Array([30, 40, 50]) },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    });

    it("should apply mixed COPY and LITERAL deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 2 },
        { type: "insert", data: new Uint8Array([99, 100]) },
        { type: "copy", start: 4, len: 2 },
        { type: "insert", data: new Uint8Array([101]) },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 2, 99, 100, 5, 6, 101]));
    });
  });

  describe("Generator Behavior", () => {
    it("should work as an iterator", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const target = new Uint8Array([1, 2, 99, 3, 4, 5]);
      const deltas: Delta[] = [
        { type: "start", targetLen: target.length },
        { type: "copy", start: 0, len: 2 },
        { type: "insert", data: new Uint8Array([99]) },
        { type: "copy", start: 2, len: 3 },
        { type: "finish", checksum: checksum(target) },
      ];

      const chunks: Uint8Array[] = [];
      for (const chunk of applyDelta(source, deltas)) {
        chunks.push(chunk);
        expect(chunk).toBeInstanceOf(Uint8Array);
      }

      expect(chunks).toHaveLength(3);
    });

    it("should allow manual iteration with next()", () => {
      const source = new Uint8Array([10, 20, 30, 40]);
      const target = new Uint8Array([10, 20, 99]);
      const deltas: Delta[] = [
        { type: "start", targetLen: target.length },
        { type: "copy", start: 0, len: 2 },
        { type: "insert", data: new Uint8Array([99]) },
        { type: "finish", checksum: checksum(target) },
      ];

      const gen = applyDelta(source, deltas);

      const first = gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toBeInstanceOf(Uint8Array);

      const second = gen.next();
      expect(second.done).toBe(false);
      expect(second.value).toBeInstanceOf(Uint8Array);

      const third = gen.next();
      expect(third.done).toBe(true);
    });

    it("should support early termination", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 4 },
        { type: "insert", data: new Uint8Array([99, 100]) },
        { type: "copy", start: 4, len: 4 },
      ];

      const gen = applyDelta(source, deltas);
      const first = gen.next();
      expect(first.done).toBe(false);
      // Don't consume the rest - should not throw
    });

    it("should yield chunks lazily", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 4 },
        { type: "insert", data: new Uint8Array([99]) },
        { type: "copy", start: 4, len: 4 },
      ];

      // Creating generator should not process anything
      const gen = applyDelta(source, deltas);
      expect(gen).toBeDefined();

      // Should process one chunk at a time
      const first = gen.next();
      expect(first.value).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
  });

  describe("Boundary Conditions", () => {
    it("should handle COPY from start of source", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [{ type: "copy", start: 0, len: 4 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("should handle COPY from end of source", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [{ type: "copy", start: 4, len: 4 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([5, 6, 7, 8]));
    });

    it("should handle COPY of entire source", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [{ type: "copy", start: 0, len: 8 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(source);
    });

    it("should handle COPY with len=1", () => {
      const source = new Uint8Array([10, 20, 30, 40]);
      const deltas: Delta[] = [{ type: "copy", start: 2, len: 1 }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([30]));
    });

    it("should handle LITERAL with single byte", () => {
      const source = new Uint8Array([1, 2, 3]);
      const deltas: Delta[] = [{ type: "insert", data: new Uint8Array([99]) }];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([99]));
    });

    it("should handle LITERAL with zero bytes", () => {
      const source = new Uint8Array([1, 2, 3]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 3 },
        { type: "insert", data: new Uint8Array([]) },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle many small deltas", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 1 },
        { type: "insert", data: new Uint8Array([99]) },
        { type: "copy", start: 1, len: 1 },
        { type: "insert", data: new Uint8Array([100]) },
        { type: "copy", start: 2, len: 1 },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([1, 99, 2, 100, 3]));
    });

    it("should handle overlapping COPY regions (duplicating data)", () => {
      const source = new Uint8Array([10, 20, 30, 40]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 2 },
        { type: "copy", start: 0, len: 2 },
        { type: "copy", start: 2, len: 2 },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([10, 20, 10, 20, 30, 40]));
    });

    it("should handle COPY in reverse order", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5]);
      const deltas: Delta[] = [
        { type: "copy", start: 3, len: 2 },
        { type: "copy", start: 0, len: 3 },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([4, 5, 1, 2, 3]));
    });

    it("should handle binary data with null bytes", () => {
      const source = new Uint8Array([0, 0, 1, 2, 0, 0]);
      const deltas: Delta[] = [
        { type: "copy", start: 0, len: 2 },
        { type: "insert", data: new Uint8Array([99]) },
        { type: "copy", start: 2, len: 2 },
      ];
      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed).toEqual(new Uint8Array([0, 0, 99, 1, 2]));
    });

    it("should handle large number of deltas", () => {
      const source = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        source[i] = i % 256;
      }

      const deltas: Delta[] = [];
      for (let i = 0; i < 100; i++) {
        deltas.push({ type: "copy", start: i * 10, len: 5 });
      }

      const reconstructed = reconstructTarget(source, deltas);
      expect(reconstructed.length).toBe(500);
    });
  });

  describe("Integration with createDelta", () => {
    it("should reconstruct target from createDelta output", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([1, 2, 99, 100, 5, 6, 7, 8]);

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
    });

    it("should handle round-trip with empty arrays", () => {
      const source = new Uint8Array([]);
      const target = new Uint8Array([1, 2, 3]);

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
    });

    it("should handle round-trip with identical arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
    });

    it("should handle round-trip with completely different arrays", () => {
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const target = new Uint8Array([
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      ]);

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
    });

    it("should handle round-trip with complex changes", () => {
      const encoder = new TextEncoder();
      const source = encoder.encode("The quick brown fox jumps over the lazy dog");
      const target = encoder.encode("The quick red fox runs over the lazy cat");

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
    });
  });

  describe("Large Block Tests (~3MB)", () => {
    const MB = 1024 * 1024;
    const SIZE_3MB = 3 * MB;

    it("should handle identical 3MB blocks", { timeout: 120000 }, () => {
      // Create identical 3MB blocks
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }
      const target = new Uint8Array(source);

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);

      // Should be mostly copy operations (very efficient)
      const copyDeltas = deltas.filter((d) => isCopyDelta(d));
      expect(copyDeltas.length).toBeGreaterThan(0);
    });

    it("should handle 3MB with small changes (0.1% modified)", { timeout: 120000 }, () => {
      // Create 3MB source
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      // Create target with 0.1% changes (~3KB modified)
      const target = new Uint8Array(source);
      const numChanges = Math.floor(SIZE_3MB * 0.001);
      for (let i = 0; i < numChanges; i++) {
        const pos = Math.floor((i * SIZE_3MB) / numChanges);
        target[pos] = (target[pos] + 1) % 256;
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);

      // Delta should be much smaller than full target
      const deltaDeltas = deltas.filter((d) => d.type === "copy" || d.type === "insert");
      expect(deltaDeltas.length).toBeGreaterThan(0);
    });

    it("should handle 3MB with medium changes (10% modified)", { timeout: 120000 }, () => {
      // Create 3MB source
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      // Create target with 10% changes (~300KB modified)
      const target = new Uint8Array(source);
      const chunkSize = 1024;
      const numChunks = Math.floor(SIZE_3MB / chunkSize);
      const chunksToModify = Math.floor(numChunks * 0.1);

      for (let i = 0; i < chunksToModify; i++) {
        const chunkIdx = Math.floor((i * numChunks) / chunksToModify);
        const start = chunkIdx * chunkSize;
        for (let j = 0; j < chunkSize && start + j < SIZE_3MB; j++) {
          target[start + j] = (target[start + j] + 100) % 256;
        }
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);

      // Should have both copy and insert operations
      const copyDeltas = deltas.filter((d) => isCopyDelta(d));
      const insertDeltas = deltas.filter((d) => isLiteralDelta(d));
      expect(copyDeltas.length).toBeGreaterThan(0);
      expect(insertDeltas.length).toBeGreaterThan(0);
    });

    it("should handle completely different 3MB blocks", { timeout: 120000 }, () => {
      // Create source with one pattern
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      // Create target with completely different pattern
      const target = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        target[i] = (255 - (i % 256)) % 256;
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);

      // Should be mostly insert operations (no common data)
      const insertDeltas = deltas.filter((d) => isLiteralDelta(d));
      expect(insertDeltas.length).toBeGreaterThan(0);
    });

    it("should handle 3MB with repeated pattern insertions", { timeout: 120000 }, () => {
      // Create source with sequential pattern
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      // Create target with same data but with 1KB repeated pattern inserted every 100KB
      const pattern = new Uint8Array(1024);
      for (let i = 0; i < pattern.length; i++) {
        pattern[i] = 0xaa;
      }

      const chunks: Uint8Array[] = [];
      const chunkSize = 100 * 1024;
      for (let i = 0; i < SIZE_3MB; i += chunkSize) {
        const end = Math.min(i + chunkSize, SIZE_3MB);
        chunks.push(source.subarray(i, end));
        if (end < SIZE_3MB) {
          chunks.push(pattern);
        }
      }

      const target = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        target.set(chunk, offset);
        offset += chunk.length;
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);

      // Should have mix of copy and insert operations
      const copyDeltas = deltas.filter((d) => isCopyDelta(d));
      const insertDeltas = deltas.filter((d) => isLiteralDelta(d));
      expect(copyDeltas.length).toBeGreaterThan(0);
      expect(insertDeltas.length).toBeGreaterThan(0);
    });

    it("should handle 3MB with changes at boundaries", { timeout: 120000 }, () => {
      // Create 3MB source
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      // Create target with changes at start, middle, and end
      const target = new Uint8Array(source);

      // Change first 10KB
      for (let i = 0; i < 10 * 1024; i++) {
        target[i] = (target[i] + 50) % 256;
      }

      // Change middle 10KB
      const middleStart = Math.floor(SIZE_3MB / 2) - 5 * 1024;
      for (let i = 0; i < 10 * 1024; i++) {
        target[middleStart + i] = (target[middleStart + i] + 50) % 256;
      }

      // Change last 10KB
      for (let i = SIZE_3MB - 10 * 1024; i < SIZE_3MB; i++) {
        target[i] = (target[i] + 50) % 256;
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);
    });

    it("should handle 3MB with binary patterns (null bytes)", { timeout: 120000 }, () => {
      // Create source with null bytes and data
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 10 === 0 ? 0 : i % 256;
      }

      // Create target with similar but slightly different null byte patterns
      const target = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        target[i] = i % 11 === 0 ? 0 : i % 256;
      }

      const deltas = Array.from(createDelta(source, target));
      const reconstructed = reconstructTarget(source, deltas);

      expect(reconstructed).toEqual(target);
      expect(reconstructed.length).toBe(SIZE_3MB);
    });

    it("should handle 3MB blocks with different block sizes", { timeout: 240000 }, () => {
      // Create 3MB source and target with 5% difference
      const source = new Uint8Array(SIZE_3MB);
      for (let i = 0; i < SIZE_3MB; i++) {
        source[i] = i % 256;
      }

      const target = new Uint8Array(source);
      const changeInterval = 20;
      for (let i = 0; i < SIZE_3MB; i += changeInterval) {
        target[i] = (target[i] + 1) % 256;
      }

      // Test with different block sizes
      const blockSizes = [16, 64, 256, 1024];

      for (const blockSize of blockSizes) {
        const deltas = Array.from(createDelta(source, target, blockSize, blockSize));
        const reconstructed = reconstructTarget(source, deltas);

        expect(reconstructed).toEqual(target);
        expect(reconstructed.length).toBe(SIZE_3MB);
      }
    });
  });
});
