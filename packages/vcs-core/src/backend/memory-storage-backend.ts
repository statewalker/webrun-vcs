/**
 * Memory Storage Backend
 *
 * In-memory implementations of DeltaApi for testing and ephemeral storage.
 *
 * ## Usage
 *
 * Use the factory function for new code:
 * - `createMemoryHistoryWithOperations()` - Creates HistoryWithOperations directly
 */

import type { ObjectId } from "../common/id/object-id.js";
import type { Blobs } from "../history/blobs/blobs.js";
import type { Trees } from "../history/trees/trees.js";
import type {
  BlobDeltaApi,
  BlobDeltaChainInfo,
  StreamingDeltaResult,
} from "../storage/delta/blob-delta-api.js";
import type { DeltaApi, StorageDeltaRelationship } from "../storage/delta/delta-api.js";
import { MemoryTreeDeltaApi } from "../storage/delta/memory-tree-delta-api.js";
import type { TreeDeltaApi } from "../storage/delta/tree-delta-api.js";

/**
 * Simple delta tracking interface for memory backend
 *
 * Tracks which blobs are stored as deltas vs full content.
 */
export interface DeltaTracker {
  /** Check if blob is stored as delta */
  isDelta(id: ObjectId): Promise<boolean>;
  /** Get delta chain info */
  getChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;
  /** Store blob as delta */
  storeDelta(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: Iterable<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void>;
  /** Expand delta to full content */
  undeltify(id: ObjectId): Promise<void>;
  /** List all delta relationships */
  listDeltas(): AsyncIterable<StorageDeltaRelationship>;
  /** Get dependents of a base */
  getDependents(baseId: ObjectId): AsyncIterable<ObjectId>;
}

/**
 * In-memory BlobDeltaApi implementation
 *
 * Uses the new Blobs interface.
 *
 * @internal Exported for use by createMemoryHistoryWithOperations
 */
export class MemoryBlobDeltaApi implements BlobDeltaApi {
  constructor(
    readonly _blobs: Blobs,
    private readonly tracker: DeltaTracker | undefined,
  ) {}

  async findBlobDelta(
    _targetId: ObjectId,
    _candidates: AsyncIterable<ObjectId>,
  ): Promise<StreamingDeltaResult | null> {
    // Memory backend doesn't compute deltas internally
    // Delta computation is handled by DeltaEngine externally
    return null;
  }

  async deltifyBlob(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    if (!this.tracker) {
      // No delta tracking - silently ignore
      return;
    }
    await this.tracker.storeDelta(targetId, baseId, delta);
  }

  async undeltifyBlob(id: ObjectId): Promise<void> {
    if (!this.tracker) {
      return;
    }
    await this.tracker.undeltify(id);
  }

  async isBlobDelta(id: ObjectId): Promise<boolean> {
    if (!this.tracker) {
      return false;
    }
    return this.tracker.isDelta(id);
  }

  async getBlobDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    if (!this.tracker) {
      return undefined;
    }
    return this.tracker.getChain(id);
  }
}

/**
 * In-memory DeltaApi implementation
 *
 * Uses the new Blobs interface.
 *
 * @internal Exported for use by createMemoryHistoryWithOperations
 */
export class MemoryDeltaApi implements DeltaApi {
  readonly blobs: BlobDeltaApi;
  readonly trees?: TreeDeltaApi;
  private batchDepth = 0;

  constructor(
    blobs: Blobs,
    private readonly tracker: DeltaTracker | undefined,
    trees?: Trees,
  ) {
    this.blobs = new MemoryBlobDeltaApi(blobs, tracker);
    if (trees) {
      this.trees = new MemoryTreeDeltaApi(trees);
    }
  }

  async isDelta(id: ObjectId): Promise<boolean> {
    if (await this.blobs.isBlobDelta(id)) return true;
    if (this.trees && (await this.trees.isTreeDelta(id))) return true;
    return false;
  }

  async getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const blobChain = await this.blobs.getBlobDeltaChain(id);
    if (blobChain) return blobChain;
    if (this.trees) {
      return this.trees.getTreeDeltaChain(id);
    }
    return undefined;
  }

  async *listDeltas(): AsyncIterable<StorageDeltaRelationship> {
    if (this.tracker) {
      yield* this.tracker.listDeltas();
    }
  }

  async *getDependents(baseId: ObjectId): AsyncIterable<ObjectId> {
    if (this.tracker) {
      yield* this.tracker.getDependents(baseId);
    }
  }

  startBatch(): void {
    this.batchDepth++;
  }

  async endBatch(): Promise<void> {
    if (this.batchDepth <= 0) {
      throw new Error("No batch in progress");
    }
    this.batchDepth--;
    // Memory backend doesn't need atomic commit
  }

  cancelBatch(): void {
    if (this.batchDepth > 0) {
      this.batchDepth--;
    }
    // Memory backend doesn't need rollback
  }
}
