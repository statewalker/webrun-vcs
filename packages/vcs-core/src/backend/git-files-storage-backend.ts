/**
 * Git Files Storage Backend
 *
 * Configuration and delta view of a Git file-based store:
 * - Loose objects in objects/XX/XXXX... files
 * - Pack files in objects/pack/*.pack with .idx index files (a `PackSet`)
 *
 * Git keeps deltas only inside packs, and those are written whole by `writePack` (a repack
 * searches deltas itself). The delta API of this backend is therefore a read-only view of the
 * installed packs: it reports which objects are stored as deltas and their chains.
 *
 * ## Usage
 *
 * Use the factory function:
 * - `createGitFilesHistory()` - Creates HistoryWithOperations directly
 */

import type { ObjectId } from "../common/id/object-id.js";
import type { Blobs } from "../history/blobs/blobs.js";
import type { Commits } from "../history/commits/commits.js";
import type { GitObjects } from "../history/objects/git-objects.js";
import type { Refs } from "../history/refs/refs.js";
import type { Tags } from "../history/tags/tags.js";
import type { Trees } from "../history/trees/trees.js";
import type { PackSet } from "../pack/pack-set.js";
import type {
  BlobDeltaApi,
  BlobDeltaChainInfo,
  StreamingDeltaResult,
} from "../storage/delta/blob-delta-api.js";
import type { DeltaApi, StorageDeltaRelationship } from "../storage/delta/delta-api.js";
import type { BaseBackendConfig } from "./history-backend-factory.js";

/**
 * Configuration for GitFilesStorageBackend
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
  /** The object kernel under the stores; received packs are written through it */
  objects?: GitObjects;
  /** The installed packs: read by the delta API, and where large received packs are kept */
  packs: PackSet;
}

/** Longest chain followed by `getDeltaChain` (git's pack.depth is 50; 4095 is git's maximum). */
const MAX_CHAIN = 4096;

const isDeltaKind = (kind: number) => kind === 6 || kind === 7;

/**
 * The delta view of a `PackSet`: which packed objects are deltas, on which bases.
 *
 * Writing deltas is not supported: git stores deltas only in packs, and `repack()` (in
 * `@statewalker/vcs-store-files`) computes them while it writes one. `deltifyBlob` throws;
 * `undeltifyBlob` does nothing, as reads already resolve deltas and a repack with a smaller
 * `depth` breaks long chains.
 *
 * @example
 * ```typescript
 * const delta = new PackSetDeltaApi(packs);
 * if (await delta.isDelta(id)) console.log(await delta.getDeltaChain(id));
 * ```
 */
export class PackSetDeltaApi implements DeltaApi {
  readonly blobs: BlobDeltaApi;
  private batchDepth = 0;

  constructor(private readonly packs: PackSet) {
    this.blobs = {
      async findBlobDelta(
        _targetId: ObjectId,
        _candidates: AsyncIterable<ObjectId>,
      ): Promise<StreamingDeltaResult | null> {
        return null;
      },
      async deltifyBlob(): Promise<void> {
        throw new Error(
          "git files store deltas only in packs: run repack() to write deltas, not deltifyBlob()",
        );
      },
      async undeltifyBlob(): Promise<void> {
        // reads resolve deltas; repack with a smaller depth to break chains
      },
      isBlobDelta: (id) => this.isDelta(id),
      getBlobDeltaChain: (id) => this.getDeltaChain(id),
    };
  }

  async isDelta(id: ObjectId): Promise<boolean> {
    const e = await this.packs.entry(id);
    return e !== undefined && isDeltaKind(e.kind);
  }

  async getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    let e = await this.packs.entry(id);
    if (!e || !isDeltaKind(e.kind)) return undefined;
    const baseIds: ObjectId[] = [];
    let totalSize = 0;
    while (e && isDeltaKind(e.kind) && e.baseId && baseIds.length < MAX_CHAIN) {
      totalSize += e.size;
      baseIds.push(e.baseId);
      e = await this.packs.entry(e.baseId);
    }
    return { depth: baseIds.length, totalSize, baseIds };
  }

  async *listDeltas(): AsyncIterable<StorageDeltaRelationship> {
    for await (const id of this.packs.list()) {
      const e = await this.packs.entry(id);
      if (!e || !isDeltaKind(e.kind) || !e.baseId) continue;
      const chain = await this.getDeltaChain(id);
      yield { targetId: id, baseId: e.baseId, depth: chain?.depth ?? 1, ratio: 0 };
    }
  }

  async *getDependents(baseId: ObjectId): AsyncIterable<ObjectId> {
    for await (const id of this.packs.list()) {
      const e = await this.packs.entry(id);
      if (e && isDeltaKind(e.kind) && e.baseId === baseId) yield id;
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
  }

  cancelBatch(): void {
    if (this.batchDepth > 0) {
      this.batchDepth--;
    }
  }
}
