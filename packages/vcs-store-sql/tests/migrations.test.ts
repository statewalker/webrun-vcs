/**
 * Tests for schema migrations
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import {
  getSchemaVersion,
  initializeSchema,
  migrations,
  rollbackMigration,
} from "../src/migrations/index.js";

describe("Schema Migrations", () => {
  let db: SqlJsAdapter;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("initializeSchema", () => {
    it("creates schema_version table", async () => {
      await initializeSchema(db);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      );
      expect(tables).toHaveLength(1);
    });

    it("creates object table", async () => {
      await initializeSchema(db);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='object'",
      );
      expect(tables).toHaveLength(1);
    });

    it("creates delta table", async () => {
      await initializeSchema(db);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='delta'",
      );
      expect(tables).toHaveLength(1);
    });

    it("creates metadata table", async () => {
      await initializeSchema(db);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
      );
      expect(tables).toHaveLength(1);
    });

    it("creates artifact view", async () => {
      await initializeSchema(db);

      const views = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='view' AND name='artifact'",
      );
      expect(views).toHaveLength(1);
    });

    it("creates indexes", async () => {
      await initializeSchema(db);

      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%idx'",
      );
      expect(indexes.length).toBeGreaterThanOrEqual(2);
    });

    it("records migration version", async () => {
      await initializeSchema(db);

      const version = await getSchemaVersion(db);
      expect(version).toBe(migrations.length);
    });

    it("is idempotent", async () => {
      await initializeSchema(db);
      await initializeSchema(db);
      await initializeSchema(db);

      const version = await getSchemaVersion(db);
      expect(version).toBe(migrations.length);
    });
  });

  describe("getSchemaVersion", () => {
    it("returns 0 for empty database", async () => {
      const version = await getSchemaVersion(db);
      expect(version).toBe(0);
    });

    it("returns current version after migration", async () => {
      await initializeSchema(db);
      const version = await getSchemaVersion(db);
      expect(version).toBeGreaterThan(0);
    });
  });

  describe("rollbackMigration", () => {
    it("rolls back to previous version", async () => {
      await initializeSchema(db);

      const versionBefore = await getSchemaVersion(db);
      expect(versionBefore).toBeGreaterThan(0);

      await rollbackMigration(db, 0);

      const versionAfter = await getSchemaVersion(db);
      expect(versionAfter).toBe(0);
    });

    it("removes tables when rolling back", async () => {
      await initializeSchema(db);

      await rollbackMigration(db, 0);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='object'",
      );
      expect(tables).toHaveLength(0);
    });

    it("can re-apply migrations after rollback", async () => {
      await initializeSchema(db);
      await rollbackMigration(db, 0);
      await initializeSchema(db);

      const version = await getSchemaVersion(db);
      expect(version).toBe(migrations.length);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='object'",
      );
      expect(tables).toHaveLength(1);
    });
  });

  describe("Schema Correctness", () => {
    it("object table has correct columns", async () => {
      await initializeSchema(db);

      const columns = await db.query<{ name: string }>("PRAGMA table_info(object)");
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toContain("record_id");
      expect(columnNames).toContain("object_id");
      expect(columnNames).toContain("size");
      expect(columnNames).toContain("content");
      expect(columnNames).toContain("created_at");
      expect(columnNames).toContain("accessed_at");
    });

    it("delta table has correct columns", async () => {
      await initializeSchema(db);

      const columns = await db.query<{ name: string }>("PRAGMA table_info(delta)");
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toContain("record_id");
      expect(columnNames).toContain("base_record_id");
      expect(columnNames).toContain("delta_size");
    });

    it("metadata table has correct columns", async () => {
      await initializeSchema(db);

      const columns = await db.query<{ name: string }>("PRAGMA table_info(metadata)");
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toContain("object_id");
      expect(columnNames).toContain("access_count");
      expect(columnNames).toContain("is_hot");
      expect(columnNames).toContain("total_size");
    });

    it("object_id has unique constraint", async () => {
      await initializeSchema(db);

      await db.execute(
        `INSERT INTO object (object_id, size, content, created_at, accessed_at)
         VALUES ('test123', 100, X'00', 0, 0)`,
      );

      await expect(
        db.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('test123', 100, X'00', 0, 0)`,
        ),
      ).rejects.toThrow();
    });
  });
});
