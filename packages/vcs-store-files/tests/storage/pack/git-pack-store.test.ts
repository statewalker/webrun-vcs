/**
 * GitPackStore tests
 *
 * Tests for pack-based object storage implementing RawStorage.
 */

import {
  createGitObject,
  createInMemoryFilesApi,
  type GitPackStore,
  MemoryRawStorage,
} from "@statewalker/vcs-core";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitPackStore } from "../../../src/pack/git-pack-store.impl.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Helper to create Git object content (with header)
 */
function makeGitObject(type: "blob" | "tree" | "commit" | "tag", content: string): Uint8Array {
  return createGitObject(type, new TextEncoder().encode(content));
}

/**
 * Helper to extract content from Git object (strip header)
 */
function extractContent(data: Uint8Array): string {
  // Find null byte
  let nullPos = -1;
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    if (data[i] === 0) {
      nullPos = i;
      break;
    }
  }
  if (nullPos === -1) return "";
  return new TextDecoder().decode(data.subarray(nullPos + 1));
}

/**
 * Async iterable helper
 */
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * Collect async iterable to array
 */
async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Concat Uint8Arrays
 */
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("GitPackStore", () => {
  let files: ReturnType<typeof createInMemoryFilesApi>;
  let store: GitPackStore;

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    store = createGitPackStore(files, "/pack", {
      maxPendingObjects: 5,
      maxPendingBytes: 10 * 1024,
    });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("initialization", () => {
    it("creates pack directory if not exists", async () => {
      expect(await files.exists("/pack")).toBe(true);
    });

    it("can be initialized multiple times safely", async () => {
      await store.initialize();
      await store.initialize();
      expect(await files.exists("/pack")).toBe(true);
    });
  });

  describe("store/load round-trip", () => {
    it("stores blob content in pending buffer", async () => {
      const content = makeGitObject("blob", "Hello, Pack!");
      const key = "abc123def456789012345678901234567890abcd";

      await store.store(key, toAsync([content]));

      expect(store.hasPending()).toBe(true);
    });

    it("flushes pending to pack and reads back", async () => {
      const content = makeGitObject("blob", "Hello, Pack!");
      const key = "abc123def456789012345678901234567890abcd";

      await store.store(key, toAsync([content]));
      await store.flush();

      const loaded = concat(await collect(store.load(key)));
      expect(extractContent(loaded)).toBe("Hello, Pack!");
    });

    it("stores and loads commit objects", async () => {
      const commitContent =
        "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Test <test@test.com> 1234567890 +0000\ncommitter Test <test@test.com> 1234567890 +0000\n\nTest commit";
      const content = makeGitObject("commit", commitContent);
      const key = "cccccccccccccccccccccccccccccccccccccccc";

      await store.store(key, toAsync([content]));
      await store.flush();

      const loaded = concat(await collect(store.load(key)));
      expect(extractContent(loaded)).toBe(commitContent);
    });

    it("stores and loads tree objects", async () => {
      const treeContent = `100644 file.txt\0${String.fromCharCode(...new Array(20).fill(0))}`;
      const content = makeGitObject("tree", treeContent);
      const key = "dddddddddddddddddddddddddddddddddddddddd";

      await store.store(key, toAsync([content]));
      await store.flush();

      const loaded = concat(await collect(store.load(key)));
      const extracted = loaded.subarray(loaded.indexOf(0) + 1);
      expect(extracted.length).toBe(new TextEncoder().encode(treeContent).length);
    });
  });

  describe("auto-flush", () => {
    it("auto-flushes when object count threshold reached", async () => {
      // Threshold is 5 objects
      const keys: string[] = [];
      for (let i = 0; i < 6; i++) {
        const content = makeGitObject("blob", `Content ${i}`);
        const key = `${i}`.repeat(40);
        keys.push(key);
        await store.store(key, toAsync([content]));
      }

      // After 6 objects with threshold 5, should have auto-flushed
      // The 6th object should be in pending, previous 5 should have been flushed
      expect(store.hasPending()).toBe(true);

      // Flush remaining and verify all objects are accessible
      await store.flush();
      for (const key of keys) {
        expect(await store.has(key)).toBe(true);
      }
    });
  });

  describe("flush", () => {
    it("creates pack and index files", async () => {
      const content = makeGitObject("blob", "Test content");
      const key = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

      await store.store(key, toAsync([content]));
      const result = await store.flush();

      expect(result.packName).toBeTruthy();
      expect(result.objectIds).toContain(key);
      expect(result.objectCount).toBe(1);

      // Check pack files exist
      const packFiles: string[] = [];
      for await (const entry of files.list("/pack")) {
        packFiles.push(entry.name);
      }

      expect(packFiles.some((f) => f.endsWith(".pack"))).toBe(true);
      expect(packFiles.some((f) => f.endsWith(".idx"))).toBe(true);
    });

    it("returns empty result when no pending objects", async () => {
      const result = await store.flush();
      expect(result.objectCount).toBe(0);
      expect(result.objectIds).toEqual([]);
    });
  });

  describe("has", () => {
    it("returns false for non-existent key", async () => {
      expect(await store.has("ffffffffffffffffffffffffffffffffffffffff")).toBe(false);
    });

    it("returns true for key in pending buffer", async () => {
      const key = "1111111111111111111111111111111111111111";
      await store.store(key, toAsync([makeGitObject("blob", "test")]));
      expect(await store.has(key)).toBe(true);
    });

    it("returns true for key in pack file", async () => {
      const key = "2222222222222222222222222222222222222222";
      await store.store(key, toAsync([makeGitObject("blob", "test")]));
      await store.flush();
      expect(await store.has(key)).toBe(true);
    });
  });

  describe("keys", () => {
    it("returns empty iterator when empty", async () => {
      const keys: string[] = [];
      for await (const key of store.keys()) {
        keys.push(key);
      }
      expect(keys).toEqual([]);
    });

    it("returns pending and packed keys", async () => {
      const key1 = "3333333333333333333333333333333333333333";
      const key2 = "4444444444444444444444444444444444444444";

      await store.store(key1, toAsync([makeGitObject("blob", "first")]));
      await store.flush();
      await store.store(key2, toAsync([makeGitObject("blob", "second")]));

      const keys: string[] = [];
      for await (const key of store.keys()) {
        keys.push(key);
      }

      expect(keys.sort()).toEqual([key1, key2].sort());
    });
  });

  describe("size", () => {
    it("returns -1 for non-existent key", async () => {
      expect(await store.size("ffffffffffffffffffffffffffffffffffffffff")).toBe(-1);
    });

    it("returns correct size for packed object", async () => {
      const text = "Hello, Size Test!";
      const content = makeGitObject("blob", text);
      const key = "5555555555555555555555555555555555555555";

      await store.store(key, toAsync([content]));
      await store.flush();

      const size = await store.size(key);
      expect(size).toBe(content.length);
    });
  });

  describe("getStats", () => {
    it("returns stats with pending and packed info", async () => {
      const key1 = "6666666666666666666666666666666666666666";
      const key2 = "7777777777777777777777777777777777777777";

      // Add one and flush
      await store.store(key1, toAsync([makeGitObject("blob", "first")]));
      await store.flush();

      // Add another to pending
      await store.store(key2, toAsync([makeGitObject("blob", "second")]));

      const stats = await store.getStats();
      expect(stats.packCount).toBe(1);
      expect(stats.totalPackedObjects).toBe(1);
      expect(stats.pendingObjects).toBe(1);
    });
  });

  describe("refresh", () => {
    it("picks up externally added packs", async () => {
      // Store and flush
      const key = "8888888888888888888888888888888888888888";
      await store.store(key, toAsync([makeGitObject("blob", "test")]));
      await store.flush();

      // Create a new store pointing to same directory
      const store2 = createGitPackStore(files, "/pack");
      await store2.initialize();

      expect(await store2.has(key)).toBe(true);

      await store2.close();
    });
  });

  describe("close", () => {
    it("flushes pending objects before closing", async () => {
      const key = "9999999999999999999999999999999999999999";
      await store.store(key, toAsync([makeGitObject("blob", "test")]));

      expect(store.hasPending()).toBe(true);
      await store.close();

      // Create new store and verify object was flushed
      const store2 = createGitPackStore(files, "/pack");
      await store2.initialize();
      expect(await store2.has(key)).toBe(true);
      await store2.close();
    });

    it("can be closed multiple times safely", async () => {
      await store.close();
      await store.close();
    });
  });

  describe("error handling", () => {
    it("throws when loading non-existent key", async () => {
      await expect(async () => {
        for await (const _ of store.load("ffffffffffffffffffffffffffffffffffffffff")) {
          // consume
        }
      }).rejects.toThrow();
    });

    it("throws when store is closed", async () => {
      await store.close();
      await expect(store.store("key", toAsync([makeGitObject("blob", "test")]))).rejects.toThrow(
        "closed",
      );
    });

    it("throws when not initialized", async () => {
      const uninitStore = createGitPackStore(files, "/uninit");
      await expect(
        uninitStore.store("key", toAsync([makeGitObject("blob", "test")])),
      ).rejects.toThrow("not initialized");
    });
  });

  describe("remove", () => {
    it("returns false for non-existent key", async () => {
      expect(await store.remove("ffffffffffffffffffffffffffffffffffffffff")).toBe(false);
    });

    it("cannot remove from pack files", async () => {
      const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      await store.store(key, toAsync([makeGitObject("blob", "test")]));
      await store.flush();

      // Pack files are immutable, remove returns false
      expect(await store.remove(key)).toBe(false);
      expect(await store.has(key)).toBe(true);
    });
  });

  describe("with loose storage fallback", () => {
    it("uses loose storage when packImmediately is false", async () => {
      const looseStorage = new MemoryRawStorage();

      const hybridStore = createGitPackStore(files, "/pack", {
        packImmediately: false,
        looseStorage,
      });
      await hybridStore.initialize();

      const key = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const content = makeGitObject("blob", "loose content");
      await hybridStore.store(key, toAsync([content]));

      // Should be in loose storage, not pending pack
      expect(hybridStore.hasPending()).toBe(false);
      expect(await looseStorage.has(key)).toBe(true);

      await hybridStore.close();
    });

    it("throws when packImmediately=false without looseStorage", async () => {
      const badStore = createGitPackStore(files, "/pack", {
        packImmediately: false,
        // No looseStorage
      });
      await badStore.initialize();

      await expect(badStore.store("key", toAsync([makeGitObject("blob", "test")]))).rejects.toThrow(
        "looseStorage",
      );

      await badStore.close();
    });
  });
});
