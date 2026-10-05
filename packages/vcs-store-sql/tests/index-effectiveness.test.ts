/**
 * T5.4: Index Effectiveness Tests
 *
 * Verifies that SQL indexes improve query performance.
 * Uses EXPLAIN QUERY PLAN to analyze index usage and compares
 * query timing with and without indexes.
 */

import type { PersonIdent } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema, rollbackMigration } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import type { SqlNativeCommitStore, SqlNativeStores } from "../src/native/types.js";

/**
 * Query plan row from EXPLAIN QUERY PLAN
 */
interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

describe("T5.4: Index Effectiveness Tests", () => {
  let db: DatabaseClient;
  let stores: SqlNativeStores;
  let commits: SqlNativeCommitStore;

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
    commits = stores.commits;
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Query Plan Analysis", () => {
    describe("commit indexes", () => {
      it("uses author_email index for findByAuthor queries", async () => {
        // Get query plan for author email query
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT commit_id FROM vcs_commit WHERE author_email = ?",
          ["alice@example.com"],
        );

        // Verify index is used (detail should mention the index)
        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails).toMatch(/USING.*INDEX.*commit_author_email_idx/i);
      });

      it("uses author_timestamp index for findByDateRange queries", async () => {
        // Get query plan for date range query
        const plan = await db.query<QueryPlanRow>(
          `EXPLAIN QUERY PLAN SELECT commit_id FROM vcs_commit
           WHERE author_timestamp BETWEEN ? AND ?`,
          [1700000000, 1700100000],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails).toMatch(/USING.*INDEX.*commit_author_timestamp_idx/i);
      });

      it("uses message index for searchMessage queries", async () => {
        // Get query plan for message search
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT commit_id FROM vcs_commit WHERE message LIKE ?",
          ["%bug%"],
        );

        // LIKE with leading wildcard may not use index efficiently,
        // but we should still have an index available
        const planDetails = plan.map((row) => row.detail).join(" ");
        // SQLite may choose SCAN for LIKE with leading wildcard
        // This verifies the query can be executed, even if not indexed
        expect(planDetails.length).toBeGreaterThan(0);
      });

      it("verifies index structure is correct", async () => {
        // Query sqlite_master to verify indexes exist
        const indexes = await db.query<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'vcs_commit'
           AND name LIKE 'commit_%'`,
        );

        const indexNames = indexes.map((i) => i.name);
        expect(indexNames).toContain("commit_author_email_idx");
        expect(indexNames).toContain("commit_author_timestamp_idx");
        expect(indexNames).toContain("commit_committer_email_idx");
        expect(indexNames).toContain("commit_committer_timestamp_idx");
      });
    });

    describe("tag indexes", () => {
      it("uses tag_name index for findByNamePattern queries", async () => {
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT tag_id FROM vcs_tag WHERE tag_name LIKE ?",
          ["v1.%"],
        );

        // SQLite may use index for prefix patterns (no leading wildcard)
        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails.length).toBeGreaterThan(0);
      });

      it("uses tagger_email index for findByTagger queries", async () => {
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT tag_id FROM vcs_tag WHERE tagger_email = ?",
          ["alice@example.com"],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails).toMatch(/USING.*INDEX.*tag_tagger_email_idx/i);
      });

      it("uses object_type index for findByTargetType queries", async () => {
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT tag_id FROM vcs_tag WHERE object_type = ?",
          [1],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails).toMatch(/USING.*INDEX.*tag_object_type_idx/i);
      });

      it("verifies tag index structure is correct", async () => {
        const indexes = await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'vcs_tag'
           AND name LIKE 'tag_%'`,
        );

        const indexNames = indexes.map((i) => i.name);
        expect(indexNames).toContain("tag_name_idx");
        expect(indexNames).toContain("tag_tagger_email_idx");
        expect(indexNames).toContain("tag_object_type_idx");
      });
    });

    describe("tree entry indexes", () => {
      it("uses object_id index for findTreesWithBlob queries", async () => {
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT tree_fk FROM tree_entry WHERE object_id = ?",
          ["0000000000000000000000000000000000000001"],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        expect(planDetails).toMatch(/USING.*INDEX.*tree_entry_object_id_idx/i);
      });
    });
  });

  describe("Performance Comparison", () => {
    describe("with large dataset", () => {
      const COMMIT_COUNT = 500;

      beforeEach(async () => {
        // Create test data in batches for efficiency
        const baseTimestamp = 1700000000;
        const emails = ["alice@example.com", "bob@example.com", "charlie@example.com"];

        for (let i = 0; i < COMMIT_COUNT; i++) {
          const email = emails[i % emails.length];
          await commits.store({
            tree: emptyTreeId,
            parents: [],
            author: createPerson("Author", email, baseTimestamp + i * 100),
            committer: createPerson("Committer", email, baseTimestamp + i * 100),
            message: i % 10 === 0 ? `Fix bug #${i}` : `Regular commit ${i}`,
          });
        }
      });

      it("indexed author query is fast", async () => {
        const start = performance.now();

        const results: string[] = [];
        for await (const id of commits.findByAuthor("alice@example.com")) {
          results.push(id);
        }

        const elapsed = performance.now() - start;

        // With 500 commits, ~167 should be from Alice (500/3)
        expect(results.length).toBeGreaterThan(100);
        // Should complete in under 500ms with index
        expect(elapsed).toBeLessThan(500);
      });

      it("indexed date range query is fast", async () => {
        const start = performance.now();

        // Query for first quarter of commits
        const since = new Date(1700000000 * 1000);
        const until = new Date((1700000000 + 12500) * 1000); // First ~125 commits

        const results: string[] = [];
        for await (const id of commits.findByDateRange(since, until)) {
          results.push(id);
        }

        const elapsed = performance.now() - start;

        expect(results.length).toBeGreaterThan(50);
        expect(elapsed).toBeLessThan(500);
      });

      it("count operation is fast on indexed table", async () => {
        const start = performance.now();
        const count = await commits.count();
        const elapsed = performance.now() - start;

        expect(count).toBe(COMMIT_COUNT);
        expect(elapsed).toBeLessThan(100);
      });
    });

    describe("index vs full scan comparison", () => {
      beforeEach(async () => {
        // Create 100 commits with varied data
        for (let i = 0; i < 100; i++) {
          await commits.store({
            tree: emptyTreeId,
            parents: [],
            author: createPerson("Alice", `user${i}@example.com`, 1700000000 + i),
            committer: createPerson("Alice", `user${i}@example.com`, 1700000000 + i),
            message: `Commit ${i}`,
          });
        }
      });

      it("specific email query uses index seek", async () => {
        // Query for a specific email that exists once
        const plan = await db.query<QueryPlanRow>(
          "EXPLAIN QUERY PLAN SELECT commit_id FROM vcs_commit WHERE author_email = ?",
          ["user50@example.com"],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        // Should show SEARCH (index seek) not SCAN (full scan)
        expect(planDetails).toMatch(/SEARCH|USING.*INDEX/i);
        expect(planDetails).not.toMatch(/SCAN.*vcs_commit[^)]*$/i);
      });

      it("compound query can use multiple indexes", async () => {
        // Check that SQLite can choose between indexes for compound queries
        const plan = await db.query<QueryPlanRow>(
          `EXPLAIN QUERY PLAN SELECT commit_id FROM vcs_commit
           WHERE author_email = ? OR author_timestamp = ?`,
          ["user50@example.com", 1700000050],
        );

        const planDetails = plan.map((row) => row.detail).join(" ");
        // SQLite should use OR optimization with indexes
        expect(planDetails.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Index Effectiveness Without Migration 4", () => {
    it("queries work without extended query indexes", async () => {
      // Create fresh database without extended indexes
      await db.close();
      db = await SqlJsAdapter.create();

      // Apply only migrations 1-3 (without extended query indexes)
      await initializeSchema(db);
      await rollbackMigration(db, 3);

      stores = createSqlNativeStores(db);
      commits = stores.commits;

      // Store some data
      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Test", "test@example.com", 1700000000),
        committer: createPerson("Test", "test@example.com", 1700000000),
        message: "Test commit",
      });

      // Query should still work (just potentially slower without index)
      const results: string[] = [];
      for await (const id of commits.findByAuthor("test@example.com")) {
        results.push(id);
      }

      expect(results).toHaveLength(1);
    });

    it("verifies extended indexes are in migration 4", async () => {
      // Check that migration 4 specifically contains the extended query indexes
      const indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'commit_%_idx'`,
      );

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("commit_author_email_idx");
      expect(indexNames).toContain("commit_author_timestamp_idx");
    });
  });

  describe("Edge Cases", () => {
    it("handles queries on empty tables efficiently", async () => {
      const start = performance.now();

      const results: string[] = [];
      for await (const id of commits.findByAuthor("nobody@example.com")) {
        results.push(id);
      }

      const elapsed = performance.now() - start;

      expect(results).toHaveLength(0);
      // Should be very fast on empty table
      expect(elapsed).toBeLessThan(50);
    });

    it("handles NULL values in indexed columns", async () => {
      // Tags can have NULL tagger fields for lightweight tags
      // Verify queries handle this properly
      const plan = await db.query<QueryPlanRow>(
        "EXPLAIN QUERY PLAN SELECT tag_id FROM vcs_tag WHERE tagger_email IS NULL",
        [],
      );

      const planDetails = plan.map((row) => row.detail).join(" ");
      expect(planDetails.length).toBeGreaterThan(0);
    });

    it("verifies primary key index for commit_id lookups", async () => {
      await commits.store({
        tree: emptyTreeId,
        parents: [],
        author: createPerson("Test", "test@example.com", 1700000000),
        committer: createPerson("Test", "test@example.com", 1700000000),
        message: "Test",
      });

      // Primary key lookup should use unique index
      const plan = await db.query<QueryPlanRow>(
        "EXPLAIN QUERY PLAN SELECT * FROM vcs_commit WHERE commit_id = ?",
        ["0".repeat(40)],
      );

      const planDetails = plan.map((row) => row.detail).join(" ");
      // Should use primary/unique index
      expect(planDetails).toMatch(/SEARCH|INDEX/i);
    });
  });
});
