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
 * Object metadata returned when parsing
 */
export interface ParsedObjectMeta {
  /** Object ID (SHA-1 hash) */
  id: ObjectId;
  /** Object type */
  type: ObjectTypeString;
  /** Content size in bytes */
  size: number;
}

/**
 * Result of importing a pack file
 */
export interface PackImportResult {
  /** Total objects imported */
  objectsImported: number;
  /** Blobs stored with delta preservation */
  blobsWithDelta: number;
  /** Trees imported */
  treesImported: number;
  /** Commits imported */
  commitsImported: number;
  /** Tags imported */
  tagsImported: number;
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
 * Pack file header information
 */
export interface PackHeader {
  /** Pack version (usually 2) */
  version: number;
  /** Number of objects in the pack */
  objectCount: number;
}

/**
 * Entry from reading a pack file
 */
export interface PackEntry {
  /** Object ID */
  id: ObjectId;
  /** Object type (resolved for deltas) */
  type: ObjectTypeString;
  /** Whether stored as delta in the pack */
  isDelta: boolean;
  /** Base object reference (for delta entries) */
  baseRef?: ObjectId | number;
  /** Raw content as stored in pack (may be delta) */
  rawContent: AsyncIterable<Uint8Array>;
  /** Resolved content (delta applied if needed) */
  resolvedContent: AsyncIterable<Uint8Array>;
  /** Uncompressed size */
  size: number;
  /** Delta chain depth (0 for non-deltas) */
  chainDepth: number;
  /** Compression ratio for deltas */
  ratio?: number;
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
 * PackReader - Streaming pack file parser
 *
 * Parse pack files entry by entry with automatic delta resolution.
 *
 * @example
 * ```typescript
 * const reader = serialization.createPackReader(packStream);
 *
 * const header = await reader.getHeader();
 * console.log(`Pack has ${header.objectCount} objects`);
 *
 * for await (const entry of reader.entries()) {
 *   // Use entry.resolvedContent for the actual content
 *   // Use entry.rawContent for delta-as-stored
 * }
 * ```
 */
export interface PackReaderApi {
  /**
   * Iterate entries in pack order
   */
  entries(): AsyncIterable<PackEntry>;

  /**
   * Get pack header info
   */
  getHeader(): Promise<PackHeader>;
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
 * // Parse a loose object
 * const { id, type } = await serialization.parseLooseObject(compressedStream);
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
   * Parse Git loose format into internal representation
   *
   * Also stores the object in the backend.
   *
   * @param compressed Compressed object stream
   * @returns Parsed object metadata
   */
  parseLooseObject(compressed: AsyncIterable<Uint8Array>): Promise<ParsedObjectMeta>;

  /**
   * Create a pack file from objects
   *
   * @param objects Object IDs to pack
   * @param options Pack creation options
   * @returns Pack file stream
   */
  createPack(objects: AsyncIterable<ObjectId>, options?: PackOptions): AsyncIterable<Uint8Array>;

  /**
   * Import objects from a pack file
   *
   * - Blob deltas: preserve if beneficial
   * - Tree/commit deltas: resolve to full content on import
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
   * Create pack file reader
   *
   * @param pack Pack file stream
   */
  createPackReader(pack: AsyncIterable<Uint8Array>): PackReaderApi;

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
