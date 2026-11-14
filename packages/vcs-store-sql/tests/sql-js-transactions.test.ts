import { describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";

describe("SqlJsAdapter.transaction", () => {
  it("isolates concurrent transactions: one rolling back keeps the other's writes", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", []);
    const tick = () => new Promise((r) => setTimeout(r, 1));

    const failing = db
      .transaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('a', '1')", []);
        await tick();
        throw new Error("boom");
      })
      .catch((e: Error) => e.message);
    const ok = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('b', '2')", []);
      await tick();
      return "done";
    });

    expect(await Promise.all([failing, ok])).toEqual(["boom", "done"]);
    expect(await db.query("SELECT k FROM t ORDER BY k", [])).toEqual([{ k: "b" }]);
    await db.close();
  });

  it("joins a nested transaction started through the client it was given", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY)", []);
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('a')", []);
      await tx.transaction(async (inner) => {
        await inner.execute("INSERT INTO t VALUES ('b')", []);
      });
    });
    expect((await db.query("SELECT k FROM t ORDER BY k", [])).length).toBe(2);
    await db.close();
  });

  it("makes statements outside a transaction wait for it (no dirty reads, no lost writes)", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY)", []);
    const tick = () => new Promise((r) => setTimeout(r, 1));
    let rolledBack = false;
    const tx = db
      .transaction(async (t) => {
        await t.execute("INSERT INTO t VALUES ('in-tx')", []);
        await tick();
        rolledBack = true;
        throw new Error("rollback");
      })
      .catch(() => undefined);
    // Issued while the transaction is open: must not see its row, nor be undone by it.
    const read = db.query<{ k: string }>("SELECT k FROM t", []);
    const write = db.execute("INSERT INTO t VALUES ('outside')", []);
    await Promise.all([tx, read, write]);
    expect(rolledBack).toBe(true);
    expect(await read).toEqual([]);
    expect(await db.query("SELECT k FROM t", [])).toEqual([{ k: "outside" }]);
    await db.close();
  });

  it("rolls a nested transaction back with the outer one", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY)", []);
    await db
      .transaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('a')", []);
        await tx.transaction(async (inner) => {
          await inner.execute("INSERT INTO t VALUES ('b')", []);
        });
        throw new Error("outer fails");
      })
      .catch(() => undefined);
    expect(await db.query("SELECT k FROM t", [])).toEqual([]);
    await db.close();
  });

  it("releases the queue when BEGIN fails, without rolling back someone else's transaction", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY)", []);
    const raw = db.getDatabase();
    raw.run("BEGIN TRANSACTION");
    raw.run("INSERT INTO t VALUES ('raw')");
    await expect(db.transaction(async () => "never")).rejects.toThrow();
    raw.run("COMMIT"); // the raw transaction survived the failed BEGIN
    expect(await db.query("SELECT k FROM t", [])).toEqual([{ k: "raw" }]);
    expect(await db.transaction(async () => "next")).toBe("next");
    await db.close();
  });
});
