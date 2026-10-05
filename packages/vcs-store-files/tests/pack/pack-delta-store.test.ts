/**
 * Tests for PackDeltaStore
 *
 * Tests the native pack-based delta store implementation.
 */

import type { DeltaInfo } from "@statewalker/vcs-core";
import {
  createInMemoryFilesApi,
  type FilesApi,
  PackObjectType,
  writePack,
  writePackIndexV2,
} from "@statewalker/vcs-core";
import type { Delta } from "@statewalker/vcs-utils";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PackDeltaStore, PackDirectory } from "../../src/pack/index.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Create a simple delta for testing
 * This creates a delta that copies from base and adds some bytes
 */
function createSimpleDelta(baseSize: number, resultSize: number = baseSize): Delta[] {
  return [{ type: "copy", offset: 0, length: Math.min(baseSize, resultSize) }];
}

/**
 * Helper to store delta using update pattern
 */
async function storeDelta(store: PackDeltaStore, info: DeltaInfo, delta: Delta[]): Promise<number> {
  const update = store.startUpdate();
  const size = await update.storeDelta(info, delta);
  await update.close();
  return size;
}

describe("PackDeltaStore", () => {
  let files: FilesApi;
  const basePath = "/repo/objects/pack";

  beforeEach(() => {
    files = createInMemoryFilesApi();
  });

  describe("initialization", () => {
    it("initializes without errors", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();
      await store.close();
    });

    it("can be initialized multiple times", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();
      await store.initialize(); // Should be a no-op
      await store.close();
    });
  });

  describe("storeDelta", () => {
    it("stores delta and returns compressed size", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const delta = createSimpleDelta(100, 100);

      const size = await storeDelta(store, { baseKey, targetKey }, delta);
      expect(size).toBeGreaterThan(0);

      await store.close();
    });

    it("creates pack file when update is closed", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";

      // Store multiple deltas in one batch
      const update = store.startUpdate();
      await update.storeDelta({ baseKey, targetKey: target1 }, createSimpleDelta(100));
      await update.storeDelta({ baseKey, targetKey: target2 }, createSimpleDelta(100));
      await update.close();

      // Check that pack was created
      const stats = await store.getPackDirectory().getStats();
      expect(stats.packCount).toBe(1);

      await store.close();
    });
  });

  describe("isDelta", () => {
    it("returns true for stored deltas", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));

      expect(await store.isDelta(targetKey)).toBe(true);

      await store.close();
    });

    it("returns false for non-existent objects", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      expect(await store.isDelta("cccccccccccccccccccccccccccccccccccccccc")).toBe(false);

      await store.close();
    });
  });

  describe("reverse index", () => {
    it("builds reverse index from pack headers", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";

      // Store both deltas in one batch
      const update = store.startUpdate();
      await update.storeDelta({ baseKey, targetKey: target1 }, createSimpleDelta(100));
      await update.storeDelta({ baseKey, targetKey: target2 }, createSimpleDelta(100));
      await update.close();

      await store.buildReverseIndex();

      const dependents = await store.findDependents(baseKey);
      expect(dependents).toContain(target1);
      expect(dependents).toContain(target2);
      expect(dependents).toHaveLength(2);

      await store.close();
    });

    it("finds dependents without building reverse index (slower)", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));

      // Don't build reverse index - should still work via pack scan
      const dependents = await store.findDependents(baseKey);
      expect(dependents).toContain(targetKey);

      await store.close();
    });

    it("invalidates reverse index", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));
      await store.buildReverseIndex();

      expect(store.getReverseIndex()).not.toBeNull();

      store.invalidateReverseIndex();

      expect(store.getReverseIndex()).toBeNull();

      await store.close();
    });
  });

  describe("isBase", () => {
    it("returns true for objects with dependents", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));

      expect(await store.isBase(baseKey)).toBe(true);

      await store.close();
    });

    it("returns false for objects without dependents", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));

      // targetKey has no dependents
      expect(await store.isBase(targetKey)).toBe(false);

      await store.close();
    });
  });

  describe("listDeltas", () => {
    it("lists all delta relationships", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";

      // Store both deltas in one batch
      const update = store.startUpdate();
      await update.storeDelta({ baseKey, targetKey: target1 }, createSimpleDelta(100));
      await update.storeDelta({ baseKey, targetKey: target2 }, createSimpleDelta(100));
      await update.close();

      const deltas: Array<{ baseKey: string; targetKey: string }> = [];
      for await (const delta of store.listDeltas()) {
        deltas.push(delta);
      }

      expect(deltas).toHaveLength(2);
      expect(deltas.map((d) => d.targetKey)).toContain(target1);
      expect(deltas.map((d) => d.targetKey)).toContain(target2);

      await store.close();
    });
  });

  describe("removeDelta", () => {
    it("marks delta as removed", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));
      await store.buildReverseIndex();

      expect(await store.removeDelta(targetKey)).toBe(true);

      // Reverse index should be updated
      expect(store.getReverseIndex()?.isDelta(targetKey)).toBe(false);

      await store.close();
    });

    it("returns false for non-deltas", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      expect(await store.removeDelta("cccccccccccccccccccccccccccccccccccccccc")).toBe(false);

      await store.close();
    });
  });

  describe("close", () => {
    it("close cleans up reverse index", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));
      await store.buildReverseIndex();

      await store.close();

      // Reverse index should be cleared
      expect(store.getReverseIndex()).toBeNull();
    });
  });

  describe("getPackDirectory", () => {
    it("returns the pack directory", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const packDir = store.getPackDirectory();
      expect(packDir).toBeDefined();

      await store.close();
    });
  });

  /**
   * Duplicate handling tests
   *
   * Ported from JGit PackInserterTest.java#checkExisting
   * Tests behavior when storing the same delta multiple times.
   *
   * Beads issue: webrun-vcs-n0ob
   */
  describe("duplicate handling", () => {
    it("stores delta even if already exists (default behavior)", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const delta = createSimpleDelta(100);

      // Store first delta
      await storeDelta(store, { baseKey, targetKey }, delta);

      const stats1 = await store.getPackDirectory().getStats();
      expect(stats1.packCount).toBe(1);

      // Store same delta again - creates new pack (no dedup by default)
      await storeDelta(store, { baseKey, targetKey }, delta);

      const stats2 = await store.getPackDirectory().getStats();
      // Note: Current implementation does not deduplicate
      // This test documents the current behavior
      expect(stats2.packCount).toBe(2);

      await store.close();
    });

    it("isDelta returns true after duplicate storage", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const targetKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));
      expect(await store.isDelta(targetKey)).toBe(true);

      // Store same delta again
      await storeDelta(store, { baseKey, targetKey }, createSimpleDelta(100));

      // Should still report as delta
      expect(await store.isDelta(targetKey)).toBe(true);

      await store.close();
    });

    it("handles multiple distinct deltas correctly", async () => {
      const store = new PackDeltaStore({ files, basePath });
      await store.initialize();

      const baseKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";
      const target3 = "3333333333333333333333333333333333333333";

      // Store all distinct deltas in one batch
      const update = store.startUpdate();
      await update.storeDelta({ baseKey, targetKey: target1 }, createSimpleDelta(100));
      await update.storeDelta({ baseKey, targetKey: target2 }, createSimpleDelta(100));
      await update.storeDelta({ baseKey, targetKey: target3 }, createSimpleDelta(100));
      await update.close();

      // All should be queryable
      expect(await store.isDelta(target1)).toBe(true);
      expect(await store.isDelta(target2)).toBe(true);
      expect(await store.isDelta(target3)).toBe(true);

      // Base should have dependents
      const dependents = await store.findDependents(baseKey);
      expect(dependents).toContain(target1);
      expect(dependents).toContain(target2);
      expect(dependents).toContain(target3);

      await store.close();
    });
  });

  /**
   * Pack directory duplicate handling tests
   *
   * Tests how PackDirectory handles objects that appear in multiple packs.
   */
  describe("PackDirectory duplicate handling", () => {
    it("has() returns true for objects in any pack", async () => {
      await files.mkdir(basePath);
      const packDir = new PackDirectory({ files, basePath });

      const idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const content = new Uint8Array([1, 2, 3]);

      // Create pack 1 with object A
      const pack1 = await createTestPack([{ id: idA, content }]);
      const index1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await packDir.addPack("pack-1", pack1.packData, index1);

      // Verify object is found
      expect(await packDir.has(idA)).toBe(true);

      // Create pack 2 with same object A
      const pack2 = await createTestPack([{ id: idA, content }]);
      const index2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await packDir.addPack("pack-2", pack2.packData, index2);

      // Should still find object
      expect(await packDir.has(idA)).toBe(true);

      // load() returns raw content without Git header
      const loaded = await packDir.load(idA);
      expect(loaded).toEqual(content);
    });

    it("listObjects deduplicates across packs", async () => {
      await files.mkdir(basePath);
      const packDir = new PackDirectory({ files, basePath });

      const idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      // Same object in two packs
      for (let i = 1; i <= 2; i++) {
        const pack = await createTestPack([{ id: idA, content: new Uint8Array([i]) }]);
        const index = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
        await packDir.addPack(`pack-${i}`, pack.packData, index);
      }

      await packDir.invalidate();

      const objects: string[] = [];
      for await (const id of packDir.listObjects()) {
        objects.push(id);
      }

      // Should only list once despite being in two packs
      expect(objects).toEqual([idA]);
    });

    it("findPack returns first pack containing object", async () => {
      await files.mkdir(basePath);
      const packDir = new PackDirectory({ files, basePath });

      const idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      // Add to pack-aaa first
      const pack1 = await createTestPack([{ id: idA, content: new Uint8Array([1]) }]);
      const index1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await packDir.addPack("pack-aaa", pack1.packData, index1);

      // Add to pack-zzz second
      const pack2 = await createTestPack([{ id: idA, content: new Uint8Array([2]) }]);
      const index2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await packDir.addPack("pack-zzz", pack2.packData, index2);

      await packDir.invalidate();

      // Should find in newer pack (packs are searched in reverse alphabetical order)
      const foundPack = await packDir.findPack(idA);
      expect(foundPack).toBe("pack-zzz");
    });

    it("handles unique objects across multiple packs", async () => {
      await files.mkdir(basePath);
      const packDir = new PackDirectory({ files, basePath });

      const idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const idB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const idC = "cccccccccccccccccccccccccccccccccccccccc";

      // Different objects in different packs
      const pack1 = await createTestPack([{ id: idA, content: new Uint8Array([1]) }]);
      const index1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await packDir.addPack("pack-1", pack1.packData, index1);

      const pack2 = await createTestPack([{ id: idB, content: new Uint8Array([2]) }]);
      const index2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await packDir.addPack("pack-2", pack2.packData, index2);

      const pack3 = await createTestPack([{ id: idC, content: new Uint8Array([3]) }]);
      const index3 = await writePackIndexV2(pack3.indexEntries, pack3.packChecksum);
      await packDir.addPack("pack-3", pack3.packData, index3);

      await packDir.invalidate();

      // All should be findable
      expect(await packDir.has(idA)).toBe(true);
      expect(await packDir.has(idB)).toBe(true);
      expect(await packDir.has(idC)).toBe(true);

      // List should contain all three
      const objects: string[] = [];
      for await (const id of packDir.listObjects()) {
        objects.push(id);
      }
      expect(objects.sort()).toEqual([idA, idB, idC].sort());
    });
  });
});

/**
 * Helper to create test packs
 */
async function createTestPack(objects: Array<{ id: string; content: Uint8Array }>) {
  const packObjects = objects.map((obj) => ({
    id: obj.id,
    type: PackObjectType.BLOB,
    content: obj.content,
  }));
  return await writePack(packObjects);
}
