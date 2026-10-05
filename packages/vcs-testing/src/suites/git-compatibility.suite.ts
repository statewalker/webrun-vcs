/**
 * Git Compatibility Test Suite
 *
 * Verifies that our implementation produces output compatible with Git.
 * These tests use known Git hashes and formats to ensure interoperability.
 *
 * Based on JGit patterns and Git format specifications.
 */

import type { History } from "@statewalker/vcs-core";
import { ObjectType } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the stores factory
 */
export interface GitCompatibilityTestContext {
  stores: History;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create stores instance for testing
 */
export type GitCompatibilityFactory = () => Promise<GitCompatibilityTestContext>;

/**
 * Helper to create async iterable from Uint8Array
 */
async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Helper to collect async iterable to array
 */
async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

const encoder = new TextEncoder();

/**
 * Well-known Git object IDs for reference:
 *
 * Empty tree: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
 * Empty blob: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
 *
 * These are computed using:
 *   echo -n "" | git hash-object --stdin -t tree
 *   echo -n "" | git hash-object --stdin
 */
const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_BLOB_ID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/**
 * Known blob hashes computed with: echo -n "content" | git hash-object --stdin
 */
const KNOWN_BLOB_HASHES: Array<{ content: string; expected: string }> = [
  { content: "hello", expected: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0" },
  { content: "hello\n", expected: "ce013625030ba8dba906f756967f9e9ca394464a" },
  { content: "test content", expected: "08cf6101416f0ce0dda3c80e627f333854c4085c" },
  { content: "", expected: EMPTY_BLOB_ID },
];

/**
 * Create the Git Compatibility test suite with a specific factory
 */
export function createGitCompatibilityTests(name: string, factory: GitCompatibilityFactory): void {
  describe(`Git Compatibility [${name}]`, () => {
    let ctx: GitCompatibilityTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Blob Object Hashing", () => {
      /**
       * Verify blob hashing produces Git-compatible SHA-1.
       * Git blob format: "blob {size}\0{content}"
       */
      it.each(KNOWN_BLOB_HASHES)(
        "should hash '$content' to $expected",
        async ({ content, expected }) => {
          const data = encoder.encode(content);
          const id = await ctx.stores.blobs.store(toStream(data));
          expect(id).toBe(expected);
        },
      );

      it("should handle binary content correctly", async () => {
        // Binary content with null bytes
        const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
        const id = await ctx.stores.blobs.store(toStream(binary));

        // Verify it's a valid SHA-1
        expect(id).toMatch(/^[0-9a-f]{40}$/);

        // Roundtrip should preserve binary content
        const loaded = await ctx.stores.blobs.load(id);
        if (!loaded) throw new Error("Blob not found");

        const chunks: Uint8Array[] = [];
        for await (const chunk of loaded) {
          chunks.push(chunk);
        }
        const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        expect(result).toEqual(binary);
      });
    });

    describe("Tree Object Hashing", () => {
      /**
       * Empty tree has a well-known hash.
       */
      it("should produce well-known empty tree hash", async () => {
        const id = await ctx.stores.trees.store([]);
        expect(id).toBe(EMPTY_TREE_ID);
      });

      /**
       * Tree entries must be sorted in Git order.
       * Git uses byte-by-byte comparison, treating '/' as part of the name.
       */
      it("should sort tree entries in Git order", async () => {
        // Create blobs for tree entries
        const blobId = await ctx.stores.blobs.store(toStream(encoder.encode("content")));

        // Add entries in reverse order - tree should sort them
        const treeId = await ctx.stores.trees.store([
          { mode: 0o100644, name: "z.txt", id: blobId },
          { mode: 0o100644, name: "a.txt", id: blobId },
          { mode: 0o100644, name: "m.txt", id: blobId },
        ]);

        // Load and verify sorted order
        const treeIter = await ctx.stores.trees.load(treeId);
        if (!treeIter) throw new Error("Tree not found");
        const entries = await toArray(treeIter);
        expect(entries.map((e) => e.name)).toEqual(["a.txt", "m.txt", "z.txt"]);
      });

      /**
       * Directories (trees) sort with a trailing '/' in comparison.
       * This means "a" < "a.txt" < "a/"
       */
      it("should sort directories correctly relative to files", async () => {
        const blobId = await ctx.stores.blobs.store(toStream(encoder.encode("file")));
        const dirTreeId = await ctx.stores.trees.store([]);

        const treeId = await ctx.stores.trees.store([
          { mode: 0o100644, name: "a.txt", id: blobId },
          { mode: 0o040000, name: "a", id: dirTreeId },
          { mode: 0o100644, name: "a-file", id: blobId },
        ]);

        const treeIter = await ctx.stores.trees.load(treeId);
        if (!treeIter) throw new Error("Tree not found");
        const entries = await toArray(treeIter);
        // Git order: "a-file" < "a.txt" < "a" (dir)
        // Because dir "a" compares as "a/" and "/" (47) > "." (46) > "-" (45)
        expect(entries.map((e) => e.name)).toEqual(["a-file", "a.txt", "a"]);
      });

      /**
       * File modes must be encoded correctly:
       * - 100644: regular file
       * - 100755: executable file
       * - 120000: symbolic link
       * - 040000: tree (directory)
       * - 160000: gitlink (submodule)
       */
      it("should handle all file modes", async () => {
        const blobId = await ctx.stores.blobs.store(toStream(encoder.encode("content")));
        const treeId = await ctx.stores.trees.store([]);

        const parentTree = await ctx.stores.trees.store([
          { mode: 0o100644, name: "regular.txt", id: blobId },
          { mode: 0o100755, name: "executable.sh", id: blobId },
          { mode: 0o120000, name: "symlink", id: blobId },
          { mode: 0o040000, name: "subdir", id: treeId },
        ]);

        const treeIter = await ctx.stores.trees.load(parentTree);
        if (!treeIter) throw new Error("Tree not found");
        const entries = await toArray(treeIter);

        const findEntry = (name: string) => entries.find((e) => e.name === name);
        expect(findEntry("regular.txt")?.mode).toBe(0o100644);
        expect(findEntry("executable.sh")?.mode).toBe(0o100755);
        expect(findEntry("symlink")?.mode).toBe(0o120000);
        expect(findEntry("subdir")?.mode).toBe(0o040000);
      });
    });

    describe("Commit Object Hashing", () => {
      /**
       * Commit format must match Git exactly.
       * Timestamps are Unix epoch seconds.
       */
      it("should produce deterministic commit hash for same data", async () => {
        const commitData = {
          tree: EMPTY_TREE_ID,
          parents: [] as string[],
          author: {
            name: "Test Author",
            email: "author@example.com",
            timestamp: 1000000000,
            tzOffset: "+0000",
          },
          committer: {
            name: "Test Committer",
            email: "committer@example.com",
            timestamp: 1000000000,
            tzOffset: "+0000",
          },
          message: "Test commit message\n",
        };

        const id1 = await ctx.stores.commits.store(commitData);
        const id2 = await ctx.stores.commits.store(commitData);

        expect(id1).toBe(id2);
        expect(id1).toMatch(/^[0-9a-f]{40}$/);
      });

      /**
       * Commit with multiple parents (merge commit).
       */
      it("should handle merge commit with multiple parents", async () => {
        // Create two parent commits
        const parent1 = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message: "Parent 1",
        });

        const parent2 = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "Parent 2",
        });

        // Create merge commit
        const merge = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [parent1, parent2],
          author: { name: "A", email: "a@test.com", timestamp: 3000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 3000, tzOffset: "+0000" },
          message: "Merge commit",
        });

