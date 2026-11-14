/**
 * SerializationApi implementation
 *
 * Wraps existing pack and compression utilities to provide the SerializationApi interface.
 * Uses the History interface for accessing typed object stores.
 */

import { deflate } from "@statewalker/vcs-utils";
import { collect } from "@statewalker/vcs-utils/streams";
import type { ObjectId } from "../common/id/index.js";
import type { Blobs } from "../history/blobs/blobs.js";
import {
  collectCommitBytes,
  commitToEntries,
  decodeCommitEntries,
  encodeCommitEntries,
  entriesToCommit,
  parseCommitFromBytes,
} from "../history/commits/commit-format.js";
import type { Commits } from "../history/commits/commits.js";
import type { History } from "../history/history.js";
import type { GitObjects } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import {
  collectTagBytes,
  decodeTagEntries,
  encodeTagEntries,
  entriesToTag,
  parseTagFromBytes,
  tagToEntries,
} from "../history/tags/tag-format.js";
import type { Tags } from "../history/tags/tags.js";
import {
  collectTreeBytes,
  decodeTreeEntries,
  encodeTreeEntries,
  parseTreeFromBytes,
} from "../history/trees/tree-format.js";
import type { Trees } from "../history/trees/trees.js";
import {
  importPack,
  PackObjectType,
  type PackSet,
  StreamingPackWriter,
  type UnpackTarget,
} from "../pack/index.js";
import type { DeltaCompressor } from "../storage/delta/delta-compressor.js";
import type {
  PackBuilder,
  PackBuildStats,
  PackImportResult,
  PackOptions,
  SerializationApi,
} from "./serialization-api.js";
import { typedStoreObjects } from "./typed-store-objects.js";

/**
 * Configuration for DefaultSerializationApi
 */
export interface SerializationApiConfig {
  /**
   * History stores for object access
   *
   * Only requires the object stores (blobs, trees, commits, tags).
   * Accepts a full History instance or just the required stores.
   */
  history: Pick<History, "blobs" | "trees" | "commits" | "tags"> &
    Partial<Pick<History, "objects" | "packs">>;

  /**
   * The object kernel received packs are written through. Defaults to `history.objects`; a
   * history without one (stores of parsed objects) is written through its typed stores, which
   * refuse objects they cannot store under their own id.
   */
  objects?: GitObjects;

  /** Where large received packs are kept. Defaults to `history.packs`; without it packs are unpacked. */
  packs?: PackSet;

  /** Packs with at least this many objects are kept when there are `packs` (git's transfer.unpackLimit, 100). */
  unpackLimit?: number;

  /** Delta compressor for computing deltas during pack export */
  deltaCompressor?: DeltaCompressor;
}

/**
 * Default implementation of SerializationApi
 *
 * Uses existing pack utilities and compression functions.
 */
export class DefaultSerializationApi implements SerializationApi {
  /** Blob storage interface (new interface) */
  private readonly _blobs: Blobs;
  /** Tree storage interface (new interface) */
  private readonly _trees: Trees;
  /** Commit storage interface (new interface) */
  private readonly _commits: Commits;
  /** Tag storage interface (new interface) */
  private readonly _tags: Tags;
  /** The object kernel received packs are written through */
  private readonly objects: UnpackTarget;
  /** Where large received packs are kept, if anywhere */
  private readonly packs?: PackSet;
  private readonly unpackLimit?: number;
  /** Optional delta compressor for pack export */
  private readonly deltaCompressor?: DeltaCompressor;

  constructor(config: SerializationApiConfig) {
    this._blobs = config.history.blobs;
    this._trees = config.history.trees;
    this._commits = config.history.commits;
    this._tags = config.history.tags;
    this.objects =
      config.objects ??
      config.history.objects ??
      typedStoreObjects({
        has: async (id) =>
          (await this._commits.has(id)) ||
          (await this._trees.has(id)) ||
          (await this._tags.has(id)) ||
          (await this._blobs.has(id)),
        exportObject: (id) => this.exportObject(id),
        importObject: (type, content) => this.importObject(type, content),
        reencode: (type, data) => reencode(type, data),
      });
    this.packs = config.packs ?? config.history.packs;
    this.unpackLimit = config.unpackLimit;
    this.deltaCompressor = config.deltaCompressor;
  }

