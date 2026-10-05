/**
 * In-memory DeltaStore implementation
 *
 * Stores delta relationships and instructions in memory.
 * Implements the new DeltaStore interface from binary-storage.
 */

import type {
  DeltaChainDetails,
  DeltaInfo,
  DeltaStore,
  DeltaStoreUpdate,
  StoredDelta,
} from "@statewalker/vcs-core";
import type { Delta } from "@statewalker/vcs-utils";

/**
 * Internal delta entry storage
 */
interface DeltaEntry {
  baseKey: string;
  targetKey: string;
  delta: Delta[];
  ratio: number;
}

/**
 * Pending delta for batch update
 */
interface PendingDelta {
  info: DeltaInfo;
  delta: Delta[];
}

/**
 * Batched update handle for in-memory delta storage
 */
class MemDeltaStoreUpdate implements DeltaStoreUpdate {
  private readonly pendingDeltas: PendingDelta[] = [];
  private readonly store: MemDeltaStore;
  private closed = false;

  constructor(store: MemDeltaStore) {
    this.store = store;
  }

  /**
   * Store a full object - no-op for memory store (objects stored elsewhere)
   */
  async storeObject(
    _key: string,
    _content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Update already closed");
    }
    // Memory delta store only handles deltas, not full objects
    // Full objects are stored in MemRawStore
  }

  /**
   * Store a delta relationship in this batch
   */
  async storeDelta(info: DeltaInfo, delta: Delta[]): Promise<number> {
    if (this.closed) {
      throw new Error("Update already closed");
    }

    this.pendingDeltas.push({ info, delta });

    // Calculate approximate size
    return delta.reduce((sum, d) => {
      switch (d.type) {
        case "copy":
          return sum + 8;
        case "insert":
          return sum + 1 + d.data.length;
        case "start":
        case "finish":
          return sum + 4;
        default:
          return sum;
      }
    }, 0);
  }

  /**
   * Commit all pending deltas
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // Apply all pending deltas
    for (const { info, delta } of this.pendingDeltas) {
      this.store.applyDelta(info, delta);
    }
  }
}

/**
 * In-memory delta storage implementation
 *
 * Stores delta relationships with support for chain traversal.
 * Maximum chain depth is enforced to prevent infinite loops.
 */
export class MemDeltaStore implements DeltaStore {
  private readonly deltas = new Map<string, DeltaEntry>();
  private readonly maxChainDepth = 50;

  /**
   * Start a batched update transaction
   */
  startUpdate(): DeltaStoreUpdate {
    return new MemDeltaStoreUpdate(this);
  }

  /**
   * Apply a delta (internal method used by update)
   */
  applyDelta(info: DeltaInfo, delta: Delta[]): void {
    // Calculate approximate ratio
    const deltaSize = delta.reduce((sum, d) => {
      switch (d.type) {
        case "copy":
          return sum + 8;
        case "insert":
          return sum + 1 + d.data.length;
        case "start":
        case "finish":
          return sum + 4;
        default:
          return sum;
      }
    }, 0);

    const ratio = deltaSize > 0 ? 1 : 0;

    this.deltas.set(info.targetKey, {
      baseKey: info.baseKey,
      targetKey: info.targetKey,
      delta,
      ratio,
    });
  }

  /**
   * Load delta for an object
   */
  async loadDelta(targetKey: string): Promise<StoredDelta | undefined> {
    const entry = this.deltas.get(targetKey);
    if (!entry) {
      return undefined;
    }

    return {
      baseKey: entry.baseKey,
      targetKey: entry.targetKey,
      delta: entry.delta,
      ratio: entry.ratio,
    };
  }

  /**
   * Check if object is stored as delta
   */
  async isDelta(targetKey: string): Promise<boolean> {
    return this.deltas.has(targetKey);
  }

  /**
   * Remove delta relationship
   */
  async removeDelta(targetKey: string, _keepAsBase?: boolean): Promise<boolean> {
    return this.deltas.delete(targetKey);
  }

  /**
   * Get delta chain info for an object
   */
  async getDeltaChainInfo(targetKey: string): Promise<DeltaChainDetails | undefined> {
    const entry = this.deltas.get(targetKey);
    if (!entry) {
      return undefined;
    }

    // Build chain
    const chain: string[] = [targetKey];
    let current = entry;
    let depth = 1;
    const totalSize = 0;

    while (current && depth < this.maxChainDepth) {
      const baseEntry = this.deltas.get(current.baseKey);
      if (!baseEntry) {
        // Found the base object
        chain.push(current.baseKey);
        break;
      }
      chain.push(current.baseKey);
      current = baseEntry;
      depth++;
    }

    // Calculate sizes (approximate)
    let compressedSize = 0;
    for (const key of chain) {
      const deltaEntry = this.deltas.get(key);
      if (deltaEntry) {
        compressedSize += deltaEntry.delta.reduce((sum, d) => {
          switch (d.type) {
            case "copy":
              return sum + 8;
            case "insert":
              return sum + 1 + d.data.length;
            case "start":
            case "finish":
              return sum + 4;
            default:
              return sum;
          }
        }, 0);
      }
    }

    return {
      baseKey: chain[chain.length - 1],
      targetKey,
      depth,
      originalSize: totalSize,
      compressedSize,
      chain,
    };
  }

  /**
   * List all delta relationships
   */
  async *listDeltas(): AsyncIterable<DeltaInfo> {
    for (const entry of this.deltas.values()) {
      yield {
        baseKey: entry.baseKey,
        targetKey: entry.targetKey,
      };
    }
  }

  /**
   * Clear all stored deltas
   */
  clear(): void {
    this.deltas.clear();
  }

  /**
   * Get number of stored deltas
   */
  get count(): number {
    return this.deltas.size;
  }
}
