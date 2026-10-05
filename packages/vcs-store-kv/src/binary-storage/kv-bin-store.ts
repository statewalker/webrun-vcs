/**
 * Key-Value based BinStore implementation
 *
 * Composite storage that combines KvRawStore and KvDeltaStore.
 * Implements the BinStore interface from binary-storage.
 */

import type { BinStore, DeltaStore, RawStorage } from "@statewalker/vcs-core";
import type { KVStore } from "../kv-store.js";
import { KvDeltaStore } from "./kv-delta-store.js";
import { KvRawStore } from "./kv-raw-store.js";

/**
 * KV-based composite binary storage
 *
 * Provides both raw and delta-compressed storage using a key-value store.
 */
export class KvBinStore implements BinStore {
  readonly name = "kv";
  readonly raw: RawStorage;
  readonly delta: DeltaStore;

  private readonly _rawStore: KvRawStore;
  private readonly _deltaStore: KvDeltaStore;

  /**
   * Create KV-based binary store
   *
   * @param kv Key-value store
   * @param rawPrefix Key prefix for raw storage (default: "raw")
   * @param deltaPrefix Key prefix for delta storage (default: "delta")
   */
  constructor(
    private readonly kv: KVStore,
    rawPrefix?: string,
    deltaPrefix?: string,
  ) {
    this._rawStore = new KvRawStore(kv, rawPrefix);
    this._deltaStore = new KvDeltaStore(kv, deltaPrefix);
    this.raw = this._rawStore;
    this.delta = this._deltaStore;
  }

  /**
   * Flush pending writes
   *
   * For KV storage with immediate writes, this is typically a no-op.
   */
  async flush(): Promise<void> {
    // No-op: KV writes are typically immediate
  }

  /**
   * Close backend and release resources
   */
  async close(): Promise<void> {
    if (this.kv.close) {
      await this.kv.close();
    }
  }

  /**
   * Refresh backend state
   *
   * For KV storage, this could be used to clear any caches.
   */
  async refresh(): Promise<void> {
    // No-op: KV storage has no caches to refresh
  }
}

/**
 * Create a new KV-based binary store
 */
export function createKvBinStore(
  kv: KVStore,
  rawPrefix?: string,
  deltaPrefix?: string,
): KvBinStore {
  return new KvBinStore(kv, rawPrefix, deltaPrefix);
}
