/**
 * Tests for sql.js adapter
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";

describe("SqlJsAdapter", () => {
  let db: SqlJsAdapter;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Basic Operations", () => {
    it("creates a new database", async () => {
      expect(db).toBeDefined();
    });

    it("executes DDL statements", async () => {
      await db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test'",
      );
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("test");
    });

    it("inserts and queries data", async () => {
      await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

      const result = await db.execute("INSERT INTO users (name) VALUES (?)", ["Alice"]);
      expect(result.lastInsertRowId).toBe(1);
      expect(result.changes).toBe(1);

      const users = await db.query<{ id: number; name: string }>("SELECT * FROM users");
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe("Alice");
    });

    it("handles BLOB data", async () => {
      await db.execute("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)");

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await db.execute("INSERT INTO blobs (data) VALUES (?)", [data]);

      const rows = await db.query<{ data: Uint8Array }>("SELECT data FROM blobs");
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toEqual(data);
    });

    it("handles null values", async () => {
      await db.execute("CREATE TABLE nullable (id INTEGER PRIMARY KEY, value TEXT)");

      await db.execute("INSERT INTO nullable (value) VALUES (?)", [null]);

      const rows = await db.query<{ value: string | null }>("SELECT value FROM nullable");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBeNull();
    });

    it("handles boolean values", async () => {
      await db.execute("CREATE TABLE bools (id INTEGER PRIMARY KEY, flag INTEGER)");

      await db.execute("INSERT INTO bools (flag) VALUES (?)", [true]);
      await db.execute("INSERT INTO bools (flag) VALUES (?)", [false]);

      const rows = await db.query<{ flag: number }>("SELECT flag FROM bools ORDER BY id");
      expect(rows).toHaveLength(2);
      expect(rows[0].flag).toBe(1);
      expect(rows[1].flag).toBe(0);
    });
  });

  describe("Transactions", () => {
    it("commits successful transactions", async () => {
      await db.execute("CREATE TABLE tx_test (id INTEGER PRIMARY KEY, value TEXT)");

      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO tx_test (value) VALUES (?)", ["one"]);
        await tx.execute("INSERT INTO tx_test (value) VALUES (?)", ["two"]);
      });

      const rows = await db.query<{ value: string }>("SELECT value FROM tx_test ORDER BY id");
      expect(rows).toHaveLength(2);
      expect(rows[0].value).toBe("one");
      expect(rows[1].value).toBe("two");
    });

    it("rolls back failed transactions", async () => {
      await db.execute("CREATE TABLE tx_test (id INTEGER PRIMARY KEY, value TEXT)");

      try {
        await db.transaction(async (tx) => {
          await tx.execute("INSERT INTO tx_test (value) VALUES (?)", ["one"]);
          throw new Error("Simulated failure");
        });
      } catch {
        // Expected
      }

      const rows = await db.query<{ value: string }>("SELECT value FROM tx_test");
      expect(rows).toHaveLength(0);
    });

    it("supports nested transaction calls", async () => {
      await db.execute("CREATE TABLE tx_test (id INTEGER PRIMARY KEY, value TEXT)");

      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO tx_test (value) VALUES (?)", ["outer"]);

        // Nested transaction should use same transaction
        await tx.transaction(async (innerTx) => {
          await innerTx.execute("INSERT INTO tx_test (value) VALUES (?)", ["inner"]);
        });
      });

      const rows = await db.query<{ value: string }>("SELECT value FROM tx_test ORDER BY id");
      expect(rows).toHaveLength(2);
    });
  });

  describe("Export/Import", () => {
    it("exports database to Uint8Array", async () => {
      await db.execute("CREATE TABLE export_test (id INTEGER PRIMARY KEY, data TEXT)");
      await db.execute("INSERT INTO export_test (data) VALUES (?)", ["test data"]);

      const exported = db.export();
      expect(exported).toBeInstanceOf(Uint8Array);
      expect(exported.length).toBeGreaterThan(0);
    });

    it("imports database from Uint8Array", async () => {
      // Create and populate first database
      await db.execute("CREATE TABLE import_test (id INTEGER PRIMARY KEY, data TEXT)");
      await db.execute("INSERT INTO import_test (data) VALUES (?)", ["test data"]);
      const exported = db.export();
      await db.close();

      // Open new database from exported data
      const db2 = await SqlJsAdapter.open(exported);

      const rows = await db2.query<{ data: string }>("SELECT data FROM import_test");
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toBe("test data");

      await db2.close();
    });
  });
});
