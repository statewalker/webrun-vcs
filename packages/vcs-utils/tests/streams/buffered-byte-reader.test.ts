/**
 * Tests for BufferedByteReader
 *
 * Uses the default pako-based decompressBlockPartial (no setup needed).
 */

import { BufferedByteReader } from "@statewalker/vcs-utils/streams";
import * as pako from "pako";
import { describe, expect, it } from "vitest";

function toIterator(chunks: Uint8Array[]): AsyncIterator<Uint8Array> {
  let i = 0;
  return {
    async next() {
      if (i < chunks.length) {
        return { value: chunks[i++], done: false };
      }
      return { value: undefined as unknown as Uint8Array, done: true };
    },
  };
}

describe("BufferedByteReader", () => {
  describe("readExact", () => {
    it("reads exact bytes from a single chunk", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1, 2, 3, 4, 5])]));
      const result = await reader.readExact(3);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("reads across chunk boundaries", async () => {
      const reader = new BufferedByteReader(
        toIterator([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]),
      );
      const result = await reader.readExact(4);
      expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    });

    it("preserves leftover bytes for next read", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1, 2, 3, 4, 5])]));
      await reader.readExact(2);
      const result = await reader.readExact(3);
      expect(Array.from(result)).toEqual([3, 4, 5]);
    });

    it("throws on premature stream end", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1, 2])]));
      await expect(reader.readExact(5)).rejects.toThrow("Unexpected end of stream");
    });
  });

  describe("seed", () => {
    it("pre-fills buffer with data", async () => {
      const reader = new BufferedByteReader(toIterator([]));
      reader.seed(new Uint8Array([10, 20, 30]));
      const result = await reader.readExact(3);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });
  });

  describe("getLeftover", () => {
    it("returns unread bytes", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1, 2, 3, 4, 5])]));
      await reader.readExact(2);
      const leftover = reader.getLeftover();
      expect(Array.from(leftover)).toEqual([3, 4, 5]);
    });
  });

  describe("isExhausted", () => {
    it("is false when data remains", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1, 2])]));
      await reader.readExact(1);
      expect(reader.isExhausted).toBe(false);
    });

    it("is true after iterator ends and buffer drains", async () => {
      const reader = new BufferedByteReader(toIterator([new Uint8Array([1])]));
      await reader.readExact(1);
      // Attempt to read more — forces iterator poll to discover end
      try {
        await reader.readExact(1);
      } catch {
        // Expected: no more data
      }
      expect(reader.isExhausted).toBe(true);
    });
  });

  describe("readCompressedObject", () => {
    it("reads a compressed object and returns compressed bytes", async () => {
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = pako.deflate(original);
      const reader = new BufferedByteReader(toIterator([compressed]));

      const result = await reader.readCompressedObject(5);
      expect(result.length).toBe(compressed.length);
    });

    it("reads compressed object followed by more data", async () => {
      const original = new Uint8Array([1, 2, 3]);
      const compressed = pako.deflate(original);
      const trailing = new Uint8Array([99, 98, 97]);
      const combined = new Uint8Array(compressed.length + trailing.length);
      combined.set(compressed);
      combined.set(trailing, compressed.length);

      const reader = new BufferedByteReader(toIterator([combined]));
      await reader.readCompressedObject(3);

      const leftover = reader.getLeftover();
      expect(Array.from(leftover)).toEqual([99, 98, 97]);
    });
  });

  describe("readDecompressed", () => {
    it("reads a compressed block and yields decompressed content", async () => {
      const original = new Uint8Array([10, 20, 30, 40, 50]);
      const compressed = pako.deflate(original);
      const reader = new BufferedByteReader(toIterator([compressed]));

      const chunks: Uint8Array[] = [];
      for await (const chunk of reader.readDecompressed(5)) {
        chunks.push(chunk);
      }

      const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      expect(Array.from(result)).toEqual([10, 20, 30, 40, 50]);
    });

    it("preserves reader state for sequential objects", async () => {
      const obj1 = new Uint8Array([1, 2, 3]);
      const obj2 = new Uint8Array([4, 5, 6, 7]);
      const compressed1 = pako.deflate(obj1);
      const compressed2 = pako.deflate(obj2);
      const combined = new Uint8Array(compressed1.length + compressed2.length);
      combined.set(compressed1);
      combined.set(compressed2, compressed1.length);

      const reader = new BufferedByteReader(toIterator([combined]));

      // Read first object
      const chunks1: Uint8Array[] = [];
      for await (const chunk of reader.readDecompressed(3)) {
        chunks1.push(chunk);
      }
      const result1 = new Uint8Array(chunks1.reduce((n, c) => n + c.length, 0));
      let off = 0;
      for (const c of chunks1) {
        result1.set(c, off);
        off += c.length;
      }

      // Read second object
      const chunks2: Uint8Array[] = [];
      for await (const chunk of reader.readDecompressed(4)) {
        chunks2.push(chunk);
      }
      const result2 = new Uint8Array(chunks2.reduce((n, c) => n + c.length, 0));
      off = 0;
      for (const c of chunks2) {
        result2.set(c, off);
        off += c.length;
      }

      expect(Array.from(result1)).toEqual([1, 2, 3]);
      expect(Array.from(result2)).toEqual([4, 5, 6, 7]);
    });

    it("works with small input chunks", async () => {
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = pako.deflate(original);

      // Split compressed data into 1-byte chunks
      const singleByteChunks = Array.from(compressed).map((b) => new Uint8Array([b]));
      const reader = new BufferedByteReader(toIterator(singleByteChunks));

      const chunks: Uint8Array[] = [];
      for await (const chunk of reader.readDecompressed(5)) {
        chunks.push(chunk);
      }

      const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it("throws on size mismatch", async () => {
      const original = new Uint8Array([1, 2, 3]);
      const compressed = pako.deflate(original);
      const reader = new BufferedByteReader(toIterator([compressed]));

      const gen = reader.readDecompressed(10); // wrong expected size
      await expect(gen.next()).rejects.toThrow("Decompression size mismatch");
    });

    it("throws on truncated compressed data", async () => {
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = pako.deflate(original);
      // Truncate the compressed data — pako may partially decompress
      const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
      const reader = new BufferedByteReader(toIterator([truncated]));

      const gen = reader.readDecompressed(5);
      // Either "Incomplete compressed data" or "Decompression size mismatch"
      await expect(gen.next()).rejects.toThrow(/compressed data|size mismatch/i);
    });

    it("consumes only compressed bytes, leaving trailing data", async () => {
      const original = new Uint8Array([1, 2, 3]);
      const compressed = pako.deflate(original);
      const trailing = new Uint8Array([99, 98]);
      const combined = new Uint8Array(compressed.length + trailing.length);
      combined.set(compressed);
      combined.set(trailing, compressed.length);

      const reader = new BufferedByteReader(toIterator([combined]));

      // Consume the decompressed output
      for await (const _chunk of reader.readDecompressed(3)) {
        // just consume
      }

      const leftover = reader.getLeftover();
      expect(Array.from(leftover)).toEqual([99, 98]);
    });
  });
});
