/**
 * Git Files Tree Delta API - Binary delta storage for tree objects
 *
 * Wraps DeltaStore's delta operations with the typed TreeDeltaApi interface.
 * Uses Git's native binary delta format (same as blobs) rather than structural deltas.
 *
 * This mirrors GitFilesBlobDeltaApi but for tree objects, enabling delta
 * compression of trees in Git-files backends.
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type { Trees } from "../../history/trees/trees.js";
import type {
  BlobDeltaChainInfo,
  DeltaCandidateSource,
  StreamingDeltaResult,
} from "./blob-delta-api.js";
import { parseBinaryDelta } from "./delta-binary-format.js";
import type { DeltaStore } from "./delta-store.js";
import type { TreeDeltaApi } from "./tree-delta-api.js";

/**
 * TreeDeltaApi implementation using DeltaStore
 *
 * Wraps DeltaStore's delta operations with the typed TreeDeltaApi interface.
 * Uses the same binary delta format as blobs - Git's OFS_DELTA/REF_DELTA.
 *
 * @internal Exported for use by createGitFilesHistory
 */
export class GitFilesTreeDeltaApi implements TreeDeltaApi {
  constructor(
    private readonly packDeltaStore: DeltaStore,
    readonly _trees: Trees,
  ) {}

  async findTreeDelta(
    _targetId: ObjectId,
    _candidates: DeltaCandidateSource,
  ): Promise<StreamingDeltaResult | null> {
    // Delta computation is handled by DeltaEngine externally
    // This API is for storage operations, not computation
    return null;
  }

  async deltifyTree(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    // Collect delta bytes
    const chunks: Uint8Array[] = [];
    for await (const chunk of delta) {
      chunks.push(chunk);
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

  async undeltifyTree(id: ObjectId): Promise<void> {
    // Load resolved content from pack
    const content = await this.packDeltaStore.loadObject?.(id);
    if (!content) {
      throw new Error(`Tree ${id} not found in pack files`);
    }

    // The content is now resolved - removing delta just means
    // the pack file marks it as removed (handled by removeDelta)
    await this.packDeltaStore.removeDelta(id, true);
  }

  async isTreeDelta(id: ObjectId): Promise<boolean> {
    return this.packDeltaStore.isDelta(id);
  }

  async getTreeDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const chainInfo = await this.packDeltaStore.getDeltaChainInfo(id);
    if (!chainInfo) return undefined;

    return {
      depth: chainInfo.depth,
      totalSize: chainInfo.compressedSize,
      baseIds: chainInfo.chain,
    };
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
