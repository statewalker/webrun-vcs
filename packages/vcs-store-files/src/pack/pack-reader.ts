/**
 * Pack file reader
 *
 * Reads Git pack files (.pack) and resolves objects including deltas.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/Pack.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/BinaryDelta.java
 */

import type { FilesApi, ObjectId, RandomAccessReader } from "@statewalker/vcs-core";
import { readAt } from "@statewalker/vcs-core";
import { applyGitDelta, decompressBlockPartial } from "@statewalker/vcs-utils";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { RandomAccessDeltaReader } from "./random-access-delta-reader.js";

/**
 * Pack-specific delta chain information
 *
 * Returned by PackReader.getDeltaChainInfo()
 */
export interface PackDeltaChainInfo {
  /** ObjectId of the base (non-delta) object */
  baseId: ObjectId;
  /** Chain depth (0 = full object, 1+ = delta depth) */
  depth: number;
  /** Total size savings (original - current compressed) */
  savings: number;
}

import type {
  PackHeader,
  PackIndex,
  PackObject,
  PackObjectHeader,
  PackObjectType,
} from "@statewalker/vcs-core";

/** Pack file signature "PACK" */
const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);

/** SHA-1 hash size in bytes */
const OBJECT_ID_LENGTH = 20;

/**
 * Pack file reader
 *
 * Provides random access to objects in a pack file, with delta resolution.
 */
export class PackReader {
  private readonly files: FilesApi;
  private readonly packPath: string;
  /** Pack index for object lookups */
  readonly index: PackIndex;
  private opened = false;
  private length = 0;

  /**
   * Optional callback to resolve base objects not found in this pack.
   * Used by PackDirectory to enable cross-pack REF_DELTA resolution.
   */
  resolveExternalBase?: (baseId: ObjectId) => Promise<PackObject | undefined>;

  constructor(files: FilesApi, packPath: string, index: PackIndex) {
    this.files = files;
    this.packPath = packPath;
    this.index = index;
  }

  /**
   * Open the pack file for reading
   */
  async open(): Promise<void> {
    if (this.opened) return;

    // Get file size from stats
    const stats = await this.files.stats(this.packPath);
    if (!stats) {
      throw new Error(`Pack file not found: ${this.packPath}`);
    }
    this.length = stats.size ?? 0;
    this.opened = true;

    // Validate header
    const header = await this.readPackHeader();
    if (header.objectCount !== this.index.objectCount) {
      throw new Error(
        `Pack object count mismatch: pack has ${header.objectCount}, index has ${this.index.objectCount}`,
      );
    }
  }

  /**
   * Close the pack file (no-op for streaming API)
   */
  async close(): Promise<void> {
    this.opened = false;
  }

  /**
   * Read and validate pack header
   */
  async readPackHeader(): Promise<PackHeader> {
    const buf = new Uint8Array(12);
    await this.read(buf, 0, 12, 0);

    // Check signature
    for (let i = 0; i < 4; i++) {
      if (buf[i] !== PACK_SIGNATURE[i]) {
        throw new Error("Invalid pack file signature");
      }
    }

    // Version (big-endian)
    const version = ((buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7]) >>> 0;
    if (version !== 2 && version !== 3) {
      throw new Error(`Unsupported pack version: ${version}`);
    }

    // Object count (big-endian)
    const objectCount = ((buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11]) >>> 0;

    return { version, objectCount };
  }

  /**
   * Check if an object exists in this pack
   */
  has(id: ObjectId): boolean {
    return this.index.has(id);
  }

  /**
   * Get an object from the pack by ID
   *
   * @param id Object ID
   * @returns Resolved object, or undefined if not found
   */
  async get(id: ObjectId): Promise<PackObject | undefined> {
    const offset = this.index.findOffset(id);
    if (offset === -1) return undefined;
    return this.load(offset);
  }

  /**
   * Load an object from a specific offset
   *
   * Handles delta resolution recursively.
   */
  async load(offset: number): Promise<PackObject> {
    const header = await this.readObjectHeader(offset);

    switch (header.type) {
      case 1: // COMMIT
      case 2: // TREE
      case 3: // BLOB
      case 4: {
        // TAG
        const content = await this.decompress(offset + header.headerLength, header.size);
        return {
          type: header.type,
          content,
          size: header.size,
          offset,
        };
      }

      case 6: {
        // OFS_DELTA
        if (header.baseOffset === undefined) {
          throw new Error("OFS_DELTA missing base offset");
        }
        const baseOffset = offset - header.baseOffset;
        const base = await this.load(baseOffset);
        const delta = await this.decompress(offset + header.headerLength, header.size);
        const content = applyGitDelta(base.content, delta);
        return {
          type: base.type,
          content,
          size: content.length,
          offset,
        };
      }

      case 7: {
        // REF_DELTA
        if (header.baseId === undefined) {
          throw new Error("REF_DELTA missing base ID");
        }
        let base: PackObject;
        const baseOffset = this.index.findOffset(header.baseId);
        if (baseOffset !== -1) {
          base = await this.load(baseOffset);
        } else if (this.resolveExternalBase) {
          // Cross-pack resolution: base object is in a different pack
          const external = await this.resolveExternalBase(header.baseId);
          if (!external) {
            throw new Error(`Base object not found: ${header.baseId}`);
          }
          base = external;
        } else {
          throw new Error(`Base object not found: ${header.baseId}`);
        }
        const delta = await this.decompress(offset + header.headerLength, header.size);
        const content = applyGitDelta(base.content, delta);
        return {
          type: base.type,
          content,
          size: content.length,
          offset,
        };
      }

      default:
        throw new Error(`Unknown object type: ${header.type}`);
    }
  }

