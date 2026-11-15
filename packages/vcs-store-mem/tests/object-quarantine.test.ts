/**
 * Quarantine for received packs over the memory store: quarantined objects live under
 * `incoming-<id>/` keys of the same `MemoryRawStorage` until they are committed.
 */

import { MemoryRawStorage } from "@statewalker/vcs-core";
import { createObjectQuarantineTests, rawQuarantineHelpers } from "@statewalker/vcs-testing";
import { createMemoryObjectStores } from "../src/object-storage/index.js";

createObjectQuarantineTests("Memory", async () => {
  const storage = new MemoryRawStorage();
  const { objects } = createMemoryObjectStores({ storage });
  return { objects, ...rawQuarantineHelpers(storage) };
});
