/**
 * @statewalker/vcs-transport-lfs
 *
 * The standard Git LFS batch protocol + basic (whole-object) transfer, client
 * and server, over a `@statewalker/content-store` byte store. It interoperates
 * on the wire with real Git LFS hosts (whole objects, SHA-256 oids); locally the
 * content-store assembles/stores the whole object. No chunk-aware dedup (that is
 * `vcs-transport-xet`), no pointer clean/smudge (that is the working-tree LFS
 * filter).
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
export { serveLfs } from "./server.js";
export { sha256Hex } from "./sha256.js";
export type { FetchLike, LfsPointer, LfsResolver, TransportEvent } from "./types.js";
