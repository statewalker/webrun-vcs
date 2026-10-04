/**
 * @statewalker/vcs-transport-xet
 *
 * A Git LFS custom transfer agent (the "Xet" model): chunk-aware, resumable,
 * deduplicated large-file transfer that stays LFS-interoperable. It is a THIN
 * ADAPTER over two existing pieces — `@statewalker/vcs-transport-lfs` for batch
 * negotiation + the basic (whole-object) fallback, and
 * `@statewalker/webrun-content-transfer` for the chunk-dedup engine. It negotiates via
 * the standard LFS batch API advertising a `xet` custom transfer; when the peer
 * agrees it moves only the missing chunks, otherwise it falls back to whole-object
 * basic LFS. The whole-file SHA-256 (the LFS oid) is the interop identity. It
 * owns no chunking/CDC (content-store), no batch/basic internals
 * (vcs-transport-lfs), no chunk protocol (content-transfer), and no pointers.
 */

export {
  BASIC_TRANSFER,
  XET_TRANSFER,
  XET_TRANSFERS,
  type XetBatchAction,
  type XetBatchObjectResponse,
  type XetBatchResponse,
} from "./batch.js";
export { xetDownload, xetUpload } from "./client.js";
export { serveXet } from "./server.js";
export type {
  FetchLike,
  HashContent,
  LfsPointer,
  TransportEvent,
  XetOptions,
  XetTransportEvent,
} from "./types.js";
