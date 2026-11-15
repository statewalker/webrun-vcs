/**
 * @statewalker/vcs-transport-lfs
 *
 * The standard Git LFS batch protocol + basic (whole-object) transfer, client
 * and server, over a `@statewalker/webrun-content-store` byte store. It interoperates
 * on the wire with real Git LFS hosts (whole objects, SHA-256 oids); locally the
 * content-store stores the object. Objects stream both ways: uploads send a
 * streaming body, downloads and server uploads are hashed while they are stored
 * and verified at the end, so no object is ever held in memory whole. No
 * chunk-aware dedup (that is `vcs-transport-xet/webrun-chunks`); pointer files are built and
 * read here (`createLfsPointer`, `formatLfsPointer`, `parseLfsPointer`), the
 * clean/smudge wiring belongs to the working tree. Besides a content-store, the
 * server and client run over any `LfsObjectStore`, such as
 * `createFilesLfsStore`: a `FilesApi` in git-lfs's own `lfs/objects` layout,
 * shared with native git-lfs, with resumable partial downloads. The File
 * Locking API is here too: the `lfsLocks` client, and `serveLfs`'s `locks`
 * option over an `LfsLockStore` (`createMemoryLockStore`,
 * `createFilesLockStore`).
 */

export {
  BASIC_TRANSFER,
  type BatchAction,
  type BatchObjectRequest,
  type BatchObjectResponse,
  type BatchRequest,
  type BatchResponse,
  LFS_CONTENT_TYPE,
} from "./batch.js";
export { lfsDownload, lfsUpload } from "./client.js";
export { createFilesLfsStore, LfsPartialChangedError } from "./files-store.js";
export {
  basicUserIdentity,
  createFilesLockStore,
  createMemoryLockStore,
  type LfsCreateLockRequest,
  type LfsListLocksQuery,
  type LfsListLocksResponse,
  type LfsLock,
  type LfsLockClientOptions,
  LfsLockError,
  type LfsLockOperation,
  type LfsLockOwner,
  type LfsLockPage,
  type LfsLockQuery,
  type LfsLockRef,
  type LfsLockStore,
  type LfsLocksClient,
  type LfsLocksOptions,
  type LfsStoredLock,
  type LfsUnlockRequest,
  type LfsVerifyLocksPage,
  type LfsVerifyLocksRequest,
  type LfsVerifyLocksResponse,
  lfsLocks,
  normalizeLockPath,
} from "./locks/index.js";
export {
  createLfsPointer,
  formatLfsPointer,
  LFS_POINTER_MAX_SIZE,
  LFS_POINTER_VERSION,
  parseLfsPointer,
} from "./pointer.js";
export {
  type LfsAuthorization,
  type LfsOperation,
  type LfsServerOptions,
  serveLfs,
} from "./server.js";
export { type ByteSource, sha256Hex } from "./sha256.js";
export {
  contentStoreLfsObjects,
  type LfsObjectStore,
  type LfsPartialStore,
  type LfsPutResult,
} from "./store.js";
export type {
  FetchLike,
  LfsPointer,
  LfsPointerExtension,
  LfsResolver,
  LfsTransferOptions,
  TransportEvent,
} from "./types.js";
export { type LfsStoreResult, storeVerified } from "./verify.js";
