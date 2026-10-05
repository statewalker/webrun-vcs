/**
 * Git Files Storage Backend
 *
 * Delta and factory implementations for Git file-based storage:
 * - Loose objects in objects/XX/XXXX... files
 * - Pack files in objects/pack/*.pack with .idx index files
 * - Delta compression using Git's OFS_DELTA/REF_DELTA formats
 *
 * ## Usage
 *
 * Use the factory function:
 * - `createGitFilesHistory()` - Creates HistoryWithOperations directly
 */

import type { ObjectId } from "../common/id/object-id.js";
import type { Blobs } from "../history/blobs/blobs.js";
import type { Commits } from "../history/commits/commits.js";
import type { Refs } from "../history/refs/refs.js";
import type { Tags } from "../history/tags/tags.js";
import type { Trees } from "../history/trees/trees.js";
import type {
  BlobDeltaApi,
  BlobDeltaChainInfo,
  StreamingDeltaResult,
} from "../storage/delta/blob-delta-api.js";
import type { CommitDeltaApi } from "../storage/delta/commit-delta-api.js";
import type { DeltaApi, StorageDeltaRelationship } from "../storage/delta/delta-api.js";
import { parseBinaryDelta } from "../storage/delta/delta-binary-format.js";
import type { DeltaStore } from "../storage/delta/delta-store.js";
import { GitFilesCommitDeltaApi } from "../storage/delta/git-commit-delta-api.js";
import { GitFilesTreeDeltaApi } from "../storage/delta/git-tree-delta-api.js";
import type { TreeDeltaApi } from "../storage/delta/tree-delta-api.js";
import type { BaseBackendConfig } from "./history-backend-factory.js";

/**
 * Configuration for GitFilesStorageBackend
 *
 * Uses the new unified interfaces (Blobs, Trees, Commits, Tags, Refs)
 * instead of the legacy store types.
 */
export interface GitFilesStorageBackendConfig extends BaseBackendConfig {
  /** Blob storage implementation */
  blobs: Blobs;
  /** Tree storage implementation */
  trees: Trees;
  /** Commit storage implementation */
  commits: Commits;
  /** Tag storage implementation */
  tags: Tags;
  /** Reference storage implementation */
  refs: Refs;
  /** Pack-based delta store for native Git delta operations */
  packDeltaStore: DeltaStore;
}

/**
 * BlobDeltaApi implementation using DeltaStore
 *
 * Wraps DeltaStore's delta operations with the typed BlobDeltaApi interface.
 *
 * @internal Exported for use by createGitFilesHistory
 */
export class GitFilesBlobDeltaApi implements BlobDeltaApi {
  constructor(
    private readonly packDeltaStore: DeltaStore,
    private readonly blobs: Blobs,
  ) {}

  async findBlobDelta(
    _targetId: ObjectId,
    _candidates: AsyncIterable<ObjectId>,
  ): Promise<StreamingDeltaResult | null> {
    // Delta computation is handled by DeltaEngine externally
    // This API is for storage operations, not computation
    return null;
  }

  async deltifyBlob(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    // Collect delta bytes
    const chunks: Uint8Array[] = [];
    for await (const chunk of delta) {
      chunks.push(chunk);
    }

    // Get blob content for the target to store as full object first
    const targetContent = await this.loadBlobContent(targetId);
    if (!targetContent) {
      throw new Error(`Target blob ${targetId} not found`);
    }

    // Start batch update to create pack with delta
    const update = this.packDeltaStore.startUpdate();

    // Store target as delta
    const deltaBytes = concatBytes(chunks);
    const deltaInstructions = parseBinaryDelta(deltaBytes);

    await update.storeDelta({ baseKey: baseId, targetKey: targetId }, deltaInstructions);

    // Commit the pack
    await update.close();
  }

  async undeltifyBlob(id: ObjectId): Promise<void> {
    // Load resolved content from pack
    const content = await this.packDeltaStore.loadObject?.(id);
    if (!content) {
      throw new Error(`Blob ${id} not found in pack files`);
    }

    // The content is now resolved - removing delta just means
    // the pack file marks it as removed (handled by removeDelta)
    await this.packDeltaStore.removeDelta(id, true);
  }

  async isBlobDelta(id: ObjectId): Promise<boolean> {
    return this.packDeltaStore.isDelta(id);
  }

  async getBlobDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const chainInfo = await this.packDeltaStore.getDeltaChainInfo(id);
    if (!chainInfo) return undefined;

    return {
      depth: chainInfo.depth,
      totalSize: chainInfo.compressedSize,
      baseIds: chainInfo.chain,
    };
  }

  private async loadBlobContent(id: ObjectId): Promise<Uint8Array | null> {
    const stream = await this.blobs.load(id);
    if (!stream) {
      return null;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return concatBytes(chunks);
  }
}

/**
 * DeltaApi implementation using DeltaStore
 *
 * Provides the unified delta interface backed by Git pack files.
 *
 * @internal Exported for use by createGitFilesHistory
 */
export class GitFilesDeltaApi implements DeltaApi {
  readonly blobs: BlobDeltaApi;
  readonly trees?: TreeDeltaApi;
  readonly commits?: CommitDeltaApi;
  private batchDepth = 0;

  constructor(
    private readonly packDeltaStore: DeltaStore,
    blobs: Blobs,
    trees?: Trees,
    options?: { enableCommitDeltas?: boolean },
  ) {
    this.blobs = new GitFilesBlobDeltaApi(packDeltaStore, blobs);
    if (trees) {
      this.trees = new GitFilesTreeDeltaApi(packDeltaStore, trees);
    }
    if (options?.enableCommitDeltas !== false) {
      this.commits = new GitFilesCommitDeltaApi(packDeltaStore);
    }
  }

  async isDelta(id: ObjectId): Promise<boolean> {
    if (await this.packDeltaStore.isDelta(id)) return true;
    return false;
  }

  async getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const blobChain = await this.blobs.getBlobDeltaChain(id);
    if (blobChain) return blobChain;
    if (this.trees) {
      const treeChain = this.trees.getTreeDeltaChain(id);
      if (treeChain) return treeChain;
    }
    if (this.commits) return this.commits.getCommitDeltaChain(id);
    return undefined;
  }

  async *listDeltas(): AsyncIterable<StorageDeltaRelationship> {
    for await (const deltaInfo of this.packDeltaStore.listDeltas()) {
      const chainInfo = await this.packDeltaStore.getDeltaChainInfo(deltaInfo.targetKey);
      yield {
        targetId: deltaInfo.targetKey,
        baseId: deltaInfo.baseKey,
        depth: chainInfo?.depth ?? 1,
        ratio: 0, // Would need to compute from sizes
      };
    }
  }

  async *getDependents(baseId: ObjectId): AsyncIterable<ObjectId> {
    const dependents = (await this.packDeltaStore.findDependents?.(baseId)) ?? [];
    for (const dep of dependents) {
      yield dep;
    }
  }

  startBatch(): void {
    this.batchDepth++;
    // DeltaStore uses startUpdate() per batch, not global state
  }

  async endBatch(): Promise<void> {
    if (this.batchDepth <= 0) {
      throw new Error("No batch in progress");
    }
    this.batchDepth--;
    // Each deltifyBlob creates its own update and commits
  }

  cancelBatch(): void {
    if (this.batchDepth > 0) {
      this.batchDepth--;
    }
  }
}

/**
 * Concatenate byte arrays
 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
