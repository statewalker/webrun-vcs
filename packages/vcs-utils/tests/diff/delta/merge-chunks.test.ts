import { describe, expect, it } from "vitest";
import { mergeChunks } from "../../../src/diff/index.js";

describe("mergeChunks", () => {
  describe("Edge Cases", () => {
    it("should handle empty iterable", () => {
      const chunks: Uint8Array[] = [];
      const result = mergeChunks(chunks);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it("should handle single chunk", () => {
      const chunk = new Uint8Array([1, 2, 3, 4, 5]);
      const chunks = [chunk];
      const result = mergeChunks(chunks);
      expect(result).toBe(chunk); // Should return the same reference
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("should handle single empty chunk", () => {
      const chunks = [new Uint8Array([])];
      const result = mergeChunks(chunks);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it("should handle multiple empty chunks", () => {
      const chunks = [new Uint8Array([]), new Uint8Array([]), new Uint8Array([])];
      const result = mergeChunks(chunks);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
  });

  describe("Basic Functionality", () => {
    it("should merge two chunks", () => {
      const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("should merge multiple chunks", () => {
      const chunks = [
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5, 6]),
        new Uint8Array([7, 8]),
      ];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    });

    it("should handle chunks of different sizes", () => {
      const chunks = [
        new Uint8Array([1]),
        new Uint8Array([2, 3, 4, 5]),
        new Uint8Array([6, 7]),
        new Uint8Array([8, 9, 10, 11, 12]),
      ];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    });

    it("should handle chunks with empty chunks mixed in", () => {
      const chunks = [
        new Uint8Array([1, 2]),
        new Uint8Array([]),
        new Uint8Array([3, 4]),
        new Uint8Array([]),
        new Uint8Array([5, 6]),
      ];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });
  });

  describe("Data Integrity", () => {
    it("should preserve all bytes correctly", () => {
      const chunks = [
        new Uint8Array([0, 1, 2, 3]),
        new Uint8Array([255, 254, 253, 252]),
        new Uint8Array([128, 127, 126, 125]),
      ];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([0, 1, 2, 3, 255, 254, 253, 252, 128, 127, 126, 125]));
    });

    it("should handle binary data with null bytes", () => {
      const chunks = [
        new Uint8Array([0, 0, 0, 0]),
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([0, 0, 0, 0]),
      ];
      const result = mergeChunks(chunks);
      expect(result).toEqual(new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0]));
    });

    it("should handle all byte values 0-255", () => {
      const chunk1 = new Uint8Array(128);
      const chunk2 = new Uint8Array(128);
      for (let i = 0; i < 128; i++) {
        chunk1[i] = i;
        chunk2[i] = i + 128;
      }
      const chunks = [chunk1, chunk2];
      const result = mergeChunks(chunks);

      expect(result.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(result[i]).toBe(i);
      }
    });
  });

  describe("Generator Support", () => {
    it("should work with generator functions", () => {
      function* generateChunks() {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4]);
        yield new Uint8Array([5, 6]);
      }

      const result = mergeChunks(generateChunks());
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("should work with iterators", () => {
      const chunks = [new Uint8Array([10, 20]), new Uint8Array([30, 40]), new Uint8Array([50, 60])];

      const result = mergeChunks(chunks[Symbol.iterator]());
      expect(result).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60]));
    });

    it("should handle lazy evaluation", () => {
      let callCount = 0;
      function* generateChunks() {
        callCount++;
        yield new Uint8Array([1, 2]);
        callCount++;
        yield new Uint8Array([3, 4]);
        callCount++;
        yield new Uint8Array([5, 6]);
      }

      const result = mergeChunks(generateChunks());
      expect(callCount).toBe(3); // All chunks were consumed
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });
  });

  describe("Large Data", () => {
    it("should handle many small chunks", () => {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < 100; i++) {
        chunks.push(new Uint8Array([i % 256]));
      }

      const result = mergeChunks(chunks);
      expect(result.length).toBe(100);
      for (let i = 0; i < 100; i++) {
        expect(result[i]).toBe(i % 256);
      }
    });

    it("should handle large chunks", () => {
      const chunk1 = new Uint8Array(10000);
      const chunk2 = new Uint8Array(10000);
      for (let i = 0; i < 10000; i++) {
        chunk1[i] = i % 256;
        chunk2[i] = (i + 100) % 256;
      }

      const result = mergeChunks([chunk1, chunk2]);
      expect(result.length).toBe(20000);

      // Verify first chunk
      for (let i = 0; i < 10000; i++) {
        expect(result[i]).toBe(i % 256);
      }

      // Verify second chunk
      for (let i = 0; i < 10000; i++) {
        expect(result[i + 10000]).toBe((i + 100) % 256);
      }
    });

    it("should handle mix of large and small chunks", () => {
      const chunks = [
        new Uint8Array([1]),
        new Uint8Array(1000).fill(42),
        new Uint8Array([2, 3]),
        new Uint8Array(500).fill(99),
        new Uint8Array([4]),
      ];

      const result = mergeChunks(chunks);
      expect(result.length).toBe(1 + 1000 + 2 + 500 + 1);
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(42);
      expect(result[1001]).toBe(2);
      expect(result[1002]).toBe(3);
      expect(result[1003]).toBe(99);
      expect(result[1503]).toBe(4);
    });
  });

  describe("Real-world Scenarios", () => {
    it("should work with text encoder output", () => {
      const encoder = new TextEncoder();
      const chunks = [encoder.encode("Hello, "), encoder.encode("World"), encoder.encode("!")];

      const result = mergeChunks(chunks);
      const decoder = new TextDecoder();
      expect(decoder.decode(result)).toBe("Hello, World!");
    });

    it("should reconstruct file-like data", () => {
      const encoder = new TextEncoder();
      const chunks = [
        encoder.encode("Line 1\n"),
        encoder.encode("Line 2\n"),
        encoder.encode("Line 3\n"),
      ];

      const result = mergeChunks(chunks);
      const decoder = new TextDecoder();
      expect(decoder.decode(result)).toBe("Line 1\nLine 2\nLine 3\n");
    });

    it("should handle image-like binary data", () => {
      // Simulate image header + data
      const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const data = new Uint8Array(100).fill(0xab);
      const footer = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

      const result = mergeChunks([header, data, footer]);
      expect(result.length).toBe(108);
      expect(result[0]).toBe(0x89);
      expect(result[1]).toBe(0x50);
      expect(result[2]).toBe(0x4e);
      expect(result[3]).toBe(0x47);
      expect(result[4]).toBe(0xab);
      expect(result[104]).toBe(0x00);
    });
  });

  describe("Memory Efficiency", () => {
    it("should not modify original chunks", () => {
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5, 6]);
      const originalChunk1 = new Uint8Array([1, 2, 3]);
      const originalChunk2 = new Uint8Array([4, 5, 6]);

      mergeChunks([chunk1, chunk2]);

      expect(chunk1).toEqual(originalChunk1);
      expect(chunk2).toEqual(originalChunk2);
    });

    it("should create a new array for merged result", () => {
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5, 6]);
      const result = mergeChunks([chunk1, chunk2]);

      // Modifying result should not affect originals
      result[0] = 99;
      expect(chunk1[0]).toBe(1);
    });
  });
});
