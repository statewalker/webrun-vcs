/**
 * SqlRawStore against the shared RawStorage contract: values are cut into
 * chunk rows, written as they arrive, renamed with `move`, and rows of the old
 * single-row layout still read, before and after schema migration 6.
 */
import { rawStorageStaging } from "@statewalker/vcs-core";
import { createRawStorageTests } from "@statewalker/vcs-testing";
import { timestampedId } from "@statewalker/vcs-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlRawStore } from "../src/binary-storage/sql-raw-store.js";
import { initializeSchema, rollbackMigration } from "../src/migrations/index.js";

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

describe("SqlRawStore.sweepStale", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });
  afterEach(async () => {
    await db.close();
  });

  const bytes = (n: number, fill = 1) =>
    (async function* () {
      yield new Uint8Array(n).fill(fill);
    })();
  const tokens = async () =>
    (
      await db.query<{ token: string }>("SELECT DISTINCT token FROM raw_test_chunk ORDER BY token")
    ).map((r) => r.token);

  it("removes chunk rows no row references once older than the expiry", async () => {
    const store = new SqlRawStore(db, "raw_test", { chunkSize: 1024 });
    await store.store("kept", bytes(3000));
    const [kept] = await tokens();
    const old = timestampedId(Date.now() - 2 * 24 * 3600_000);
    const fresh = timestampedId();
    for (const t of [old, fresh]) {
      await db.execute("INSERT INTO raw_test_chunk (token, seq, data) VALUES (?, 0, ?)", [
        t,
        new Uint8Array(4),
      ]);
    }
    expect(await store.sweepStale({ olderThanMs: 24 * 3600_000 })).toBe(1);
    expect(await tokens()).toEqual([kept, fresh].sort());
    expect(await store.size("kept")).toBe(3000);
  });

  it("removes orphans of unknown age only with olderThanMs 0", async () => {
    const store = new SqlRawStore(db, "raw_test", { chunkSize: 1024 });
    await store.has("x"); // create the tables
    await db.execute("INSERT INTO raw_test_chunk (token, seq, data) VALUES (?, 0, ?)", [
      "3f2b8c1e-0d4a-4e8b-9c6f-2a1b3c4d5e6f",
      new Uint8Array(4),
    ]);
    expect(await store.sweepStale({ olderThanMs: 3600_000 })).toBe(0);
    expect(await store.sweepStale({ olderThanMs: 0 })).toBe(1);
    expect(await tokens()).toEqual([]);
  });

  it("never removes the chunk rows of a write in progress", async () => {
    const store = new SqlRawStore(db, "raw_test", { chunkSize: 1024 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writing = store.store(
      "big",
      (async function* () {
        yield new Uint8Array(3000).fill(7);
        await gate;
        yield new Uint8Array(3000).fill(8);
      })(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect((await tokens()).length).toBe(1);
    expect(await store.sweepStale({ olderThanMs: 0 })).toBe(0);
    release();
    await writing;
    let n = 0;
    for await (const c of store.load("big")) n += c.length;
    expect(n).toBe(6000);
  });
});

describe("SqlRawStore holding git objects (same id twice)", () => {
  it("keeps the stored value: a reader of it never loses its chunk rows", async () => {
    const db = await SqlJsAdapter.create();
    try {
      const raw = new SqlRawStore(db, "raw_test", { chunkSize: 64 * 1024 });
      const staging = rawStorageStaging(raw);
      const big = () =>
        (async function* () {
          for (let i = 0; i < 4; i++) yield new Uint8Array(100 * 1024).fill(3);
        })();
      expect(await staging.putStaged(big(), () => "id")).toEqual({ id: "id", stored: true });
      const reader = raw.load("id")[Symbol.asyncIterator]();
      let n = ((await reader.next()).value as Uint8Array).length;
      expect(await staging.putStaged(big(), () => "id")).toEqual({ id: "id", stored: false });
      for (let r = await reader.next(); !r.done; r = await reader.next()) n += r.value.length;
      expect(n).toBe(400 * 1024);
      const left = await db.query<{ n: number }>(
        "SELECT COUNT(DISTINCT token) AS n FROM raw_test_chunk",
      );
      expect(left[0]?.n).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("migration 6 rollback", () => {
  it("deletes the rows of values kept in chunks, keeps single-row values", async () => {
    const db = await SqlJsAdapter.create();
    try {
      await initializeSchema(db);
      const store = new SqlRawStore(db, "raw_objects", { chunkSize: 1024 });
      await store.store(
        "small",
        (async function* () {
          yield enc.encode("one row");
        })(),
      );
      await store.store(
        "big",
        (async function* () {
          yield new Uint8Array(4000).fill(5);
        })(),
      );
      await rollbackMigration(db, 5);
      const rows = await db.query<{ key: string }>("SELECT key FROM raw_objects ORDER BY key");
      // a row with an empty `data` would read as an empty value in the old layout: it goes
      expect(rows.map((r) => r.key)).toEqual(["small"]);
      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_objects_chunk'",
      );
      expect(tables).toHaveLength(0);
      const left = await db.query<{ data: Uint8Array }>(
        "SELECT data FROM raw_objects WHERE key = 'small'",
      );
      expect(new TextDecoder().decode(left[0]?.data)).toBe("one row");
    } finally {
      await db.close();
    }
  });
});
