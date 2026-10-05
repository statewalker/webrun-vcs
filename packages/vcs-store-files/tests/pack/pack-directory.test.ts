/**
 * Tests for PackDirectory
 *
 * Tests multi-pack management, caching, and object lookup.
 */

import {
  createInMemoryFilesApi,
  type FilesApi,
  PackObjectType,
  writePack,
  writePackIndexV2,
} from "@statewalker/vcs-core";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PackDirectory } from "../../src/pack/index.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Create a pack file with test objects
 */
async function createTestPack(objects: Array<{ id: string; content: Uint8Array }>) {
  const packObjects = objects.map((obj) => ({
    id: obj.id,
    type: PackObjectType.BLOB,
    content: obj.content,
  }));
  return await writePack(packObjects);
}

describe("PackDirectory", () => {
  let files: FilesApi;
  const basePath = "/repo/objects/pack";

  beforeEach(() => {
    files = createInMemoryFilesApi();
  });

  describe("scan", () => {
    it("returns empty array for non-existent directory", async () => {
      const packDir = new PackDirectory({ files, basePath });
      const names = await packDir.scan();
      expect(names).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      await files.mkdir(basePath);

      const packDir = new PackDirectory({ files, basePath });
      const names = await packDir.scan();
      expect(names).toEqual([]);
    });

    it("finds pack files with matching idx files", async () => {
      // Create pack directory
      await files.mkdir(basePath);

      // Create a valid pack
      const pack1 = await createTestPack([
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", content: new Uint8Array([1, 2, 3]) },
      ]);
      const indexData1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await files.write(`${basePath}/pack-abc.pack`, [pack1.packData]);
      await files.write(`${basePath}/pack-abc.idx`, [indexData1]);

      // Create another pack
      const pack2 = await createTestPack([
        { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", content: new Uint8Array([4, 5, 6]) },
      ]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-def.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-def.idx`, [indexData2]);

      const packDir = new PackDirectory({ files, basePath });
      const names = await packDir.scan();

      expect(names).toHaveLength(2);
      expect(names).toContain("pack-abc");
      expect(names).toContain("pack-def");
    });

    it("ignores pack files without matching idx", async () => {
      await files.mkdir(basePath);

      // Create pack without idx
      await files.write(`${basePath}/pack-orphan.pack`, [new Uint8Array([1, 2, 3])]);

      // Create complete pack
      const pack = await createTestPack([
        { id: "cccccccccccccccccccccccccccccccccccccccc", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-valid.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-valid.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });
      const names = await packDir.scan();

      expect(names).toEqual(["pack-valid"]);
    });

    it("returns packs in reverse alphabetical order", async () => {
      await files.mkdir(basePath);

      // Create packs with different names
      for (const name of ["pack-a", "pack-b", "pack-c"]) {
        const pack = await createTestPack([
          { id: `${name.slice(-1).repeat(40)}`, content: new Uint8Array([1]) },
        ]);
        const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
        await files.write(`${basePath}/${name}.pack`, [pack.packData]);
        await files.write(`${basePath}/${name}.idx`, [indexData]);
      }

      const packDir = new PackDirectory({ files, basePath });
      const names = await packDir.scan();

      expect(names).toEqual(["pack-c", "pack-b", "pack-a"]);
    });

    it("caches scan results", async () => {
      await files.mkdir(basePath);

      const pack = await createTestPack([
        { id: "dddddddddddddddddddddddddddddddddddddddd", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-test.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-test.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      // First scan
      const names1 = await packDir.scan();
      expect(names1).toEqual(["pack-test"]);

      // Add another pack file
      const pack2 = await createTestPack([
        { id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", content: new Uint8Array([2]) },
      ]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-new.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-new.idx`, [indexData2]);

      // Second scan returns cached result
      const names2 = await packDir.scan();
      expect(names2).toEqual(["pack-test"]);
    });
  });

  describe("has and findPack", () => {
    it("finds object in pack", async () => {
      await files.mkdir(basePath);

      const objectId = "1234567890abcdef1234567890abcdef12345678";
      const pack = await createTestPack([{ id: objectId, content: new Uint8Array([1, 2, 3]) }]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-test.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-test.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      expect(await packDir.has(objectId)).toBe(true);
      expect(await packDir.findPack(objectId)).toBe("pack-test");
    });

    it("returns false/undefined for non-existent object", async () => {
      await files.mkdir(basePath);

      const pack = await createTestPack([
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-test.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-test.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      expect(await packDir.has("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
      expect(await packDir.findPack("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    });

    it("searches packs in order (newer first)", async () => {
      await files.mkdir(basePath);

      const objectId = "1111111111111111111111111111111111111111";

      // Object in older pack
      const packOld = await createTestPack([{ id: objectId, content: new Uint8Array([1]) }]);
      const indexOld = await writePackIndexV2(packOld.indexEntries, packOld.packChecksum);
      await files.write(`${basePath}/pack-aaa.pack`, [packOld.packData]);
      await files.write(`${basePath}/pack-aaa.idx`, [indexOld]);

      // Same object in newer pack (should be found first)
      const packNew = await createTestPack([{ id: objectId, content: new Uint8Array([2]) }]);
      const indexNew = await writePackIndexV2(packNew.indexEntries, packNew.packChecksum);
      await files.write(`${basePath}/pack-zzz.pack`, [packNew.packData]);
      await files.write(`${basePath}/pack-zzz.idx`, [indexNew]);

      const packDir = new PackDirectory({ files, basePath });
      const foundPack = await packDir.findPack(objectId);

      // Should find in the "newer" pack (zzz comes after aaa in reverse order)
      expect(foundPack).toBe("pack-zzz");
    });
  });

  describe("load", () => {
    it("loads object content from pack", async () => {
      await files.mkdir(basePath);

      const objectId = "fedcba0987654321fedcba0987654321fedcba09";
      const content = new TextEncoder().encode("hello world");
      const pack = await createTestPack([{ id: objectId, content }]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-test.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-test.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      // load() returns raw content without Git header
      const loaded = await packDir.load(objectId);
      expect(loaded).toBeDefined();
      expect(new TextDecoder().decode(loaded)).toBe("hello world");

      // loadRaw() returns content WITH Git header (for RawStore compatibility)
      const loadedRaw = await packDir.loadRaw(objectId);
      expect(loadedRaw).toBeDefined();
      // Header format: "blob <size>\0<content>"
      expect(new TextDecoder().decode(loadedRaw)).toBe("blob 11\0hello world");
    });

    it("returns undefined for non-existent object", async () => {
      await files.mkdir(basePath);

      const packDir = new PackDirectory({ files, basePath });
      const loaded = await packDir.load("0000000000000000000000000000000000000000");

      expect(loaded).toBeUndefined();
    });
  });

  describe("addPack", () => {
    it("adds new pack files", async () => {
      const packDir = new PackDirectory({ files, basePath });

      const pack = await createTestPack([
        { id: "abababababababababababababababababababab", content: new Uint8Array([1, 2, 3]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);

      await packDir.addPack("pack-new", pack.packData, indexData);

      // Pack should be scannable
      const names = await packDir.scan();
      expect(names).toContain("pack-new");

      // Object should be findable
      expect(await packDir.has("abababababababababababababababababababab")).toBe(true);
    });

    it("creates directory if needed", async () => {
      const packDir = new PackDirectory({ files, basePath });

      const pack = await createTestPack([
        { id: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);

      await packDir.addPack("pack-first", pack.packData, indexData);

      expect(await files.exists(basePath)).toBe(true);
      expect(await files.exists(`${basePath}/pack-first.pack`)).toBe(true);
      expect(await files.exists(`${basePath}/pack-first.idx`)).toBe(true);
    });
  });

  describe("removePack", () => {
    it("removes pack files", async () => {
      await files.mkdir(basePath);

      const pack = await createTestPack([
        { id: "efefefefefefefefefefefefefefefefefefefef", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-delete.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-delete.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      // Verify pack exists
      expect(await packDir.has("efefefefefefefefefefefefefefefefefefefef")).toBe(true);

      // Remove pack
      await packDir.removePack("pack-delete");

      // Files should be gone
      expect(await files.exists(`${basePath}/pack-delete.pack`)).toBe(false);
      expect(await files.exists(`${basePath}/pack-delete.idx`)).toBe(false);

      // Rescan should not find the pack
      await packDir.invalidate();
      const names = await packDir.scan();
      expect(names).not.toContain("pack-delete");
    });
  });

  describe("invalidate", () => {
    it("clears cache and forces rescan", async () => {
      await files.mkdir(basePath);

      const pack = await createTestPack([
        { id: "1010101010101010101010101010101010101010", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-one.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-one.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      // Initial scan
      let names = await packDir.scan();
      expect(names).toEqual(["pack-one"]);

      // Add new pack externally
      const pack2 = await createTestPack([
        { id: "2020202020202020202020202020202020202020", content: new Uint8Array([2]) },
      ]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-two.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-two.idx`, [indexData2]);

      // Cached scan won't see new pack
      names = await packDir.scan();
      expect(names).not.toContain("pack-two");

      // Invalidate and rescan
      await packDir.invalidate();
      names = await packDir.scan();
      expect(names).toContain("pack-two");
    });
  });

  describe("listObjects", () => {
    it("lists all objects across packs", async () => {
      await files.mkdir(basePath);

      // Create first pack
      const pack1 = await createTestPack([
        { id: "1111111111111111111111111111111111111111", content: new Uint8Array([1]) },
        { id: "2222222222222222222222222222222222222222", content: new Uint8Array([2]) },
      ]);
      const indexData1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await files.write(`${basePath}/pack-a.pack`, [pack1.packData]);
      await files.write(`${basePath}/pack-a.idx`, [indexData1]);

      // Create second pack
      const pack2 = await createTestPack([
        { id: "3333333333333333333333333333333333333333", content: new Uint8Array([3]) },
      ]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-b.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-b.idx`, [indexData2]);

      const packDir = new PackDirectory({ files, basePath });
      const objects: string[] = [];
      for await (const id of packDir.listObjects()) {
        objects.push(id);
      }

      expect(objects).toHaveLength(3);
      expect(objects).toContain("1111111111111111111111111111111111111111");
      expect(objects).toContain("2222222222222222222222222222222222222222");
      expect(objects).toContain("3333333333333333333333333333333333333333");
    });

    it("deduplicates objects across packs", async () => {
      await files.mkdir(basePath);

      const sharedId = "4444444444444444444444444444444444444444";

      // Same object in two packs
      const pack1 = await createTestPack([{ id: sharedId, content: new Uint8Array([1]) }]);
      const indexData1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await files.write(`${basePath}/pack-a.pack`, [pack1.packData]);
      await files.write(`${basePath}/pack-a.idx`, [indexData1]);

      const pack2 = await createTestPack([{ id: sharedId, content: new Uint8Array([1]) }]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-b.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-b.idx`, [indexData2]);

      const packDir = new PackDirectory({ files, basePath });
      const objects: string[] = [];
      for await (const id of packDir.listObjects()) {
        objects.push(id);
      }

      // Should only list once
      expect(objects).toEqual([sharedId]);
    });
  });

  describe("getStats", () => {
    it("returns statistics about packs", async () => {
      await files.mkdir(basePath);

      // Create first pack with 2 objects
      const pack1 = await createTestPack([
        { id: "5555555555555555555555555555555555555555", content: new Uint8Array([1]) },
        { id: "6666666666666666666666666666666666666666", content: new Uint8Array([2]) },
      ]);
      const indexData1 = await writePackIndexV2(pack1.indexEntries, pack1.packChecksum);
      await files.write(`${basePath}/pack-a.pack`, [pack1.packData]);
      await files.write(`${basePath}/pack-a.idx`, [indexData1]);

      // Create second pack with 1 object
      const pack2 = await createTestPack([
        { id: "7777777777777777777777777777777777777777", content: new Uint8Array([3]) },
      ]);
      const indexData2 = await writePackIndexV2(pack2.indexEntries, pack2.packChecksum);
      await files.write(`${basePath}/pack-b.pack`, [pack2.packData]);
      await files.write(`${basePath}/pack-b.idx`, [indexData2]);

      const packDir = new PackDirectory({ files, basePath });
      const stats = await packDir.getStats();

      expect(stats.packCount).toBe(2);
      expect(stats.totalObjects).toBe(3);
      expect(stats.packs).toHaveLength(2);
    });
  });

  describe("caching", () => {
    it("caches pack readers", async () => {
      await files.mkdir(basePath);

      const pack = await createTestPack([
        { id: "8888888888888888888888888888888888888888", content: new Uint8Array([1]) },
      ]);
      const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
      await files.write(`${basePath}/pack-cached.pack`, [pack.packData]);
      await files.write(`${basePath}/pack-cached.idx`, [indexData]);

      const packDir = new PackDirectory({ files, basePath });

      // First access
      const reader1 = await packDir.getPack("pack-cached");
      // Second access should return same reader
      const reader2 = await packDir.getPack("pack-cached");

      expect(reader1).toBe(reader2);
    });

    it("evicts old entries when cache is full", async () => {
      await files.mkdir(basePath);

      // Create more packs than cache capacity
      const packDir = new PackDirectory({ files, basePath, maxCachedPacks: 2 });

      for (let i = 0; i < 3; i++) {
        const id = `${i}`.repeat(40);
        const pack = await createTestPack([{ id, content: new Uint8Array([i]) }]);
        const indexData = await writePackIndexV2(pack.indexEntries, pack.packChecksum);
        await files.write(`${basePath}/pack-${i}.pack`, [pack.packData]);
        await files.write(`${basePath}/pack-${i}.idx`, [indexData]);
      }

      // Access all three packs
      await packDir.getPack("pack-0");
      await packDir.getPack("pack-1");
      await packDir.getPack("pack-2");

      // Cache should have evicted pack-0 (oldest)
      // We can't directly check cache contents, but this should still work
      const reader = await packDir.getPack("pack-0");
      expect(reader).toBeDefined();
    });
  });
});
