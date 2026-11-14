/**
 * Tests for in-memory store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the memory implementations follow the interface contracts.
 */

import { createGitObjects, MemoryRawStorage, rawStorageStaging } from "@statewalker/vcs-core";
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
import { createMemoryObjectStores, MemoryRefs, MemoryStagingStore } from "../src/index.js";

// TreeStore tests
createTreeStoreTests("Memory", async () => ({
  treeStore: createMemoryObjectStores().trees,
}));

// CommitStore tests
createCommitStoreTests("Memory", async () => ({
  commitStore: createMemoryObjectStores().commits,
}));

// TagStore tests
createTagStoreTests("Memory", async () => ({
  tagStore: createMemoryObjectStores().tags,
}));

// RefStore tests
createRefStoreTests("Memory", async () => ({
  refStore: new MemoryRefs(),
}));

// Ref batch tests
createRefBatchTests("Memory", async () => ({ refs: new MemoryRefs() }), { reflog: true });

// StagingStore tests
createStagingStoreTests("Memory", async () => ({
  stagingStore: new MemoryStagingStore(),
  trees: createMemoryObjectStores().trees,
}));

// BlobStore tests
createBlobStoreTests("Memory", async () => {
  const stores = createMemoryObjectStores();
  return { blobStore: stores.blobs };
});

// Object kernel tests
createGitObjectsTests("Memory", async () => {
  const store = rawStorageStaging(new MemoryRawStorage());
  return { objects: createGitObjects(store), store };
});
