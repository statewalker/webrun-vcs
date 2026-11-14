/**
 * @statewalker/vcs-transport-lfs
 *
 * The standard Git LFS batch protocol + basic (whole-object) transfer, client
 * and server, over a `@statewalker/webrun-content-store` byte store. It interoperates
 * on the wire with real Git LFS hosts (whole objects, SHA-256 oids); locally the
 * content-store stores the object. Objects stream both ways: uploads send a
 * streaming body, downloads and server uploads are hashed while they are stored
 * and verified at the end, so no object is ever held in memory whole. No
 * chunk-aware dedup (that is `vcs-transport-xet`); pointer files are built and
 * read here (`createLfsPointer`, `formatLfsPointer`, `parseLfsPointer`), the
 * clean/smudge wiring belongs to the working tree.
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
export {
  createLfsPointer,
  formatLfsPointer,
  LFS_POINTER_VERSION,
  parseLfsPointer,
} from "./pointer.js";
export { serveLfs } from "./server.js";
export { type ByteSource, sha256Hex } from "./sha256.js";
export type {
  FetchLike,
  LfsPointer,
  LfsResolver,
  LfsTransferOptions,
  TransportEvent,
} from "./types.js";
export { type LfsStoreResult, storeVerified } from "./verify.js";
