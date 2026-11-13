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
});
