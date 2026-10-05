/**
 * Parametrized test suite for VolatileStore implementations
 *
 * This suite tests the core VolatileStore interface contract.
 * All storage implementations must pass these tests.
 */

import type { VolatileContent, VolatileStore } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface VolatileStoreTestContext {
  volatileStore: VolatileStore;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type VolatileStoreFactory = () => Promise<VolatileStoreTestContext>;

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
 * Helper to create async iterable from Uint8Array
 */
async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Create the VolatileStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "File", "Hybrid")
 * @param factory Factory function to create storage instances
 */
export function createVolatileStoreTests(name: string, factory: VolatileStoreFactory): void {
  describe(`VolatileStore [${name}]`, () => {
    let ctx: VolatileStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Store Operation", () => {
      it("stores content and returns VolatileContent handle", async () => {
        const content = encoder.encode("Hello, World!");
        const handle = await ctx.volatileStore.store(toStream(content));

        expect(handle).toBeDefined();
        expect(typeof handle.size).toBe("number");
        expect(typeof handle.read).toBe("function");
        expect(typeof handle.dispose).toBe("function");

        await handle.dispose();
      });

      it("returns correct size for stored content", async () => {
        const content = encoder.encode("Test content");
        const handle = await ctx.volatileStore.store(toStream(content));

        expect(handle.size).toBe(content.length);

        await handle.dispose();
      });

      it("read returns stored content", async () => {
        const content = encoder.encode("Read test");
        const handle = await ctx.volatileStore.store(toStream(content));

        const loaded = await collectBytes(handle.read());
        expect(decoder.decode(loaded)).toBe("Read test");

        await handle.dispose();
      });
    });

    describe("Multiple Reads", () => {
      it("read can be called multiple times", async () => {
        const content = encoder.encode("Multi read");
        const handle = await ctx.volatileStore.store(toStream(content));

        const read1 = await collectBytes(handle.read());
        const read2 = await collectBytes(handle.read());
        const read3 = await collectBytes(handle.read());

        expect(decoder.decode(read1)).toBe("Multi read");
        expect(decoder.decode(read2)).toBe("Multi read");
        expect(decoder.decode(read3)).toBe("Multi read");

        await handle.dispose();
      });

      it("multiple reads return identical content", async () => {
        const content = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          content[i] = i;
        }

        const handle = await ctx.volatileStore.store(toStream(content));

        const read1 = await collectBytes(handle.read());
        const read2 = await collectBytes(handle.read());

        expect(read1).toEqual(read2);
        expect(read1.length).toBe(256);

        await handle.dispose();
      });
    });

    describe("Streaming Input", () => {
      it("stores from async iterable with multiple chunks", async () => {
        async function* generateChunks(): AsyncIterable<Uint8Array> {
          yield encoder.encode("chunk1");
          yield encoder.encode("chunk2");
          yield encoder.encode("chunk3");
        }

        const handle = await ctx.volatileStore.store(generateChunks());

        expect(handle.size).toBe(18); // "chunk1chunk2chunk3".length

        const loaded = await collectBytes(handle.read());
        expect(decoder.decode(loaded)).toBe("chunk1chunk2chunk3");

        await handle.dispose();
      });

      it("stores from sync iterable", async () => {
        function* generateChunks(): Iterable<Uint8Array> {
          yield encoder.encode("sync1");
          yield encoder.encode("sync2");
        }

        const handle = await ctx.volatileStore.store(generateChunks());
        const loaded = await collectBytes(handle.read());

        expect(decoder.decode(loaded)).toBe("sync1sync2");

        await handle.dispose();
      });
    });

    describe("Dispose Operation", () => {
      it("dispose releases resources", async () => {
        const content = encoder.encode("dispose test");
        const handle = await ctx.volatileStore.store(toStream(content));

        await expect(handle.dispose()).resolves.not.toThrow();
      });

      it("dispose can be called multiple times without error", async () => {
        const content = encoder.encode("double dispose");
        const handle = await ctx.volatileStore.store(toStream(content));

        await handle.dispose();
        // Second dispose should not throw
        await expect(handle.dispose()).resolves.not.toThrow();
      });
    });

    describe("Binary Content", () => {
      it("preserves binary content exactly", async () => {
        const binaryContent = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          binaryContent[i] = i;
        }

        const handle = await ctx.volatileStore.store(toStream(binaryContent));
        const loaded = await collectBytes(handle.read());

        expect(loaded.length).toBe(256);
        for (let i = 0; i < 256; i++) {
          expect(loaded[i]).toBe(i);
        }

        await handle.dispose();
      });

      it("handles null bytes in content", async () => {
        const contentWithNulls = new Uint8Array([0, 1, 0, 2, 0, 3]);
        const handle = await ctx.volatileStore.store(toStream(contentWithNulls));

        const loaded = await collectBytes(handle.read());
        expect(loaded).toEqual(contentWithNulls);

        await handle.dispose();
      });
    });

    describe("Empty Content", () => {
      it("handles empty content", async () => {
        const emptyContent = new Uint8Array(0);
        const handle = await ctx.volatileStore.store(toStream(emptyContent));

        expect(handle.size).toBe(0);

        const loaded = await collectBytes(handle.read());
        expect(loaded.length).toBe(0);

        await handle.dispose();
      });
    });

    describe("Large Content", () => {
      it.skipIf(process.env.CI)("handles large content", async () => {
        // 100KB content
        const largeContent = new Uint8Array(100 * 1024);
        for (let i = 0; i < largeContent.length; i++) {
          largeContent[i] = i % 256;
        }

        const handle = await ctx.volatileStore.store(toStream(largeContent));

        expect(handle.size).toBe(largeContent.length);

        const loaded = await collectBytes(handle.read());
        expect(loaded.length).toBe(largeContent.length);

        // Verify content integrity
        for (let i = 0; i < loaded.length; i++) {
          expect(loaded[i]).toBe(largeContent[i]);
        }

        await handle.dispose();
      });
    });

    describe("Multiple Handles", () => {
      it("stores multiple items independently", async () => {
        const content1 = encoder.encode("content1");
        const content2 = encoder.encode("content2");
        const content3 = encoder.encode("content3");

        const handle1 = await ctx.volatileStore.store(toStream(content1));
        const handle2 = await ctx.volatileStore.store(toStream(content2));
        const handle3 = await ctx.volatileStore.store(toStream(content3));

        const loaded1 = await collectBytes(handle1.read());
        const loaded2 = await collectBytes(handle2.read());
        const loaded3 = await collectBytes(handle3.read());

        expect(decoder.decode(loaded1)).toBe("content1");
        expect(decoder.decode(loaded2)).toBe("content2");
        expect(decoder.decode(loaded3)).toBe("content3");

        await handle1.dispose();
        await handle2.dispose();
        await handle3.dispose();
      });

      it("disposing one handle does not affect others", async () => {
        const content1 = encoder.encode("independent1");
        const content2 = encoder.encode("independent2");

        const handle1 = await ctx.volatileStore.store(toStream(content1));
        const handle2 = await ctx.volatileStore.store(toStream(content2));

        await handle1.dispose();

        // handle2 should still work
        const loaded2 = await collectBytes(handle2.read());
        expect(decoder.decode(loaded2)).toBe("independent2");

        await handle2.dispose();
      });
    });

    describe("VolatileContent Properties", () => {
      it("size property is readonly number", async () => {
        const content = encoder.encode("size check");
        const handle: VolatileContent = await ctx.volatileStore.store(toStream(content));

        expect(typeof handle.size).toBe("number");
        expect(handle.size).toBe(content.length);

        await handle.dispose();
      });

      it("read returns AsyncIterable<Uint8Array>", async () => {
        const content = encoder.encode("iterable");
        const handle = await ctx.volatileStore.store(toStream(content));

        const iterable = handle.read();
        expect(iterable[Symbol.asyncIterator]).toBeDefined();

        await handle.dispose();
      });
    });

    describe("Edge Cases", () => {
      it("handles single byte content", async () => {
        const singleByte = new Uint8Array([42]);
        const handle = await ctx.volatileStore.store(toStream(singleByte));

        expect(handle.size).toBe(1);

        const loaded = await collectBytes(handle.read());
        expect(loaded).toEqual(singleByte);

        await handle.dispose();
      });

      it("handles content with only newlines", async () => {
        const newlines = encoder.encode("\n\n\n");
        const handle = await ctx.volatileStore.store(toStream(newlines));

        const loaded = await collectBytes(handle.read());
        expect(decoder.decode(loaded)).toBe("\n\n\n");

        await handle.dispose();
      });

      it("handles UTF-8 content", async () => {
        const utf8Content = encoder.encode("Hello 世界 🌍 مرحبا");
        const handle = await ctx.volatileStore.store(toStream(utf8Content));

        const loaded = await collectBytes(handle.read());
        expect(decoder.decode(loaded)).toBe("Hello 世界 🌍 مرحبا");

        await handle.dispose();
      });
    });
  });
}
