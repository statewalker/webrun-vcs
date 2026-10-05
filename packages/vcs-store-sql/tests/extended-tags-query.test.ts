/**
 * T5.3: Extended Tags Query Tests
 *
 * Comprehensive tests for SQL native store extended tag query capabilities:
 * - findByNamePattern: Query tags by name pattern (SQL LIKE)
 * - findByTagger: Query tags by tagger email
 * - findByTargetType: Query tags by target object type
 * - count: Tag statistics
 */

import type { PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type {
  SqlNativeCommitStore,
  SqlNativeStores,
  SqlNativeTagStore,
} from "../src/native/types.js";

describe("T5.3: Extended Tags Query Tests", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;
  let tags: SqlNativeTagStore;
  let commits: SqlNativeCommitStore;

  // Object type constants (matching Git encoding)
  const TYPE_COMMIT = 1;
  const TYPE_TREE = 2;
  const TYPE_BLOB = 3;
  const TYPE_TAG = 4;

  // Test tree ID (empty tree)
  const emptyTreeId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  // Helper to create person
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

  // Helper to create a test commit and return its ID
  const createCommit = async (message: string, timestamp = 1700000000): Promise<string> => {
    const person = createPerson("Test User", "test@example.com", timestamp);
    return await commits.store({
      tree: emptyTreeId,
      parents: [],
      author: person,
      committer: person,
      message,
    });
  };

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
    stores = createSqlNativeStores(db);
    tags = stores.tags;
    commits = stores.commits;
  });

  afterEach(async () => {
    await db.close();
  });

  describe("findByNamePattern", () => {
    it("returns empty iterator for no matching tags", async () => {
      const commitId = await createCommit("Test commit");
      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "Release v1.0.0",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("v2%")) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds tags matching exact name", async () => {
      const commitId = await createCommit("Test commit");
      const tagId = await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "Release v1.0.0",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("v1.0.0")) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(tagId);
    });

    it("finds tags matching version pattern", async () => {
      const commitId = await createCommit("Test commit");

      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "Release v1.0.0",
      });

      await tags.store({
        tag: "v1.1.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000100),
        message: "Release v1.1.0",
      });

      await tags.store({
        tag: "v2.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000200),
        message: "Release v2.0.0",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("v1.%")) {
        results.push(id);
      }

      expect(results).toHaveLength(2);
    });

    it("finds tags matching prefix pattern", async () => {
      const commitId = await createCommit("Test commit");

      await tags.store({
        tag: "release-candidate-1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "RC 1",
      });

      await tags.store({
        tag: "release-candidate-2",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000100),
        message: "RC 2",
      });

      await tags.store({
        tag: "beta-1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000200),
        message: "Beta 1",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("release-%")) {
        results.push(id);
      }

      expect(results).toHaveLength(2);
    });

    it("handles underscore wildcard (single character)", async () => {
      const commitId = await createCommit("Test commit");

      await tags.store({
        tag: "v1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "v1",
      });

      await tags.store({
        tag: "v2",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000100),
        message: "v2",
      });

      await tags.store({
        tag: "v10",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000200),
        message: "v10",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("v_")) {
        results.push(id);
      }

      // Only v1 and v2 should match (single digit)
      expect(results).toHaveLength(2);
    });

    it("is case-insensitive for pattern matching (SQLite LIKE)", async () => {
      const commitId = await createCommit("Test commit");

      await tags.store({
        tag: "Release-v1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "Release",
      });

      await tags.store({
        tag: "RELEASE-v2",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000100),
        message: "Release",
      });

      await tags.store({
        tag: "release-v3",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000200),
        message: "Release",
      });

      const results: string[] = [];
      for await (const id of tags.findByNamePattern("release%")) {
        results.push(id);
      }

      // SQLite LIKE is case-insensitive for ASCII
      expect(results).toHaveLength(3);
    });
  });

  describe("findByTagger", () => {
    it("returns empty iterator for non-existent tagger", async () => {
      const commitId = await createCommit("Test commit");
      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Alice", "alice@example.com", 1700000000),
        message: "Tag by Alice",
      });

      const results: string[] = [];
      for await (const id of tags.findByTagger("bob@example.com")) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds tags by tagger email", async () => {
      const commitId = await createCommit("Test commit");
      const alice = createPerson("Alice", "alice@example.com", 1700000000);
      const bob = createPerson("Bob", "bob@example.com", 1700000100);

      const tag1 = await tags.store({
        tag: "alice-tag-1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: alice,
        message: "Alice tag 1",
      });

      await tags.store({
        tag: "bob-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: bob,
        message: "Bob tag",
      });

      const tag2 = await tags.store({
        tag: "alice-tag-2",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: { ...alice, timestamp: 1700000200 },
        message: "Alice tag 2",
      });

      const results: string[] = [];
      for await (const id of tags.findByTagger("alice@example.com")) {
        results.push(id);
      }

      expect(results).toHaveLength(2);
      expect(results).toContain(tag1);
      expect(results).toContain(tag2);
    });

    it("handles tags without tagger (lightweight tags)", async () => {
      const commitId = await createCommit("Test commit");

      // Store a lightweight tag (no tagger)
      await tags.store({
        tag: "lightweight-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        message: "", // No message for lightweight tag
      });

      // Store annotated tag with tagger
      const tagId = await tags.store({
        tag: "annotated-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Alice", "alice@example.com", 1700000000),
        message: "Annotated tag",
      });

      const results: string[] = [];
      for await (const id of tags.findByTagger("alice@example.com")) {
        results.push(id);
      }

      // Only annotated tag should be found
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(tagId);
    });

    it("handles emails with special characters", async () => {
      const commitId = await createCommit("Test commit");
      const specialEmail = createPerson("Special", "user+tag@example.com", 1700000000);

      const tagId = await tags.store({
        tag: "special-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: specialEmail,
        message: "Special email tag",
      });

      const results: string[] = [];
      for await (const id of tags.findByTagger("user+tag@example.com")) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(tagId);
    });

    it("is case-sensitive for email matching", async () => {
      const commitId = await createCommit("Test commit");

      await tags.store({
        tag: "tag1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Alice", "Alice@Example.COM", 1700000000),
        message: "Tag 1",
      });

      const exactResults: string[] = [];
      for await (const id of tags.findByTagger("Alice@Example.COM")) {
        exactResults.push(id);
      }
      expect(exactResults).toHaveLength(1);

      const lowerResults: string[] = [];
      for await (const id of tags.findByTagger("alice@example.com")) {
        lowerResults.push(id);
      }
      // SQL = comparison is case-sensitive
      expect(lowerResults).toHaveLength(0);
    });
  });

  describe("findByTargetType", () => {
    it("returns empty iterator when no tags match target type", async () => {
      const commitId = await createCommit("Test commit");
      await tags.store({
        tag: "commit-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: createPerson("Tagger", "tagger@example.com", 1700000000),
        message: "Tag pointing to commit",
      });

      const results: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_BLOB)) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds tags pointing to commits", async () => {
      const commitId = await createCommit("Test commit");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      const commitTag = await tags.store({
        tag: "commit-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Tag pointing to commit",
      });

      const results: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_COMMIT)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(commitTag);
    });

    it("finds tags pointing to trees", async () => {
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      const treeTag = await tags.store({
        tag: "tree-tag",
        object: emptyTreeId,
        objectType: TYPE_TREE,
        tagger,
        message: "Tag pointing to tree",
      });

      const results: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_TREE)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(treeTag);
    });

    it("finds tags pointing to blobs", async () => {
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);
      // Use a fake blob ID (in real usage would be actual blob)
      const blobId = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";

      const blobTag = await tags.store({
        tag: "blob-tag",
        object: blobId,
        objectType: TYPE_BLOB,
        tagger,
        message: "Tag pointing to blob",
      });

      const results: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_BLOB)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(blobTag);
    });

    it("finds nested tags (tags pointing to tags)", async () => {
      const commitId = await createCommit("Test commit");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      // First create a commit tag
      const innerTagId = await tags.store({
        tag: "inner-tag",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Inner tag",
      });

      // Then create a tag pointing to the inner tag
      const outerTagId = await tags.store({
        tag: "outer-tag",
        object: innerTagId,
        objectType: TYPE_TAG,
        tagger: { ...tagger, timestamp: 1700000100 },
        message: "Tag pointing to another tag",
      });

      const results: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_TAG)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(outerTagId);
    });

    it("finds multiple tags of same type", async () => {
      const commit1 = await createCommit("Commit 1");
      const commit2 = await createCommit("Commit 2");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      await tags.store({
        tag: "tag1",
        object: commit1,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Tag 1",
      });

      await tags.store({
        tag: "tag2",
        object: commit2,
        objectType: TYPE_COMMIT,
        tagger: { ...tagger, timestamp: 1700000100 },
        message: "Tag 2",
      });

      // Also create a tree tag for contrast
      await tags.store({
        tag: "tree-tag",
        object: emptyTreeId,
        objectType: TYPE_TREE,
        tagger: { ...tagger, timestamp: 1700000200 },
        message: "Tree tag",
      });

      const commitResults: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_COMMIT)) {
        commitResults.push(id);
      }

      expect(commitResults).toHaveLength(2);
    });
  });

  describe("count", () => {
    it("returns 0 for empty store", async () => {
      expect(await tags.count()).toBe(0);
    });

    it("returns correct count after adding tags", async () => {
      const commitId = await createCommit("Test commit");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      await tags.store({
        tag: "tag1",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Tag 1",
      });

      expect(await tags.count()).toBe(1);

      await tags.store({
        tag: "tag2",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: { ...tagger, timestamp: 1700000100 },
        message: "Tag 2",
      });

      expect(await tags.count()).toBe(2);

      await tags.store({
        tag: "tag3",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: { ...tagger, timestamp: 1700000200 },
        message: "Tag 3",
      });

      expect(await tags.count()).toBe(3);
    });

    it("does not count duplicate tags", async () => {
      const commitId = await createCommit("Test commit");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      // Store same tag twice (same content = same SHA)
      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Release v1.0.0",
      });

      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Release v1.0.0",
      });

      expect(await tags.count()).toBe(1);
    });

    it("counts distinct tags correctly", async () => {
      const commitId = await createCommit("Test commit");
      const tagger = createPerson("Tagger", "tagger@example.com", 1700000000);

      // Different messages = different tags
      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Release v1.0.0",
      });

      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger,
        message: "Re-release v1.0.0", // Different message
      });

      expect(await tags.count()).toBe(2);
    });
  });

  describe("Combined Queries", () => {
    it("can combine name pattern and tagger queries", async () => {
      const commitId = await createCommit("Test commit");
      const alice = createPerson("Alice", "alice@example.com", 1700000000);
      const bob = createPerson("Bob", "bob@example.com", 1700000100);

      // Alice creates v1.x tags
      await tags.store({
        tag: "v1.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: alice,
        message: "Alice v1.0.0",
      });

      await tags.store({
        tag: "v1.1.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: { ...alice, timestamp: 1700000200 },
        message: "Alice v1.1.0",
      });

      // Bob creates v2.x tags
      await tags.store({
        tag: "v2.0.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: bob,
        message: "Bob v2.0.0",
      });

      // Alice creates v2.x tag
      await tags.store({
        tag: "v2.1.0",
        object: commitId,
        objectType: TYPE_COMMIT,
        tagger: { ...alice, timestamp: 1700000300 },
        message: "Alice v2.1.0",
      });

      // Find v2.x tags
      const v2Tags = new Set<string>();
      for await (const id of tags.findByNamePattern("v2.%")) {
        v2Tags.add(id);
      }

      // Find Alice's tags
      const aliceTags = new Set<string>();
      for await (const id of tags.findByTagger("alice@example.com")) {
        aliceTags.add(id);
      }

      // Intersection: Alice's v2.x tags
      const aliceV2Tags = [...v2Tags].filter((id) => aliceTags.has(id));

      expect(aliceV2Tags).toHaveLength(1);
    });

    it("handles empty results gracefully", async () => {
      // Query on empty store
      const nameResults: string[] = [];
      for await (const id of tags.findByNamePattern("v%")) {
        nameResults.push(id);
      }
      expect(nameResults).toHaveLength(0);

      const taggerResults: string[] = [];
      for await (const id of tags.findByTagger("anyone@example.com")) {
        taggerResults.push(id);
      }
      expect(taggerResults).toHaveLength(0);

      const typeResults: string[] = [];
      for await (const id of tags.findByTargetType(TYPE_COMMIT)) {
        typeResults.push(id);
      }
      expect(typeResults).toHaveLength(0);

      expect(await tags.count()).toBe(0);
    });
  });
});
