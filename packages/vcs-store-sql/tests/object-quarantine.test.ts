/**
 * Quarantine for received packs over the SQL raw store: quarantined objects are rows keyed
 * `incoming-<id>/<oid>` in the same table, all renamed in one transaction on commit
 * (`SqlRawStore.moveAll`). The SQL native stores (parsed objects, no object kernel) cannot
 * quarantine: their `importPack` writes straight into the store and returns no quarantine.
 */

import { writePack } from "@statewalker/vcs-core";
import { createObjectQuarantineTests, rawQuarantineHelpers } from "@statewalker/vcs-testing";
import { describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlRawStore } from "../src/binary-storage/sql-raw-store.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlObjectStores } from "../src/object-storage/index.js";
import { SQLHistoryFactory } from "../src/sql-storage-backend.js";

async function createTestDb() {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  return db;
}

createObjectQuarantineTests("SQL", async () => {
  const db = await createTestDb();
  const { objects } = createSqlObjectStores({ db, tableName: "quarantine_objects" });
  return {
    objects,
    ...rawQuarantineHelpers(new SqlRawStore(db, "quarantine_objects")),
    cleanup: () => db.close(),
  };
});

describe("SqlRawStore.moveAll", () => {
  it("renames every key in one transaction, or none when a source is missing", async () => {
    const db = await createTestDb();
    const raw = new SqlRawStore(db, "move_all");
    const one = (async function* () {
      yield new Uint8Array([1]);
    })();
    const two = (async function* () {
      yield new Uint8Array([2]);
    })();
    await raw.store("a", one);
    await raw.store("b", two);
    await expect(
      raw.moveAll([
        ["a", "x"],
        ["missing", "y"],
      ]),
    ).rejects.toThrow();
    expect(await raw.has("a")).toBe(true);
    expect(await raw.has("x")).toBe(false);
    await raw.moveAll([
      ["a", "x"],
      ["b", "y"],
    ]);
    expect([
      await raw.has("a"),
      await raw.has("b"),
      await raw.has("x"),
      await raw.has("y"),
    ]).toEqual([false, false, true, true]);
    await db.close();
  });
});

describe("SQL native stores: no quarantine (explicit fallback)", () => {
  it("importPack with quarantine imports directly and returns no quarantine", async () => {
    const history = await new SQLHistoryFactory().createHistory({
      db: await SqlJsAdapter.create(),
    });
    await history.initialize();
    const source = createSqlObjectStores({ db: await createTestDb() });
    const bytes = new TextEncoder().encode("native\n");
    const id = await source.objects.put("blob", bytes.length, [bytes]);
    const chunks: Uint8Array[] = [];
    for await (const c of writePack(source.objects, [id])) chunks.push(c);
    const result = await history.serialization.importPack(
      (async function* () {
        yield* chunks;
      })(),
      { quarantine: true },
    );
    expect(result.quarantine).toBeUndefined();
    expect(result.quarantined).toBe(false);
    expect(await history.blobs.has(id)).toBe(true);
    await history.close();
  });
});
