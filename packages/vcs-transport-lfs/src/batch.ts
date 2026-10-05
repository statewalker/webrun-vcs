/**
 * Git LFS batch API wire shapes (JSON). These mirror the standard spec:
 * request `{ operation, transfers, objects }`; response `{ transfer, objects }`
 * where each object carries either `actions` (per-op `{href, header?}`) or an
 * `error {code, message}`. Only the `basic` transfer is supported.
 */

/** The one transfer adapter this package implements. */
export const BASIC_TRANSFER = "basic";

/** Git LFS batch/pointer JSON media type. */
export const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";

/** One object in a batch request (`{oid, size}`). */
export interface BatchObjectRequest {
  oid: string;
  size: number;
}

/** `POST /objects/batch` request body. */
export interface BatchRequest {
  operation: "upload" | "download";
  transfers: string[];
  objects: BatchObjectRequest[];
}

/** A single basic-transfer action: where + how to move the whole object. */
export interface BatchAction {
  href: string;
  header?: Record<string, string>;
}

/** One object in a batch response: either `actions` or an `error`. */
export interface BatchObjectResponse {
  oid: string;
  size: number;
  actions?: { upload?: BatchAction; download?: BatchAction };
  error?: { code: number; message: string };
}

/** `POST /objects/batch` response body. */
export interface BatchResponse {
  transfer: string;
  objects: BatchObjectResponse[];
}
