/**
 * Memory Tree Delta API - In-memory structural tree delta storage
 *
 * Stores tree deltas as structural diffs (add/modify/delete of entries)
 * in an in-memory Map. Suitable for testing and ephemeral storage.
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type { TreeEntry } from "../../history/trees/tree-entry.js";
import type { Trees } from "../../history/trees/trees.js";
import type { BlobDeltaChainInfo, StreamingDeltaResult } from "./blob-delta-api.js";
import {
  applyStructuralTreeDelta,
  computeStructuralTreeDelta,
  parseStructuralDelta,
  serializeStructuralDelta,
} from "./structural-tree-delta.js";
import type { StructuralTreeDelta, TreeDeltaApi, TreeDeltaChange } from "./tree-delta-api.js";

/**
 * Stored structural delta entry
 */
interface StoredTreeDelta {
  baseId: ObjectId;
  changes: TreeDeltaChange[];
}

/**
 * In-memory TreeDeltaApi using structural deltas.
 *
 * Trees are diffed at the entry level: each change is an add, modify,
 * or delete of a named entry. This is more efficient than binary deltas
 * for backends that already store trees in normalized form.
 */
export class MemoryTreeDeltaApi implements TreeDeltaApi {
  /** Map from target tree ID to its structural delta */
  private readonly deltas = new Map<ObjectId, StoredTreeDelta>();
  /** Maximum allowed delta chain depth */
  private readonly maxChainDepth: number;

  constructor(
    private readonly trees: Trees,
    options?: { maxChainDepth?: number },
  ) {
    this.maxChainDepth = options?.maxChainDepth ?? 10;
  }

  async findTreeDelta(
    _targetId: ObjectId,
    _candidates: AsyncIterable<ObjectId>,
  ): Promise<StreamingDeltaResult | null> {
    // Delta finding is handled externally by DeltaEngine
    return null;
  }

  async deltifyTree(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    // Collect delta bytes and parse structural delta
    const chunks: Uint8Array[] = [];
    for await (const chunk of delta) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const deltaBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      deltaBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const parsed = parseStructuralDelta(deltaBytes);

    this.deltas.set(targetId, {
      baseId: parsed.baseTreeId || baseId,
      changes: parsed.changes,
    });
  }

  async undeltifyTree(id: ObjectId): Promise<void> {
    const stored = this.deltas.get(id);
    if (!stored) return;

    // Resolve the full tree by loading base and applying changes
    const baseEntries = await this.loadTreeEntries(stored.baseId);
    const targetEntries = applyStructuralTreeDelta(baseEntries, stored.changes);

    // Store reconstructed tree
    await this.trees.store(targetEntries);

    // Remove delta
    this.deltas.delete(id);
  }

  async isTreeDelta(id: ObjectId): Promise<boolean> {
    return this.deltas.has(id);
  }

  async getTreeDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const stored = this.deltas.get(id);
    if (!stored) return undefined;

    const baseIds: ObjectId[] = [stored.baseId];
    let depth = 1;
    let currentBaseId = stored.baseId;

    // Walk the chain
    while (depth < this.maxChainDepth) {
      const baseDelta = this.deltas.get(currentBaseId);
      if (!baseDelta) break;
      baseIds.push(baseDelta.baseId);
      currentBaseId = baseDelta.baseId;
      depth++;
    }

    return {
      depth,
      totalSize: 0, // Memory backend doesn't track sizes
      baseIds,
    };
  }

  /**
   * Deltify a tree from entry arrays directly (convenience for memory backend).
   *
   * Computes structural delta and stores it without serialization roundtrip.
   */
  async deltifyTreeFromEntries(
    targetId: ObjectId,
    baseId: ObjectId,
    baseEntries: TreeEntry[],
    targetEntries: TreeEntry[],
  ): Promise<void> {
    const changes = computeStructuralTreeDelta(baseEntries, targetEntries);
    this.deltas.set(targetId, { baseId, changes });
  }

  /**
   * Get the stored structural delta for a tree (for testing/inspection).
   */
  getStoredDelta(id: ObjectId): StoredTreeDelta | undefined {
    return this.deltas.get(id);
  }

  /**
   * Reconstruct full tree entries from a potentially deltified tree.
   */
  async resolveTreeEntries(id: ObjectId): Promise<TreeEntry[]> {
    const stored = this.deltas.get(id);
    if (!stored) {
      return this.loadTreeEntries(id);
    }

    const baseEntries = await this.resolveTreeEntries(stored.baseId);
    return applyStructuralTreeDelta(baseEntries, stored.changes);
  }

  private async loadTreeEntries(treeId: ObjectId): Promise<TreeEntry[]> {
    const tree = await this.trees.load(treeId);
    if (!tree) {
      throw new Error(`Tree not found: ${treeId}`);
    }
    const entries: TreeEntry[] = [];
    for await (const entry of tree) {
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Create a serialized structural delta for wire transmission.
   */
  createSerializedDelta(baseId: ObjectId, changes: TreeDeltaChange[]): Uint8Array {
    const delta: StructuralTreeDelta = { baseTreeId: baseId, changes };
    return serializeStructuralDelta(delta);
  }
}