  /**
   * Check if an object is stored as a delta
   *
   * @param id Object ID to check
   * @returns True if object is a delta (OFS_DELTA or REF_DELTA)
   */
  async isDelta(id: ObjectId): Promise<boolean> {
    const offset = this.index.findOffset(id);
    if (offset === -1) return false;

    const header = await this.readObjectHeader(offset);
    return header.type === 6 || header.type === 7;
  }

  /**
   * Get delta chain information for an object
   *
   * Walks the delta chain to find the base object and calculate depth.
   *
   * @param id Object ID to query
   * @returns Chain info or undefined if not a delta
   */
  async getDeltaChainInfo(id: ObjectId): Promise<PackDeltaChainInfo | undefined> {
    const offset = this.index.findOffset(id);
    if (offset === -1) return undefined;

    const header = await this.readObjectHeader(offset);

    // Not a delta - return undefined per interface contract
    if (header.type !== 6 && header.type !== 7) {
      return undefined;
    }

    // Walk the chain to find base and calculate depth
    let depth = 0;
    let currentOffset = offset;
    let currentHeader = header;
    let deltaSize = 0;
    let baseId: ObjectId | undefined;

    while (currentHeader.type === 6 || currentHeader.type === 7) {
      depth++;
      deltaSize += currentHeader.size; // Accumulate delta sizes

      if (currentHeader.type === 6) {
        // OFS_DELTA - base is at relative offset
        if (currentHeader.baseOffset === undefined) {
          throw new Error("OFS_DELTA missing base offset");
        }
        currentOffset = currentOffset - currentHeader.baseOffset;
      } else {
        // REF_DELTA - lookup base by ID
        if (currentHeader.baseId === undefined) {
          throw new Error("REF_DELTA missing base ID");
        }
        baseId = currentHeader.baseId;
        currentOffset = this.index.findOffset(baseId);
        if (currentOffset === -1) {
          // Base is in a different pack — resolve externally and return
          if (this.resolveExternalBase) {
            const fullObject = await this.load(offset);
            return { baseId, depth, savings: fullObject.size - deltaSize };
          }
          throw new Error(`Base object not found: ${baseId}`);
        }
      }

      currentHeader = await this.readObjectHeader(currentOffset);
    }

    // Get base object ID from index if not already known
    if (baseId === undefined) {
      // Find the object ID at the base offset
      baseId = this.findObjectIdByOffset(currentOffset);
    }

    // Load the full resolved object to calculate savings
    const fullObject = await this.load(offset);
    const savings = fullObject.size - deltaSize;

    return { baseId, depth, savings };
  }

  /**
   * Find object ID by its offset in the pack file
   *
   * Iterates through index entries to find matching offset.
   * Used to resolve OFS_DELTA base references.
   *
   * Note: This is O(n) - for large packs, consider using
   * PackReverseIndex for offset->id mapping.
   *
   * Based on: jgit PackReverseIndex.java#findObject
   *
   * @param offset Offset to search for
   * @returns Object ID
   * @throws Error if offset not found
   */
  findObjectIdByOffset(offset: number): ObjectId {
    // Iterate through all entries to find matching offset
    for (const entry of this.index.entries()) {
      if (entry.offset === offset) {
        return entry.id;
      }
    }
    throw new Error(`Object at offset ${offset} not found in index`);
  }

