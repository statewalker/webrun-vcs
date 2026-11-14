/**
 * SqlRawStore against the shared RawStorage contract: values are cut into
 * chunk rows, written as they arrive, renamed with `move`, and rows of the old
 * single-row layout still read, before and after schema migration 6.
 */
import { createRawStorageTests } from "@statewalker/vcs-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlRawStore } from "../src/binary-storage/sql-raw-store.js";
import { initializeSchema } from "../src/migrations/index.js";

/** Counts the bytes of every blob parameter the database is asked to write. */
function countWrites(db: SqlJsAdapter): () => number {
  let written = 0;
  const execute = db.execute.bind(db);
  db.execute = (sql, params) => {
    for (const p of params ?? []) if (p instanceof Uint8Array) written += p.length;
    return execute(sql, params);
  };
  return () => written;
}

createRawStorageTests("SqlRawStore", async () => {
  const db = await SqlJsAdapter.create();
  const written = countWrites(db);
  return {
    rawStorage: new SqlRawStore(db, "raw_test"),
    supportsMove: true,
    persistedBytes: written,
    cleanup: () => db.close(),
  };
});

const enc = new TextEncoder();
const text = async (s: AsyncIterable<Uint8Array>) => {
  const parts: number[] = [];
  for await (const c of s) parts.push(...c);
  return new TextDecoder().decode(Uint8Array.from(parts));
};

describe("SqlRawStore old single-row layout", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    // a table as older versions created it, with a value in it
    await db.execute(
      "CREATE TABLE raw_objects (key TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL)",
    );
    const old = enc.encode("written by an older version");
    await db.execute("INSERT INTO raw_objects (key, data, size) VALUES (?, ?, ?)", [
      "k",
      old,
      old.length,
    ]);
  });
  afterEach(async () => {
    await db.close();
  });

  it("reads old rows and stores new chunked values next to them", async () => {
    const store = new SqlRawStore(db, "raw_objects", { chunkSize: 1024 });
    expect(await text(store.load("k"))).toBe("written by an older version");
    expect(await store.size("k")).toBe(27);
    await store.store(
      "big",
      (async function* () {
        yield new Uint8Array(4000).fill(2);
      })(),
    );
    const chunks = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM raw_objects_chunk");
    expect(chunks[0]?.n).toBe(4);
    expect(await store.size("big")).toBe(4000);
    expect(await text(store.load("k", { start: 8 }))).toBe("by an older version");
  });

  it("migration 6 upgrades the table, and old rows still read afterwards", async () => {
    await initializeSchema(db);
    const columns = await db.query<{ name: string }>("PRAGMA table_info(raw_objects)");
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["key", "data", "size", "chunk_count", "chunk_token"]),
    );
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_objects_chunk'",
    );
    expect(tables).toHaveLength(1);
    const store = new SqlRawStore(db, "raw_objects");
    expect(await text(store.load("k"))).toBe("written by an older version");
    const keys: string[] = [];
    for await (const key of store.keys()) keys.push(key);
    expect(keys).toEqual(["k"]);
  });
});
