/**
 * Tests for KV-based store implementations
 *
 * Uses the parametrized test suites from @statewalker/vcs-testing
 * to verify the KV implementations follow the interface contracts.
 */

import { createGitObjects, FileMode, rawStorageStaging } from "@statewalker/vcs-core";
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
import { MergeStage } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
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

// Object kernel tests
createGitObjectsTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  // counts the bytes of every value written, for the bounded-memory test
  let persisted = 0;
  const set = kv.set.bind(kv);
  kv.set = (key, value) => {
    persisted += value.length;
    return set(key, value);
  };
  const setMany = kv.setMany.bind(kv);
  kv.setMany = (entries) => {
    for (const v of entries.values()) persisted += v.length;
    return setMany(entries);
  };
  const store = rawStorageStaging(new KvRawStore(kv, "objects"));
  return {
    objects: createGitObjects(store),
    store,
    cleanup: () => kv.close(),
    persistedBytes: () => persisted,
  };
});

describe("KV staging values with paths that are no UTF-8", () => {
  it("stores a lone surrogate as a JSON escape, so the bytes round-trip", async () => {
    // a path as the index holds it (`decodeGitPath`): the byte 0xe9 is U+DCE9
    const path = "caf\udce9.txt";
    const kv = new MemoryKVAdapter();
    const staging = new KVStaging(kv);
    const builder = staging.createBuilder();
    builder.add({
      path,
      mode: FileMode.REGULAR_FILE,
      objectId: "ce013625030ba8dba906f756967f9e9ca394464a",
      stage: MergeStage.MERGED,
      size: 1,
      mtime: 0,
    });
    await builder.finish();

    // JSON.stringify writes the lone surrogate as the ASCII escape "\udce9", which UTF-8
    // encodes without loss (a raw lone surrogate would become U+FFFD)
    const values: Uint8Array[] = [];
    for await (const key of kv.list("staging:")) {
      const value = await kv.get(key);
      if (value && key.startsWith(`staging:${path}`)) values.push(value);
    }
    expect(values).toHaveLength(1);
    const json = new TextDecoder().decode(values[0]);
    expect(json).toContain("caf\\udce9.txt");
    expect(JSON.parse(json).p).toBe(path);

    const reopened = new KVStaging(kv);
    expect((await reopened.getEntry(path))?.path).toBe(path);
    await kv.close();
  });
});
