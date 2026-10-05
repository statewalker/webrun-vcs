/**
 * T5.2: Extended Trees Query Tests
 *
 * Comprehensive tests for SQL native store extended tree query capabilities:
 * - findTreesWithBlob: Find trees containing a specific blob
 * - findByNamePattern: Query tree entries by name pattern (SQL LIKE)
 * - count: Tree statistics
 */

import type { TreeEntry } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type {
  SqlNativeBlobStore,
  SqlNativeStores,
  SqlNativeTreeStore,
} from "../src/native/types.js";

describe("T5.2: Extended Trees Query Tests", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;
  let trees: SqlNativeTreeStore;
  let blobs: SqlNativeBlobStore;

  // File mode constants
  const REGULAR_FILE = 0o100644;
  const DIRECTORY = 0o040000;

  // Helper to create tree entry
  const createEntry = (name: string, id: string, mode: number = REGULAR_FILE): TreeEntry => ({
    name,
    id,
    mode,
  });

  // Helper to store a blob and return its ID
  const storeBlob = async (content: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);

    async function* chunks(): AsyncIterable<Uint8Array> {
      yield data;
    }

    return await blobs.store(chunks());
  };

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
    stores = createSqlNativeStores(db);
    trees = stores.trees;
    blobs = stores.blobs;
  });

  afterEach(async () => {
    await db.close();
  });

  describe("findTreesWithBlob", () => {
    it("returns empty iterator for non-existent blob", async () => {
      const nonExistentBlobId = "0000000000000000000000000000000000000000";

      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(nonExistentBlobId)) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds tree containing a specific blob", async () => {
      const blobId = await storeBlob("Hello, World!");

      const treeId = await trees.store([createEntry("hello.txt", blobId)]);

      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(blobId)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(treeId);
    });

    it("finds multiple trees containing the same blob", async () => {
      const blobId = await storeBlob("Shared content");

      const tree1 = await trees.store([createEntry("file1.txt", blobId)]);
      const tree2 = await trees.store([createEntry("file2.txt", blobId)]);
      const tree3 = await trees.store([createEntry("another.txt", blobId)]);

      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(blobId)) {
        results.push(id);
      }

      expect(results).toHaveLength(3);
      expect(results).toContain(tree1);
      expect(results).toContain(tree2);
      expect(results).toContain(tree3);
    });

    it("does not find trees that do not contain the blob", async () => {
      const blob1 = await storeBlob("Content 1");
      const blob2 = await storeBlob("Content 2");

      const _tree1 = await trees.store([createEntry("file1.txt", blob1)]);
      const tree2 = await trees.store([createEntry("file2.txt", blob2)]);

      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(blob2)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(tree2);
    });

    it("finds tree with blob among multiple entries", async () => {
      const blob1 = await storeBlob("Content 1");
      const blob2 = await storeBlob("Content 2");
      const blob3 = await storeBlob("Content 3");

      const treeId = await trees.store([
        createEntry("a.txt", blob1),
        createEntry("b.txt", blob2),
        createEntry("c.txt", blob3),
      ]);

      // Search for blob2
      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(blob2)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(treeId);
    });

    it("handles large number of trees efficiently", async () => {
      const blobId = await storeBlob("Target blob");
      const otherBlob = await storeBlob("Other blob");

      // Create 50 trees without target blob
      for (let i = 0; i < 50; i++) {
        await trees.store([createEntry(`file${i}.txt`, otherBlob)]);
      }

      // Create 5 trees with target blob
      const targetTrees: string[] = [];
      for (let i = 0; i < 5; i++) {
        const treeId = await trees.store([createEntry(`target${i}.txt`, blobId)]);
        targetTrees.push(treeId);
      }

      const startTime = Date.now();
      const results: string[] = [];
      for await (const id of trees.findTreesWithBlob(blobId)) {
        results.push(id);
      }
      const elapsed = Date.now() - startTime;

      expect(results).toHaveLength(5);
      for (const treeId of targetTrees) {
        expect(results).toContain(treeId);
      }
      expect(elapsed).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  describe("findByNamePattern", () => {
    it("returns empty iterator for no matching entries", async () => {
      const blobId = await storeBlob("Content");
      await trees.store([createEntry("readme.md", blobId)]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%.ts")) {
        results.push(result);
      }
      expect(results).toHaveLength(0);
    });

    it("finds entries matching exact name", async () => {
      const blobId = await storeBlob("Content");
      const treeId = await trees.store([createEntry("package.json", blobId)]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("package.json")) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].treeId).toBe(treeId);
      expect(results[0].entry.name).toBe("package.json");
    });

    it("finds entries matching file extension pattern", async () => {
      const blob = await storeBlob("Content");
      const tree1 = await trees.store([
        createEntry("index.ts", blob),
        createEntry("utils.ts", blob),
        createEntry("config.json", blob),
      ]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%.ts")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.treeId === tree1)).toBe(true);
      expect(results.map((r) => r.entry.name).sort()).toEqual(["index.ts", "utils.ts"]);
    });

    it("finds entries matching prefix pattern", async () => {
      const blob = await storeBlob("Content");
      await trees.store([
        createEntry("src-main.ts", blob),
        createEntry("src-utils.ts", blob),
        createEntry("lib-helper.ts", blob),
      ]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("src%")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.entry.name).sort()).toEqual(["src-main.ts", "src-utils.ts"]);
    });

    it("finds entries matching middle pattern", async () => {
      const blob = await storeBlob("Content");
      await trees.store([
        createEntry("my-component.ts", blob),
        createEntry("your-component.tsx", blob),
        createEntry("another-module.ts", blob),
      ]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%component%")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.entry.name).sort()).toEqual([
        "my-component.ts",
        "your-component.tsx",
      ]);
    });

    it("handles underscore wildcard (single character)", async () => {
      const blob = await storeBlob("Content");
      await trees.store([
        createEntry("v1.txt", blob),
        createEntry("v2.txt", blob),
        createEntry("v10.txt", blob),
      ]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("v_.txt")) {
        results.push(result);
      }

      // Only v1.txt and v2.txt should match (single digit)
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.entry.name).sort()).toEqual(["v1.txt", "v2.txt"]);
    });

    it("finds entries across multiple trees", async () => {
      const blob = await storeBlob("Content");
      const tree1 = await trees.store([createEntry("index.ts", blob)]);
      const tree2 = await trees.store([createEntry("main.ts", blob)]);
      const _tree3 = await trees.store([createEntry("readme.md", blob)]);

      const results: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%.ts")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.treeId).sort()).toEqual([tree1, tree2].sort());
    });

    it("returns correct entry metadata", async () => {
      const blob = await storeBlob("Content");
      const subTreeId = await trees.store([createEntry("nested.txt", blob)]);
      const treeId = await trees.store([
        createEntry("file.txt", blob, REGULAR_FILE),
        createEntry("subdir", subTreeId, DIRECTORY),
      ]);

      const fileResults: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("file.txt")) {
        fileResults.push(result);
      }

      expect(fileResults).toHaveLength(1);
      expect(fileResults[0].treeId).toBe(treeId);
      expect(fileResults[0].entry.mode).toBe(REGULAR_FILE);
      expect(fileResults[0].entry.id).toBe(blob);

      const dirResults: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("subdir")) {
        dirResults.push(result);
      }

      expect(dirResults).toHaveLength(1);
      expect(dirResults[0].treeId).toBe(treeId);
      expect(dirResults[0].entry.mode).toBe(DIRECTORY);
      expect(dirResults[0].entry.id).toBe(subTreeId);
    });

    it("is case-insensitive for pattern matching (SQLite LIKE)", async () => {
      const blob = await storeBlob("Content");
      await trees.store([
        createEntry("README.md", blob),
        createEntry("readme.md", blob),
        createEntry("Readme.md", blob),
      ]);

      const lowerResults: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("readme.md")) {
        lowerResults.push(result);
      }

      // SQLite LIKE is case-insensitive for ASCII characters by default
      expect(lowerResults).toHaveLength(3);
      const names = lowerResults.map((r) => r.entry.name).sort();
      expect(names).toEqual(["README.md", "Readme.md", "readme.md"]);
    });
  });

  describe("count", () => {
    it("returns 0 for empty store", async () => {
      expect(await trees.count()).toBe(0);
    });

    it("returns correct count after adding trees", async () => {
      const blob = await storeBlob("Content");

      await trees.store([createEntry("file1.txt", blob)]);
      expect(await trees.count()).toBe(1);

      await trees.store([createEntry("file2.txt", blob)]);
      expect(await trees.count()).toBe(2);

      await trees.store([createEntry("file3.txt", blob)]);
      expect(await trees.count()).toBe(3);
    });

    it("does not count duplicate trees", async () => {
      const blob = await storeBlob("Same content");

      // Storing identical tree entries results in same tree ID (content-addressed)
      await trees.store([createEntry("file.txt", blob)]);
      await trees.store([createEntry("file.txt", blob)]);

      expect(await trees.count()).toBe(1);
    });

    it("counts distinct trees correctly", async () => {
      const blob1 = await storeBlob("Content 1");
      const blob2 = await storeBlob("Content 2");

      // Different content = different trees
      await trees.store([createEntry("file.txt", blob1)]);
      await trees.store([createEntry("file.txt", blob2)]);

      expect(await trees.count()).toBe(2);
    });
  });

  describe("Combined Queries", () => {
    it("can find which trees contain files matching a pattern and blob", async () => {
      const jsBlob = await storeBlob("console.log('hello');");
      const tsBlob = await storeBlob("export const x: number = 1;");

      await trees.store([createEntry("index.js", jsBlob), createEntry("utils.js", jsBlob)]);

      await trees.store([createEntry("index.ts", tsBlob), createEntry("utils.ts", tsBlob)]);

      await trees.store([createEntry("mixed.js", jsBlob), createEntry("mixed.ts", tsBlob)]);

      // Find trees with JS files
      const jsEntries: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%.js")) {
        jsEntries.push(result);
      }

      // Find trees containing the JS blob
      const treesWithJsBlob = new Set<string>();
      for await (const treeId of trees.findTreesWithBlob(jsBlob)) {
        treesWithJsBlob.add(treeId);
      }

      // Intersection: trees that have *.js files AND contain the JS blob
      const jsTrees = [...new Set(jsEntries.map((e) => e.treeId))].filter((id) =>
        treesWithJsBlob.has(id),
      );

      expect(jsTrees).toHaveLength(2); // Tree with index.js/utils.js and tree with mixed.js/mixed.ts
    });

    it("handles empty results gracefully", async () => {
      // Query on empty store
      const blobResults: string[] = [];
      for await (const id of trees.findTreesWithBlob("0000000000000000000000000000000000000000")) {
        blobResults.push(id);
      }
      expect(blobResults).toHaveLength(0);

      const patternResults: Array<{ treeId: string; entry: TreeEntry }> = [];
      for await (const result of trees.findByNamePattern("%.nonexistent")) {
        patternResults.push(result);
      }
      expect(patternResults).toHaveLength(0);

      expect(await trees.count()).toBe(0);
    });
  });
});
