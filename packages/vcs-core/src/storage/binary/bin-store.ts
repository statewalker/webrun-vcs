/**
 * Binary storage interface
 *
 * Combines raw byte storage with delta compression support.
 * This is the main abstraction for binary object storage in backends
 * like KV, SQL, and in-memory stores.
 */

import type { DeltaStore } from "../delta/delta-store.js";
import type { RawStorage } from "../raw/raw-storage.js";

/**
 * Binary storage combining raw and delta stores
 *
 * This interface is used by external storage backends (KV, SQL, memory)
 * to provide both raw byte storage and delta compression capabilities.
 */
export interface BinStore {
  /** Store name identifier */
  readonly name: string;
  /** Raw byte storage */
  readonly raw: RawStorage;
  /** Delta-compressed storage */
  readonly delta: DeltaStore;
  /** Flush pending writes to persistent storage */
  flush(): Promise<void>;
  /** Close backend and release resources */
  close(): Promise<void>;
  /** Refresh backend state (clear caches, etc.) */
  refresh(): Promise<void>;
}
