/**
 * T5.5: Extended Query API Documentation Tests
 *
 * Verifies that the extended query interface is well-documented and properly typed.
 * Tests interface compatibility, type guards, and API surface.
 */

import { type ObjectId, ObjectType, type PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type {
  SqlNativeBlobStore,
  SqlNativeCommitStore,
  SqlNativeStores,
  SqlNativeTagStore,
  SqlNativeTreeStore,
} from "../src/native/types.js";

describe("T5.5: Extended Query API Documentation Tests", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;

  // Test data helpers
  const createPerson = (
    name: string,
    email: string,
    timestamp: number,
    tzOffset = "+0000",
  ): PersonIdent => ({
    name,
    email,
    timestamp,
    tzOffset,
  });

  const emptyTreeId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
    stores = createSqlNativeStores(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Interface Compatibility", () => {
    describe("Commits interface", () => {
      it("extended store is compatible with base Commits interface", () => {
        // SqlNativeCommitStore extends CommitStore which is compatible with Commits
        // This test verifies the type relationship at compile time
        const commits = stores.commits;

        // Verify base interface methods exist
        expect(typeof commits.store).toBe("function");
        expect(typeof commits.load).toBe("function");
        expect(typeof commits.has).toBe("function");
        expect(typeof commits.keys).toBe("function");
        expect(typeof commits.getParents).toBe("function");
        expect(typeof commits.getTree).toBe("function");
        expect(typeof commits.walkAncestry).toBe("function");
        expect(typeof commits.findMergeBase).toBe("function");
        expect(typeof commits.isAncestor).toBe("function");
      });

      it("extended methods are available on SQL native store", () => {
        const commits = stores.commits;

        // Extended query methods
        expect(typeof commits.findByAuthor).toBe("function");
        expect(typeof commits.findByDateRange).toBe("function");
        expect(typeof commits.searchMessage).toBe("function");
        expect(typeof commits.getAncestors).toBe("function");
        expect(typeof commits.count).toBe("function");
      });

      it("extended store can be used where base interface is expected", async () => {
        // Function that accepts base Commits interface
        async function countCommitsInStore(store: {
          keys: () => AsyncIterable<ObjectId>;
        }): Promise<number> {
          let count = 0;
          for await (const _ of store.keys()) {
            count++;
          }
          return count;
        }

        // SqlNativeCommitStore should work here
        const commits = stores.commits;
        await commits.store({
          tree: emptyTreeId,
          parents: [],
          author: createPerson("Test", "test@example.com", 1700000000),
          committer: createPerson("Test", "test@example.com", 1700000000),
          message: "Test commit",
        });

        const count = await countCommitsInStore(commits);
        expect(count).toBe(1);
      });
    });

    describe("Trees interface", () => {
      it("extended store is compatible with base Trees interface", () => {
        const trees = stores.trees;

        // Verify base interface methods exist
        expect(typeof trees.store).toBe("function");
        expect(typeof trees.load).toBe("function");
        expect(typeof trees.has).toBe("function");
        expect(typeof trees.keys).toBe("function");
      });

      it("extended methods are available on SQL native store", () => {
        const trees = stores.trees;

        // Extended query methods
        expect(typeof trees.findTreesWithBlob).toBe("function");
        expect(typeof trees.findByNamePattern).toBe("function");
        expect(typeof trees.count).toBe("function");
      });
    });

    describe("Tags interface", () => {
      it("extended store is compatible with base Tags interface", () => {
        const tags = stores.tags;

        // Verify base interface methods exist
        expect(typeof tags.store).toBe("function");
        expect(typeof tags.load).toBe("function");
        expect(typeof tags.has).toBe("function");
        expect(typeof tags.keys).toBe("function");
      });

      it("extended methods are available on SQL native store", () => {
        const tags = stores.tags;

        // Extended query methods
        expect(typeof tags.findByNamePattern).toBe("function");
        expect(typeof tags.findByTagger).toBe("function");
        expect(typeof tags.findByTargetType).toBe("function");
        expect(typeof tags.count).toBe("function");
      });
    });

    describe("Blobs interface", () => {
      it("extended store is compatible with base Blobs interface", () => {
        const blobs = stores.blobs;

        // Verify base interface methods exist
        expect(typeof blobs.store).toBe("function");
        expect(typeof blobs.load).toBe("function");
        expect(typeof blobs.has).toBe("function");
        expect(typeof blobs.keys).toBe("function");
      });

      it("extended methods are available on SQL native store", () => {
        const blobs = stores.blobs;

        // Extended methods
        expect(typeof blobs.count).toBe("function");
        expect(typeof blobs.totalSize).toBe("function");
      });
    });
  });

  describe("Type Guards for Extended Capabilities", () => {
    /**
     * Type guard for extended commit queries
     */
    function hasCommitQueryCapabilities(
      store: unknown,
    ): store is { findByAuthor: (email: string) => AsyncIterable<ObjectId> } {
      return (
        typeof store === "object" &&
        store !== null &&
        "findByAuthor" in store &&
        typeof (store as Record<string, unknown>).findByAuthor === "function"
      );
    }

    /**
     * Type guard for extended tree queries
     */
    function hasTreeQueryCapabilities(
      store: unknown,
    ): store is { findTreesWithBlob: (blobId: ObjectId) => AsyncIterable<ObjectId> } {
      return (
        typeof store === "object" &&
        store !== null &&
        "findTreesWithBlob" in store &&
        typeof (store as Record<string, unknown>).findTreesWithBlob === "function"
      );
    }

    /**
     * Type guard for extended tag queries
     */
    function hasTagQueryCapabilities(
      store: unknown,
    ): store is { findByNamePattern: (pattern: string) => AsyncIterable<ObjectId> } {
      return (
        typeof store === "object" &&
        store !== null &&
        "findByNamePattern" in store &&
        typeof (store as Record<string, unknown>).findByNamePattern === "function"
      );
    }

    /**
     * Type guard for count capability
     */
    function hasCountCapability(store: unknown): store is { count: () => Promise<number> } {
      return (
        typeof store === "object" &&
        store !== null &&
        "count" in store &&
        typeof (store as Record<string, unknown>).count === "function"
      );
    }

    it("type guard correctly identifies SQL native commit store", () => {
      expect(hasCommitQueryCapabilities(stores.commits)).toBe(true);
      expect(hasCountCapability(stores.commits)).toBe(true);
    });

    it("type guard correctly identifies SQL native tree store", () => {
      expect(hasTreeQueryCapabilities(stores.trees)).toBe(true);
      expect(hasCountCapability(stores.trees)).toBe(true);
    });

    it("type guard correctly identifies SQL native tag store", () => {
      expect(hasTagQueryCapabilities(stores.tags)).toBe(true);
      expect(hasCountCapability(stores.tags)).toBe(true);
    });

    it("type guard correctly identifies SQL native blob store", () => {
      expect(hasCountCapability(stores.blobs)).toBe(true);
    });

    it("type guard returns false for non-extended stores", () => {
      // A minimal store without extended capabilities
      const minimalStore = {
        store: async () => "",
        load: async () => undefined,
        has: async () => false,
        keys: async function* () {},
      };

      expect(hasCommitQueryCapabilities(minimalStore)).toBe(false);
      expect(hasTreeQueryCapabilities(minimalStore)).toBe(false);
      expect(hasTagQueryCapabilities(minimalStore)).toBe(false);
      expect(hasCountCapability(minimalStore)).toBe(false);
    });

    it("can use type guard for conditional extended features", async () => {
      const store = stores.commits;

      // Pattern for using extended features conditionally
      if (hasCommitQueryCapabilities(store)) {
        // TypeScript now knows store has findByAuthor
        const results: string[] = [];
        for await (const id of store.findByAuthor("test@example.com")) {
          results.push(id);
        }
        expect(results).toHaveLength(0); // Empty store
      } else {
        // Fallback for non-extended stores would go here
        throw new Error("Expected extended capabilities");
      }
    });
  });

  describe("API Surface Tests", () => {
    describe("method signatures", () => {
      it("findByAuthor accepts string email", async () => {
        const commits = stores.commits;

        // Should accept any valid email string
        const results: string[] = [];
        for await (const id of commits.findByAuthor("any.email@example.com")) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("findByDateRange accepts Date objects", async () => {
        const commits = stores.commits;

        // Should accept Date objects
        const since = new Date("2024-01-01");
        const until = new Date("2024-12-31");

        const results: string[] = [];
        for await (const id of commits.findByDateRange(since, until)) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("searchMessage accepts string pattern", async () => {
        const commits = stores.commits;

        // Should accept any string pattern
        const results: string[] = [];
        for await (const id of commits.searchMessage("fix")) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("count returns Promise<number>", async () => {
        const commits = stores.commits;

        const count = await commits.count();
        expect(typeof count).toBe("number");
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      });

      it("findTreesWithBlob accepts ObjectId string", async () => {
        const trees = stores.trees;

        // Should accept any valid ObjectId
        const results: string[] = [];
        for await (const id of trees.findTreesWithBlob("0".repeat(40))) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("findByNamePattern accepts SQL LIKE pattern", async () => {
        const trees = stores.trees;

        // Should accept SQL LIKE patterns
        const results: Array<{ treeId: string; entry: { name: string } }> = [];
        for await (const entry of trees.findByNamePattern("%.ts")) {
          results.push(entry);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("findByTagger accepts email string", async () => {
        const tags = stores.tags;

        const results: string[] = [];
        for await (const id of tags.findByTagger("tagger@example.com")) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });

      it("findByTargetType accepts ObjectType enum", async () => {
        const tags = stores.tags;

        const results: string[] = [];
        for await (const id of tags.findByTargetType(ObjectType.COMMIT)) {
          results.push(id);
        }
        expect(Array.isArray(results)).toBe(true);
      });
    });

    describe("return type consistency", () => {
      it("all query methods return AsyncIterable", async () => {
        const commits = stores.commits;
        const trees = stores.trees;
        const tags = stores.tags;

        // Verify these return AsyncIterables (can be used in for-await-of)
        const queries = [
          commits.findByAuthor("test@example.com"),
          commits.findByDateRange(new Date(), new Date()),
          commits.searchMessage("test"),
          commits.getAncestors("0".repeat(40)),
          trees.findTreesWithBlob("0".repeat(40)),
          trees.findByNamePattern("%.ts"),
          tags.findByNamePattern("v%"),
          tags.findByTagger("test@example.com"),
          tags.findByTargetType(ObjectType.COMMIT),
        ];

        // All queries should be async iterables
        for (const query of queries) {
          expect(typeof query[Symbol.asyncIterator]).toBe("function");
        }
      });

      it("count methods return Promise<number>", async () => {
        const counts = await Promise.all([
          stores.commits.count(),
          stores.trees.count(),
          stores.blobs.count(),
          stores.tags.count(),
        ]);

        for (const count of counts) {
          expect(typeof count).toBe("number");
          expect(Number.isInteger(count)).toBe(true);
        }
      });

      it("totalSize returns Promise<number>", async () => {
        const size = await stores.blobs.totalSize();
        expect(typeof size).toBe("number");
        expect(Number.isInteger(size)).toBe(true);
        expect(size).toBeGreaterThanOrEqual(0);
      });
    });

    describe("interface exports", () => {
      it("SqlNativeCommitStore extends CommitStore", () => {
        // Type check at compile time - this verifies the type hierarchy
        const commits: SqlNativeCommitStore = stores.commits;
        expect(commits).toBe(stores.commits);
      });

      it("SqlNativeTreeStore extends TreeStore", () => {
        const trees: SqlNativeTreeStore = stores.trees;
        expect(trees).toBe(stores.trees);
      });

      it("SqlNativeBlobStore extends BlobStore", () => {
        const blobs: SqlNativeBlobStore = stores.blobs;
        expect(blobs).toBe(stores.blobs);
      });

      it("SqlNativeTagStore extends TagStore", () => {
        const tags: SqlNativeTagStore = stores.tags;
        expect(tags).toBe(stores.tags);
      });

      it("SqlNativeStores provides all store types", () => {
        expect(stores.commits).toBeDefined();
        expect(stores.trees).toBeDefined();
        expect(stores.blobs).toBeDefined();
        expect(stores.tags).toBeDefined();
      });
    });
  });

  describe("Error Handling Documentation", () => {
    it("getAncestors throws for non-existent commit", async () => {
      const commits = stores.commits;

      await expect(async () => {
        for await (const _ of commits.getAncestors("0".repeat(40))) {
          // Should throw before yielding
        }
      }).rejects.toThrow(/not found/);
    });

    it("empty results are returned as empty iterables, not errors", async () => {
      const commits = stores.commits;

      // Non-existent author should return empty, not throw
      const results: string[] = [];
      for await (const id of commits.findByAuthor("nobody@example.com")) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("findByDateRange with inverted range returns empty", async () => {
      const commits = stores.commits;

      // End before start should return empty
      const results: string[] = [];
      for await (const id of commits.findByDateRange(
        new Date("2025-01-01"),
        new Date("2020-01-01"),
      )) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });
  });

  describe("Naming Conventions", () => {
    it("all extended query methods follow findBy/search naming", () => {
      const commits = stores.commits;
      const trees = stores.trees;
      const tags = stores.tags;

      // Commits: findByX for exact matches, searchX for text search
      expect("findByAuthor" in commits).toBe(true);
      expect("findByDateRange" in commits).toBe(true);
      expect("searchMessage" in commits).toBe(true);

      // Trees: findX for object lookups
      expect("findTreesWithBlob" in trees).toBe(true);
      expect("findByNamePattern" in trees).toBe(true);

      // Tags: findByX for exact matches
      expect("findByNamePattern" in tags).toBe(true);
      expect("findByTagger" in tags).toBe(true);
      expect("findByTargetType" in tags).toBe(true);
    });

    it("count methods are consistently named across all stores", () => {
      // All stores should have count()
      expect("count" in stores.commits).toBe(true);
      expect("count" in stores.trees).toBe(true);
      expect("count" in stores.blobs).toBe(true);
      expect("count" in stores.tags).toBe(true);
    });
  });
});
