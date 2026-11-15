/**
 * Git LFS batch API wire shapes (JSON). These mirror the standard spec:
 * request `{ operation, transfers, objects, hash_algo? }`; response `{ transfer,
 * objects, hash_algo? }` where each object carries `actions` (per-op `{href,
 * header?, expires_in?}`), no actions at all (an upload the server already
 * holds), or an `error {code, message}`. Only the `basic` transfer is supported.
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
  /** The oid hash algorithm; `sha256` when absent (the only one served). */
  hash_algo?: string;
}

/** A single basic-transfer action: where + how to move the whole object. */
export interface BatchAction {
  href: string;
  header?: Record<string, string>;
  /** Seconds the action stays valid. */
  expires_in?: number;
  /** When the action stops being valid (ISO 8601). */
  expires_at?: string;
}

/** One object in a batch response: either `actions` or an `error`. */
export interface BatchObjectResponse {
  oid: string;
  size: number;
  /** The actions' own headers authorize the transfers: send no other credentials. */
  authenticated?: boolean;
  actions?: { upload?: BatchAction; download?: BatchAction; verify?: BatchAction };
  error?: { code: number; message: string };
}

/** `POST /objects/batch` response body. */
export interface BatchResponse {
  transfer: string;
  objects: BatchObjectResponse[];
  hash_algo?: string;
}
