/**
 * Quarantine for received packs over the KV store: quarantined objects live under
 * `incoming-<id>/` keys of the same `KvRawStore` and are renamed (`move`) on commit.
 */

import { createObjectQuarantineTests, rawQuarantineHelpers } from "@statewalker/vcs-testing";
import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KvRawStore } from "../src/binary-storage/kv-raw-store.js";
import { createKvObjectStores } from "../src/object-storage/index.js";

createObjectQuarantineTests("KV", async () => {
  const kv = new MemoryKVAdapter();
  const { objects } = createKvObjectStores({ kv, prefix: "objects:" });
  return {
    objects,
    ...rawQuarantineHelpers(new KvRawStore(kv, "objects:")),
    cleanup: () => kv.close(),
  };
});
