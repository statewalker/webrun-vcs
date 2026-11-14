/**
 * Tests for KV-based store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the KV implementations follow the interface contracts.
 */

import { createGitObjects, rawStorageStaging } from "@statewalker/vcs-core";
import {
  createBlobStoreTests,
  createCommitStoreTests,
  createGitObjectStoreTests,
  createGitObjectsTests,
  createRefBatchTests,
  createRefStoreTests,
  createStagingStoreTests,
  createTagStoreTests,
  createTreeStoreTests,
} from "@statewalker/vcs-testing";
import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KvRawStore } from "../src/binary-storage/kv-raw-store.js";
import { KVRefStore } from "../src/kv-ref-store.js";
import { KVStaging } from "../src/kv-staging-store.js";
import { createKvObjectStores } from "../src/object-storage/index.js";

// TreeStore tests
createTreeStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  return {
    treeStore: createKvObjectStores({ kv }).trees,
    cleanup: async () => {
      await kv.close();
    },
  };
});

// CommitStore tests
createCommitStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  return {
    commitStore: createKvObjectStores({ kv }).commits,
    cleanup: async () => {
      await kv.close();
    },
  };
});

// TagStore tests
createTagStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  return {
    tagStore: createKvObjectStores({ kv }).tags,
    cleanup: async () => {
      await kv.close();
    },
  };
});

// RefStore tests
createRefStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  return {
    refStore: new KVRefStore(kv),
    cleanup: async () => {
      await kv.close();
    },
  };
});

// Ref batch tests
createRefBatchTests(
  "KV",
  async () => {
    const kv = new MemoryKVAdapter();
    return { refs: new KVRefStore(kv), cleanup: () => kv.close() };
  },
  { reflog: true },
);

// StagingStore tests
createStagingStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  return {
    stagingStore: new KVStaging(kv),
    trees: createKvObjectStores({ kv }).trees,
    cleanup: async () => {
      await kv.close();
    },
  };
});

// BlobStore tests
createBlobStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  const stores = createKvObjectStores({ kv });
  return { blobStore: stores.blobs };
});

// GitObjectStore tests
createGitObjectStoreTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  const stores = createKvObjectStores({ kv });
  return { objectStore: stores.objects };
});

// Object kernel tests
createGitObjectsTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  const store = rawStorageStaging(new KvRawStore(kv, "objects"));
  return { objects: createGitObjects(store), store, cleanup: () => kv.close() };
});