  /**
   * Serialize an object to Git loose format
   */
  async *serializeLooseObject(id: ObjectId): AsyncIterable<Uint8Array> {
    const { type, content } = await this.exportObject(id);

    // Collect content to get size
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }
    const contentBytes = concatBytes(chunks);

    // Create header: "type size\0"
    const header = new TextEncoder().encode(`${type} ${contentBytes.length}\0`);

    // Concatenate header and content
    const fullData = concatBytes([header, contentBytes]);

    // Compress with zlib (not raw deflate)
    yield* deflate(toAsyncIterable(fullData), { raw: false });
  }

  /**
   * Create a pack file from objects
   */
  async *createPack(
    objects: AsyncIterable<ObjectId>,
    options?: PackOptions,
  ): AsyncIterable<Uint8Array> {
    const builder = this.createPackBuilder(options);

    for await (const id of objects) {
      if (options?.useDelta !== false) {
        await builder.addObjectWithDelta(id);
      } else {
        await builder.addObject(id);
      }
    }

    yield* builder.finalize();
  }

  /**
   * Import objects from a pack stream, byte for byte, through `importPack`.
   */
  async importPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
    const r = await importPack(this.objects, pack, {
      packs: this.packs,
      unpackLimit: this.unpackLimit,
    });
    return {
      objectsImported: r.count,
      blobsWithDelta: 0,
      treesImported: r.types.tree,
      commitsImported: r.types.commit,
      tagsImported: r.types.tag,
      packId: r.kept?.packId,
    };
  }

  /**
   * Create incremental pack builder
   */
  createPackBuilder(options?: PackOptions): PackBuilder {
    return new DefaultPackBuilder(
      this._blobs,
      this._trees,
      this._commits,
      this._tags,
      options,
      this.deltaCompressor,
    );
  }

  /**
   * Export single object
   */
  async exportObject(
    id: ObjectId,
  ): Promise<{ type: ObjectTypeString; content: AsyncIterable<Uint8Array> }> {
    // Check structured types first — their load() methods validate the type
    // header, so they work correctly even when all objects share the same
    // storage (e.g. file-backed .git/objects).  Blobs are checked last
    // because blobs.has() cannot discriminate types in shared storage.
    const commit = await this._commits.load(id);
    if (commit) {
      return { type: "commit", content: this.serializeCommit(id) };
    }

    const tree = await this._trees.load(id);
    if (tree) {
      return { type: "tree", content: this.serializeTree(id) };
    }

    const tag = await this._tags.load(id);
    if (tag) {
      return { type: "tag", content: this.serializeTag(id) };
    }

    if (await this._blobs.has(id)) {
      const content = await this._blobs.load(id);
      if (!content) throw new Error(`Blob not found: ${id}`);
      return { type: "blob", content };
    }

    throw new Error(`Object not found: ${id}`);
  }

  /**
   * Import single object
   */
  async importObject(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId> {
    switch (type) {
      case "blob":
        return this._blobs.store(content);
      case "tree":
        return this.storeTreeFromStream(content);
      case "commit":
        return this.storeCommitFromStream(content);
      case "tag":
        return this.storeTagFromStream(content);
      default:
        throw new Error(`Unknown object type: ${type}`);
    }
  }

  // ============ Private helpers ============

  private async *serializeTree(id: ObjectId): AsyncIterable<Uint8Array> {
    const tree = await this._trees.load(id);
    if (!tree) throw new Error(`Tree not found: ${id}`);
    yield* encodeTreeEntries(tree);
  }

  private async *serializeCommit(id: ObjectId): AsyncIterable<Uint8Array> {
    const commit = await this._commits.load(id);
    if (!commit) throw new Error(`Commit not found: ${id}`);
    yield* encodeCommitEntries(commitToEntries(commit));
  }

  private async *serializeTag(id: ObjectId): AsyncIterable<Uint8Array> {
    const tag = await this._tags.load(id);
    if (!tag) throw new Error(`Tag not found: ${id}`);
    yield* encodeTagEntries(tagToEntries(tag));
  }

  private async storeTreeFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const entries = decodeTreeEntries(content);
    return await this._trees.store(entries);
  }

  private async storeCommitFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const commit = await entriesToCommit(decodeCommitEntries(content));
    return this._commits.store(commit);
  }

  private async storeTagFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const tag = await entriesToTag(decodeTagEntries(content));
    return this._tags.store(tag);
  }
}

