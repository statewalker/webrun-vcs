/**
 * Pack file writer
 *
 * Writes Git pack files (.pack) containing compressed objects.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackWriter.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackOutputStream.java
 */

import { compressBlock } from "@statewalker/vcs-utils";
import { CRC32, crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { PackIndexWriterEntry } from "./pack-index-writer.js";
import { PackObjectType } from "./types.js";
import { writeOfsVarint, writePackHeader } from "./varint.js";

/** Pack file signature "PACK" */
const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);

/** Pack version we generate */
const PACK_VERSION = 2;

/** SHA-1 hash size in bytes */
const _OBJECT_ID_LENGTH = 20;

/**
 * Object to be written to a pack file
 */
export interface PackWriterObject {
  /** Object ID (40-char hex string) */
  id: string;
  /** Object type (1=commit, 2=tree, 3=blob, 4=tag) */
  type: PackObjectType;
  /** Uncompressed object content */
  content: Uint8Array;
  /**
   * Optional: base object ID for REF_DELTA
   * If provided, this object will be stored as a REF_DELTA
   */
  deltaBaseId?: string;
  /**
   * Optional: delta data (if this is a delta object)
   * If provided along with deltaBaseId, this is the delta to apply
   */
  deltaData?: Uint8Array;
}

/**
 * Result of writing a pack file
 */
export interface PackWriterResult {
  /** The complete pack file data */
  packData: Uint8Array;
  /** SHA-1 checksum of the pack (last 20 bytes of pack file) */
  packChecksum: Uint8Array;
  /** Index entries for each object (sorted by object ID) */
  indexEntries: PackIndexWriterEntry[];
}

/**
 * Encode a 32-bit unsigned integer to big-endian bytes
 */
function encodeUInt32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = (value >>> 24) & 0xff;
  bytes[1] = (value >>> 16) & 0xff;
  bytes[2] = (value >>> 8) & 0xff;
  bytes[3] = value & 0xff;
  return bytes;
}

/**
 * Concatenate multiple Uint8Arrays
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Write a pack file containing the given objects
 *
 * Objects can be stored as:
 * - Whole objects: COMMIT, TREE, BLOB, TAG (types 1-4)
 * - REF_DELTA: references base object by SHA-1 (type 7)
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackWriter.java#writePack
 *
 * @param objects Objects to pack (order determines pack layout)
 * @returns Pack file data, checksum, and index entries
 */
export async function writePack(objects: readonly PackWriterObject[]): Promise<PackWriterResult> {
  // Build pack data incrementally
  const chunks: Uint8Array[] = [];
  const indexEntries: PackIndexWriterEntry[] = [];

  // Write pack header: "PACK" + version (4 bytes) + object count (4 bytes)
  const header = concatBytes(
    PACK_SIGNATURE,
    encodeUInt32(PACK_VERSION),
    encodeUInt32(objects.length),
  );
  chunks.push(header);

  let currentOffset = header.length;

  // Write each object
  for (const obj of objects) {
    const entryOffset = currentOffset;

    // Determine if this is a delta object
    const deltaBaseId = obj.deltaBaseId;
    const deltaData = obj.deltaData;
    const isRefDelta = deltaBaseId !== undefined && deltaData !== undefined;

    // Get the data to compress
    const dataToCompress = isRefDelta ? deltaData : obj.content;

    // Write object header
    const type = isRefDelta ? PackObjectType.REF_DELTA : obj.type;
    const objectHeader = writePackHeader(type, dataToCompress.length);

    // For REF_DELTA, include the base object ID after the header
    let fullHeader: Uint8Array;
    if (isRefDelta) {
      const baseIdBytes = hexToBytes(deltaBaseId);
      fullHeader = concatBytes(objectHeader, baseIdBytes);
    } else {
      fullHeader = objectHeader;
    }

    // Compress the data (zlib format, not raw deflate)
    const compressed = await compressBlock(dataToCompress, { raw: false });

    // Compute CRC32 of header + compressed data
    let entryCrc = crc32(fullHeader);
    entryCrc = crc32(compressed, entryCrc ^ 0xffffffff) ^ 0xffffffff;
    // Fix: CRC32 continuation requires reinverting
    entryCrc = crc32(compressed, crc32(fullHeader) ^ 0xffffffff);

    // Add to chunks
    chunks.push(fullHeader);
    chunks.push(compressed);

    // Track offset for this entry
    currentOffset += fullHeader.length + compressed.length;

    // Add to index entries
    indexEntries.push({
      id: obj.id,
      offset: entryOffset,
      crc32: entryCrc,
    });
  }

  // Concatenate all chunks (excluding checksum)
  const packDataWithoutChecksum = concatBytes(...chunks);

  // Compute pack checksum (SHA-1 of all pack data)
  const packChecksum = await sha1(packDataWithoutChecksum);

  // Final pack data includes checksum at the end
  const packData = concatBytes(packDataWithoutChecksum, packChecksum);

  // Sort index entries by object ID for the index file
  const sortedEntries = [...indexEntries].sort((a, b) => a.id.localeCompare(b.id));

  return {
    packData,
    packChecksum,
    indexEntries: sortedEntries,
  };
}

/**
 * Streaming pack writer for building packs incrementally
 *
 * This is useful when you want to:
 * - Write objects one at a time
 * - Use OFS_DELTA (offset-based deltas)
 * - Have fine-grained control over the pack layout
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackOutputStream.java
 */
export class PackWriterStream {
  private chunks: Uint8Array[] = [];
  private currentOffset = 0;
  private objectCount = 0;
  private indexEntries: PackIndexWriterEntry[] = [];
  private objectOffsets = new Map<string, number>();
  private finalized = false;

