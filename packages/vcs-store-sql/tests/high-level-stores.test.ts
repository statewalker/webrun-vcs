/**
 * Tests for SQL high-level store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the SQL implementations follow the interface contracts.
 */

import { createGitObjects, rawStorageStaging } from "@statewalker/vcs-core";
import {
  createBlobStoreTests,
  createCommitStoreTests,
  createGitObjectsTests,
  createRefBatchTests,
  createRefStoreTests,
  createStagingStoreTests,
  createTagStoreTests,
  createTreeStoreTests,
} from "@statewalker/vcs-testing";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlRawStore } from "../src/binary-storage/sql-raw-store.js";
import { initializeSchema } from "../src/migrations/index.js";
import {
  SqlNativeBlobStoreImpl,
  SqlNativeCommitStoreImpl,
  SqlNativeTagStoreImpl,
  SqlNativeTreeStoreImpl,
} from "../src/native/index.js";
import { createSqlObjectStores } from "../src/object-storage/index.js";
import { SQLRefStore } from "../src/ref-store.js";
import { SQLStaging } from "../src/staging-store.js";

/**
 * Create a fresh database with schema for testing
 */
async function createTestDb() {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  return db;
}

// TreeStore tests
createTreeStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    treeStore: new SqlNativeTreeStoreImpl(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// CommitStore tests
createCommitStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    commitStore: new SqlNativeCommitStoreImpl(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// TagStore tests
createTagStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    tagStore: new SqlNativeTagStoreImpl(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// RefStore tests
createRefStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    refStore: new SQLRefStore(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// Ref batch tests
createRefBatchTests(
  "SQL",
  async () => {
    const db = await createTestDb();
    return { refs: new SQLRefStore(db), cleanup: () => db.close() };
  },
  { reflog: true },
);

// StagingStore tests
createStagingStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    stagingStore: new SQLStaging(db),
    trees: new SqlNativeTreeStoreImpl(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// BlobStore tests
createBlobStoreTests("SQL", async () => {
  const db = await createTestDb();
  const stores = createSqlObjectStores({ db });
  return {
    blobStore: stores.blobs,
    cleanup: async () => {
      await db.close();
    },
  };
});

// Object kernel tests
createGitObjectsTests("SQL", async () => {
  const db = await createTestDb();
  // counts the bytes of every blob parameter written, for the bounded-memory test
  let persisted = 0;
  const execute = db.execute.bind(db);
  db.execute = (sql, params) => {
    for (const p of params ?? []) if (p instanceof Uint8Array) persisted += p.length;
    return execute(sql, params);
  };
  const store = rawStorageStaging(new SqlRawStore(db, "raw_objects"));
  return {
    objects: createGitObjects(store),
    store,
    cleanup: () => db.close(),
    persistedBytes: () => persisted,
  };
});

// BlobStore tests on the native SQL blob store (createHistory("sql") uses it)
createBlobStoreTests("SQL native", async () => {
  const db = await createTestDb();
  return { blobStore: new SqlNativeBlobStoreImpl(db), cleanup: () => db.close() };
});
