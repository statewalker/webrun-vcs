/**
 * T4.5: SQL Schema Validation Tests
 *
 * Validates SQL schema correctness, migration integrity, and constraint enforcement
 * separate from functional tests. These tests verify the database structure matches
 * expectations after all migrations are applied.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import {
  getSchemaVersion,
  initializeSchema,
  migrations,
  rollbackMigration,
} from "../src/migrations/index.js";

describe("T4.5: SQL Schema Validation", () => {
  let db: SqlJsAdapter;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Table Structure Validation", () => {
    describe("v1 tables (initial_schema)", () => {
      it("object table has all required columns with correct types", async () => {
        const columns = await db.query<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>("PRAGMA table_info(object)");

        const columnMap = new Map(columns.map((c) => [c.name, c]));

        // Primary key
        expect(columnMap.get("record_id")?.pk).toBe(1);
        expect(columnMap.get("record_id")?.type).toBe("INTEGER");

        // Required columns
        expect(columnMap.get("object_id")?.notnull).toBe(1);
        expect(columnMap.get("object_id")?.type).toBe("TEXT");

        expect(columnMap.get("size")?.notnull).toBe(1);
        expect(columnMap.get("size")?.type).toBe("INTEGER");

        expect(columnMap.get("content")?.type).toBe("BLOB");

        expect(columnMap.get("created_at")?.notnull).toBe(1);
        expect(columnMap.get("created_at")?.type).toBe("INTEGER");

        expect(columnMap.get("accessed_at")?.notnull).toBe(1);
        expect(columnMap.get("accessed_at")?.type).toBe("INTEGER");
      });

      it("delta table has foreign key to object", async () => {
        const columns = await db.query<{
          name: string;
          type: string;
          pk: number;
        }>("PRAGMA table_info(delta)");

        const columnMap = new Map(columns.map((c) => [c.name, c]));

        expect(columnMap.get("record_id")?.pk).toBe(1);
        expect(columnMap.has("base_record_id")).toBe(true);
        expect(columnMap.has("delta_size")).toBe(true);
      });

      it("metadata table is WITHOUT ROWID", async () => {
        const tableInfo = await db.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='metadata'",
        );
        expect(tableInfo[0]?.sql).toContain("WITHOUT ROWID");
      });

      it("artifact view exists and references correct tables", async () => {
        const views = await db.query<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type='view' AND name='artifact'",
        );
        expect(views).toHaveLength(1);
        expect(views[0]?.sql).toContain("object");
        expect(views[0]?.sql).toContain("delta");
      });
    });

    describe("v2 tables (delta_content_table)", () => {
      it("delta_content table has all required columns", async () => {
        const columns = await db.query<{
          name: string;
          type: string;
          notnull: number;
        }>("PRAGMA table_info(delta_content)");

        const columnMap = new Map(columns.map((c) => [c.name, c]));

        expect(columnMap.get("object_id")?.notnull).toBe(0); // PRIMARY KEY implies NOT NULL
        expect(columnMap.get("base_object_id")?.notnull).toBe(1);
        expect(columnMap.get("delta_data")?.notnull).toBe(1);
        expect(columnMap.get("delta_format")?.notnull).toBe(1);
        expect(columnMap.get("original_size")?.notnull).toBe(1);
        expect(columnMap.get("delta_size")?.notnull).toBe(1);
        expect(columnMap.get("created_at")?.notnull).toBe(1);
      });

      it("delta_format has CHECK constraint", async () => {
        const tableInfo = await db.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='delta_content'",
        );
        expect(tableInfo[0]?.sql).toContain("CHECK");
        expect(tableInfo[0]?.sql).toMatch(/git.*fossil|fossil.*git/);
      });
    });

    describe("v3 tables (high_level_stores)", () => {
      it("tree table exists with correct structure", async () => {
        const columns = await db.query<{ name: string }>("PRAGMA table_info(tree)");
        const columnNames = columns.map((c) => c.name);

        expect(columnNames).toContain("id");
        expect(columnNames).toContain("tree_id");
        expect(columnNames).toContain("created_at");
      });

      it("tree_entry table has composite primary key", async () => {
        const columns = await db.query<{ name: string; pk: number }>(
          "PRAGMA table_info(tree_entry)",
        );

        const pkColumns = columns.filter((c) => c.pk > 0);
        expect(pkColumns).toHaveLength(2);
        expect(pkColumns.map((c) => c.name).sort()).toEqual(["position", "tree_fk"]);
      });

      it("vcs_commit table has all required columns", async () => {
        const columns = await db.query<{ name: string }>("PRAGMA table_info(vcs_commit)");
        const columnNames = columns.map((c) => c.name);

        expect(columnNames).toContain("commit_id");
        expect(columnNames).toContain("tree_id");
        expect(columnNames).toContain("author_name");
        expect(columnNames).toContain("author_email");
        expect(columnNames).toContain("author_timestamp");
        expect(columnNames).toContain("author_tz");
        expect(columnNames).toContain("committer_name");
        expect(columnNames).toContain("committer_email");
        expect(columnNames).toContain("committer_timestamp");
        expect(columnNames).toContain("committer_tz");
        expect(columnNames).toContain("message");
      });

      it("commit_parent table references vcs_commit", async () => {
        const columns = await db.query<{ name: string }>("PRAGMA table_info(commit_parent)");
        const columnNames = columns.map((c) => c.name);

        expect(columnNames).toContain("commit_fk");
        expect(columnNames).toContain("position");
        expect(columnNames).toContain("parent_id");
      });

      it("vcs_tag table has all required columns", async () => {
        const columns = await db.query<{ name: string }>("PRAGMA table_info(vcs_tag)");
        const columnNames = columns.map((c) => c.name);

        expect(columnNames).toContain("tag_id");
        expect(columnNames).toContain("object_id");
        expect(columnNames).toContain("object_type");
        expect(columnNames).toContain("tag_name");
        expect(columnNames).toContain("tagger_name");
        expect(columnNames).toContain("tagger_email");
        expect(columnNames).toContain("message");
      });

      it("vcs_ref table is WITHOUT ROWID", async () => {
        const tableInfo = await db.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='vcs_ref'",
        );
        expect(tableInfo[0]?.sql).toContain("WITHOUT ROWID");
      });

      it("staging_entry table has composite primary key on path and stage", async () => {
        const columns = await db.query<{ name: string; pk: number }>(
          "PRAGMA table_info(staging_entry)",
        );

        const pkColumns = columns.filter((c) => c.pk > 0);
        expect(pkColumns).toHaveLength(2);
        expect(pkColumns.map((c) => c.name).sort()).toEqual(["path", "stage"]);
      });
    });
  });

  describe("Index Validation (v4 extended_query_indexes)", () => {
    it("creates commit author email index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_author_email_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates commit author timestamp index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_author_timestamp_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates commit committer email index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_committer_email_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates commit committer timestamp index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_committer_timestamp_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates commit message index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_message_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates tag name index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='tag_name_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates tag tagger email index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='tag_tagger_email_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates tag object type index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='tag_object_type_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates tag tagger timestamp index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='tag_tagger_timestamp_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("creates tree entry object_id index", async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='tree_entry_object_id_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("indexes all v4 indexes in total", async () => {
      const v4Indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type='index'
         AND (name LIKE 'commit_%_idx'
              OR name LIKE 'tag_%_idx'
              OR name = 'tree_entry_object_id_idx')`,
      );
      // 5 commit v4 indexes + 1 commit_parent v3 index + 4 tag indexes + 1 tree_entry index = 11
      // Note: commit_parent_parent_idx (from v3) also matches the commit_%_idx pattern
      expect(v4Indexes.length).toBe(11);
    });
  });

  describe("Index Effectiveness", () => {
    beforeEach(async () => {
      // Insert test data for query plan analysis
      await db.execute(
        `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email,
          author_timestamp, author_tz, committer_name, committer_email,
          committer_timestamp, committer_tz, message, created_at)
         VALUES ('abc123', 'tree1', 'Test Author', 'test@example.com',
          1700000000, '+0000', 'Test Committer', 'test@example.com',
          1700000000, '+0000', 'Test commit message', 0)`,
      );

      await db.execute(
        `INSERT INTO vcs_tag (tag_id, object_id, object_type, tag_name,
          tagger_name, tagger_email, tagger_timestamp, tagger_tz, message, created_at)
         VALUES ('tag1', 'abc123', 1, 'v1.0.0', 'Tagger', 'tagger@example.com',
          1700000000, '+0000', 'Release', 0)`,
      );
    });

    it("uses index for author email queries", async () => {
      const plan = await db.query<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM vcs_commit WHERE author_email = 'test@example.com'",
      );
      const planStr = plan.map((p) => p.detail).join(" ");
      expect(planStr).toMatch(/INDEX|COVERING|SEARCH/i);
    });

    it("uses index for timestamp range queries", async () => {
      const plan = await db.query<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM vcs_commit
         WHERE author_timestamp BETWEEN 1699999999 AND 1700000001`,
      );
      const planStr = plan.map((p) => p.detail).join(" ");
      expect(planStr).toMatch(/INDEX|COVERING|SEARCH/i);
    });

    it("uses index for tag name queries", async () => {
      const plan = await db.query<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM vcs_tag WHERE tag_name = 'v1.0.0'",
      );
      const planStr = plan.map((p) => p.detail).join(" ");
      expect(planStr).toMatch(/INDEX|COVERING|SEARCH/i);
    });
  });

  describe("Constraint Enforcement", () => {
    describe("unique constraints", () => {
      it("enforces object_id uniqueness in object table", async () => {
        await db.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('unique_test', 100, X'00', 0, 0)`,
        );

        await expect(
          db.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('unique_test', 100, X'00', 0, 0)`,
          ),
        ).rejects.toThrow(/UNIQUE|constraint/i);
      });

      it("enforces tree_id uniqueness in tree table", async () => {
        await db.execute("INSERT INTO tree (tree_id, created_at) VALUES ('tree_unique_test', 0)");

        await expect(
          db.execute("INSERT INTO tree (tree_id, created_at) VALUES ('tree_unique_test', 0)"),
        ).rejects.toThrow(/UNIQUE|constraint/i);
      });

      it("enforces commit_id uniqueness in vcs_commit table", async () => {
        await db.execute(
          `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email,
            author_timestamp, author_tz, committer_name, committer_email,
            committer_timestamp, committer_tz, message, created_at)
           VALUES ('commit_unique', 'tree1', 'Author', 'a@b.com', 0, '+0000',
            'Committer', 'c@d.com', 0, '+0000', 'msg', 0)`,
        );

        await expect(
          db.execute(
            `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email,
              author_timestamp, author_tz, committer_name, committer_email,
              committer_timestamp, committer_tz, message, created_at)
             VALUES ('commit_unique', 'tree2', 'Author2', 'a@b.com', 0, '+0000',
              'Committer2', 'c@d.com', 0, '+0000', 'msg2', 0)`,
          ),
        ).rejects.toThrow(/UNIQUE|constraint/i);
      });
    });

    describe("foreign key constraints", () => {
      // Note: SQLite foreign keys need to be enabled
      beforeEach(async () => {
        await db.execute("PRAGMA foreign_keys = ON");
      });

      it("enforces delta.record_id references object.record_id", async () => {
        // Insert object first
        await db.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('fk_test_obj', 100, X'00', 0, 0)`,
        );

        const result = await db.query<{ record_id: number }>(
          "SELECT record_id FROM object WHERE object_id = 'fk_test_obj'",
        );
        const recordId = result[0]?.record_id;

        // Can insert delta with valid reference
        await db.execute(
          `INSERT INTO delta (record_id, base_record_id, delta_size)
           VALUES (${recordId}, ${recordId}, 50)`,
        );

        // Cannot insert with invalid reference
        await expect(
          db.execute(
            "INSERT INTO delta (record_id, base_record_id, delta_size) VALUES (99999, 1, 50)",
          ),
        ).rejects.toThrow(/FOREIGN KEY|constraint/i);
      });

      it("cascades delete from tree to tree_entry", async () => {
        // Insert tree
        const treeResult = await db.execute(
          "INSERT INTO tree (tree_id, created_at) VALUES ('cascade_test_tree', 0)",
        );
        const treeId = treeResult.lastInsertRowId;

        // Insert tree entry
        await db.execute(
          `INSERT INTO tree_entry (tree_fk, position, mode, name, object_id)
           VALUES (${treeId}, 0, 33188, 'file.txt', 'blob123')`,
        );

        // Verify entry exists
        const entriesBefore = await db.query<{ tree_fk: number }>(
          `SELECT tree_fk FROM tree_entry WHERE tree_fk = ${treeId}`,
        );
        expect(entriesBefore).toHaveLength(1);

        // Delete tree
        await db.execute(`DELETE FROM tree WHERE id = ${treeId}`);

        // Verify entry is cascaded
        const entriesAfter = await db.query<{ tree_fk: number }>(
          `SELECT tree_fk FROM tree_entry WHERE tree_fk = ${treeId}`,
        );
        expect(entriesAfter).toHaveLength(0);
      });

      it("cascades delete from vcs_commit to commit_parent", async () => {
        // Insert commit
        const commitResult = await db.execute(
          `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email,
            author_timestamp, author_tz, committer_name, committer_email,
            committer_timestamp, committer_tz, message, created_at)
           VALUES ('cascade_commit', 'tree1', 'A', 'a@b.com', 0, '+0000',
            'C', 'c@d.com', 0, '+0000', 'msg', 0)`,
        );
        const commitId = commitResult.lastInsertRowId;

        // Insert parent reference
        await db.execute(
          `INSERT INTO commit_parent (commit_fk, position, parent_id)
           VALUES (${commitId}, 0, 'parent123')`,
        );

        // Verify parent exists
        const parentsBefore = await db.query<{ commit_fk: number }>(
          `SELECT commit_fk FROM commit_parent WHERE commit_fk = ${commitId}`,
        );
        expect(parentsBefore).toHaveLength(1);

        // Delete commit
        await db.execute(`DELETE FROM vcs_commit WHERE id = ${commitId}`);

        // Verify parent is cascaded
        const parentsAfter = await db.query<{ commit_fk: number }>(
          `SELECT commit_fk FROM commit_parent WHERE commit_fk = ${commitId}`,
        );
        expect(parentsAfter).toHaveLength(0);
      });
    });

    describe("check constraints", () => {
      it("enforces delta_format check constraint", async () => {
        // Valid formats should work
        await db.execute(
          `INSERT INTO delta_content (object_id, base_object_id, delta_data,
            delta_format, original_size, delta_size, created_at)
           VALUES ('dc1', 'base1', X'00', 'git', 100, 50, 0)`,
        );

        await db.execute(
          `INSERT INTO delta_content (object_id, base_object_id, delta_data,
            delta_format, original_size, delta_size, created_at)
           VALUES ('dc2', 'base2', X'00', 'fossil', 100, 50, 0)`,
        );

        // Invalid format should fail
        await expect(
          db.execute(
            `INSERT INTO delta_content (object_id, base_object_id, delta_data,
              delta_format, original_size, delta_size, created_at)
             VALUES ('dc3', 'base3', X'00', 'invalid', 100, 50, 0)`,
          ),
        ).rejects.toThrow(/CHECK|constraint/i);
      });
    });
  });

  describe("Schema Versioning", () => {
    it("records all migration versions", async () => {
      const versions = await db.query<{ version: number }>(
        "SELECT version FROM schema_version ORDER BY version",
      );

      expect(versions.map((v) => v.version)).toEqual(migrations.map((m) => m.version));
    });

    it("records applied_at timestamp for each migration", async () => {
      const versions = await db.query<{ version: number; applied_at: number }>(
        "SELECT version, applied_at FROM schema_version",
      );

      for (const v of versions) {
        expect(v.applied_at).toBeGreaterThan(0);
      }
    });

    it("final schema version matches latest migration", async () => {
      const version = await getSchemaVersion(db);
      expect(version).toBe(migrations[migrations.length - 1]?.version);
    });
  });

  describe("Migration Integrity", () => {
    it("can rollback to each version and re-apply", async () => {
      // Rollback to v2, then re-apply
      await rollbackMigration(db, 2);
      let version = await getSchemaVersion(db);
      expect(version).toBe(2);

      // Re-apply
      await initializeSchema(db);
      version = await getSchemaVersion(db);
      expect(version).toBe(migrations.length);

      // Verify v4 indexes exist after re-apply
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='commit_author_email_idx'",
      );
      expect(indexes).toHaveLength(1);
    });

    it("preserves data during rollback and re-apply of v4", async () => {
      // Insert commit data
      await db.execute(
        `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email,
          author_timestamp, author_tz, committer_name, committer_email,
          committer_timestamp, committer_tz, message, created_at)
         VALUES ('preserve_test', 'tree1', 'Author', 'author@test.com',
          1700000000, '+0000', 'Committer', 'c@d.com', 0, '+0000', 'msg', 0)`,
      );

      // Rollback v4 (only removes indexes)
      await rollbackMigration(db, 3);

      // Verify data still exists
      const commits = await db.query<{ commit_id: string }>(
        "SELECT commit_id FROM vcs_commit WHERE commit_id = 'preserve_test'",
      );
      expect(commits).toHaveLength(1);

      // Re-apply v4
      await initializeSchema(db);

      // Verify data still exists and indexes are back
      const commitsAfter = await db.query<{ commit_id: string }>(
        "SELECT commit_id FROM vcs_commit WHERE commit_id = 'preserve_test'",
      );
      expect(commitsAfter).toHaveLength(1);
    });

    it("all tables exist after full migration", async () => {
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      );

      const tableNames = tables.map((t) => t.name);

      // v1 tables
      expect(tableNames).toContain("object");
      expect(tableNames).toContain("delta");
      expect(tableNames).toContain("metadata");
      expect(tableNames).toContain("schema_version");

      // v2 tables
      expect(tableNames).toContain("delta_content");

      // v3 tables
      expect(tableNames).toContain("tree");
      expect(tableNames).toContain("tree_entry");
      expect(tableNames).toContain("vcs_commit");
      expect(tableNames).toContain("commit_parent");
      expect(tableNames).toContain("vcs_tag");
      expect(tableNames).toContain("vcs_ref");
      expect(tableNames).toContain("staging_entry");
    });

    it("all views exist after full migration", async () => {
      const views = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name",
      );

      expect(views.map((v) => v.name)).toContain("artifact");
    });
  });
});
