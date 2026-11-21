/**
 * Serialization API - Git-compatible wire format I/O
 *
 * This is API 3 of the StorageBackend three-API architecture:
 * 1. StructuredStores - Typed access to parsed objects
 * 2. DeltaApi - Blob delta operations for storage optimization
 * 3. **SerializationApi** - Git-compatible serialization
 *
 * Handles conversion between internal representation and Git wire format:
 * - Loose object format: zlib(type + " " + size + "\0" + content)
 * - Pack file format: For efficient transport and storage
 */

import type { ObjectId } from "../common/id/index.js";
import type { ObjectQuarantine } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import type { PackEntryInfo } from "../pack/unpack-objects.js";

/**
 * Result of importing a pack file
 */
export interface PackImportResult {
  /** Total objects imported */
  objectsImported: number;
  /**
   * Always 0: received objects are stored byte for byte (loose, or inside a kept pack), never
   * re-encoded as backend deltas.
   */
  blobsWithDelta: number;
  /** Trees imported */
  treesImported: number;
  /** Commits imported */
  commitsImported: number;
  /** Tags imported */
  tagsImported: number;
  /** The kept pack's id, when the pack was installed instead of unpacked */
  packId?: string;
  /**
   * With `quarantine: true`, where the backend can quarantine: the objects kept aside until the
   * caller calls `commit()` (publish) or `discard()` (remove them all). Absent when the
   * backend cannot (stores of parsed objects): the objects are then already published.
   */
  quarantine?: ObjectQuarantine;
  /**
   * With `quarantine: true`: true when the objects were quarantined, false when the backend
   * cannot quarantine and imported them straight into the store. Absent otherwise.
   */
  quarantined?: boolean;
}

/** Options of `SerializationApi.importPack`. */
export interface PackImportOptions {
  /**
   * Keep the objects in a quarantine until the caller accepts them, as git's receive-pack does
   * (see `GitObjects.beginQuarantine`): `result.quarantine` is set when the backend can.
   */
  quarantine?: boolean;
  /**
   * Keep the pack whatever its size, never unpacking it into loose objects (git's
   * `TRANS_OPT_KEEP`, which `git clone` sets: `fetch-pack --keep`)
   */
  keepPack?: boolean;
  /**
   * Called for every received object once it is stored (unpacked) or its pack resolved (kept),
   * with its entry in the pack: what git's index-pack checks with `--strict` (see
   * `PackEntryInfo`)
   */
  onObject?: (id: ObjectId, type: ObjectTypeString, entry: PackEntryInfo) => void;
  /**
   * Called with the content of every received commit, tree and tag while it is in memory, in
   * no particular order (`content` is only valid during the call): what index-pack reads the
   * links of. An object too large to hold (streamed into a store) is not reported.
   */
  onContent?: (id: ObjectId, type: ObjectTypeString, content: Uint8Array) => void;
}

/**
 * Options for creating a pack file
 */
export interface PackOptions {
  /** Search deltas between the objects, git's windowed search (default: true) */
  useDelta?: boolean;
  /** Longest delta chain the search builds (default: 50, git's pack.depth) */
  maxChainDepth?: number;
  /** Write deltas on a base in the pack as OFS deltas (default: true, git's ofs-delta) */
  ofsDelta?: boolean;
  /** Reuse entries stored in the backend's packs as they are (default: true) */
  reuse?: boolean;
}

/**
 * Options for exporting the objects between wants and haves
 */
export interface ExportOptions extends PackOptions {
  /** A thin pack: deltas against objects the receiver has, not sent (default: false) */
  thinPack?: boolean;
  /** The receiver's shallow commits: their parents are not walked */
  shallow?: Iterable<ObjectId>;
  /**
   * Candidate annotated tags, as git's `pack-objects --include-tag` (upload-pack's
   * `include-tag`): each one peeling to an object in the pack is added, with every tag of its
   * chain. Pass the ids of the `refs/tags/*` the receiver may see.
   */
  includeTags?: Iterable<ObjectId>;
}

/**
 * SerializationApi - Git-compatible serialization interface
 *
 * Provides methods for:
 * - Loose object serialization (zlib compressed Git format)
 * - Pack file creation and parsing
 * - Object import/export
 *
 * @example
 * ```typescript
 * // Serialize an object to Git loose format
 * const stream = serialization.serializeLooseObject(blobId);
 * for await (const chunk of stream) {
 *   // Write to .git/objects/XX/YYYY...
 * }
 *
 * // Create a pack file of given objects, or of what a receiver lacks
 * const packStream = serialization.createPack(objectIds);
 * const forPush = serialization.exportPack([localTip], [remoteTip]);
 *
 * // Import a pack file
 * const result = await serialization.importPack(packStream);
 * ```
 */
export interface SerializationApi {
  /**
   * Serialize an object to Git loose format, streamed
   *
   * Produces: zlib(type + " " + size + "\0" + content)
   *
   * @param id Object ID to serialize
   * @returns Compressed object stream
   */
  serializeLooseObject(id: ObjectId): AsyncIterable<Uint8Array>;

  /**
   * Create a pack file from objects, streamed through `writePack`. The ids are collected
   * first (a pack header carries the count); objects are read one at a time as they are
   * written, and entries the backend's packs hold are copied as stored.
   *
   * @param objects Object IDs to pack
   * @param options Pack creation options
   * @returns Pack file stream
   */
  createPack(objects: AsyncIterable<ObjectId>, options?: PackOptions): AsyncIterable<Uint8Array>;

  /**
   * The pack of objects reachable from `wants` and not from `haves` (`git pack-objects --revs`):
   * `listObjects`, then `writePack` with the paths for the delta search.
   *
   * @param wants Tips to send
   * @param haves Tips the receiver has
   * @param options Export options
   * @returns Pack file stream
   */
  exportPack(
    wants: Iterable<ObjectId>,
    haves: Iterable<ObjectId>,
    options?: ExportOptions,
  ): AsyncIterable<Uint8Array>;

  /**
   * Import objects from a received pack stream, byte for byte (see `importPack` in the pack
   * module): a pack of at least `unpackLimit` objects is kept as a pack where the backend has
   * packs (thin packs completed from the local objects), any other is unpacked into loose
   * objects. The stream is never buffered whole. Refuses a corrupt pack with `PackError`.
   *
   * With `options.quarantine`, the objects stay invisible to the repository's readers until
   * `result.quarantine.commit()` (backends that can quarantine; see `PackImportResult`).
   *
   * @param pack Pack file stream
   * @param options Import options
   * @returns Import statistics
   */
  importPack(
    pack: AsyncIterable<Uint8Array>,
    options?: PackImportOptions,
  ): Promise<PackImportResult>;

  /**
   * Export single object in Git format
   *
   * Returns object type and raw content (without header).
   *
   * @param id Object ID to export
   */
  exportObject(id: ObjectId): Promise<{
    type: ObjectTypeString;
    content: AsyncIterable<Uint8Array>;
  }>;

  /**
   * Import single object from Git format
   *
   * @param type Object type
   * @param content Object content (without header)
   * @param size The content's length, when known: a blob is then stored in one
   *   pass (see `Blobs.store`)
   * @returns Object ID of the stored object
   */
  importObject(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array>,
    size?: number,
  ): Promise<ObjectId>;
}