  /**
   * Read object header at offset
   */
  async readObjectHeader(offset: number): Promise<PackObjectHeader> {
    const buf = new Uint8Array(32); // Large enough for most headers
    await this.read(buf, 0, 32, offset);

    // First byte: type in bits 4-6, size in bits 0-3
    let c = buf[0];
    const type = ((c >> 4) & 0x07) as PackObjectType;
    let size = c & 0x0f;
    let shift = 4;
    let p = 1;

    // Continue reading size (variable-length encoding)
    while ((c & 0x80) !== 0) {
      c = buf[p++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }

    let headerLength = p;
    let baseOffset: number | undefined;
    let baseId: ObjectId | undefined;

    // For delta types, read base reference
    if (type === 6) {
      // OFS_DELTA
      c = buf[p++];
      baseOffset = c & 0x7f;
      while ((c & 0x80) !== 0) {
        baseOffset++;
        c = buf[p++];
        baseOffset <<= 7;
        baseOffset += c & 0x7f;
      }
      headerLength = p;
    } else if (type === 7) {
      // REF_DELTA
      // Read 20-byte base object ID
      const idBuf = buf.subarray(p, p + OBJECT_ID_LENGTH);
      baseId = bytesToHex(idBuf);
      headerLength = p + OBJECT_ID_LENGTH;
    }

    return { type, size, baseOffset, baseId, headerLength };
  }

  /**
   * Load raw delta bytes without resolution
   *
   * Returns the compressed delta data directly, without
   * applying the delta to reconstruct the object.
   *
   * Useful for:
   * - Copying deltas between packs
   * - Inspecting delta format
   * - Re-deltifying with different base
   *
   * Based on: jgit Pack.java#copyAsIs
   *
   * @param id Object ID
   * @returns Raw delta bytes or undefined if not a delta
   */
  async loadRawDelta(id: ObjectId): Promise<Uint8Array | undefined> {
    const offset = this.index.findOffset(id);
    if (offset === -1) return undefined;

    const header = await this.readObjectHeader(offset);

    // Not a delta - return undefined
    if (header.type !== 6 && header.type !== 7) {
      return undefined;
    }

    // Decompress delta data
    return this.decompress(offset + header.headerLength, header.size);
  }

  /**
   * Get a random access reader for an object
   *
   * Enables partial reads from delta-reconstructed content without
   * full reconstruction. For delta objects, only the portions needed
   * for the requested range are read and reconstructed.
   *
   * @param id Object ID
   * @returns RandomAccessReader, or undefined if not found
   */
  async getRandomAccess(id: ObjectId): Promise<RandomAccessReader | undefined> {
    const offset = this.index.findOffset(id);
    if (offset === -1) return undefined;
    return this.createRandomAccessReader(offset);
  }

  /**
   * Create a random access reader for an object at offset
   *
   * @param offset Object offset in pack file
   * @returns RandomAccessReader for the object
   */
  async createRandomAccessReader(offset: number): Promise<RandomAccessReader> {
    return new RandomAccessDeltaReader(this, offset);
  }

  /**
   * Decompress data at a specific offset in the pack file
   *
   * Public method for use by random access readers.
   *
   * @param offset Offset in pack file where compressed data starts
   * @param expectedSize Expected uncompressed size
   * @returns Decompressed data
   */
  async decompressAt(offset: number, expectedSize: number): Promise<Uint8Array> {
    return this.decompress(offset, expectedSize);
  }

  /**
   * Read bytes from pack file at a specific position
   *
   * Public method for use by random access readers.
   *
   * @param buffer Buffer to read into
   * @param bufferOffset Offset in buffer to start writing
   * @param length Number of bytes to read
   * @param position Position in pack file to read from
   * @returns Number of bytes read
   */
  async readBytesAt(
    buffer: Uint8Array,
    bufferOffset: number,
    length: number,
    position: number,
  ): Promise<number> {
    return this.read(buffer, bufferOffset, length, position);
  }

  /**
   * Get the pack file length
   */
  get packLength(): number {
    return this.length;
  }

  /**
   * Read bytes from pack file
   */
  private async read(
    buffer: Uint8Array,
    bufferOffset: number,
    length: number,
    position: number,
  ): Promise<number> {
    if (!this.opened) {
      throw new Error("Pack file not open");
    }
    return readAt(this.files, this.packPath, buffer, bufferOffset, length, position);
  }

  /**
   * Decompress zlib data at offset using streaming decompression
   *
   * Pack files store compressed objects contiguously without explicit length
   * markers for the compressed data. We use partial decompression which
   * stops when the zlib stream is complete, ignoring trailing data.
   */
  private async decompress(offset: number, expectedSize: number): Promise<Uint8Array> {
    // Read enough compressed data - zlib compression ratio is typically 2-10x
    // Use a larger buffer to ensure we have the complete compressed stream
    const estimatedSize = Math.max(expectedSize * 2, 65536);
    const compressedSize = Math.min(estimatedSize, this.length - offset);
    const compressed = new Uint8Array(compressedSize);
    await this.read(compressed, 0, compressedSize, offset);

    // Use partial decompression to handle trailing data gracefully
    // Git pack files use zlib format (RFC 1950), not raw DEFLATE
    const { data } = await decompressBlockPartial(compressed, { raw: false });

    if (data.length !== expectedSize) {
      throw new Error(`Decompression size mismatch: expected ${expectedSize}, got ${data.length}`);
    }

    return data;
  }
}

/**
 * Check if an object header represents a delta type
 */
export function isDeltaType(type: number): boolean {
  return type === 6 || type === 7; // OFS_DELTA or REF_DELTA
}
