/**
 * Parametrized test suite for Blobs implementations
 *
 * This suite tests the core Blobs interface contract.
 * All storage implementations must pass these tests.
 */

import type { Blobs } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface BlobStoreTestContext {
  blobStore: Blobs;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type BlobStoreFactory = () => Promise<BlobStoreTestContext>;

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
 * Create the BlobStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "KV")
 * @param factory Factory function to create storage instances
 */
export function createBlobStoreTests(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore [${name}]`, () => {
    let ctx: BlobStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Operations", () => {
      it("stores and loads blob content", async () => {
        const content = encoder.encode("Hello, World!");
        const id = await ctx.blobStore.store(toStream(content));

        expect(id).toMatch(/^[0-9a-f]{40}$/);

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(decoder.decode(loaded)).toBe("Hello, World!");
      });

      it("returns valid SHA-1 object ID", async () => {
        const content = encoder.encode("test content");
        const id = await ctx.blobStore.store(toStream(content));

        expect(id).toMatch(/^[0-9a-f]{40}$/);
        expect(id.length).toBe(40);
      });

      it("content-addressable: same content produces same ID", async () => {
        const content = encoder.encode("Same content");

        const id1 = await ctx.blobStore.store(toStream(content));
        const id2 = await ctx.blobStore.store(toStream(content));

        expect(id1).toBe(id2);
      });

      it("different content produces different IDs", async () => {
        const content1 = encoder.encode("Content A");
        const content2 = encoder.encode("Content B");

        const id1 = await ctx.blobStore.store(toStream(content1));
        const id2 = await ctx.blobStore.store(toStream(content2));

        expect(id1).not.toBe(id2);
      });

      it("checks existence via has()", async () => {
        const content = encoder.encode("test");
        const id = await ctx.blobStore.store(toStream(content));

        expect(await ctx.blobStore.has(id)).toBe(true);
        expect(await ctx.blobStore.has("0000000000000000000000000000000000000000")).toBe(false);
      });

      it("removes blob", async () => {
        const content = encoder.encode("to be removed");
        const id = await ctx.blobStore.store(toStream(content));

        expect(await ctx.blobStore.has(id)).toBe(true);

        const removed = await ctx.blobStore.remove(id);
        expect(removed).toBe(true);
        expect(await ctx.blobStore.has(id)).toBe(false);
      });

      it("returns false when removing non-existent blob", async () => {
        const removed = await ctx.blobStore.remove("0000000000000000000000000000000000000000");
        expect(removed).toBe(false);
      });

      it("lists all blob keys", async () => {
        const content1 = encoder.encode("blob 1");
        const content2 = encoder.encode("blob 2");
        const content3 = encoder.encode("blob 3");

        const id1 = await ctx.blobStore.store(toStream(content1));
        const id2 = await ctx.blobStore.store(toStream(content2));
        const id3 = await ctx.blobStore.store(toStream(content3));

        const keys = await toArray(ctx.blobStore.keys());

        expect(keys).toContain(id1);
        expect(keys).toContain(id2);
        expect(keys).toContain(id3);
        expect(keys.length).toBe(3);
      });
    });

    describe("Size Operations", () => {
      it("returns correct blob size", async () => {
        const content = encoder.encode("Hello, World!");
        const id = await ctx.blobStore.store(toStream(content));

        const size = await ctx.blobStore.size(id);
        expect(size).toBe(content.length);
      });

      it("returns size for empty blob", async () => {
        const content = new Uint8Array(0);
        const id = await ctx.blobStore.store(toStream(content));

        const size = await ctx.blobStore.size(id);
        expect(size).toBe(0);
      });

      it("size is consistent with stored content", async () => {
        const testSizes = [0, 1, 10, 100, 1000, 10000];

        for (const expectedSize of testSizes) {
          const content = new Uint8Array(expectedSize).fill(65); // 'A'
          const id = await ctx.blobStore.store(toStream(content));

          const size = await ctx.blobStore.size(id);
          expect(size).toBe(expectedSize);

          // Also verify loaded content has correct size
          const result = await ctx.blobStore.load(id);
          if (!result) throw new Error("Blob not found");
          const loaded = await collectBytes(result);
          expect(loaded.length).toBe(expectedSize);
        }
      });
    });

    describe("Streaming", () => {
      it("stores from async iterable", async () => {
        async function* generateChunks(): AsyncIterable<Uint8Array> {
          yield encoder.encode("chunk1");
          yield encoder.encode("chunk2");
          yield encoder.encode("chunk3");
        }

        const id = await ctx.blobStore.store(generateChunks());
        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);

        expect(decoder.decode(loaded)).toBe("chunk1chunk2chunk3");
      });

      it("stores from sync iterable", async () => {
        function* generateChunks(): Iterable<Uint8Array> {
          yield encoder.encode("sync1");
          yield encoder.encode("sync2");
        }

        const id = await ctx.blobStore.store(generateChunks());
        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);

        expect(decoder.decode(loaded)).toBe("sync1sync2");
      });

      it("load returns async iterable", async () => {
        const content = encoder.encode("streamable content");
        const id = await ctx.blobStore.store(toStream(content));

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const chunks: Uint8Array[] = [];
        for await (const chunk of result) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThan(0);
        const combined = await collectBytes(
          (async function* () {
            for (const c of chunks) yield c;
          })(),
        );
        expect(decoder.decode(combined)).toBe("streamable content");
      });

      it.skipIf(process.env.CI)("handles large blobs via streaming", async () => {
        // 100KB blob
        const largeContent = new Uint8Array(100 * 1024);
        for (let i = 0; i < largeContent.length; i++) {
          largeContent[i] = i % 256;
        }

        const id = await ctx.blobStore.store(toStream(largeContent));
        expect(await ctx.blobStore.has(id)).toBe(true);

        const size = await ctx.blobStore.size(id);
        expect(size).toBe(largeContent.length);

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(loaded.length).toBe(largeContent.length);

        // Verify content integrity
        expect(loaded).toEqual(largeContent);
      });
    });

    describe("Git Compatibility", () => {
      it("produces Git-compatible SHA-1 for known content", async () => {
        // Known Git hash: echo -n "Hello, World!" | git hash-object --stdin
        // Returns: b45ef6fec89518d314f546fd6c3025367b721684
        const content = encoder.encode("Hello, World!");
        const id = await ctx.blobStore.store(toStream(content));

        expect(id).toBe("b45ef6fec89518d314f546fd6c3025367b721684");
      });

      it("produces Git-compatible SHA-1 for hello", async () => {
        // Known Git hash: echo -n "hello" | git hash-object --stdin
        // Returns: b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
        const content = encoder.encode("hello");
        const id = await ctx.blobStore.store(toStream(content));

        expect(id).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
      });

      it("handles empty blob with known hash", async () => {
        // Known Git hash for empty blob: git hash-object -t blob /dev/null
        // Returns: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
        const emptyContent = new Uint8Array(0);
        const id = await ctx.blobStore.store(toStream(emptyContent));

        expect(id).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
      });

      it("preserves binary content exactly", async () => {
        // Binary content with all byte values 0-255
        const binaryContent = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          binaryContent[i] = i;
        }

        const id = await ctx.blobStore.store(toStream(binaryContent));
        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);

        expect(loaded.length).toBe(256);
        for (let i = 0; i < 256; i++) {
          expect(loaded[i]).toBe(i);
        }
      });

      it("handles null bytes in content", async () => {
        const contentWithNulls = new Uint8Array([0, 1, 0, 2, 0, 3]);
        const id = await ctx.blobStore.store(toStream(contentWithNulls));

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(loaded).toEqual(contentWithNulls);
      });
    });

    describe("Error Handling", () => {
      it("returns undefined when loading non-existent blob", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        const result = await ctx.blobStore.load(nonExistentId);
        expect(result).toBeUndefined();
      });

      it("returns -1 for size of non-existent blob", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        const size = await ctx.blobStore.size(nonExistentId);
        expect(size).toBe(-1);
      });

      it("handles empty content correctly", async () => {
        const emptyContent = new Uint8Array(0);
        const id = await ctx.blobStore.store(toStream(emptyContent));

        expect(await ctx.blobStore.has(id)).toBe(true);
        expect(await ctx.blobStore.size(id)).toBe(0);

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(loaded.length).toBe(0);
      });
    });

    describe("Edge Cases", () => {
      it("handles empty keys listing", async () => {
        // Fresh store should have no keys
        const keys = await toArray(ctx.blobStore.keys());
        expect(keys.length).toBe(0);
      });

      it("handles store/remove/store cycle", async () => {
        const content = encoder.encode("cycle test");

        const id1 = await ctx.blobStore.store(toStream(content));
        expect(await ctx.blobStore.has(id1)).toBe(true);

        await ctx.blobStore.remove(id1);
        expect(await ctx.blobStore.has(id1)).toBe(false);

        const id2 = await ctx.blobStore.store(toStream(content));
        expect(id2).toBe(id1); // Same content = same ID
        expect(await ctx.blobStore.has(id2)).toBe(true);
      });

      it("handles multiple removes of same blob", async () => {
        const content = encoder.encode("remove twice");
        const id = await ctx.blobStore.store(toStream(content));

        const removed1 = await ctx.blobStore.remove(id);
        expect(removed1).toBe(true);

        const removed2 = await ctx.blobStore.remove(id);
        expect(removed2).toBe(false);
      });

      it("handles blobs with newlines", async () => {
        const content = encoder.encode("line1\nline2\nline3\n");
        const id = await ctx.blobStore.store(toStream(content));

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(decoder.decode(loaded)).toBe("line1\nline2\nline3\n");
      });

      it("handles blobs with carriage returns", async () => {
        const content = encoder.encode("line1\r\nline2\r\nline3\r\n");
        const id = await ctx.blobStore.store(toStream(content));

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(decoder.decode(loaded)).toBe("line1\r\nline2\r\nline3\r\n");
      });

      it("handles UTF-8 content", async () => {
        const content = encoder.encode("Hello 世界 🌍 مرحبا");
        const id = await ctx.blobStore.store(toStream(content));

        const result = await ctx.blobStore.load(id);
        if (!result) throw new Error("Blob not found");
        const loaded = await collectBytes(result);
        expect(decoder.decode(loaded)).toBe("Hello 世界 🌍 مرحبا");
      });
    });
  });
}
