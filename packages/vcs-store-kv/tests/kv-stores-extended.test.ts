/**
 * Tests for KV stores with extended query capabilities
 *
 * Verifies that the extended query methods (findByAuthor, searchMessage, etc.)
 * work correctly with O(n) scans.
 */

import { ObjectType, type PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KVCommitStore } from "../src/kv-commit-store.js";
import type { KVStore } from "../src/kv-store.js";
import { KVTagStore } from "../src/kv-tag-store.js";
import { KVTreeStore } from "../src/kv-tree-store.js";

describe("KV Stores Extended Queries", () => {
  let kv: KVStore;

  beforeEach(() => {
    kv = new MemoryKVAdapter();
  });

  afterEach(async () => {
    // MemoryAdapter doesn't need cleanup
  });

  describe("KVCommitStore", () => {
    let commitStore: KVCommitStore;

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

    beforeEach(() => {
      commitStore = new KVCommitStore(kv);
    });

    it("findByAuthor returns commits by author email", async () => {
      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Commit by Alice",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Commit by Bob",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Another commit by Alice",
      });

      const aliceCommits: string[] = [];
      for await (const id of commitStore.findByAuthor("alice@example.com")) {
        aliceCommits.push(id);
      }

      expect(aliceCommits).toHaveLength(2);

      const bobCommits: string[] = [];
      for await (const id of commitStore.findByAuthor("bob@example.com")) {
        bobCommits.push(id);
      }

      expect(bobCommits).toHaveLength(1);
    });

    it("findByDateRange returns commits in date range", async () => {
      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Early commit",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Middle commit",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author3,
        committer: author3,
        message: "Late commit",
      });

      const since = new Date(1700050000 * 1000);
      const until = new Date(1700150000 * 1000);

      const rangeCommits: string[] = [];
      for await (const id of commitStore.findByDateRange(since, until)) {
        rangeCommits.push(id);
      }

      expect(rangeCommits).toHaveLength(1); // Only Bob's commit
    });

    it("searchMessage finds commits by message content", async () => {
      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Fix critical bug in login",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Add new feature",
      });

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author3,
        committer: author3,
        message: "Fix minor bug",
      });

      const bugCommits: string[] = [];
      for await (const id of commitStore.searchMessage("bug")) {
        bugCommits.push(id);
      }

      expect(bugCommits).toHaveLength(2);

      const featureCommits: string[] = [];
      for await (const id of commitStore.searchMessage("feature")) {
        featureCommits.push(id);
      }

      expect(featureCommits).toHaveLength(1);
    });

    it("count returns correct number of commits", async () => {
      expect(await commitStore.count()).toBe(0);

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author1,
        committer: author1,
        message: "Commit 1",
      });

      expect(await commitStore.count()).toBe(1);

      await commitStore.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: author2,
        committer: author2,
        message: "Commit 2",
      });

      expect(await commitStore.count()).toBe(2);
    });
  });

  describe("KVTreeStore", () => {
    let treeStore: KVTreeStore;

    beforeEach(() => {
      treeStore = new KVTreeStore(kv);
    });

    it("findTreesWithBlob finds trees containing specific blob", async () => {
      const blobId = "0000000000000000000000000000000000000001";

      await treeStore.store([
        { mode: 0o100644, name: "file.txt", id: blobId },
        { mode: 0o100644, name: "other.txt", id: "0000000000000000000000000000000000000002" },
      ]);

      await treeStore.store([
        { mode: 0o100644, name: "another.txt", id: "0000000000000000000000000000000000000003" },
      ]);

      const treesWithBlob: string[] = [];
      for await (const id of treeStore.findTreesWithBlob(blobId)) {
        treesWithBlob.push(id);
      }

      expect(treesWithBlob).toHaveLength(1);
    });

    it("findByNamePattern finds entries matching pattern", async () => {
      await treeStore.store([
        { mode: 0o100644, name: "file.ts", id: "0000000000000000000000000000000000000001" },
        { mode: 0o100644, name: "file.js", id: "0000000000000000000000000000000000000002" },
        { mode: 0o100644, name: "README.md", id: "0000000000000000000000000000000000000003" },
      ]);

      // Find .ts files using wildcard pattern
      const tsFiles: Array<{ treeId: string; entry: { name: string } }> = [];
      for await (const result of treeStore.findByNamePattern("*.ts")) {
        tsFiles.push(result);
      }

      expect(tsFiles).toHaveLength(1);
      expect(tsFiles[0].entry.name).toBe("file.ts");
    });

    it("count returns correct number of trees", async () => {
      expect(await treeStore.count()).toBe(0);

      await treeStore.store([
        { mode: 0o100644, name: "file.txt", id: "0000000000000000000000000000000000000001" },
      ]);

      expect(await treeStore.count()).toBe(1);
    });
  });

  describe("KVTagStore", () => {
    let tagStore: KVTagStore;

    const tagger: PersonIdent = {
      name: "Alice",
      email: "alice@example.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    };

    beforeEach(() => {
      tagStore = new KVTagStore(kv);
    });

    it("findByNamePattern finds tags matching pattern", async () => {
      await tagStore.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release 1.0.0",
      });

      await tagStore.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.COMMIT,
        tag: "v1.1.0",
        tagger,
        message: "Release 1.1.0",
      });

      await tagStore.store({
        object: "0000000000000000000000000000000000000003",
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger,
        message: "Release 2.0.0",
      });

      // Find v1.x tags using wildcard pattern
      const v1Tags: string[] = [];
      for await (const id of tagStore.findByNamePattern("v1.*")) {
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

      await tagStore.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release by Alice",
      });

      await tagStore.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger: tagger2,
        message: "Release by Bob",
      });

      const aliceTags: string[] = [];
      for await (const id of tagStore.findByTagger("alice@example.com")) {
        aliceTags.push(id);
      }

      expect(aliceTags).toHaveLength(1);
    });

    it("findByTargetType finds tags by object type", async () => {
      await tagStore.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Commit tag",
      });

      await tagStore.store({
        object: "0000000000000000000000000000000000000002",
        objectType: ObjectType.TREE,
        tag: "tree-tag",
        tagger,
        message: "Tree tag",
      });

      const commitTags: string[] = [];
      for await (const id of tagStore.findByTargetType(ObjectType.COMMIT)) {
        commitTags.push(id);
      }

      expect(commitTags).toHaveLength(1);

      const treeTags: string[] = [];
      for await (const id of tagStore.findByTargetType(ObjectType.TREE)) {
        treeTags.push(id);
      }

      expect(treeTags).toHaveLength(1);
    });

    it("count returns correct number of tags", async () => {
      expect(await tagStore.count()).toBe(0);

      await tagStore.store({
        object: "0000000000000000000000000000000000000001",
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger,
        message: "Release",
      });

      expect(await tagStore.count()).toBe(1);
    });
  });
});
