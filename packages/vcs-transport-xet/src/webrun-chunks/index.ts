/**
 * @statewalker/vcs-transport-xet/webrun-chunks
 *
 * The webrun private chunk transfer: a Git LFS custom transfer agent named
 * `webrun-chunks` (formerly advertised as `xet`; renamed because it is NOT
 * Hugging Face Xet, which the package root now implements). It negotiates via
 * the standard LFS batch API, advertising `["webrun-chunks", "basic"]`. When
 * the peer agrees it moves only the missing chunks through
 * `@statewalker/webrun-content-transfer`; otherwise it falls back to
 * whole-object basic LFS from `@statewalker/vcs-transport-lfs`. The whole-file
 * SHA-256 (the LFS oid) is the interop identity. It owns no chunking/CDC
 * (content-store), no batch/basic internals (vcs-transport-lfs), no chunk
 * protocol (content-transfer), and no pointers.
 */

export {
  BASIC_TRANSFER,
  WEBRUN_CHUNKS_TRANSFER,
  WEBRUN_CHUNKS_TRANSFERS,
  type WebrunChunksBatchAction,
  type WebrunChunksBatchObjectResponse,
  type WebrunChunksBatchResponse,
} from "./batch.js";
export { webrunChunksDownload, webrunChunksUpload } from "./client.js";
export { serveWebrunChunks } from "./server.js";
export type {
  FetchLike,
  HashContent,
  LfsPointer,
  TransportEvent,
  WebrunChunksOptions,
  WebrunChunksTransportEvent,
} from "./types.js";
