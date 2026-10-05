/**
 * Tests for SQL native stores with extended query capabilities
 *
 * Verifies that the extended query methods (findByAuthor, searchMessage, etc.)
 * work correctly with the SQL indexes and FTS5.
 */

import { ObjectType, type PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type { SqlNativeStores } from "../src/native/types.js";

describe("SQL Native Stores Extended Queries", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
    stores = createSqlNativeStores(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("SqlNativeCommitStore", () => {
    const author1: PersonIdent = {
      name: "Alice",
      email: "alice@example.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    };

    const author2: PersonIdent = {
      name: "Bob",
      email: "bob@example.com",
      timestamp: 1700100000,
      tzOffset: "+0000",
    };

    const author3: PersonIdent = {
      name: "Charlie",
      email: "charlie@example.com",
      timestamp: 1700200000,
      tzOffset: "+0000",
    };

    it("findByAuthor returns commits by author email", async () => {
      // Store commits from different authors
      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Commit by Alice",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Commit by Bob",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Another commit by Alice",
      });

      // Find commits by Alice
      const aliceCommits: string[] = [];
      for await (const id of stores.commits.findByAuthor("alice@example.com")) {
        aliceCommits.push(id);
      }

      expect(aliceCommits).toHaveLength(2);

      // Find commits by Bob
      const bobCommits: string[] = [];
      for await (const id of stores.commits.findByAuthor("bob@example.com")) {
        bobCommits.push(id);
      }

      expect(bobCommits).toHaveLength(1);
    });

    it("findByDateRange returns commits in date range", async () => {
      // Store commits at different times
      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Early commit",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Middle commit",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author3,
        committer: author3,
        message: "Late commit",
      });

      // Find commits in middle range
      const since = new Date(1700050000 * 1000);
      const until = new Date(1700150000 * 1000);

      const rangeCommits: string[] = [];
      for await (const id of stores.commits.findByDateRange(since, until)) {
        rangeCommits.push(id);
      }

      expect(rangeCommits).toHaveLength(1); // Only Bob's commit
    });

    it("searchMessage finds commits by message content", async () => {
      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Fix critical bug in login",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Add new feature",
      });

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author3,
        committer: author3,
        message: "Fix minor bug",
      });

      // Search for "bug" - should find 2 commits
      const bugCommits: string[] = [];
      for await (const id of stores.commits.searchMessage("bug")) {
        bugCommits.push(id);
      }

      expect(bugCommits).toHaveLength(2);

      // Search for "feature" - should find 1 commit
      const featureCommits: string[] = [];
      for await (const id of stores.commits.searchMessage("feature")) {
        featureCommits.push(id);
      }

      expect(featureCommits).toHaveLength(1);
    });

    it("count returns correct number of commits", async () => {
      expect(await stores.commits.count()).toBe(0);

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Commit 1",
      });

      expect(await stores.commits.count()).toBe(1);

      await stores.commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Commit 2",
      });

      expect(await stores.commits.count()).toBe(2);
    });
  });

  describe("SqlNativeTreeStore", () => {
    it("findTreesWithBlob finds trees containing specific blob", async () => {
      const blobId = "0000000000000000000000000000000000000001";

      // Store tree with the blob
      await stores.trees.store([
        { mode: 0o100644, name: "file.txt", id: blobId },
        { mode: 0o100644, name: "other.txt", id: "0000000000000000000000000000000000000002" },
      ]);

      // Store tree without the blob
      await stores.trees.store([
        { mode: 0o100644, name: "another.txt", id: "0000000000000000000000000000000000000003" },
      ]);

      const treesWithBlob: string[] = [];
      for await (const id of stores.trees.findTreesWithBlob(blobId)) {
        treesWithBlob.push(id);
      }

      expect(treesWithBlob).toHaveLength(1);
    });

    it("findByNamePattern finds entries matching pattern", async () => {
      await stores.trees.store([
        { mode: 0o100644, name: "file.ts", id: "0000000000000000000000000000000000000001" },
        { mode: 0o100644, name: "file.js", id: "0000000000000000000000000000000000000002" },
        { mode: 0o100644, name: "README.md", id: "0000000000000000000000000000000000000003" },
      ]);

      // Find .ts files
      const tsFiles: Array<{ treeId: string; entry: { name: string } }> = [];
      for await (const result of stores.trees.findByNamePattern("%.ts")) {
        tsFiles.push(result);
      }

      expect(tsFiles).toHaveLength(1);
      expect(tsFiles[0].entry.name).toBe("file.ts");
    });

    it("count returns correct number of trees", async () => {
      expect(await stores.trees.count()).toBe(0);

      await stores.trees.store([
        { mode: 0o100644, name: "file.txt", id: "0000000000000000000000000000000000000001" },
      ]);

      expect(await stores.trees.count()).toBe(1);
    });
  });

  describe("SqlNativeTagStore", () => {
    const tagger: PersonIdent = {
      name: "Alice",
      email: "alice@example.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    };

    it("findByNamePattern finds tags matching pattern", async () => {
      await stores.tags.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release 1.0.0",
      });

      await stores.tags.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.COMMIT,
        tag: "v1.1.0",
        tagger,
        message: "Release 1.1.0",
      });

      await stores.tags.store({
        object: "0000000000000000000000000000000000000003",
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger,
        message: "Release 2.0.0",
      });

      // Find v1.x tags
      const v1Tags: string[] = [];
      for await (const id of stores.tags.findByNamePattern("v1.%")) {
        v1Tags.push(id);
      }

      expect(v1Tags).toHaveLength(2);
    });

    it("findByTagger finds tags by tagger email", async () => {
      const tagger2: PersonIdent = {
        name: "Bob",
        email: "bob@example.com",
        timestamp: 1700100000,
        tzOffset: "+0000",
      };

      await stores.tags.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release by Alice",
      });

      await stores.tags.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger: tagger2,
        message: "Release by Bob",
      });

      const aliceTags: string[] = [];
      for await (const id of stores.tags.findByTagger("alice@example.com")) {
        aliceTags.push(id);
      }

      expect(aliceTags).toHaveLength(1);
    });

    it("findByTargetType finds tags by object type", async () => {
      await stores.tags.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Commit tag",
      });

      await stores.tags.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.TREE,
        tag: "tree-tag",
        tagger,
        message: "Tree tag",
      });

      const commitTags: string[] = [];
      for await (const id of stores.tags.findByTargetType(ObjectType.COMMIT)) {
        commitTags.push(id);
      }

      expect(commitTags).toHaveLength(1);

      const treeTags: string[] = [];
      for await (const id of stores.tags.findByTargetType(ObjectType.TREE)) {
        treeTags.push(id);
      }

      expect(treeTags).toHaveLength(1);
    });

    it("count returns correct number of tags", async () => {
      expect(await stores.tags.count()).toBe(0);

      await stores.tags.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release",
      });

      expect(await stores.tags.count()).toBe(1);
    });
  });
});
