/**
 * Tests for in-memory store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the memory implementations follow the interface contracts.
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
import {
  createMemoryObjectStores,
  MemoryCommitStore,
  MemoryRefStore,
  MemoryStagingStore,
  MemoryTagStore,
  MemoryTreeStore,
} from "../src/index.js";

// TreeStore tests
createTreeStoreTests("Memory", async () => ({
  treeStore: new MemoryTreeStore(),
}));

// CommitStore tests
createCommitStoreTests("Memory", async () => ({
  commitStore: new MemoryCommitStore(),
}));

// TagStore tests
createTagStoreTests("Memory", async () => ({
  tagStore: new MemoryTagStore(),
}));

// RefStore tests
createRefStoreTests("Memory", async () => ({
  refStore: new MemoryRefStore(),
}));

// StagingStore tests
createStagingStoreTests("Memory", async () => ({
  stagingStore: new MemoryStagingStore(),
  treeStore: new MemoryTreeStore(),
}));

// BlobStore tests
createBlobStoreTests("Memory", async () => {
  const stores = createMemoryObjectStores();
  return { blobStore: stores.blobs };
});

// GitObjectStore tests
createGitObjectStoreTests("Memory", async () => {
  const stores = createMemoryObjectStores();
  return { objectStore: stores.objects };
});
