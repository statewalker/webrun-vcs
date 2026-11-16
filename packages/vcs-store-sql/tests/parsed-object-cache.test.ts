/**
 * The tree and commit caches over the SQL store do not serve removed objects, also when a
 * second `SqlRawStore` over the same table removes them.
 */

import { createParsedObjectCacheTests } from "@statewalker/vcs-testing";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlRawStore } from "../src/binary-storage/sql-raw-store.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlObjectStores } from "../src/object-storage/index.js";

createParsedObjectCacheTests("SQL", async () => {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  const { objects } = createSqlObjectStores({ db, tableName: "cache_objects" });
  const behind = new SqlRawStore(db, "cache_objects");
  return { objects, removeBehind: (id) => behind.remove(id), cleanup: () => db.close() };
});
