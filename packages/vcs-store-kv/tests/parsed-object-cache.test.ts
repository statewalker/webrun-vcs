/**
 * The tree and commit caches over the KV store do not serve removed objects, also when a
 * second `KvRawStore` over the same keys removes them.
 */

import { createParsedObjectCacheTests } from "@statewalker/vcs-testing";
import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KvRawStore } from "../src/binary-storage/kv-raw-store.js";
import { createKvObjectStores } from "../src/object-storage/index.js";

createParsedObjectCacheTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  const { objects } = createKvObjectStores({ kv, prefix: "objects:" });
  const behind = new KvRawStore(kv, "objects:");
  return { objects, removeBehind: (id) => behind.remove(id), cleanup: () => kv.close() };
});
