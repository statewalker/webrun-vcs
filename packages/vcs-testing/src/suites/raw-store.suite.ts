/**
 * Parametrized test suite for RawStorage implementations
 *
 * This suite tests the core RawStorage interface contract.
 * All storage implementations must pass these tests.
 */

import type { RawStorage } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface RawStorageTestContext {
  rawStorage: RawStorage;
  cleanup?: () => Promise<void>;
  /** Set when the store implements `move`; the move tests then run. */
  supportsMove?: boolean;
  /**
   * Bytes the backend has persisted so far (for example, the sizes of the KV
   * values or SQL blobs written). When given, the suite checks that `store`
   * writes content as it arrives instead of collecting it first.
   */
  persistedBytes?: () => number;
}

/**
 * Factory function to create a storage instance for testing
 */
export type RawStorageFactory = () => Promise<RawStorageTestContext>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Helper to collect async iterable of Uint8Array into single buffer
 */
async function collectBytes(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of input) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Helper to collect async iterable to array
 */
/**
 * Assert two byte arrays are equal. Large arrays are compared directly rather than with
 * `toEqual`, whose element-by-element diff takes seconds on a few hundred KiB.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch, `first differing byte at ${mismatch}`).toBe(-1);
}

async function toArray<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

/**
 * Helper to create async iterable from Uint8Array
 */
async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Create the RawStorage test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "File")
 * @param factory Factory function to create storage instances
 */