/** The content typed stores keep for `data`: parsed, then encoded again (blobs as they are). */
async function reencode(type: ObjectTypeString, data: Uint8Array): Promise<Uint8Array> {
  switch (type) {
    case "blob":
      return data;
    case "tree":
      return collectTreeBytes(await parseTreeFromBytes(data));
    case "commit":
      return collectCommitBytes(await parseCommitFromBytes(data));
    case "tag":
      return collectTagBytes(await parseTagFromBytes(data));
  }
}

/**
 * Pending pack entry — either a full object or a delta
 */
type PendingPackEntry =
  | { kind: "full"; id: string; type: PackObjectType; content: Uint8Array }
  | { kind: "delta"; id: string; baseId: string; delta: Uint8Array };

/**
 * Default PackBuilder implementation
 *
 * When a DeltaCompressor is provided, uses a sliding window of recently
 * added objects to find delta bases for new objects during addObjectWithDelta().
 */
class DefaultPackBuilder implements PackBuilder {
  private readonly _blobs: Blobs;
  private readonly _trees: Trees;
  private readonly _commits: Commits;
  private readonly _tags: Tags;
  private readonly pendingObjects: PendingPackEntry[] = [];
  private readonly options: PackOptions;
  private readonly deltaCompressor?: DeltaCompressor;
  /** Sliding window of recently seen objects for delta base candidates */
  private readonly window = new Map<string, { type: PackObjectType; content: Uint8Array }>();
  private readonly windowOrder: string[] = [];
  private static readonly MAX_WINDOW_SIZE = 10;
  private stats: PackBuildStats = {
    totalObjects: 0,
    deltifiedObjects: 0,
    totalSize: 0,
    deltaSavings: 0,
  };
  private finalized = false;

  constructor(
    blobs: Blobs,
    trees: Trees,
    commits: Commits,
    tags: Tags,
    options?: PackOptions,
    deltaCompressor?: DeltaCompressor,
  ) {
    this._blobs = blobs;
    this._trees = trees;
    this._commits = commits;
    this._tags = tags;
    this.options = options ?? {};
    this.deltaCompressor = deltaCompressor;
  }

  async addObject(id: ObjectId): Promise<void> {
    if (this.finalized) {
      throw new Error("Pack already finalized");
    }

    const { type, content } = await this.loadObject(id);
    this.pendingObjects.push({ kind: "full", id, type, content });

    this.stats.totalObjects++;
    this.stats.totalSize += content.length;
    this.options.onProgress?.(this.stats);
  }