  /**
   * Add a whole object to the pack
   *
   * @param id Object ID
   * @param type Object type (1=commit, 2=tree, 3=blob, 4=tag)
   * @param content Uncompressed object content
   */
  async addObject(id: string, type: PackObjectType, content: Uint8Array): Promise<void> {
    if (this.finalized) {
      throw new Error("Pack has been finalized");
    }

    const entryOffset = this.currentOffset;
    this.objectOffsets.set(id, entryOffset);

    // Write object header
    const header = writePackHeader(type, content.length);

    // Compress the content
    const compressed = await compressBlock(content, { raw: false });

    // Compute CRC32
    const crcCalc = new CRC32();
    crcCalc.update(header);
    crcCalc.update(compressed);

    // Add to chunks
    this.chunks.push(header);
    this.chunks.push(compressed);
    this.currentOffset += header.length + compressed.length;
    this.objectCount++;

    // Add index entry
    this.indexEntries.push({
      id,
      offset: entryOffset,
      crc32: crcCalc.getValue(),
    });
  }

  /**
   * Add a REF_DELTA object to the pack
   *
   * The base object is referenced by its SHA-1 ID.
   *
   * @param id Object ID of the deltified object
   * @param baseId Object ID of the base object
   * @param delta Delta data to apply to the base
   */
  async addRefDelta(id: string, baseId: string, delta: Uint8Array): Promise<void> {
    if (this.finalized) {
      throw new Error("Pack has been finalized");
    }

    const entryOffset = this.currentOffset;
    this.objectOffsets.set(id, entryOffset);

    // Write object header
    const header = writePackHeader(PackObjectType.REF_DELTA, delta.length);
    const baseIdBytes = hexToBytes(baseId);

    // Compress the delta
    const compressed = await compressBlock(delta, { raw: false });

    // Compute CRC32
    const crcCalc = new CRC32();
    crcCalc.update(header);
    crcCalc.update(baseIdBytes);
    crcCalc.update(compressed);

    // Add to chunks
    this.chunks.push(header);
    this.chunks.push(baseIdBytes);
    this.chunks.push(compressed);
    this.currentOffset += header.length + baseIdBytes.length + compressed.length;
    this.objectCount++;

    // Add index entry
    this.indexEntries.push({
      id,
      offset: entryOffset,
      crc32: crcCalc.getValue(),
    });
  }

  /**
   * Add an OFS_DELTA object to the pack
   *
   * The base object is referenced by a negative offset from this object.
   * The base object MUST have been written earlier in this pack.
   *
   * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackOutputStream.java#writeHeader
   *
   * @param id Object ID of the deltified object
   * @param baseId Object ID of the base object (must be in this pack)
   * @param delta Delta data to apply to the base
   */
  async addOfsDelta(id: string, baseId: string, delta: Uint8Array): Promise<void> {
    if (this.finalized) {
      throw new Error("Pack has been finalized");
    }

    const baseOffset = this.objectOffsets.get(baseId);
    if (baseOffset === undefined) {
      throw new Error(`Base object ${baseId} not found in pack`);
    }

    const entryOffset = this.currentOffset;
    const negativeOffset = entryOffset - baseOffset;

    this.objectOffsets.set(id, entryOffset);

    // Write object header
    const header = writePackHeader(PackObjectType.OFS_DELTA, delta.length);
    const offsetBytes = writeOfsVarint(negativeOffset);

    // Compress the delta
    const compressed = await compressBlock(delta, { raw: false });

    // Compute CRC32
    const crcCalc = new CRC32();
    crcCalc.update(header);
    crcCalc.update(offsetBytes);
    crcCalc.update(compressed);

    // Add to chunks
    this.chunks.push(header);
    this.chunks.push(offsetBytes);
    this.chunks.push(compressed);
    this.currentOffset += header.length + offsetBytes.length + compressed.length;
    this.objectCount++;

    // Add index entry
    this.indexEntries.push({
      id,
      offset: entryOffset,
      crc32: crcCalc.getValue(),
    });
  }

  /**
   * Get the current offset in the pack
   *
   * Useful for calculating OFS_DELTA offsets.
   */
  getCurrentOffset(): number {
    return this.currentOffset;
  }

  /**
   * Get the offset of a previously written object
   */
  getObjectOffset(id: string): number | undefined {
    return this.objectOffsets.get(id);
  }

  /**
   * Finalize the pack and return the result
   *
   * After calling this method, no more objects can be added.
   */
  async finalize(): Promise<PackWriterResult> {
    if (this.finalized) {
      throw new Error("Pack has already been finalized");
    }
    this.finalized = true;

    // Build pack header
    const header = concatBytes(
      PACK_SIGNATURE,
      encodeUInt32(PACK_VERSION),
      encodeUInt32(this.objectCount),
    );

    // Prepend header to chunks and adjust offsets
    const headerSize = header.length;
    for (const entry of this.indexEntries) {
      entry.offset += headerSize;
    }

    // Concatenate all data
    const packDataWithoutChecksum = concatBytes(header, ...this.chunks);

    // Compute pack checksum
    const packChecksum = await sha1(packDataWithoutChecksum);

    // Final pack data
    const packData = concatBytes(packDataWithoutChecksum, packChecksum);

    // Sort index entries by object ID
    const sortedEntries = [...this.indexEntries].sort((a, b) => a.id.localeCompare(b.id));

    return {
      packData,
      packChecksum,
      indexEntries: sortedEntries,
    };
  }
}
