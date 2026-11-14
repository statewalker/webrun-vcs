// Adapters bridging the `@statewalker/webrun-storage` byte seam to vcs-core stores.
export { blobStoreToRawStorage } from "./blob-store-raw-storage.js";
export { kvStoreRefs } from "./kv-store-refs.js";
export { rawStorageStaging, type StagingBlobStore } from "./staging-blob-store.js";
