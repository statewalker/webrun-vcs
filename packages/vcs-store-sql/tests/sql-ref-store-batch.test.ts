import { describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { initializeSchema } from "../src/migrations/index.js";
import { SQLRefStore } from "../src/ref-store.js";

const oid = (n: number) => n.toString(16).padStart(40, "a");

async function freshDb() {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  return db;
}

/** Wraps a client so that the transaction's `failAt`-th execute throws. */
function failingAt(db: DatabaseClient, failAt: number): DatabaseClient {
  return {
    query: (sql, params) => db.query(sql, params),
    execute: (sql, params) => db.execute(sql, params),
    close: () => db.close(),
    transaction: (fn) =>
      db.transaction((tx) => {
        let n = 0;
        return fn({
          ...tx,
          execute: (sql, params) => {
            if (++n === failAt) throw new Error("disk full");
            return tx.execute(sql, params);
          },
        });
      }),
  };
}

describe("SQLRefStore.batch", () => {
  it("writes nothing when a statement fails part-way through the batch", async () => {
    const db = await freshDb();
    await new SQLRefStore(db).set("refs/heads/a", oid(1));
    const refs = new SQLRefStore(failingAt(db, 2));
    await expect(
      refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(2) },
        { name: "refs/heads/b", new: oid(3) },
      ]),
    ).rejects.toThrow("disk full");
    const plain = new SQLRefStore(db);
    expect((await plain.resolve("refs/heads/a"))?.objectId).toBe(oid(1));
    expect(await plain.has("refs/heads/b")).toBe(false);
    await db.close();
  });

  it("finds children by byte order, non-ASCII ones included, and not siblings", async () => {
    const db = await freshDb();
    const refs = new SQLRefStore(db);
    await refs.set("refs/heads/x-y", oid(1));
    await refs.set("refs/heads/x.y", oid(1));
    expect((await refs.batch([{ name: "refs/heads/x", new: oid(2) }])).ok).toBe(true);
    await refs.set("refs/heads/z/é", oid(1));
    expect((await refs.batch([{ name: "refs/heads/z", new: oid(2) }])).rejected).toEqual([
      { name: "refs/heads/z", reason: "df-conflict" },
    ]);
    await db.close();
  });

  it("clears a peeled id and marks the ref loose when it is rewritten", async () => {
    const db = await freshDb();
    await db.execute(
      "INSERT INTO vcs_ref (name, object_id, peeled_object_id, storage, updated_at) VALUES (?, ?, ?, 'packed', 0)",
      ["refs/tags/v1", oid(1), oid(9)],
    );
    const refs = new SQLRefStore(db);
    expect((await refs.batch([{ name: "refs/tags/v1", old: oid(1), new: oid(2) }])).ok).toBe(true);
    expect(await refs.get("refs/tags/v1")).toMatchObject({
      objectId: oid(2),
      peeled: false,
      storage: "loose",
    });
    await db.close();
  });
});

describe("SQLRefStore.list(prefix)", () => {
  it("matches the prefix exactly: case-sensitive, no LIKE wildcards", async () => {
    const db = await freshDb();
    const refs = new SQLRefStore(db);
    for (const name of ["refs/heads/a_b", "refs/heads/aXb", "refs/heads/A", "refs/heads/é"]) {
      await refs.set(name, oid(1));
    }
    const names = async (prefix: string) => {
      const out: string[] = [];
      for await (const ref of refs.list(prefix)) out.push(ref.name);
      return out;
    };
    expect(await names("refs/heads/a_")).toEqual(["refs/heads/a_b"]);
    expect(await names("refs/HEADS/")).toEqual([]);
    expect(await names("refs/heads/")).toEqual([
      "refs/heads/A",
      "refs/heads/aXb",
      "refs/heads/a_b",
      "refs/heads/é",
    ]);
    await db.close();
  });
});
