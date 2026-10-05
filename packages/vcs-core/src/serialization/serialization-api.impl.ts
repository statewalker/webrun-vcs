/**
 * SerializationApi implementation
 *
 * Wraps existing pack and compression utilities to provide the SerializationApi interface.
 * Uses the History interface for accessing typed object stores.
 */

import { deflate, inflate } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { collect } from "@statewalker/vcs-utils/streams";
import type { ObjectId } from "../common/id/index.js";
import type { Blobs } from "../history/blobs/blobs.js";
import {
  collectCommitBytes,
  commitToEntries,
  decodeCommitEntries,
  encodeCommitEntries,
  entriesToCommit,
} from "../history/commits/commit-format.js";
import type { Commits } from "../history/commits/commits.js";
import type { History } from "../history/history.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import {
  collectTagBytes,
  decodeTagEntries,
  encodeTagEntries,
  entriesToTag,
  tagToEntries,
} from "../history/tags/tag-format.js";
import type { Tags } from "../history/tags/tags.js";
import {
  collectTreeBytes,
  decodeTreeEntries,
  encodeTreeEntries,
} from "../history/trees/tree-format.js";
import type { Trees } from "../history/trees/trees.js";
import {
  PackObjectType,
  parsePackEntries,
  parsePackEntriesFromStream,
  StreamingPackWriter,
} from "../pack/index.js";
import type { BlobDeltaApi } from "../storage/delta/blob-delta-api.js";
import type { CommitDeltaApi } from "../storage/delta/commit-delta-api.js";
import { serializeDeltaToGit } from "../storage/delta/delta-binary-format.js";
import type { DeltaCompressor } from "../storage/delta/delta-compressor.js";
import type { TreeDeltaApi } from "../storage/delta/tree-delta-api.js";
import type {
  PackBuilder,
  PackBuildStats,
  PackEntry,
  PackHeader,
  PackImportResult,
  PackOptions,
  PackReaderApi,
  ParsedObjectMeta,
  SerializationApi,
} from "./serialization-api.js";

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
  history: Pick<History, "blobs" | "trees" | "commits" | "tags">;

  /** Blob delta API for delta-aware import */
  blobDeltaApi?: BlobDeltaApi;

  /** Tree delta API for delta-aware import (optional, backend-dependent) */
  treeDeltaApi?: TreeDeltaApi;

  /** Commit delta API for delta-aware import (optional, backend-dependent) */
  commitDeltaApi?: CommitDeltaApi;

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
  /** Optional blob delta API for delta-aware import */
  private readonly blobDeltaApi?: BlobDeltaApi;
  /** Optional tree delta API for delta-aware import */
  private readonly treeDeltaApi?: TreeDeltaApi;
  /** Optional commit delta API for delta-aware import */
  private readonly commitDeltaApi?: CommitDeltaApi;
  /** Optional delta compressor for pack export */
  private readonly deltaCompressor?: DeltaCompressor;

  constructor(config: SerializationApiConfig) {
    this._blobs = config.history.blobs;
    this._trees = config.history.trees;
    this._commits = config.history.commits;
    this._tags = config.history.tags;
    this.blobDeltaApi = config.blobDeltaApi;
    this.treeDeltaApi = config.treeDeltaApi;
    this.commitDeltaApi = config.commitDeltaApi;
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
   * Parse Git loose format and store
   */
  async parseLooseObject(compressed: AsyncIterable<Uint8Array>): Promise<ParsedObjectMeta> {
    // Decompress
    const decompressedChunks: Uint8Array[] = [];
    for await (const chunk of inflate(compressed, { raw: false })) {
      decompressedChunks.push(chunk);
    }
    const data = concatBytes(decompressedChunks);

    // Parse header: "type size\0content"
    const nullIndex = data.indexOf(0);
    if (nullIndex === -1) {
      throw new Error("Invalid loose object: no null byte found");
    }

    const headerStr = new TextDecoder().decode(data.subarray(0, nullIndex));
    const spaceIndex = headerStr.indexOf(" ");
    if (spaceIndex === -1) {
      throw new Error("Invalid loose object header: no space found");
    }

    const type = headerStr.substring(0, spaceIndex) as ObjectTypeString;
    const size = parseInt(headerStr.substring(spaceIndex + 1), 10);
    const content = data.subarray(nullIndex + 1);

    if (content.length !== size) {
      throw new Error(`Size mismatch: header says ${size}, content is ${content.length}`);
    }

    // Compute ID (SHA-1 of header + content)
    const hash = await sha1(data);
    const id = bytesToHex(hash);

    // Store the object
    await this.importObject(type, toAsyncIterable(content));

    return { id, type, size };
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
   * Import objects from a pack file
   */
  async importPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
    let objectsImported = 0;
    let blobsWithDelta = 0;
    let treesImported = 0;
    let commitsImported = 0;
    let tagsImported = 0;

    // Stream entries one at a time — no full-pack accumulation
    for await (const entry of parsePackEntriesFromStream(pack)) {
      switch (entry.objectType) {
        case "blob":
          if (entry.type === "delta" && this.blobDeltaApi) {
            // Preserve blob delta if we have delta API
            const deltaBytes = serializeDeltaToGit(entry.delta);
            await this.blobDeltaApi.deltifyBlob(entry.id, entry.baseId, [deltaBytes]);
            blobsWithDelta++;
          } else {
            // Store as full blob
            await this._blobs.store([entry.content]);
          }
          break;

        case "tree":
          if (entry.type === "delta" && this.treeDeltaApi) {
            // Preserve tree delta if we have tree delta API
            const treeDeltaBytes = serializeDeltaToGit(entry.delta);
            await this.treeDeltaApi.deltifyTree(entry.id, entry.baseId, [treeDeltaBytes]);
          } else {
            // Store as full tree
            await this.storeTreeFromStream([entry.content]);
          }
          treesImported++;
          break;

        case "commit":
          if (entry.type === "delta" && this.commitDeltaApi) {
            // Preserve commit delta if we have commit delta API
            const commitDeltaBytes = serializeDeltaToGit(entry.delta);
            await this.commitDeltaApi.deltifyCommit(entry.id, entry.baseId, [commitDeltaBytes]);
          } else {
            // Store as full commit
            await this.storeCommitFromStream([entry.content]);
          }
          commitsImported++;
          break;

        case "tag":
          // Tags are always stored fully resolved
          await this.storeTagFromStream([entry.content]);
          tagsImported++;
          break;
      }
      objectsImported++;
    }

    return {
      objectsImported,
      blobsWithDelta,
      treesImported,
      commitsImported,
      tagsImported,
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
   * Create pack file reader
   */
  createPackReader(pack: AsyncIterable<Uint8Array>): PackReaderApi {
    return new StreamingPackReader(pack);
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

/**
 * Streaming pack reader implementation
 */
class StreamingPackReader implements PackReaderApi {
  private packData: Uint8Array | null = null;
  private header: PackHeader | null = null;

  constructor(private readonly pack: AsyncIterable<Uint8Array>) {}

  async *entries(): AsyncIterable<PackEntry> {
    await this.ensureLoaded();
    if (!this.packData) {
      throw new Error("Pack data not loaded");
    }
    const result = await parsePackEntries(this.packData);

    for (const entry of result.entries) {
      const packEntry: PackEntry = {
        id: entry.id,
        type: entry.objectType,
        isDelta: entry.type === "delta",
        baseRef: entry.type === "delta" ? entry.baseId : undefined,
        rawContent: toAsyncIterable(entry.type === "delta" ? new Uint8Array(0) : entry.content),
        resolvedContent: toAsyncIterable(entry.content),
        size: entry.content.length,
        chainDepth: entry.type === "delta" ? 1 : 0, // Simplified
        ratio: entry.type === "delta" ? 0.5 : undefined, // Simplified
      };
      yield packEntry;
    }
  }

  async getHeader(): Promise<PackHeader> {
    await this.ensureLoaded();
    if (!this.header) {
      throw new Error("Pack header not loaded");
    }
    return this.header;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.packData) return;

    const chunks: Uint8Array[] = [];
    for await (const chunk of this.pack) {
      chunks.push(chunk);
    }
    this.packData = concatBytes(chunks);

    // Parse header
    if (this.packData.length < 12) {
      throw new Error("Pack data too short");
    }

    const view = new DataView(this.packData.buffer, this.packData.byteOffset);
    const signature = view.getUint32(0, false);
    if (signature !== 0x5041434b) {
      // "PACK"
      throw new Error("Invalid pack signature");
    }

    this.header = {
      version: view.getUint32(4, false),
      objectCount: view.getUint32(8, false),
    };
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
