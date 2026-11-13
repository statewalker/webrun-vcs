/**
 * Tests for BufferedByteReader
 *
 * Compressed reads use the portable push inflater (no setup needed).
 */

import { randomBytes } from "node:crypto";
import { InflateError, TruncatedStreamError } from "@statewalker/vcs-utils/compression";
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
      await expect(gen.next()).rejects.toThrow(TruncatedStreamError);
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

  describe("compressed reads on the push inflater", () => {
    function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
      return out;
    }
    function countingIterator(chunks: Uint8Array[]) {
      const it = { pulls: 0, ...toIterator(chunks) };
      const next = it.next.bind(it);
      it.next = () => {
        it.pulls++;
        return next();
      };
      return it;
    }

    it("pulls each chunk once and never past the object's last chunk", async () => {
      const original = new Uint8Array(1 << 20);
      for (let i = 0; i < original.length; i++) original[i] = (i * 7919) % 251;
      const compressed = pako.deflate(original);
      const parts = chunksOf(compressed, 1024);
      const iterator = countingIterator([...parts, new Uint8Array([42])]);
      const reader = new BufferedByteReader(iterator);

      const bytes = await reader.readCompressedObject(original.length);

      expect(Array.from(bytes)).toEqual(Array.from(compressed));
      expect(iterator.pulls).toBe(parts.length);
      expect(await reader.readExact(1)).toEqual(new Uint8Array([42]));
    });

    it("streams a large object in pieces instead of one buffer", async () => {
      const original = new Uint8Array(1 << 20).fill(7);
      const reader = new BufferedByteReader(toIterator(chunksOf(pako.deflate(original), 512)));
      let pieces = 0;
      let total = 0;
      for await (const piece of reader.readDecompressed(original.length)) {
        pieces++;
        total += piece.length;
      }
      expect(total).toBe(original.length);
      expect(pieces).toBeGreaterThan(1);
    });

    it("reports corruption as corruption, not as missing data", async () => {
      const compressed = pako.deflate(new TextEncoder().encode("payload ".repeat(500)));
      compressed[compressed.length - 1] ^= 0xff;
      const reader = new BufferedByteReader(toIterator([compressed, new Uint8Array(64)]));
      await expect(reader.readCompressedObject(4000)).rejects.toThrow(
        /inflate failed|Adler|check/i,
      );
    });

    it("reports a stream that ends inside the object as truncated", async () => {
      const compressed = pako.deflate(new TextEncoder().encode("payload ".repeat(500)));
      const reader = new BufferedByteReader(toIterator([compressed.subarray(0, 20)]));
      await expect(reader.readCompressedObject(4000)).rejects.toThrow(TruncatedStreamError);
    });

    it("stays on the object boundary when the consumer stops early", async () => {
      // Incompressible, so the object spans many chunks and pushes.
      const original = new Uint8Array(randomBytes(300_000));
      const next = pako.deflate(new TextEncoder().encode("next object"));
      const all = new Uint8Array([...pako.deflate(original), ...next]);
      const reader = new BufferedByteReader(toIterator(chunksOf(all, 10_000)));

      for await (const _piece of reader.readDecompressed(original.length)) break;

      const second = await reader.readCompressedObject(11);
      expect(Array.from(second)).toEqual(Array.from(next));
    });

    it("reports a bad rest of an abandoned block on the next read", async () => {
      const original = new Uint8Array(randomBytes(100_000));
      const compressed = pako.deflate(original);
      const truncated = compressed.subarray(0, compressed.length - 10);
      const reader = new BufferedByteReader(toIterator(chunksOf(truncated, 10_000)));
      for await (const _piece of reader.readDecompressed(original.length)) break;
      await expect(reader.readExact(1)).rejects.toThrow(TruncatedStreamError);
    });

    it("reads an empty object: no pieces, and the reader moves past it", async () => {
      const empty = pako.deflate(new Uint8Array(0));
      const reader = new BufferedByteReader(toIterator([new Uint8Array([...empty, 5])]));
      const pieces: Uint8Array[] = [];
      for await (const piece of reader.readDecompressed(0)) pieces.push(piece);
      expect(pieces.reduce((n, p) => n + p.length, 0)).toBe(0);
      expect(await reader.readExact(1)).toEqual(new Uint8Array([5]));
    });
  });
});
