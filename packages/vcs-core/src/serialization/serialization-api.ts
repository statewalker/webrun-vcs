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
import type { ObjectTypeString } from "../history/objects/object-types.js";

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
}

/**
 * Statistics from pack building
 */
export interface PackBuildStats {
  /** Total objects added */
  totalObjects: number;
  /** Objects stored as deltas */
  deltifiedObjects: number;
  /** Total uncompressed size */
  totalSize: number;
  /** Bytes saved by delta compression */
  deltaSavings: number;
}

/**
 * Options for creating a pack file
 */
export interface PackOptions {
  /** Enable delta compression (default: true) */
  useDelta?: boolean;
  /** Create thin pack with external base references (default: false) */
  thinPack?: boolean;
  /** Maximum delta chain depth (default: 50) */
  maxChainDepth?: number;
  /** Progress callback */
  onProgress?: (stats: PackBuildStats) => void;
}

/**
 * PackBuilder - Incremental pack file builder
 *
 * Build pack files one object at a time with optional delta compression.
 *
 * @example
 * ```typescript
 * const builder = serialization.createPackBuilder();
 *
 * await builder.addObject(commitId);
 * await builder.addObject(treeId);
 * await builder.addObjectWithDelta(blobId, baseBlobId);
 *
 * const packStream = builder.finalize();
 * for await (const chunk of packStream) {
 *   // Write to transport or file
 * }
 * ```
 */
export interface PackBuilder {
  /**
   * Add object (engine decides full vs delta)
   *
   * @param id Object ID to add
   */
  addObject(id: ObjectId): Promise<void>;

  /**
   * Add object with explicit delta preference
   *
   * If preferredBaseId is provided and suitable, the object
   * will be stored as a delta against that base.
   *
   * @param id Object ID to add
   * @param preferredBaseId Optional preferred base for delta
   */
  addObjectWithDelta(id: ObjectId, preferredBaseId?: ObjectId): Promise<void>;

  /**
   * Finalize and get pack stream
   *
   * Returns the complete pack file as a byte stream.
   * After calling this, no more objects can be added.
   */
  finalize(): AsyncIterable<Uint8Array>;

  /**
   * Get current pack statistics
   */
  getStats(): PackBuildStats;
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
 * // Create a pack file
 * const packStream = serialization.createPack(objectIds);
 *
 * // Import a pack file
 * const result = await serialization.importPack(packStream);
 * ```
 */
export interface SerializationApi {
  /**
   * Serialize an object to Git loose format
   *
   * Produces: zlib(type + " " + size + "\0" + content)
   *
   * @param id Object ID to serialize
   * @returns Compressed object stream
   */
  serializeLooseObject(id: ObjectId): AsyncIterable<Uint8Array>;

  /**
   * Create a pack file from objects
   *
   * @param objects Object IDs to pack
   * @param options Pack creation options
   * @returns Pack file stream
   */
  createPack(objects: AsyncIterable<ObjectId>, options?: PackOptions): AsyncIterable<Uint8Array>;

  /**
   * Import objects from a received pack stream, byte for byte (see `importPack` in the pack
   * module): a pack of at least `unpackLimit` objects is kept as a pack where the backend has
   * packs (thin packs completed from the local objects), any other is unpacked into loose
   * objects. The stream is never buffered whole. Refuses a corrupt pack with `PackError`.
   *
   * @param pack Pack file stream
   * @returns Import statistics
   */
  importPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult>;

  /**
   * Create incremental pack builder
   *
   * @param options Pack builder options
   */
  createPackBuilder(options?: PackOptions): PackBuilder;

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
   * @returns Object ID of the stored object
   */
  importObject(type: ObjectTypeString, content: AsyncIterable<Uint8Array>): Promise<ObjectId>;
}
