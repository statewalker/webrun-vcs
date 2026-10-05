/**
 * In-memory BinStore implementation
 *
 * Composite storage that combines RawStorage and DeltaStore.
 * Implements the BinStore interface from binary-storage.
 */

import {
  type BinStore,
  type DeltaStore,
  MemoryRawStorage,
  type RawStorage,
} from "@statewalker/vcs-core";

import { MemDeltaStore } from "./mem-delta-store.js";

/**
 * In-memory composite binary storage
 *
 * Provides both raw and delta-compressed storage in memory.
 */
export class MemBinStore implements BinStore {
  readonly name = "memory";
  readonly raw: RawStorage;
  readonly delta: DeltaStore;

  private readonly _rawStore: MemoryRawStorage;
  private readonly _deltaStore: MemDeltaStore;

  constructor() {
    this._rawStore = new MemoryRawStorage();
    this._deltaStore = new MemDeltaStore();
    this.raw = this._rawStore;
    this.delta = this._deltaStore;
  }

  /**
   * Flush pending writes (no-op for memory storage)
   */
  async flush(): Promise<void> {
    // No-op: memory storage has no pending writes
  }

  /**
   * Close backend and release resources
   */
  async close(): Promise<void> {
    // No-op: memory storage has no external resources
  }

  /**
   * Refresh backend state (no-op for memory storage)
   */
  async refresh(): Promise<void> {
    // No-op: memory storage is always current
  }

  /**
   * Clear all stored data
   */
  clear(): void {
    this._rawStore.clear();
    this._deltaStore.clear();
  }
}

/**
 * Create a new in-memory binary store
 */
export function createMemBinStore(): MemBinStore {
  return new MemBinStore();
}
