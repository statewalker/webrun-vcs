/**
 * Pack file types and interfaces
 *
 * Based on jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndex.java
 */

import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Entry in a pack index representing an object's location
 */
export interface PackIndexEntry {
  /** Object ID (40-char hex string) */
  id: ObjectId;
  /** Byte offset within the pack file */
  offset: number;
  /** CRC32 checksum of the object data (V2 only) */
  crc32?: number;
}

/**
 * Pack index interface for locating objects within pack files
 *
 * Pack index files (.idx) provide random access to any object in the pack
 * by associating an ObjectId to the byte offset within the pack file.
 */
export interface PackIndex {
  /** Total number of objects in the index */
  readonly objectCount: number;

  /** Number of objects requiring 64-bit offsets */
  readonly offset64Count: number;

  /** Version of the index format (1 or 2) */
  readonly version: number;

  /** Pack file checksum (last 20 bytes of pack file) */
  readonly packChecksum: Uint8Array;

  /** Index file checksum */
  readonly indexChecksum: Uint8Array;

  /**
   * Check if an object exists in this pack
   */
  has(id: ObjectId): boolean;

  /**
   * Find the byte offset of an object in the pack file
   *
   * @param id Object ID to find
   * @returns Offset in pack file, or -1 if not found
   */
  findOffset(id: ObjectId): number;

  /**
   * Find the position (index) of an object in the sorted list
   *
   * @param id Object ID to find
   * @returns Position in the list (0-based), or -1 if not found
   */
  findPosition(id: ObjectId): number;

  /**
   * Get the CRC32 checksum for an object
   *
   * @param id Object ID
   * @returns CRC32 value, or undefined if not supported (V1) or not found
   */
  findCRC32(id: ObjectId): number | undefined;

  /**
   * Check if this index supports CRC32 checksums
   */
  hasCRC32Support(): boolean;

  /**
   * Get object ID at the nth position (sorted order)
   */
  getObjectId(nthPosition: number): ObjectId;

  /**
   * Get offset at the nth position
   */
  getOffset(nthPosition: number): number;

  /**
   * Iterate over all entries in sorted order
   */
  entries(): IterableIterator<PackIndexEntry>;

  /**
   * Find objects matching a prefix
   *
   * @param prefix Hex prefix to match (2+ characters)
   * @param limit Maximum results to return
   * @returns Matching object IDs
   */
  resolve(prefix: string, limit?: number): ObjectId[];

  /**
   * List all object IDs in the index
   *
   * @returns Iterator of object IDs
   */
  listObjects(): IterableIterator<ObjectId>;
}

/**
 * Git pack file object types
 */
export enum PackObjectType {
  COMMIT = 1,
  TREE = 2,
  BLOB = 3,
  TAG = 4,
  OFS_DELTA = 6,
  REF_DELTA = 7,
}

/**
 * Pack file header information
 */
export interface PackHeader {
  /** Version number (2 or 3) */
  version: number;
  /** Number of objects in the pack */
  objectCount: number;
}

/**
 * Resolved object from a pack file
 */
export interface PackObject {
  /** Object type code */
  type: PackObjectType;
  /** Uncompressed object content */
  content: Uint8Array;
  /** Size of uncompressed content */
  size: number;
  /** Original offset in pack file */
  offset: number;
}

/**
 * Object header in pack file (before delta resolution)
 */
export interface PackObjectHeader {
  /** Object type code */
  type: PackObjectType;
  /** Size of content (for delta types, this is delta size) */
  size: number;
  /** For OFS_DELTA: negative offset to base object */
  baseOffset?: number;
  /** For REF_DELTA: base object ID */
  baseId?: ObjectId;
  /** Number of bytes consumed for header */
  headerLength: number;
}