        // Load and verify parents
        const loaded = await ctx.stores.commits.load(merge);
        if (!loaded) throw new Error("Commit not found");
        expect(loaded.parents).toEqual([parent1, parent2]);
      });

      /**
       * Timezone offset must be formatted correctly.
       */
      it("should handle various timezone offsets", async () => {
        const timezones = ["+0000", "-0500", "+0530", "+1200", "-1100"];

        for (const tz of timezones) {
          const commit = await ctx.stores.commits.store({
            tree: EMPTY_TREE_ID,
            parents: [],
            author: { name: "A", email: "a@test.com", timestamp: 1000000, tzOffset: tz },
            committer: { name: "A", email: "a@test.com", timestamp: 1000000, tzOffset: tz },
            message: `TZ: ${tz}`,
          });

          const loaded = await ctx.stores.commits.load(commit);
          if (!loaded) throw new Error("Commit not found");
          expect(loaded.author.tzOffset).toBe(tz);
          expect(loaded.committer.tzOffset).toBe(tz);
        }
      });

      /**
       * Multi-line commit messages must be preserved.
       */
      it("should preserve multi-line commit messages", async () => {
        const message = `First line

Second paragraph with details.

- Bullet point 1
- Bullet point 2

Signed-off-by: Test <test@example.com>
`;

        const commit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message,
        });

        const loaded = await ctx.stores.commits.load(commit);
        if (!loaded) throw new Error("Commit not found");
        expect(loaded.message).toBe(message);
      });
    });

    describe("Tag Object Hashing", () => {
      /**
       * Annotated tags must have proper format.
       */
      it("should create Git-compatible annotated tag", async () => {
        // First create a commit to tag
        const commitId = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message: "Initial commit",
        });

        const tagId = await ctx.stores.tags.store({
          object: commitId,
          objectType: ObjectType.COMMIT,
          tag: "v1.0.0",
          tagger: { name: "Tagger", email: "tagger@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "Release version 1.0.0",
        });

        expect(tagId).toMatch(/^[0-9a-f]{40}$/);

        const loaded = await ctx.stores.tags.load(tagId);
        if (!loaded) throw new Error("Tag not found");
        expect(loaded.object).toBe(commitId);
        expect(loaded.objectType).toBe(ObjectType.COMMIT);
        expect(loaded.tag).toBe("v1.0.0");
        expect(loaded.message).toBe("Release version 1.0.0");
      });
    });

    describe("Stash Commit Format", () => {
      /**
       * Stash commits have a specific structure:
       * - Parent 0: HEAD at stash time
       * - Parent 1: Index state
       * - Parent 2 (optional): Untracked files tree
       *
       * Message format: "WIP on {branch}: {short-sha} {commit-message}"
       */
      it("should create stash with correct parent structure", async () => {
        // Create HEAD commit
        const headCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message: "HEAD commit",
        });

        // Create index commit (first parent is HEAD)
        const indexCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [headCommit],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "index on main: abc1234 HEAD commit",
        });

        // Create stash commit (two parents: HEAD, index)
        const stashCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [headCommit, indexCommit],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "WIP on main: abc1234 HEAD commit",
        });

        const loaded = await ctx.stores.commits.load(stashCommit);
        if (!loaded) throw new Error("Commit not found");
        expect(loaded.parents.length).toBe(2);
        expect(loaded.parents[0]).toBe(headCommit);
        expect(loaded.parents[1]).toBe(indexCommit);
        expect(loaded.message).toMatch(/^WIP on /);
      });

      /**
       * Stash with untracked files has three parents.
       */
      it("should support stash with untracked files (3 parents)", async () => {
        const headCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message: "HEAD",
        });

        const indexCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [headCommit],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "index on main: abc HEAD",
        });

        // Untracked files tree
        const untrackedBlob = await ctx.stores.blobs.store(toStream(encoder.encode("untracked")));
        const untrackedTree = await ctx.stores.trees.store([
          { mode: 0o100644, name: "new-file.txt", id: untrackedBlob },
        ]);

        const untrackedCommit = await ctx.stores.commits.store({
          tree: untrackedTree,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "untracked files on main: abc HEAD",
        });

        // Stash with 3 parents
        const stashCommit = await ctx.stores.commits.store({
          tree: EMPTY_TREE_ID,
          parents: [headCommit, indexCommit, untrackedCommit],
          author: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 2000, tzOffset: "+0000" },
          message: "WIP on main: abc HEAD",
        });

        const loaded = await ctx.stores.commits.load(stashCommit);
        if (!loaded) throw new Error("Commit not found");
        expect(loaded.parents.length).toBe(3);
        expect(loaded.parents[2]).toBe(untrackedCommit);
      });
    });

    describe("Object ID Format", () => {
      /**
       * All object IDs must be 40-character lowercase hex strings.
       */
      it("should produce lowercase hex SHA-1 IDs", async () => {
        const blobId = await ctx.stores.blobs.store(toStream(encoder.encode("test")));
        expect(blobId).toMatch(/^[0-9a-f]{40}$/);
        expect(blobId).toBe(blobId.toLowerCase());

        const treeId = await ctx.stores.trees.store([]);
        expect(treeId).toMatch(/^[0-9a-f]{40}$/);

        const commitId = await ctx.stores.commits.store({
          tree: treeId,
          parents: [],
          author: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          committer: { name: "A", email: "a@test.com", timestamp: 1000, tzOffset: "+0000" },
          message: "test",
        });
        expect(commitId).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });
}
