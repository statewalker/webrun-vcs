/**
 * T5.1: Extended Commits Query Tests
 *
 * Comprehensive tests for SQL native store extended commit query capabilities:
 * - findByAuthor: Query by author email with various patterns
 * - findByDateRange: Query by commit timestamp range
 * - searchMessage: Full-text search on commit messages
 * - getAncestors: Recursive ancestry traversal
 * - count: Commit statistics
 */

import type { PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type { SqlNativeCommitStore, SqlNativeStores } from "../src/native/types.js";

describe("T5.1: Extended Commits Query Tests", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;
  let commits: SqlNativeCommitStore;

  // Test data: create persons with different timestamps for testing
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

  // Test tree ID (empty tree)
  const emptyTreeId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
    stores = createSqlNativeStores(db);
    commits = stores.commits;
  });

  afterEach(async () => {
    await db.close();
  });

  describe("findByAuthor", () => {
    it("returns empty iterator for non-existent author", async () => {
      const results: string[] = [];
      for await (const id of commits.findByAuthor("nobody@example.com")) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds commits by exact email match", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);
      const bob = createPerson("Bob", "bob@example.com", 1700000100);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Alice commit 1",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: bob,
        committer: bob,
        message: "Bob commit",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Alice commit 2",
      });

      const aliceCommits: string[] = [];
      for await (const id of commits.findByAuthor("alice@example.com")) {
        aliceCommits.push(id);
      }

      expect(aliceCommits).toHaveLength(2);
    });

    it("is case-sensitive for email matching", async () => {
      const alice = createPerson("Alice", "Alice@Example.COM", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Alice commit",
      });

      // Exact case should match
      const exactMatch: string[] = [];
      for await (const id of commits.findByAuthor("Alice@Example.COM")) {
        exactMatch.push(id);
      }
      expect(exactMatch).toHaveLength(1);

      // Different case should not match (SQL uses exact string comparison)
      const lowerCase: string[] = [];
      for await (const id of commits.findByAuthor("alice@example.com")) {
        lowerCase.push(id);
      }
      // SQL = operator is case-sensitive
      expect(lowerCase).toHaveLength(0);
    });

    it("handles emails with special characters", async () => {
      const specialEmail = createPerson("Special", "user+test@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: specialEmail,
        committer: specialEmail,
        message: "Special email commit",
      });

      const results: string[] = [];
      for await (const id of commits.findByAuthor("user+test@example.com")) {
        results.push(id);
      }
      expect(results).toHaveLength(1);
    });

    it("distinguishes author from committer email", async () => {
      const author = createPerson("Alice", "alice@example.com", 1700000000);
      const committer = createPerson("Bob", "bob@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author,
        committer,
        message: "Different author and committer",
      });

      // Should find by author email
      const authorResults: string[] = [];
      for await (const id of commits.findByAuthor("alice@example.com")) {
        authorResults.push(id);
      }
      expect(authorResults).toHaveLength(1);

      // Should not find by committer email (findByAuthor checks author only)
      const committerResults: string[] = [];
      for await (const id of commits.findByAuthor("bob@example.com")) {
        committerResults.push(id);
      }
      expect(committerResults).toHaveLength(0);
    });

    it("handles large number of commits efficiently", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      // Create 100 commits
      for (let i = 0; i < 100; i++) {
        await commits.store({
          tree: emptyTreeId,
          parents: [],
          author: { ...alice, timestamp: alice.timestamp + i },
          committer: alice,
          message: `Commit ${i}`,
        });
      }

      const startTime = Date.now();
      const results: string[] = [];
      for await (const id of commits.findByAuthor("alice@example.com")) {
        results.push(id);
      }
      const elapsed = Date.now() - startTime;

      expect(results).toHaveLength(100);
      expect(elapsed).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  describe("findByDateRange", () => {
    it("returns empty iterator for range with no commits", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Commit",
      });

      const results: string[] = [];
      // Query for dates before our commit
      const since = new Date(1600000000 * 1000);
      const until = new Date(1600001000 * 1000);

      for await (const id of commits.findByDateRange(since, until)) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds commits within date range (inclusive)", async () => {
      // Create commits at specific timestamps
      const t1 = 1700000000; // Early
      const t2 = 1700100000; // Middle
      const t3 = 1700200000; // Late

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Alice", "alice@example.com", t1),
        committer: createPerson("Alice", "alice@example.com", t1),
        message: "Early commit",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Bob", "bob@example.com", t2),
        committer: createPerson("Bob", "bob@example.com", t2),
        message: "Middle commit",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Charlie", "charlie@example.com", t3),
        committer: createPerson("Charlie", "charlie@example.com", t3),
        message: "Late commit",
      });

      // Query for middle range (timestamps are in seconds, need to add full second for exclusion)
      const since = new Date((t1 + 1) * 1000); // 1 second after t1
      const until = new Date((t3 - 1) * 1000); // 1 second before t3

      const results: string[] = [];
      for await (const id of commits.findByDateRange(since, until)) {
        results.push(id);
      }

      expect(results).toHaveLength(1); // Only middle commit
    });

    it("includes boundary commits when range matches exactly", async () => {
      const timestamp = 1700000000;
      const alice = createPerson("Alice", "alice@example.com", timestamp);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Boundary commit",
      });

      const since = new Date(timestamp * 1000);
      const until = new Date(timestamp * 1000);

      const results: string[] = [];
      for await (const id of commits.findByDateRange(since, until)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
    });

    it("handles same since and until date", async () => {
      const timestamp = 1700000000;
      const alice = createPerson("Alice", "alice@example.com", timestamp);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Exact time commit",
      });

      const exactTime = new Date(timestamp * 1000);

      const results: string[] = [];
      for await (const id of commits.findByDateRange(exactTime, exactTime)) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
    });

    it("returns results ordered by timestamp (newest first)", async () => {
      const t1 = 1700000000;
      const t2 = 1700100000;
      const t3 = 1700200000;

      // Store in non-chronological order
      const _commit2 = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Bob", "bob@example.com", t2),
        committer: createPerson("Bob", "bob@example.com", t2),
        message: "Middle commit",
      });

      const commit1 = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Alice", "alice@example.com", t1),
        committer: createPerson("Alice", "alice@example.com", t1),
        message: "Early commit",
      });

      const commit3 = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Charlie", "charlie@example.com", t3),
        committer: createPerson("Charlie", "charlie@example.com", t3),
        message: "Late commit",
      });

      const since = new Date((t1 - 1) * 1000);
      const until = new Date((t3 + 1) * 1000);

      const results: string[] = [];
      for await (const id of commits.findByDateRange(since, until)) {
        results.push(id);
      }

      expect(results).toHaveLength(3);
      expect(results[0]).toBe(commit3); // Newest first
      expect(results[2]).toBe(commit1); // Oldest last
    });
  });

  describe("searchMessage", () => {
    it("returns empty iterator for no matching message", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Initial commit",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("nonexistent")) {
        results.push(id);
      }
      expect(results).toHaveLength(0);
    });

    it("finds commits by substring match", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Fix critical bug in authentication",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Add new feature",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("bug")) {
        results.push(id);
      }
      expect(results).toHaveLength(1);
    });

    it("matches partial words", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Implementing new authentication system",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("auth")) {
        results.push(id);
      }
      expect(results).toHaveLength(1);
    });

    it("is case-insensitive", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "FIX CRITICAL BUG",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("fix")) {
        results.push(id);
      }
      expect(results).toHaveLength(1);
    });

    it("handles special characters in search pattern", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Fix issue #123",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("#123")) {
        results.push(id);
      }
      expect(results).toHaveLength(1);
    });

    it("handles multi-line commit messages", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Short title\n\nLonger description with more details about the change",
      });

      // Search in title
      const titleResults: string[] = [];
      for await (const id of commits.searchMessage("title")) {
        titleResults.push(id);
      }
      expect(titleResults).toHaveLength(1);

      // Search in body
      const bodyResults: string[] = [];
      for await (const id of commits.searchMessage("description")) {
        bodyResults.push(id);
      }
      expect(bodyResults).toHaveLength(1);
    });

    it("returns all matching commits", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);
      const bob = createPerson("Bob", "bob@example.com", 1700000100);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Fix bug in login",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: bob,
        committer: bob,
        message: "Fix bug in checkout",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Add new feature",
      });

      const results: string[] = [];
      for await (const id of commits.searchMessage("Fix bug")) {
        results.push(id);
      }
      expect(results).toHaveLength(2);
    });
  });

  describe("count", () => {
    it("returns 0 for empty store", async () => {
      expect(await commits.count()).toBe(0);
    });

    it("returns correct count after adding commits", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Commit 1",
      });

      expect(await commits.count()).toBe(1);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Commit 2",
      });

      expect(await commits.count()).toBe(2);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Commit 3",
      });

      expect(await commits.count()).toBe(3);
    });
  });

  describe("getAncestors", () => {
    it("returns empty for commit with no parents", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      const commitId = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Root commit",
      });

      const ancestors: string[] = [];
      for await (const id of commits.getAncestors(commitId)) {
        ancestors.push(id);
      }
      expect(ancestors).toHaveLength(0);
    });

    it("returns parent for single-parent commit", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      const parent = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Parent commit",
      });

      const child = await commits.store({
        tree: emptyTreeId,
        parents: [parent],
        author: alice,
        committer: alice,
        message: "Child commit",
      });

      const ancestors: string[] = [];
      for await (const id of commits.getAncestors(child)) {
        ancestors.push(id);
      }
      expect(ancestors).toContain(parent);
    });

    it("returns direct parent in linear history", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      // Create linear chain: root -> c1 -> c2
      const root = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Root",
      });

      const c1 = await commits.store({
        tree: emptyTreeId,
        parents: [root],
        author: alice,
        committer: alice,
        message: "Commit 1",
      });

      const c2 = await commits.store({
        tree: emptyTreeId,
        parents: [c1],
        author: alice,
        committer: alice,
        message: "Commit 2",
      });

      const ancestors: string[] = [];
      for await (const id of commits.getAncestors(c2)) {
        ancestors.push(id);
      }

      // At minimum, should have direct parent
      expect(ancestors).toContain(c1);
      expect(ancestors).not.toContain(c2);
    });

    it("returns both direct parents for merge commits", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);

      // Create merge: root -> branch1 \
      //                               -> merge
      //               root -> branch2 /
      const root = await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Root",
      });

      const branch1 = await commits.store({
        tree: emptyTreeId,
        parents: [root],
        author: alice,
        committer: alice,
        message: "Branch 1",
      });

      const branch2 = await commits.store({
        tree: emptyTreeId,
        parents: [root],
        author: alice,
        committer: alice,
        message: "Branch 2",
      });

      const merge = await commits.store({
        tree: emptyTreeId,
        parents: [branch1, branch2],
        author: alice,
        committer: alice,
        message: "Merge commit",
      });

      const ancestors: string[] = [];
      for await (const id of commits.getAncestors(merge)) {
        ancestors.push(id);
      }

      // Should have both direct parents
      expect(ancestors).toContain(branch1);
      expect(ancestors).toContain(branch2);
    });

    it("throws error for non-existent commit", async () => {
      const nonExistent = "0000000000000000000000000000000000000000";

      await expect(async () => {
        const ancestors: string[] = [];
        for await (const id of commits.getAncestors(nonExistent)) {
          ancestors.push(id);
        }
      }).rejects.toThrow(/not found/);
    });
  });

  describe("Combined Queries", () => {
    it("can combine author and date range queries manually", async () => {
      const alice = createPerson("Alice", "alice@example.com", 1700000000);
      const bob = createPerson("Bob", "bob@example.com", 1700100000);
      const aliceLater = createPerson("Alice", "alice@example.com", 1700200000);

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: alice,
        committer: alice,
        message: "Alice early",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: bob,
        committer: bob,
        message: "Bob middle",
      });

      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: aliceLater,
        committer: aliceLater,
        message: "Alice late",
      });

      // Get all Alice commits
      const aliceCommits = new Set<string>();
      for await (const id of commits.findByAuthor("alice@example.com")) {
        aliceCommits.add(id);
      }

      // Get commits in date range
      const since = new Date(1700050000 * 1000);
      const until = new Date(1700250000 * 1000);

      const rangeCommits = new Set<string>();
      for await (const id of commits.findByDateRange(since, until)) {
        rangeCommits.add(id);
      }

      // Intersection: Alice commits in date range
      const aliceInRange = [...aliceCommits].filter((id) => rangeCommits.has(id));

      expect(aliceInRange).toHaveLength(1); // Only "Alice late"
    });

    it("handles empty results gracefully", async () => {
      // Query on empty store
      const authors: string[] = [];
      for await (const id of commits.findByAuthor("anyone@example.com")) {
        authors.push(id);
      }
      expect(authors).toHaveLength(0);

      const dates: string[] = [];
      for await (const id of commits.findByDateRange(new Date(0), new Date())) {
        dates.push(id);
      }
      expect(dates).toHaveLength(0);

      const messages: string[] = [];
      for await (const id of commits.searchMessage("anything")) {
        messages.push(id);
      }
      expect(messages).toHaveLength(0);

      expect(await commits.count()).toBe(0);
    });
  });
});
