/**
 * Adapter: `@statewalker/webrun-storage` {@link BlobStore} → vcs-core {@link RawStorage}.
 *
 * The two contracts have the same shape once `BlobStore` gained a ranged `get`
 * plus `size`, so every method maps one-to-one — this is a thin pass-through
 * that lets the existing git engine run over the storage seam unchanged.
 *
 * Promoted from the B1 test-scope spike helper to production (B2).
 */

import type { BlobStore } from "@statewalker/webrun-storage";
import type { RawStorage } from "../raw/raw-storage.js";

export function blobStoreToRawStorage(blob: BlobStore): RawStorage {
  return {
    store: (key, content) => blob.put(key, content),
    load: (key, options) => blob.get(key, options),
    has: (key) => blob.has(key),
    remove: (key) => blob.remove(key),
    keys: () => blob.list(),
    size: (key) => blob.size(key),
  };
}
