/**
 * The webrun-chunks extension over the standard LFS batch shapes.
 *
 * The batch REQUEST advertises `transfers: ["webrun-chunks","basic"]` (webrun-chunks preferred,
 * basic as the interop floor). The RESPONSE's top-level `transfer` is `"webrun-chunks"`
 * only when the server agreed; otherwise it is `"basic"` and the client falls
 * back to `@statewalker/vcs-transport-lfs`. A webrun-chunks action extends the LFS
 * `{href}` action with the peer's content-store object id, which the client
 * needs to drive the chunk-level {@link import("@statewalker/webrun-content-transfer").transfer}.
 */

import type {
  BatchAction,
  BatchObjectResponse,
  BatchResponse,
} from "@statewalker/vcs-transport-lfs";
import { BASIC_TRANSFER } from "@statewalker/vcs-transport-lfs";

export { BASIC_TRANSFER };

/** The custom transfer this package advertises + implements. */
export const WEBRUN_CHUNKS_TRANSFER = "webrun-chunks";

/** The transfers a webrun-chunks client advertises, in preference order. */
export const WEBRUN_CHUNKS_TRANSFERS = [WEBRUN_CHUNKS_TRANSFER, BASIC_TRANSFER];

/**
 * A webrun-chunks batch action: the LFS `{href, header?}` plus the peer's content-store
 * `objectId`. On `download` the client transfers FROM that id; on `upload` it
 * is the href of the per-oid chunk channel (objectId is the client's own).
 */
export interface WebrunChunksBatchAction extends BatchAction {
  objectId?: string;
}

export interface WebrunChunksBatchObjectResponse extends BatchObjectResponse {
  actions?: { upload?: WebrunChunksBatchAction; download?: WebrunChunksBatchAction };
}

export interface WebrunChunksBatchResponse extends BatchResponse {
  objects: WebrunChunksBatchObjectResponse[];
}