  async addObjectWithDelta(id: ObjectId, preferredBaseId?: ObjectId): Promise<void> {
    if (this.finalized) {
      throw new Error("Pack already finalized");
    }

    const { type, content } = await this.loadObject(id);
    let deltaEntry: { baseId: string; delta: Uint8Array } | null = null;

    if (this.deltaCompressor) {
      // Try preferred base first
      if (preferredBaseId) {
        const base = this.window.get(preferredBaseId);
        if (base && base.type === type) {
          const result = this.deltaCompressor.computeDelta(base.content, content);
          if (result) {
            deltaEntry = { baseId: preferredBaseId, delta: result.delta };
          }
        }
      }

      // Scan window for same-type objects
      if (!deltaEntry) {
        let bestResult: ReturnType<DeltaCompressor["computeDelta"]> = null;
        let bestBaseId: string | null = null;

        for (const [wId, wObj] of this.window) {
          if (wObj.type !== type) continue;

          const estimate = this.deltaCompressor.estimateDeltaQuality(
            wObj.content.length,
            content.length,
          );
          if (!estimate.worthTrying) continue;

          const result = this.deltaCompressor.computeDelta(wObj.content, content);
          if (result && (!bestResult || result.ratio > bestResult.ratio)) {
            bestResult = result;
            bestBaseId = wId;
          }
        }

        if (bestResult && bestBaseId) {
          deltaEntry = { baseId: bestBaseId, delta: bestResult.delta };
        }
      }
    }

    if (deltaEntry) {
      this.pendingObjects.push({
        kind: "delta",
        id,
        baseId: deltaEntry.baseId,
        delta: deltaEntry.delta,
      });
      this.stats.deltifiedObjects++;
      this.stats.deltaSavings += content.length - deltaEntry.delta.length;
    } else {
      this.pendingObjects.push({ kind: "full", id, type, content });
    }

    // Add to sliding window (regardless of delta result, so it can be a base for later objects)
    this.addToWindow(id, type, content);

    this.stats.totalObjects++;
    this.stats.totalSize += content.length;
    this.options.onProgress?.(this.stats);
  }

  async *finalize(): AsyncIterable<Uint8Array> {
    if (this.finalized) {
      throw new Error("Pack already finalized");
    }
    this.finalized = true;

    const writer = new StreamingPackWriter(this.pendingObjects.length);
    for (const entry of this.pendingObjects) {
      if (entry.kind === "delta") {
        yield* writer.addRefDelta(entry.id, entry.baseId, entry.delta);
      } else {
        yield* writer.addObject(entry.id, entry.type, entry.content);
      }
    }
    yield* writer.finalize();
  }

  getStats(): PackBuildStats {
    return { ...this.stats };
  }

  private addToWindow(id: string, type: PackObjectType, content: Uint8Array): void {
    this.window.set(id, { type, content });
    this.windowOrder.push(id);

    // Evict oldest when window is full
    while (this.windowOrder.length > DefaultPackBuilder.MAX_WINDOW_SIZE) {
      const evicted = this.windowOrder.shift();
      if (evicted !== undefined) {
        this.window.delete(evicted);
      }
    }
  }

  private async loadObject(id: ObjectId): Promise<{ type: PackObjectType; content: Uint8Array }> {
    // Check structured types first — their load() methods validate the type
    // header, so they work correctly even when all objects share the same
    // storage (e.g. file-backed .git/objects).  Blobs are checked last
    // because blobs.has() cannot discriminate types in shared storage.
    {
      const commit = await this._commits.load(id);
      if (commit) {
        return { type: PackObjectType.COMMIT, content: await collectCommitBytes(commit) };
      }
    }

    {
      const tree = await this._trees.load(id);
      if (tree) {
        return { type: PackObjectType.TREE, content: await collectTreeBytes(tree) };
      }
    }

    {
      const tag = await this._tags.load(id);
      if (tag) {
        return { type: PackObjectType.TAG, content: await collectTagBytes(tag) };
      }
    }

    if (await this._blobs.has(id)) {
      const blobContent = await this._blobs.load(id);
      if (!blobContent) throw new Error(`Blob not found: ${id}`);
      return { type: PackObjectType.BLOB, content: await collect(blobContent) };
    }

    throw new Error(`Object not found: ${id}`);
  }
}

// ============ Utility functions ============

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