export function createRawStorageTests(name: string, factory: RawStorageFactory): void {
  describe(`RawStorage [${name}]`, () => {
    let ctx: RawStorageTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Operations", () => {
      it("stores and loads content by key", async () => {
        const content = encoder.encode("Hello, World!");
        await ctx.rawStorage.store("test-key", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("test-key"));
        expect(decoder.decode(loaded)).toBe("Hello, World!");
      });

      it("overwrites existing content", async () => {
        const content1 = encoder.encode("original");
        const content2 = encoder.encode("replaced");

        await ctx.rawStorage.store("overwrite-key", toStream(content1));
        await ctx.rawStorage.store("overwrite-key", toStream(content2));

        const loaded = await collectBytes(ctx.rawStorage.load("overwrite-key"));
        expect(decoder.decode(loaded)).toBe("replaced");
      });

      it("checks existence via has()", async () => {
        const content = encoder.encode("exists");
        await ctx.rawStorage.store("exists-key", toStream(content));

        expect(await ctx.rawStorage.has("exists-key")).toBe(true);
        expect(await ctx.rawStorage.has("nonexistent-key")).toBe(false);
      });

      it("removes content by key", async () => {
        const content = encoder.encode("to remove");
        await ctx.rawStorage.store("remove-key", toStream(content));

        expect(await ctx.rawStorage.has("remove-key")).toBe(true);

        const removed = await ctx.rawStorage.remove("remove-key");
        expect(removed).toBe(true);
        expect(await ctx.rawStorage.has("remove-key")).toBe(false);
      });

      it("returns false when removing non-existent key", async () => {
        const removed = await ctx.rawStorage.remove("never-existed");
        expect(removed).toBe(false);
      });

      it("lists all keys", async () => {
        await ctx.rawStorage.store("key1", toStream(encoder.encode("content1")));
        await ctx.rawStorage.store("key2", toStream(encoder.encode("content2")));
        await ctx.rawStorage.store("key3", toStream(encoder.encode("content3")));

        const keys = await toArray(ctx.rawStorage.keys());

        expect(keys).toContain("key1");
        expect(keys).toContain("key2");
        expect(keys).toContain("key3");
        expect(keys.length).toBe(3);
      });

      it("returns correct size for stored content", async () => {
        const content = encoder.encode("Hello, World!");
        await ctx.rawStorage.store("size-test", toStream(content));

        const size = await ctx.rawStorage.size("size-test");
        expect(size).toBe(content.length);
      });

      it("returns -1 for size of non-existent key", async () => {
        const size = await ctx.rawStorage.size("nonexistent");
        expect(size).toBe(-1);
      });
    });

    describe("Partial Reads", () => {
      it("loads with start offset", async () => {
        const content = encoder.encode("0123456789");
        await ctx.rawStorage.store("start-key", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("start-key", { start: 5 }));
        expect(decoder.decode(loaded)).toBe("56789");
      });

      it("loads with end limit", async () => {
        const content = encoder.encode("0123456789");
        await ctx.rawStorage.store("end-key", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("end-key", { end: 5 }));
        expect(decoder.decode(loaded)).toBe("01234");
      });

      it("loads with start and end", async () => {
        const content = encoder.encode("0123456789");
        await ctx.rawStorage.store("range-key", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("range-key", { start: 3, end: 7 }));
        expect(decoder.decode(loaded)).toBe("3456");
      });

      it("handles start at end of content", async () => {
        const content = encoder.encode("12345");
        await ctx.rawStorage.store("end-start", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("end-start", { start: 5 }));
        expect(loaded.length).toBe(0);
      });

      it("handles end exceeding content length", async () => {
        const content = encoder.encode("12345");
        await ctx.rawStorage.store("exceed-key", toStream(content));

        const loaded = await collectBytes(
          ctx.rawStorage.load("exceed-key", { start: 3, end: 100 }),
        );
        expect(decoder.decode(loaded)).toBe("45");
      });

      it("handles zero start", async () => {
        const content = encoder.encode("content");
        await ctx.rawStorage.store("zero-start", toStream(content));

        const loaded = await collectBytes(ctx.rawStorage.load("zero-start", { start: 0 }));
        expect(decoder.decode(loaded)).toBe("content");
      });
    });

    describe("Streaming", () => {
      it("stores from async iterable", async () => {
        async function* generateChunks(): AsyncIterable<Uint8Array> {
          yield encoder.encode("chunk1");
          yield encoder.encode("chunk2");
          yield encoder.encode("chunk3");
        }

        await ctx.rawStorage.store("stream-key", generateChunks());
        const loaded = await collectBytes(ctx.rawStorage.load("stream-key"));

        expect(decoder.decode(loaded)).toBe("chunk1chunk2chunk3");
      });

      it.skipIf(globalThis.process?.env?.CI)("handles large content via streaming", async () => {
        // 100KB content
        const largeContent = new Uint8Array(100 * 1024);
        for (let i = 0; i < largeContent.length; i++) {
          largeContent[i] = i % 256;
        }

        await ctx.rawStorage.store("large-key", toStream(largeContent));

        const size = await ctx.rawStorage.size("large-key");
        expect(size).toBe(largeContent.length);

        const loaded = await collectBytes(ctx.rawStorage.load("large-key"));
        expect(loaded.length).toBe(largeContent.length);

        // Verify content integrity
        for (let i = 0; i < loaded.length; i++) {
          expect(loaded[i]).toBe(largeContent[i]);
        }
      });
    });

    describe("Binary Content", () => {
      it("preserves binary content exactly", async () => {
        const binaryContent = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          binaryContent[i] = i;
        }

        await ctx.rawStorage.store("binary-key", toStream(binaryContent));
        const loaded = await collectBytes(ctx.rawStorage.load("binary-key"));

        expect(loaded.length).toBe(256);
        for (let i = 0; i < 256; i++) {
          expect(loaded[i]).toBe(i);
        }
      });

      it("handles null bytes in content", async () => {
        const contentWithNulls = new Uint8Array([0, 1, 0, 2, 0, 3]);
        await ctx.rawStorage.store("nulls-key", toStream(contentWithNulls));

        const loaded = await collectBytes(ctx.rawStorage.load("nulls-key"));
        expect(loaded).toEqual(contentWithNulls);
      });

      it("handles empty content", async () => {
        const emptyContent = new Uint8Array(0);
        await ctx.rawStorage.store("empty-key", toStream(emptyContent));

        expect(await ctx.rawStorage.has("empty-key")).toBe(true);
        expect(await ctx.rawStorage.size("empty-key")).toBe(0);

        const loaded = await collectBytes(ctx.rawStorage.load("empty-key"));
        expect(loaded.length).toBe(0);
      });
    });

    describe("Key Handling", () => {
      it("handles SHA-1 hash keys", async () => {
        const key = "b45ef6fec89518d314f546fd6c3025367b721684";
        await ctx.rawStorage.store(key, toStream(encoder.encode("hash key content")));

        expect(await ctx.rawStorage.has(key)).toBe(true);

        const loaded = await collectBytes(ctx.rawStorage.load(key));
        expect(decoder.decode(loaded)).toBe("hash key content");
      });

      it("handles path-like keys", async () => {
        const key = "objects/ab/cdef123456";
        await ctx.rawStorage.store(key, toStream(encoder.encode("path key")));

        expect(await ctx.rawStorage.has(key)).toBe(true);
      });

      it("handles keys with special characters", async () => {
        const key = "key-with_special.chars";
        await ctx.rawStorage.store(key, toStream(encoder.encode("special")));

        expect(await ctx.rawStorage.has(key)).toBe(true);
      });
    });

    describe("Error Handling", () => {
      it("throws when loading non-existent key", async () => {
        await expect(async () => {
          for await (const _chunk of ctx.rawStorage.load("nonexistent")) {
            // Should not reach here
          }
        }).rejects.toThrow();
      });
    });

    describe("Edge Cases", () => {
      it("handles empty keys listing", async () => {
        const keys = await toArray(ctx.rawStorage.keys());
        expect(keys.length).toBe(0);
      });

      it("handles store/remove/store cycle", async () => {
        const content = encoder.encode("cycle content");

        await ctx.rawStorage.store("cycle-key", toStream(content));
        expect(await ctx.rawStorage.has("cycle-key")).toBe(true);

        await ctx.rawStorage.remove("cycle-key");
        expect(await ctx.rawStorage.has("cycle-key")).toBe(false);

        await ctx.rawStorage.store("cycle-key", toStream(content));
        expect(await ctx.rawStorage.has("cycle-key")).toBe(true);
      });

      it("handles multiple removes of same key", async () => {
        await ctx.rawStorage.store("multi-rem", toStream(encoder.encode("x")));

        const removed1 = await ctx.rawStorage.remove("multi-rem");
        expect(removed1).toBe(true);

        const removed2 = await ctx.rawStorage.remove("multi-rem");
        expect(removed2).toBe(false);
      });
    });

    describe("Large values", () => {
      /** 600 KiB + 123 of deterministic bytes, so values cross several 256 KiB chunks. */
      const large = (seed: number) => {
        const out = new Uint8Array(600 * 1024 + 123);
        let x = seed;
        for (let i = 0; i < out.length; i++) {
          x = (Math.imul(x, 1103515245) + 12345) | 0;
          out[i] = x >>> 24;
        }
        return out;
      };
      async function* pieces(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
        for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
      }

      it("round-trips a value fed in odd-sized pieces, with ranges across chunk boundaries", async () => {
        const data = large(1);
        await ctx.rawStorage.store("big", pieces(data, 7777));
        expect(await ctx.rawStorage.size("big")).toBe(data.length);
        expectSameBytes(await collectBytes(ctx.rawStorage.load("big")), data);
        const start = 256 * 1024 - 10;
        const end = 512 * 1024 + 10;
        expectSameBytes(
          await collectBytes(ctx.rawStorage.load("big", { start, end })),
          data.subarray(start, end),
        );
        expect(await collectBytes(ctx.rawStorage.load("big", { start: data.length - 5 }))).toEqual(
          data.subarray(data.length - 5),
        );
      });

      it("replaces large values with small ones and back, listing only the key", async () => {
        await ctx.rawStorage.store("v", pieces(large(2), 65536));
        await ctx.rawStorage.store("v", toStream(encoder.encode("small")));
        expect(decoder.decode(await collectBytes(ctx.rawStorage.load("v")))).toBe("small");
        expect(await ctx.rawStorage.size("v")).toBe(5);
        const again = large(3);
        await ctx.rawStorage.store("v", pieces(again, 65536));
        expectSameBytes(await collectBytes(ctx.rawStorage.load("v")), again);
        expect(await toArray(ctx.rawStorage.keys())).toEqual(["v"]);
        expect(await ctx.rawStorage.remove("v")).toBe(true);
        expect(await toArray(ctx.rawStorage.keys())).toEqual([]);
      });

      it("keeps nothing of a write whose stream fails", async () => {
        async function* failing(): AsyncIterable<Uint8Array> {
          yield* pieces(large(4), 65536);
          throw new Error("source failed");
        }
        await expect(ctx.rawStorage.store("broken", failing())).rejects.toThrow("source failed");
        expect(await ctx.rawStorage.has("broken")).toBe(false);
        expect(await toArray(ctx.rawStorage.keys())).toEqual([]);
      });

      it("writes content as it arrives (when the backend reports persisted bytes)", async () => {
        const persisted = ctx.persistedBytes;
        if (!persisted) return;
        const before = persisted();
        let produced = 0;
        let maxLag = 0;
        async function* source(): AsyncIterable<Uint8Array> {
          for (let i = 0; i < 64; i++) {
            maxLag = Math.max(maxLag, produced - (persisted?.() ?? 0) + before);
            produced += 64 * 1024;
            yield new Uint8Array(64 * 1024).fill(i);
          }
        }
        await ctx.rawStorage.store("streamed", source());
        expect(await ctx.rawStorage.size("streamed")).toBe(64 * 64 * 1024);
        // never more than about one storage chunk (plus the piece in hand) ahead
        expect(maxLag).toBeLessThanOrEqual(1024 * 1024);
      });
    });

    describe("move", () => {
      it("renames a value, small or large, replacing the target", async () => {
        if (!ctx.supportsMove) return;
        const move = ctx.rawStorage.move?.bind(ctx.rawStorage);
        expect(move).toBeTypeOf("function");
        if (!move) return;
        const big = new Uint8Array(300 * 1024).fill(7);
        await ctx.rawStorage.store("a", toStream(big));
        await ctx.rawStorage.store("b", toStream(encoder.encode("old")));
        expect(await move("a", "b")).toBe(true);
        expect(await ctx.rawStorage.has("a")).toBe(false);
        expectSameBytes(await collectBytes(ctx.rawStorage.load("b")), big);
        await ctx.rawStorage.store("c", toStream(encoder.encode("tiny")));
        expect(await move("c", "b")).toBe(true);
        expect(decoder.decode(await collectBytes(ctx.rawStorage.load("b")))).toBe("tiny");
        expect(await move("missing", "d")).toBe(false);
        expect(await toArray(ctx.rawStorage.keys())).toEqual(["b"]);
      });
    });
  });
}
