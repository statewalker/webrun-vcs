/**
 * T4.7: SQL Transaction Tests
 *
 * Tests transaction handling for SQL storage backend:
 * - Atomicity: commits all changes or none
 * - Isolation: concurrent operations see consistent state
 * - Batch operations: multiple stores within single transaction
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { initializeSchema } from "../src/migrations/index.js";

describe("T4.7: SQL Transactions", () => {
  let db: SqlJsAdapter;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Atomicity", () => {
    it("commits all changes when transaction succeeds", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('obj1', 100, X'00', 0, 0)`,
        );
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('obj2', 200, X'01', 0, 0)`,
        );
      });

      const objects = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id IN ('obj1', 'obj2') ORDER BY object_id",
      );

      expect(objects).toHaveLength(2);
      expect(objects[0]?.object_id).toBe("obj1");
      expect(objects[1]?.object_id).toBe("obj2");
    });

    it("rolls back all changes on error", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('rollback_test1', 100, X'00', 0, 0)`,
          );
          // This should fail due to duplicate
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('rollback_test1', 200, X'01', 0, 0)`,
          );
        }),
      ).rejects.toThrow();

      // First insert should be rolled back
      const objects = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'rollback_test1'",
      );

      expect(objects).toHaveLength(0);
    });

    it("rolls back on application error", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('app_error_test', 100, X'00', 0, 0)`,
          );
          throw new Error("Application error");
        }),
      ).rejects.toThrow("Application error");

      // Insert should be rolled back
      const objects = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'app_error_test'",
      );

      expect(objects).toHaveLength(0);
    });

    it("commits partial work before error is not visible", async () => {
      // Insert a valid object first (outside transaction)
      await db.execute(
        `INSERT INTO object (object_id, size, content, created_at, accessed_at)
         VALUES ('pre_existing', 100, X'00', 0, 0)`,
      );

      await expect(
        db.transaction(async (tx) => {
          // Update existing object
          await tx.execute("UPDATE object SET size = 999 WHERE object_id = 'pre_existing'");
          // Insert new object
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('new_in_tx', 200, X'01', 0, 0)`,
          );
          // Fail
          throw new Error("Rollback everything");
        }),
      ).rejects.toThrow("Rollback everything");

      // Original object should have original size
      const objects = await db.query<{ object_id: string; size: number }>(
        "SELECT object_id, size FROM object WHERE object_id = 'pre_existing'",
      );

      expect(objects).toHaveLength(1);
      expect(objects[0]?.size).toBe(100);

      // New object should not exist
      const newObjects = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'new_in_tx'",
      );

      expect(newObjects).toHaveLength(0);
    });
  });

  describe("Isolation", () => {
    it("reads committed data outside transaction", async () => {
      await db.execute(
        `INSERT INTO object (object_id, size, content, created_at, accessed_at)
         VALUES ('committed_obj', 100, X'00', 0, 0)`,
      );

      const result = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'committed_obj'",
      );

      expect(result).toHaveLength(1);
    });

    it("transaction sees its own uncommitted changes", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('uncommitted_obj', 100, X'00', 0, 0)`,
        );

        // Within same transaction, we can see the inserted object
        const result = await tx.query<{ object_id: string }>(
          "SELECT object_id FROM object WHERE object_id = 'uncommitted_obj'",
        );

        expect(result).toHaveLength(1);
      });
    });

    it("nested query within transaction sees current state", async () => {
      await db.transaction(async (tx) => {
        // Insert first object
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('nested1', 100, X'00', 0, 0)`,
        );

        // Query current count
        const count1 = await tx.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM object");

        // Insert second object
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('nested2', 200, X'01', 0, 0)`,
        );

        // Query updated count
        const count2 = await tx.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM object");

        expect(count2[0]?.cnt).toBe(count1[0]?.cnt + 1);
      });
    });
  });

  describe("Batch Operations", () => {
    it("batches multiple stores in single transaction", async () => {
      await db.transaction(async (tx) => {
        // Store multiple objects
        for (let i = 0; i < 10; i++) {
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('batch_obj_${i}', ${i * 100}, X'00', 0, 0)`,
          );
        }
      });

      const count = await db.query<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM object WHERE object_id LIKE 'batch_obj_%'",
      );

      expect(count[0]?.cnt).toBe(10);
    });

    it("maintains integrity across batch inserts", async () => {
      await db.transaction(async (tx) => {
        // Insert tree
        const treeResult = await tx.execute(
          "INSERT INTO tree (tree_id, created_at) VALUES ('batch_tree', 0)",
        );
        const treeId = treeResult.lastInsertRowId;

        // Insert multiple tree entries referencing the tree
        for (let i = 0; i < 5; i++) {
          await tx.execute(
            `INSERT INTO tree_entry (tree_fk, position, mode, name, object_id)
             VALUES (${treeId}, ${i}, 33188, 'file${i}.txt', 'blob${i}')`,
          );
        }
      });

      // Verify all entries exist
      const entries = await db.query<{ name: string }>(
        `SELECT te.name FROM tree_entry te
         JOIN tree t ON te.tree_fk = t.id
         WHERE t.tree_id = 'batch_tree'
         ORDER BY te.position`,
      );

      expect(entries).toHaveLength(5);
      expect(entries.map((e) => e.name)).toEqual([
        "file0.txt",
        "file1.txt",
        "file2.txt",
        "file3.txt",
        "file4.txt",
      ]);
    });

    it("rolls back entire batch on partial failure", async () => {
      await expect(
        db.transaction(async (tx) => {
          // Insert several valid objects
          for (let i = 0; i < 5; i++) {
            await tx.execute(
              `INSERT INTO object (object_id, size, content, created_at, accessed_at)
               VALUES ('partial_batch_${i}', ${i * 100}, X'00', 0, 0)`,
            );
          }

          // Try to insert duplicate (should fail)
          await tx.execute(
            `INSERT INTO object (object_id, size, content, created_at, accessed_at)
             VALUES ('partial_batch_0', 999, X'01', 0, 0)`,
          );
        }),
      ).rejects.toThrow();

      // None of the batch inserts should exist
      const count = await db.query<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM object WHERE object_id LIKE 'partial_batch_%'",
      );

      expect(count[0]?.cnt).toBe(0);
    });

    it("handles mixed operations (insert, update, delete) in batch", async () => {
      // Setup: create initial object
      await db.execute(
        `INSERT INTO object (object_id, size, content, created_at, accessed_at)
         VALUES ('mixed_existing', 100, X'00', 0, 0)`,
      );

      await db.transaction(async (tx) => {
        // Insert new
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('mixed_new', 200, X'01', 0, 0)`,
        );

        // Update existing
        await tx.execute("UPDATE object SET size = 999 WHERE object_id = 'mixed_existing'");

        // Delete (requires inserting another object first)
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('mixed_to_delete', 300, X'02', 0, 0)`,
        );
        await tx.execute("DELETE FROM object WHERE object_id = 'mixed_to_delete'");
      });

      // Verify final state
      const existing = await db.query<{ size: number }>(
        "SELECT size FROM object WHERE object_id = 'mixed_existing'",
      );
      expect(existing[0]?.size).toBe(999);

      const newObj = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'mixed_new'",
      );
      expect(newObj).toHaveLength(1);

      const deleted = await db.query<{ object_id: string }>(
        "SELECT object_id FROM object WHERE object_id = 'mixed_to_delete'",
      );
      expect(deleted).toHaveLength(0);
    });
  });

  describe("Transaction Return Values", () => {
    it("returns value from transaction function", async () => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('return_test', 100, X'00', 0, 0)`,
        );

        const rows = await tx.query<{ object_id: string }>(
          "SELECT object_id FROM object WHERE object_id = 'return_test'",
        );

        return rows[0]?.object_id;
      });

      expect(result).toBe("return_test");
    });

    it("returns execute result from transaction", async () => {
      const result = await db.transaction(async (tx) => {
        const insertResult = await tx.execute(
          `INSERT INTO object (object_id, size, content, created_at, accessed_at)
           VALUES ('insert_result_test', 100, X'00', 0, 0)`,
        );
        return insertResult;
      });

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowId).toBeGreaterThan(0);
    });
  });

  describe("Foreign Key Transactions", () => {
    beforeEach(async () => {
      await db.execute("PRAGMA foreign_keys = ON");
    });

    it("enforces foreign keys within transaction", async () => {
      await expect(
        db.transaction(async (tx) => {
          // Try to insert tree_entry with invalid tree_fk
          await tx.execute(
            `INSERT INTO tree_entry (tree_fk, position, mode, name, object_id)
             VALUES (99999, 0, 33188, 'orphan.txt', 'blob123')`,
          );
        }),
      ).rejects.toThrow(/FOREIGN KEY|constraint/i);
    });

    it("allows valid foreign key inserts in transaction", async () => {
      await db.transaction(async (tx) => {
        const treeResult = await tx.execute(
          "INSERT INTO tree (tree_id, created_at) VALUES ('fk_valid_tree', 0)",
        );
        const treeId = treeResult.lastInsertRowId;

        await tx.execute(
          `INSERT INTO tree_entry (tree_fk, position, mode, name, object_id)
           VALUES (${treeId}, 0, 33188, 'valid.txt', 'blob123')`,
        );
      });

      const entries = await db.query<{ name: string }>(
        `SELECT te.name FROM tree_entry te
         JOIN tree t ON te.tree_fk = t.id
         WHERE t.tree_id = 'fk_valid_tree'`,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe("valid.txt");
    });

    it("cascades delete within transaction", async () => {
      let treeId: number;

      await db.transaction(async (tx) => {
        const treeResult = await tx.execute(
          "INSERT INTO tree (tree_id, created_at) VALUES ('cascade_tx_tree', 0)",
        );
        treeId = treeResult.lastInsertRowId;

        await tx.execute(
          `INSERT INTO tree_entry (tree_fk, position, mode, name, object_id)
           VALUES (${treeId}, 0, 33188, 'cascade_file.txt', 'blob123')`,
        );
      });

      // Delete tree within new transaction - should cascade
      await db.transaction(async (tx) => {
        await tx.execute(`DELETE FROM tree WHERE id = ${treeId!}`);

        // Within same transaction, entry should be gone
        const entries = await tx.query<{ tree_fk: number }>(
          `SELECT tree_fk FROM tree_entry WHERE tree_fk = ${treeId!}`,
        );

        expect(entries).toHaveLength(0);
      });
    });
  });
});
