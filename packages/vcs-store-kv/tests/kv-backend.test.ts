/**
 * T4.8: KV Backend Tests
 *
 * Tests KV-specific behavior:
 * - Key structure and prefixes
 * - Batch operations
 * - Compare-and-swap operations
 * - Key iteration
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KvRawStore } from "../src/binary-storage/kv-raw-store.js";
import { KVRefStore } from "../src/kv-ref-store.js";
import { createKvObjectStores } from "../src/object-storage/index.js";

describe("T4.8: KV Backend", () => {
  describe("key structure", () => {
    describe("object storage keys", () => {
      let kv: MemoryKVAdapter;

      beforeEach(() => {
        kv = new MemoryKVAdapter();
      });

      it("uses correct key prefix for objects", async () => {
        const stores = createKvObjectStores({ kv });

        // Store a blob
        const content = new TextEncoder().encode("test content");
        const blobId = await stores.blobs.store(
          (async function* () {
            yield content;
          })(),
        );

        // Check key structure
        const keys: string[] = [];
        for await (const key of kv.list("objects:")) {
          keys.push(key);
        }

        // Should have data and size keys
        // Key format is: {prefix}:{RAW_PREFIX|SIZE_PREFIX}{key}
        // With default prefix "objects:", keys look like "objects::raw:..." and "objects::size:..."
        expect(keys.length).toBe(2);
        expect(keys.some((k) => k.includes(":raw:"))).toBe(true);
        expect(keys.some((k) => k.includes(":size:"))).toBe(true);

        // Key should contain the blob ID
        expect(keys.some((k) => k.includes(blobId))).toBe(true);
      });

      it("uses custom prefix for objects when specified", async () => {
        const stores = createKvObjectStores({ kv, prefix: "custom:" });

        const content = new TextEncoder().encode("test");
        await stores.blobs.store(
          (async function* () {
            yield content;
          })(),
        );

        const keys: string[] = [];
        for await (const key of kv.list("custom:")) {
          keys.push(key);
        }

        expect(keys.length).toBe(2);
        expect(keys.every((k) => k.startsWith("custom:"))).toBe(true);
      });

      it("separates data and size keys correctly", async () => {
        const rawStore = new KvRawStore(kv, "test");
        const key = "mykey";

        await rawStore.store(
          key,
          (async function* () {
            yield new TextEncoder().encode("hello");
          })(),
        );

        // Check both keys exist
        const dataKey = `test:raw:${key}`;
        const sizeKey = `test:size:${key}`;

        expect(await kv.has(dataKey)).toBe(true);
        expect(await kv.has(sizeKey)).toBe(true);

        // Verify size is stored correctly
        const sizeData = await kv.get(sizeKey);
        expect(sizeData).toBeDefined();
        if (sizeData) {
          const size = new DataView(
            sizeData.buffer,
            sizeData.byteOffset,
            sizeData.byteLength,
          ).getUint32(0, true);
          expect(size).toBe(5); // "hello" is 5 bytes
        }
      });
    });

    describe("ref storage keys", () => {
      let kv: MemoryKVAdapter;
      let refStore: KVRefStore;

      beforeEach(() => {
        kv = new MemoryKVAdapter();
        refStore = new KVRefStore(kv);
      });

      it("uses correct key prefix for refs", async () => {
        const objectId = "a".repeat(40);
        await refStore.set("refs/heads/main", objectId);

        const keys: string[] = [];
        for await (const key of kv.list("ref:")) {
          keys.push(key);
        }

        expect(keys.length).toBe(1);
        expect(keys[0]).toBe("ref:refs/heads/main");
      });

      it("handles nested ref paths correctly", async () => {
        const objectId = "b".repeat(40);
        await refStore.set("refs/remotes/origin/main", objectId);
        await refStore.set("refs/remotes/origin/feature", objectId);

        const keys: string[] = [];
        for await (const key of kv.list("ref:refs/remotes/origin/")) {
          keys.push(key);
        }

        expect(keys.length).toBe(2);
        expect(keys).toContain("ref:refs/remotes/origin/main");
        expect(keys).toContain("ref:refs/remotes/origin/feature");
      });

      it("stores symbolic refs with different format", async () => {
        await refStore.setSymbolic("HEAD", "refs/heads/main");

        const data = await kv.get("ref:HEAD");
        expect(data).toBeDefined();

        if (data) {
          const decoded = JSON.parse(new TextDecoder().decode(data));
          expect(decoded.t).toBe("refs/heads/main"); // 't' is for target
        }
      });

      it("stores direct refs with objectId", async () => {
        const objectId = "c".repeat(40);
        await refStore.set("refs/heads/main", objectId);

        const data = await kv.get("ref:refs/heads/main");
        expect(data).toBeDefined();

        if (data) {
          const decoded = JSON.parse(new TextDecoder().decode(data));
          expect(decoded.oid).toBe(objectId); // 'oid' is for objectId
        }
      });
    });

    describe("key iteration", () => {
      let kv: MemoryKVAdapter;

      beforeEach(() => {
        kv = new MemoryKVAdapter();
      });

      it("handles iteration over empty store", async () => {
        const keys: string[] = [];
        for await (const key of kv.list("nonexistent:")) {
          keys.push(key);
        }
        expect(keys).toEqual([]);
      });

      it("iterates keys in consistent order", async () => {
        // Store multiple entries
        for (let i = 0; i < 10; i++) {
          await kv.set(`key:${i.toString().padStart(3, "0")}`, new Uint8Array([i]));
        }

        const keys1: string[] = [];
        for await (const key of kv.list("key:")) {
          keys1.push(key);
        }

        const keys2: string[] = [];
        for await (const key of kv.list("key:")) {
          keys2.push(key);
        }

        expect(keys1).toEqual(keys2);
        expect(keys1.length).toBe(10);
      });

      it("filters by prefix correctly", async () => {
        await kv.set("a:1", new Uint8Array([1]));
        await kv.set("a:2", new Uint8Array([2]));
        await kv.set("b:1", new Uint8Array([3]));
        await kv.set("b:2", new Uint8Array([4]));

        const aKeys: string[] = [];
        for await (const key of kv.list("a:")) {
          aKeys.push(key);
        }

        const bKeys: string[] = [];
        for await (const key of kv.list("b:")) {
          bKeys.push(key);
        }

        expect(aKeys).toEqual(["a:1", "a:2"]);
        expect(bKeys).toEqual(["b:1", "b:2"]);
      });
    });
  });

  describe("batch operations", () => {
    let kv: MemoryKVAdapter;

    beforeEach(() => {
      kv = new MemoryKVAdapter();
    });

    describe("setMany", () => {
      it("batches writes for performance", async () => {
        const entries = new Map<string, Uint8Array>();
        for (let i = 0; i < 100; i++) {
          entries.set(`key:${i}`, new Uint8Array([i % 256]));
        }

        await kv.setMany(entries);

        expect(kv.size).toBe(100);

        // Verify all entries stored correctly
        for (const [key, value] of entries) {
          const stored = await kv.get(key);
          expect(stored).toEqual(value);
        }
      });

      it("handles empty batch", async () => {
        await kv.setMany(new Map());
        expect(kv.size).toBe(0);
      });

      it("overwrites existing keys in batch", async () => {
        await kv.set("key:1", new Uint8Array([1]));
        await kv.set("key:2", new Uint8Array([2]));

        const entries = new Map<string, Uint8Array>();
        entries.set("key:1", new Uint8Array([10]));
        entries.set("key:2", new Uint8Array([20]));
        entries.set("key:3", new Uint8Array([30]));

        await kv.setMany(entries);

        expect(await kv.get("key:1")).toEqual(new Uint8Array([10]));
        expect(await kv.get("key:2")).toEqual(new Uint8Array([20]));
        expect(await kv.get("key:3")).toEqual(new Uint8Array([30]));
      });
    });

    describe("getMany", () => {
      it("batches reads for performance", async () => {
        // Store test data
        for (let i = 0; i < 10; i++) {
          await kv.set(`key:${i}`, new Uint8Array([i]));
        }

        const keys = Array.from({ length: 10 }, (_, i) => `key:${i}`);
        const result = await kv.getMany(keys);

        expect(result.size).toBe(10);
        for (let i = 0; i < 10; i++) {
          expect(result.get(`key:${i}`)).toEqual(new Uint8Array([i]));
        }
      });

      it("handles missing keys in batch", async () => {
        await kv.set("key:1", new Uint8Array([1]));
        await kv.set("key:3", new Uint8Array([3]));

        const result = await kv.getMany(["key:1", "key:2", "key:3"]);

        expect(result.size).toBe(2);
        expect(result.has("key:1")).toBe(true);
        expect(result.has("key:2")).toBe(false);
        expect(result.has("key:3")).toBe(true);
      });

      it("handles empty key list", async () => {
        const result = await kv.getMany([]);
        expect(result.size).toBe(0);
      });
    });

    describe("combined batch operations", () => {
      it("raw store uses setMany for efficient writes", async () => {
        const rawStore = new KvRawStore(kv, "test");

        // Store content
        await rawStore.store(
          "key1",
          (async function* () {
            yield new TextEncoder().encode("content1");
          })(),
        );

        // Should have created 2 keys in a single batch (data + size)
        expect(kv.size).toBe(2);
      });
    });
  });

  describe("compare-and-swap operations", () => {
    let kv: MemoryKVAdapter;

    beforeEach(() => {
      kv = new MemoryKVAdapter();
    });

    it("succeeds when value matches expected", async () => {
      const initialValue = new Uint8Array([1, 2, 3]);
      await kv.set("key", initialValue);

      const newValue = new Uint8Array([4, 5, 6]);
      const success = await kv.compareAndSwap("key", initialValue, newValue);

      expect(success).toBe(true);
      expect(await kv.get("key")).toEqual(newValue);
    });

    it("fails when value does not match expected", async () => {
      const initialValue = new Uint8Array([1, 2, 3]);
      await kv.set("key", initialValue);

      const wrongExpected = new Uint8Array([9, 9, 9]);
      const newValue = new Uint8Array([4, 5, 6]);
      const success = await kv.compareAndSwap("key", wrongExpected, newValue);

      expect(success).toBe(false);
      expect(await kv.get("key")).toEqual(initialValue);
    });

    it("succeeds for new key when expected is undefined", async () => {
      const newValue = new Uint8Array([1, 2, 3]);
      const success = await kv.compareAndSwap("newkey", undefined, newValue);

      expect(success).toBe(true);
      expect(await kv.get("newkey")).toEqual(newValue);
    });

    it("fails for existing key when expected is undefined", async () => {
      await kv.set("key", new Uint8Array([1]));

      const success = await kv.compareAndSwap("key", undefined, new Uint8Array([2]));

      expect(success).toBe(false);
    });

    describe("ref store CAS", () => {
      it("uses CAS for atomic ref updates", async () => {
        const refStore = new KVRefStore(kv);
        const oldId = "a".repeat(40);
        const newId = "b".repeat(40);

        await refStore.set("refs/heads/main", oldId);

        const result = await refStore.compareAndSwap("refs/heads/main", oldId, newId);

        expect(result.success).toBe(true);
        expect(result.previousValue).toBe(oldId);

        const ref = await refStore.resolve("refs/heads/main");
        expect(ref?.objectId).toBe(newId);
      });

      it("reports failure for concurrent modification", async () => {
        const refStore = new KVRefStore(kv);
        const oldId = "a".repeat(40);
        const wrongOldId = "c".repeat(40);
        const newId = "b".repeat(40);

        await refStore.set("refs/heads/main", oldId);

        const result = await refStore.compareAndSwap("refs/heads/main", wrongOldId, newId);

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain("Expected");

        // Value should be unchanged
        const ref = await refStore.resolve("refs/heads/main");
        expect(ref?.objectId).toBe(oldId);
      });
    });
  });

  describe("data isolation", () => {
    it("isolates data between different prefixes", async () => {
      const kv = new MemoryKVAdapter();

      const rawStore1 = new KvRawStore(kv, "store1");
      const rawStore2 = new KvRawStore(kv, "store2");

      await rawStore1.store(
        "key",
        (async function* () {
          yield new TextEncoder().encode("value1");
        })(),
      );

      await rawStore2.store(
        "key",
        (async function* () {
          yield new TextEncoder().encode("value2");
        })(),
      );

      // Same key in different stores should have different values
      const chunks1: Uint8Array[] = [];
      for await (const chunk of rawStore1.load("key")) {
        chunks1.push(chunk);
      }

      const chunks2: Uint8Array[] = [];
      for await (const chunk of rawStore2.load("key")) {
        chunks2.push(chunk);
      }

      expect(new TextDecoder().decode(chunks1[0])).toBe("value1");
      expect(new TextDecoder().decode(chunks2[0])).toBe("value2");
    });

    it("isolates refs from objects", async () => {
      const kv = new MemoryKVAdapter();
      const refStore = new KVRefStore(kv);
      const objectStores = createKvObjectStores({ kv });

      // Store a ref and an object
      const objectId = "d".repeat(40);
      await refStore.set("refs/heads/main", objectId);

      const content = new TextEncoder().encode("blob content");
      await objectStores.blobs.store(
        (async function* () {
          yield content;
        })(),
      );

      // List keys by prefix
      const refKeys: string[] = [];
      for await (const key of kv.list("ref:")) {
        refKeys.push(key);
      }

      const objectKeys: string[] = [];
      for await (const key of kv.list("objects:")) {
        objectKeys.push(key);
      }

      // Should be completely separate
      expect(refKeys.length).toBe(1);
      expect(objectKeys.length).toBe(2); // data + size
      expect(refKeys.some((k) => k.startsWith("objects:"))).toBe(false);
      expect(objectKeys.some((k) => k.startsWith("ref:"))).toBe(false);
    });
  });

  describe("edge cases", () => {
    let kv: MemoryKVAdapter;

    beforeEach(() => {
      kv = new MemoryKVAdapter();
    });

    it("handles empty value", async () => {
      await kv.set("empty", new Uint8Array(0));
      const result = await kv.get("empty");
      expect(result).toEqual(new Uint8Array(0));
    });

    it("handles large values", async () => {
      const largeValue = new Uint8Array(1024 * 1024); // 1MB
      for (let i = 0; i < largeValue.length; i++) {
        largeValue[i] = i % 256;
      }

      await kv.set("large", largeValue);
      const result = await kv.get("large");

      expect(result?.length).toBe(1024 * 1024);
      // Verify content
      expect(result?.[0]).toBe(0);
      expect(result?.[255]).toBe(255);
      expect(result?.[256]).toBe(0);
    });

    it("handles special characters in keys", async () => {
      const keys = [
        "key:with:colons",
        "key/with/slashes",
        "key with spaces",
        "key=with=equals",
        "key\twith\ttabs",
      ];

      for (const key of keys) {
        await kv.set(key, new Uint8Array([1]));
        expect(await kv.has(key)).toBe(true);
        expect(await kv.get(key)).toEqual(new Uint8Array([1]));
      }
    });

    it("handles Unicode in keys", async () => {
      const unicodeKey = "key:日本語:emoji:🎉";
      await kv.set(unicodeKey, new Uint8Array([42]));

      expect(await kv.has(unicodeKey)).toBe(true);
      expect(await kv.get(unicodeKey)).toEqual(new Uint8Array([42]));
    });

    it("returns copy of data to prevent external mutation", async () => {
      const original = new Uint8Array([1, 2, 3]);
      await kv.set("key", original);

      const retrieved = await kv.get("key");
      expect(retrieved).toEqual(original);

      // Mutate retrieved value
      if (retrieved) {
        retrieved[0] = 99;
      }

      // Original stored value should be unchanged
      const retrieved2 = await kv.get("key");
      expect(retrieved2).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("handles deletion of non-existent key", async () => {
      const deleted = await kv.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("clears all data on close", async () => {
      const kv = new MemoryKVAdapter();

      await kv.set("key1", new Uint8Array([1]));
      await kv.set("key2", new Uint8Array([2]));

      expect(kv.size).toBe(2);

      await kv.close();

      expect(kv.size).toBe(0);
    });

    it("clear() removes all entries", async () => {
      const kv = new MemoryKVAdapter();

      await kv.set("key1", new Uint8Array([1]));
      await kv.set("key2", new Uint8Array([2]));
      await kv.set("key3", new Uint8Array([3]));

      kv.clear();

      expect(kv.size).toBe(0);
      expect(await kv.has("key1")).toBe(false);
    });
  });
});
