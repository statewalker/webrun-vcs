/**
 * Tests for SQL high-level store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the SQL implementations follow the interface contracts.
 */

import {
  createBlobStoreTests,
  createCommitStoreTests,
  createGitObjectStoreTests,
  createRefStoreTests,
  createStagingStoreTests,
  createTagStoreTests,
  createTreeStoreTests,
} from "@statewalker/vcs-testing";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SQLCommitStore } from "../src/commit-store.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlObjectStores } from "../src/object-storage/index.js";
import { SQLRefStore } from "../src/ref-store.js";
import { SQLStaging } from "../src/staging-store.js";
import { SQLTagStore } from "../src/tag-store.js";
import { SQLTreeStore } from "../src/tree-store.js";

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
    treeStore: new SQLTreeStore(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// CommitStore tests
createCommitStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    commitStore: new SQLCommitStore(db),
    cleanup: async () => {
      await db.close();
    },
  };
});

// TagStore tests
createTagStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    tagStore: new SQLTagStore(db),
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

// StagingStore tests
createStagingStoreTests("SQL", async () => {
  const db = await createTestDb();
  return {
    stagingStore: new SQLStaging(db),
    treeStore: new SQLTreeStore(db),
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

// GitObjectStore tests
createGitObjectStoreTests("SQL", async () => {
  const db = await createTestDb();
  const stores = createSqlObjectStores({ db });
  return {
    objectStore: stores.objects,
    cleanup: async () => {
      await db.close();
    },
  };
});
