/**
 * The tree and commit caches over the memory store do not serve removed objects.
 */

import { createGitObjects, MemoryRawStorage, rawStorageStaging } from "@statewalker/vcs-core";
import { createParsedObjectCacheTests } from "@statewalker/vcs-testing";

createParsedObjectCacheTests("Memory", async () => {
  const raw = new MemoryRawStorage();
  return {
    objects: createGitObjects(rawStorageStaging(raw)),
    removeBehind: (id) => raw.remove(id),
  };
});
