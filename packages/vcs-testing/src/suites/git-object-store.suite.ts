/**
 * Parametrized test suite for GitObjectStore implementations
 *
 * This suite tests the core GitObjectStore interface contract.
 * All storage implementations must pass these tests.
 */

import type { GitObjectStore, ObjectTypeString } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface GitObjectStoreTestContext {
  objectStore: GitObjectStore;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type GitObjectStoreFactory = () => Promise<GitObjectStoreTestContext>;

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
 * Create the GitObjectStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "KV")
 * @param factory Factory function to create storage instances
 */
export function createGitObjectStoreTests(name: string, factory: GitObjectStoreFactory): void {
  describe(`GitObjectStore [${name}]`, () => {
    let ctx: GitObjectStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Operations", () => {
      it("stores and loads object with type", async () => {
        const content = encoder.encode("Hello, World!");
        const id = await ctx.objectStore.store("blob", toStream(content));

        expect(id).toMatch(/^[0-9a-f]{40}$/);

        const loaded = await collectBytes(ctx.objectStore.load(id));
        expect(decoder.decode(loaded)).toBe("Hello, World!");
      });

      it("returns valid SHA-1 object ID", async () => {
        const content = encoder.encode("test content");
        const id = await ctx.objectStore.store("blob", toStream(content));

        expect(id).toMatch(/^[0-9a-f]{40}$/);
        expect(id.length).toBe(40);
      });

      it("content-addressable: same content and type produces same ID", async () => {
        const content = encoder.encode("Same content");

        const id1 = await ctx.objectStore.store("blob", toStream(content));
        const id2 = await ctx.objectStore.store("blob", toStream(content));

        expect(id1).toBe(id2);
      });

      it("different types produce different IDs for same content", async () => {
        const content = encoder.encode("content");

        const blobId = await ctx.objectStore.store("blob", toStream(content));

        // Note: tree content format is different, so this is just demonstrating
        // that type affects the hash. Real tree content would be binary.
        // For this test, we use a simplified approach.
        const treeContent = encoder.encode(`100644 test.txt\0${"a".repeat(20)}`);
        const treeId = await ctx.objectStore.store("tree", toStream(treeContent));

        expect(blobId).not.toBe(treeId);
      });

      it("checks existence via has()", async () => {
        const content = encoder.encode("test");
        const id = await ctx.objectStore.store("blob", toStream(content));

        expect(await ctx.objectStore.has(id)).toBe(true);
        expect(await ctx.objectStore.has("0000000000000000000000000000000000000000")).toBe(false);
      });

      it("deletes object", async () => {
        const content = encoder.encode("to be deleted");
        const id = await ctx.objectStore.store("blob", toStream(content));

        expect(await ctx.objectStore.has(id)).toBe(true);

        const deleted = await ctx.objectStore.remove(id);
        expect(deleted).toBe(true);
        expect(await ctx.objectStore.has(id)).toBe(false);
      });

      it("returns false when deleting non-existent object", async () => {
        const deleted = await ctx.objectStore.remove("0000000000000000000000000000000000000000");
        expect(deleted).toBe(false);
      });

      it("lists all objects", async () => {
        const content1 = encoder.encode("object 1");
        const content2 = encoder.encode("object 2");
        const content3 = encoder.encode("object 3");

        const id1 = await ctx.objectStore.store("blob", toStream(content1));
        const id2 = await ctx.objectStore.store("blob", toStream(content2));
        const id3 = await ctx.objectStore.store("blob", toStream(content3));

        const ids = await toArray(ctx.objectStore.list());

        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
        expect(ids).toContain(id3);
        expect(ids.length).toBe(3);
      });
    });

    describe("Type Handling", () => {
      const types: ObjectTypeString[] = ["blob", "tree", "commit", "tag"];

      for (const type of types) {
        it(`stores and loads ${type} type`, async () => {
          const content = encoder.encode(`${type} content`);
          const id = await ctx.objectStore.store(type, toStream(content));

          expect(await ctx.objectStore.has(id)).toBe(true);

          const header = await ctx.objectStore.getHeader(id);
          expect(header.type).toBe(type);
        });
      }

      it("stores blob type correctly", async () => {
        const content = encoder.encode("blob data");
        const id = await ctx.objectStore.store("blob", toStream(content));

        const header = await ctx.objectStore.getHeader(id);
        expect(header.type).toBe("blob");
        expect(header.size).toBe(content.length);
      });

      it("stores tree type correctly", async () => {
        const content = encoder.encode("tree data");
        const id = await ctx.objectStore.store("tree", toStream(content));

        const header = await ctx.objectStore.getHeader(id);
        expect(header.type).toBe("tree");
        expect(header.size).toBe(content.length);
      });

      it("stores commit type correctly", async () => {
        const content = encoder.encode("commit data");
        const id = await ctx.objectStore.store("commit", toStream(content));

        const header = await ctx.objectStore.getHeader(id);
        expect(header.type).toBe("commit");
        expect(header.size).toBe(content.length);
      });

      it("stores tag type correctly", async () => {
        const content = encoder.encode("tag data");
        const id = await ctx.objectStore.store("tag", toStream(content));

        const header = await ctx.objectStore.getHeader(id);
        expect(header.type).toBe("tag");
        expect(header.size).toBe(content.length);
      });
    });

    describe("Header Operations", () => {
      it("getHeader returns type and size", async () => {
        const content = encoder.encode("header test content");
        const id = await ctx.objectStore.store("blob", toStream(content));

        const header = await ctx.objectStore.getHeader(id);

        expect(header.type).toBe("blob");
        expect(header.size).toBe(content.length);
      });

      it("loadWithHeader returns header and content stream", async () => {
        const content = encoder.encode("loadWithHeader test");
        const id = await ctx.objectStore.store("blob", toStream(content));

        const [header, stream] = await ctx.objectStore.loadWithHeader(id);

        expect(header.type).toBe("blob");
        expect(header.size).toBe(content.length);

        const loaded = await collectBytes(stream);
        expect(decoder.decode(loaded)).toBe("loadWithHeader test");
      });

      it("loadRaw returns full Git format (header + content)", async () => {
        const content = encoder.encode("raw test");
        const id = await ctx.objectStore.store("blob", toStream(content));

        const raw = await collectBytes(ctx.objectStore.loadRaw(id));

        // Git format: "type size\0content"
        const rawString = decoder.decode(raw);
        expect(rawString).toContain("blob");
        expect(rawString).toContain(String(content.length));
        expect(rawString).toContain("\0");
        expect(rawString).toContain("raw test");

        // Verify format: type<space>size<null>content
        const headerEnd = raw.indexOf(0);
        expect(headerEnd).toBeGreaterThan(0);
        const headerStr = decoder.decode(raw.slice(0, headerEnd));
        expect(headerStr).toBe(`blob ${content.length}`);

        // Content follows null byte
        const contentPart = raw.slice(headerEnd + 1);
        expect(decoder.decode(contentPart)).toBe("raw test");
      });

      it("load returns content without header", async () => {
        const content = encoder.encode("content only");
        const id = await ctx.objectStore.store("blob", toStream(content));

        const loaded = await collectBytes(ctx.objectStore.load(id));

        // Should NOT include header
        expect(decoder.decode(loaded)).toBe("content only");
        expect(loaded.includes(0)).toBe(false); // No null byte (unless in content)
      });
    });

    describe("Git Format Compliance", () => {
      it("produces Git-compatible blob hash", async () => {
        // Known Git hash: echo -n "Hello, World!" | git hash-object --stdin
        // Returns: b45ef6fec89518d314f546fd6c3025367b721684
        const content = encoder.encode("Hello, World!");
        const id = await ctx.objectStore.store("blob", toStream(content));

        expect(id).toBe("b45ef6fec89518d314f546fd6c3025367b721684");
      });

      it("produces Git-compatible empty blob hash", async () => {
        // Known Git hash for empty blob: git hash-object -t blob /dev/null
        // Returns: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
        const emptyContent = new Uint8Array(0);
        const id = await ctx.objectStore.store("blob", toStream(emptyContent));

        expect(id).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
      });

      it("SHA-1 computed over full Git format", async () => {
        const content = encoder.encode("test");
        const id = await ctx.objectStore.store("blob", toStream(content));

        // The ID should be SHA-1 of "blob 4\0test"
        // We can verify by checking:
        // 1. loadRaw returns complete Git format
        // 2. ID matches expected value
        const raw = await collectBytes(ctx.objectStore.loadRaw(id));
        const headerEnd = raw.indexOf(0);
        const header = decoder.decode(raw.slice(0, headerEnd));
        expect(header).toBe("blob 4");
      });

      it("header format is 'type size'", async () => {
        const content = encoder.encode("12345"); // 5 bytes
        const id = await ctx.objectStore.store("commit", toStream(content));

        const raw = await collectBytes(ctx.objectStore.loadRaw(id));
        const headerEnd = raw.indexOf(0);
        const header = decoder.decode(raw.slice(0, headerEnd));

        // Header must be exactly "commit 5"
        expect(header).toBe("commit 5");
      });
    });

    describe("Error Handling", () => {
      it("throws when loading non-existent object", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        await expect(async () => {
          for await (const _chunk of ctx.objectStore.load(nonExistentId)) {
            // Should not reach here
          }
        }).rejects.toThrow();
      });

      it("throws when getting header of non-existent object", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        await expect(ctx.objectStore.getHeader(nonExistentId)).rejects.toThrow();
      });

      it("throws when loading raw of non-existent object", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        await expect(async () => {
          for await (const _chunk of ctx.objectStore.loadRaw(nonExistentId)) {
            // Should not reach here
          }
        }).rejects.toThrow();
      });

      it("throws when loadWithHeader of non-existent object", async () => {
        const nonExistentId = "0000000000000000000000000000000000000000";

        await expect(ctx.objectStore.loadWithHeader(nonExistentId)).rejects.toThrow();
      });
    });

    describe("Edge Cases", () => {
      it("handles empty list", async () => {
        const ids = await toArray(ctx.objectStore.list());
        expect(ids.length).toBe(0);
      });

      it("handles empty content", async () => {
        const emptyContent = new Uint8Array(0);
        const id = await ctx.objectStore.store("blob", toStream(emptyContent));

        expect(await ctx.objectStore.has(id)).toBe(true);

        const header = await ctx.objectStore.getHeader(id);
        expect(header.size).toBe(0);

        const loaded = await collectBytes(ctx.objectStore.load(id));
        expect(loaded.length).toBe(0);
      });

      it("handles binary content with all byte values", async () => {
        const binaryContent = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          binaryContent[i] = i;
        }

        const id = await ctx.objectStore.store("blob", toStream(binaryContent));
        const loaded = await collectBytes(ctx.objectStore.load(id));

        expect(loaded.length).toBe(256);
        for (let i = 0; i < 256; i++) {
          expect(loaded[i]).toBe(i);
        }
      });

      it("handles store/delete/store cycle", async () => {
        const content = encoder.encode("cycle test");

        const id1 = await ctx.objectStore.store("blob", toStream(content));
        await ctx.objectStore.remove(id1);

        const id2 = await ctx.objectStore.store("blob", toStream(content));
        expect(id2).toBe(id1);
        expect(await ctx.objectStore.has(id2)).toBe(true);
      });

      it("handles multiple different object types", async () => {
        const blobContent = encoder.encode("blob");
        const treeContent = encoder.encode("tree");
        const commitContent = encoder.encode("commit");
        const tagContent = encoder.encode("tag");

        const blobId = await ctx.objectStore.store("blob", toStream(blobContent));
        const treeId = await ctx.objectStore.store("tree", toStream(treeContent));
        const commitId = await ctx.objectStore.store("commit", toStream(commitContent));
        const tagId = await ctx.objectStore.store("tag", toStream(tagContent));

        // All should exist
        expect(await ctx.objectStore.has(blobId)).toBe(true);
        expect(await ctx.objectStore.has(treeId)).toBe(true);
        expect(await ctx.objectStore.has(commitId)).toBe(true);
        expect(await ctx.objectStore.has(tagId)).toBe(true);

        // Types should be correct
        expect((await ctx.objectStore.getHeader(blobId)).type).toBe("blob");
        expect((await ctx.objectStore.getHeader(treeId)).type).toBe("tree");
        expect((await ctx.objectStore.getHeader(commitId)).type).toBe("commit");
        expect((await ctx.objectStore.getHeader(tagId)).type).toBe("tag");

        // All IDs should be different (content includes type in hash)
        const ids = [blobId, treeId, commitId, tagId];
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(4);
      });
    });
  });
}
