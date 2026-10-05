/**
 * The xet extension over the standard LFS batch shapes.
 *
 * The batch REQUEST advertises `transfers: ["xet","basic"]` (xet preferred,
 * basic as the interop floor). The RESPONSE's top-level `transfer` is `"xet"`
 * only when the server agreed; otherwise it is `"basic"` and the client falls
 * back to `@statewalker/vcs-transport-lfs`. A xet action extends the LFS
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
export const XET_TRANSFER = "xet";

/** The transfers a xet client advertises, in preference order. */
export const XET_TRANSFERS = [XET_TRANSFER, BASIC_TRANSFER];

/**
 * A xet batch action: the LFS `{href, header?}` plus the peer's content-store
 * `objectId`. On `download` the client transfers FROM that id; on `upload` it
 * is the href of the per-oid chunk channel (objectId is the client's own).
 */
export interface XetBatchAction extends BatchAction {
  objectId?: string;
}

export interface XetBatchObjectResponse extends BatchObjectResponse {
  actions?: { upload?: XetBatchAction; download?: XetBatchAction };
}

export interface XetBatchResponse extends BatchResponse {
  objects: XetBatchObjectResponse[];
}
