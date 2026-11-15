// Adapters bridging the `@statewalker/webrun-storage` byte seam to vcs-core stores.
export { blobStoreToRawStorage } from "./blob-store-raw-storage.js";
export { kvStoreRefs } from "./kv-store-refs.js";
export {
  RAW_QUARANTINE_PREFIX,
  RAW_STAGING_TMP_PREFIX,
  type RawStorageStagingOptions,
  rawStorageStaging,
  type SpooledContent,
  STAGING_INLINE_THRESHOLD,
  type StagingBlobStore,
  type StagingQuarantine,
  sweepStaleRawStaging,
} from "./staging-blob-store.js";
