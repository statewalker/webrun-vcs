/**
 * Pack index file reader
 *
 * Reads .idx files to locate objects within pack files.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndex.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexV1.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexV2.java
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { PackIndex, PackIndexEntry } from "./types.js";

/** Magic bytes for V2+ index: 0xFF, 't', 'O', 'c' */
const TOC_SIGNATURE = new Uint8Array([0xff, 0x74, 0x4f, 0x63]);

/** Number of fanout buckets (one per possible first byte) */
const FANOUT_SIZE = 256;

/** SHA-1 hash size in bytes */
const OBJECT_ID_LENGTH = 20;

/**
 * Decode a 32-bit unsigned integer from big-endian bytes
 */
function decodeUInt32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * Decode a 64-bit unsigned integer from big-endian bytes
 *
 * Note: JavaScript numbers only have 53 bits of precision for integers,
 * so very large pack files (>8PB) would have precision issues.
 */
function decodeUInt64(data: Uint8Array, offset: number): number {
  const high = decodeUInt32(data, offset);
  const low = decodeUInt32(data, offset + 4);
  return high * 0x100000000 + low;
}

/**
 * Compare two object IDs (as raw bytes)
 *
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
function compareBytes(a: Uint8Array, aOffset: number, b: Uint8Array): number {
  for (let i = 0; i < OBJECT_ID_LENGTH; i++) {
    const diff = a[aOffset + i] - b[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Compare a prefix with an object ID
 *
 * @param prefix Hex prefix string
 * @param data Raw object ID bytes
 * @param offset Offset into data
 * @returns negative if prefix < id, 0 if prefix matches, positive if prefix > id
 */
function comparePrefixToBytes(prefix: Uint8Array, data: Uint8Array, offset: number): number {
  for (let i = 0; i < prefix.length; i++) {
    const diff = prefix[i] - data[offset + i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Read a pack index from raw bytes
 *
 * Automatically detects V1 vs V2 format.
 */
export function readPackIndex(data: Uint8Array): PackIndex {
  if (data.length < 8) {
    throw new Error("Pack index file too small");
  }

  // Check for V2+ TOC signature
  if (isTocSignature(data)) {
    const version = decodeUInt32(data, 4);
    if (version === 2) {
      return new PackIndexV2(data);
    }
    throw new Error(`Unsupported pack index version: ${version}`);
  }

  // No TOC means V1 format
  return new PackIndexV1(data);
}

/**
 * Check if data starts with V2+ TOC signature
 */
function isTocSignature(data: Uint8Array): boolean {
  for (let i = 0; i < TOC_SIGNATURE.length; i++) {
    if (data[i] !== TOC_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Base class for pack index implementations
 */
abstract class BasePackIndex implements PackIndex {
  protected readonly data: Uint8Array;
  protected readonly fanoutTable: number[];
  readonly objectCount!: number; // Set by subclass constructors

  constructor(data: Uint8Array) {
    this.data = data;
    this.fanoutTable = new Array(FANOUT_SIZE);
  }

  abstract readonly version: number;
  abstract readonly offset64Count: number;
  abstract readonly packChecksum: Uint8Array;
  abstract readonly indexChecksum: Uint8Array;

  has(id: ObjectId): boolean {
    return this.findOffset(id) !== -1;
  }

  abstract findOffset(id: ObjectId): number;
  abstract findPosition(id: ObjectId): number;
  abstract findCRC32(id: ObjectId): number | undefined;
  abstract hasCRC32Support(): boolean;
  abstract getObjectId(nthPosition: number): ObjectId;
  abstract getOffset(nthPosition: number): number;
  abstract entries(): IterableIterator<PackIndexEntry>;
  abstract resolve(prefix: string, limit?: number): ObjectId[];

  /**
   * List all object IDs in the index
   */
  *listObjects(): IterableIterator<ObjectId> {
    for (let i = 0; i < this.objectCount; i++) {
      yield this.getObjectId(i);
    }
  }

  /**
   * Find which bucket (first byte) contains the nth position
   */
  protected findLevelOne(nthPosition: number): number {
    // Binary search for the bucket containing position
    let low = 0;
    let high = FANOUT_SIZE - 1;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.fanoutTable[mid] <= nthPosition) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  /**
   * Get position within a bucket
   */
  protected getLevelTwo(nthPosition: number, levelOne: number): number {
    const base = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    return nthPosition - base;
  }
}

/**
 * Pack index V1 format reader
 *
 * V1 format:
 * - Fanout table: 256 x 4 bytes (cumulative object count per first byte)
 * - For each object: 4-byte offset + 20-byte SHA-1
 * - Pack checksum: 20 bytes
 * - Index checksum: 20 bytes (optional, may not be present in old indexes)
 */
class PackIndexV1 extends BasePackIndex {
  readonly version = 1;
  private _offset64Count: number | undefined;

  constructor(data: Uint8Array) {
    super(data);

    // Read fanout table
    for (let i = 0; i < FANOUT_SIZE; i++) {
      this.fanoutTable[i] = decodeUInt32(data, i * 4);
    }
    (this as { objectCount: number }).objectCount = this.fanoutTable[FANOUT_SIZE - 1];
  }

  get offset64Count(): number {
    if (this._offset64Count === undefined) {
      // V1 doesn't have a separate 64-bit offset table
      // Count offsets >= 2GB (which would overflow a signed 32-bit int)
      let count = 0;
      for (let i = 0; i < this.objectCount; i++) {
        if (this.getOffset(i) >= 0x80000000) count++;
      }
      this._offset64Count = count;
    }
    return this._offset64Count;
  }

  get packChecksum(): Uint8Array {
    const fanoutEnd = FANOUT_SIZE * 4;
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const entriesEnd = fanoutEnd + this.objectCount * recordSize;
    return this.data.subarray(entriesEnd, entriesEnd + OBJECT_ID_LENGTH);
  }

  get indexChecksum(): Uint8Array {
    const fanoutEnd = FANOUT_SIZE * 4;
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const entriesEnd = fanoutEnd + this.objectCount * recordSize;
    // Index checksum follows pack checksum
    return this.data.subarray(entriesEnd + OBJECT_ID_LENGTH, entriesEnd + OBJECT_ID_LENGTH * 2);
  }

  findOffset(id: ObjectId): number {
    const idBytes = hexToBytes(id);
    const levelOne = idBytes[0];

    const bucketStart = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    const bucketEnd = this.fanoutTable[levelOne];
    const bucketCount = bucketEnd - bucketStart;

    if (bucketCount === 0) return -1;

    // Binary search within bucket
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;
    const baseOffset = fanoutEnd + bucketStart * recordSize;

    let low = 0;
    let high = bucketCount;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entryOffset = baseOffset + mid * recordSize + 4; // +4 to skip offset field
      const cmp = compareBytes(this.data, entryOffset, idBytes);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        // Found it - read offset from 4 bytes before the ID
        return decodeUInt32(this.data, entryOffset - 4);
      }
    }

    return -1;
  }

  findPosition(id: ObjectId): number {
    const idBytes = hexToBytes(id);
    const levelOne = idBytes[0];

    const bucketStart = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    const bucketEnd = this.fanoutTable[levelOne];
    const bucketCount = bucketEnd - bucketStart;

    if (bucketCount === 0) return -1;

    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;
    const baseOffset = fanoutEnd + bucketStart * recordSize;

    let low = 0;
    let high = bucketCount;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entryOffset = baseOffset + mid * recordSize + 4;
      const cmp = compareBytes(this.data, entryOffset, idBytes);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return bucketStart + mid;
      }
    }

    return -1;
  }

  findCRC32(_id: ObjectId): number | undefined {
    return undefined; // V1 doesn't support CRC32
  }

  hasCRC32Support(): boolean {
    return false;
  }

  getObjectId(nthPosition: number): ObjectId {
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;
    const entryOffset = fanoutEnd + nthPosition * recordSize + 4;
    return bytesToHex(this.data.subarray(entryOffset, entryOffset + OBJECT_ID_LENGTH));
  }

  getOffset(nthPosition: number): number {
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;
    const entryOffset = fanoutEnd + nthPosition * recordSize;
    return decodeUInt32(this.data, entryOffset);
  }

  *entries(): IterableIterator<PackIndexEntry> {
    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;

    for (let i = 0; i < this.objectCount; i++) {
      const entryOffset = fanoutEnd + i * recordSize;
      yield {
        id: bytesToHex(this.data.subarray(entryOffset + 4, entryOffset + 4 + OBJECT_ID_LENGTH)),
        offset: decodeUInt32(this.data, entryOffset),
      };
    }
  }

  resolve(prefix: string, limit = 10): ObjectId[] {
    const prefixBytes = hexToBytes(prefix.padEnd(40, "0"));
    const prefixLen = Math.floor(prefix.length / 2);
    const levelOne = prefixBytes[0];

    const bucketStart = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    const bucketEnd = this.fanoutTable[levelOne];
    const bucketCount = bucketEnd - bucketStart;

    if (bucketCount === 0) return [];

    const recordSize = 4 + OBJECT_ID_LENGTH;
    const fanoutEnd = FANOUT_SIZE * 4;
    const baseOffset = fanoutEnd + bucketStart * recordSize;

    // Binary search to find first match
    let low = 0;
    let high = bucketCount;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entryOffset = baseOffset + mid * recordSize + 4;
      const cmp = comparePrefixToBytes(prefixBytes.subarray(0, prefixLen), this.data, entryOffset);

      if (cmp <= 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    // Collect matches
    const matches: ObjectId[] = [];
    for (let i = low; i < bucketCount && matches.length < limit; i++) {
      const entryOffset = baseOffset + i * recordSize + 4;
      if (comparePrefixToBytes(prefixBytes.subarray(0, prefixLen), this.data, entryOffset) !== 0) {
        break;
      }
      matches.push(bytesToHex(this.data.subarray(entryOffset, entryOffset + OBJECT_ID_LENGTH)));
    }

    return matches;
  }
}

/**
 * Pack index V2 format reader
 *
 * V2 format:
 * - Magic: 0xFF, 't', 'O', 'c' (4 bytes)
 * - Version: 2 (4 bytes)
 * - Fanout table: 256 x 4 bytes
 * - Object names: N x 20 bytes (sorted)
 * - CRC32 checksums: N x 4 bytes
 * - 32-bit offsets: N x 4 bytes (high bit set = index into 64-bit table)
 * - 64-bit offsets: M x 8 bytes (only for large files)
 * - Pack checksum: 20 bytes
 * - Index checksum: 20 bytes
 */
class PackIndexV2 extends BasePackIndex {
  readonly version = 2;
  private readonly namesOffset: number;
  private readonly crc32Offset: number;
  private readonly offset32Offset: number;
  private readonly offset64Offset: number;
  private readonly packChecksumOffset: number;

  constructor(data: Uint8Array) {
    super(data);

    // Skip magic (4) + version (4)
    const fanoutOffset = 8;

    // Read fanout table
    for (let i = 0; i < FANOUT_SIZE; i++) {
      this.fanoutTable[i] = decodeUInt32(data, fanoutOffset + i * 4);
    }
    (this as { objectCount: number }).objectCount = this.fanoutTable[FANOUT_SIZE - 1];

    // Calculate section offsets
    this.namesOffset = fanoutOffset + FANOUT_SIZE * 4;
    this.crc32Offset = this.namesOffset + this.objectCount * OBJECT_ID_LENGTH;
    this.offset32Offset = this.crc32Offset + this.objectCount * 4;

    // Count 64-bit offsets by scanning 32-bit offset table
    let offset64Count = 0;
    for (let i = 0; i < this.objectCount; i++) {
      const offset32 = decodeUInt32(data, this.offset32Offset + i * 4);
      if ((offset32 & 0x80000000) !== 0) {
        offset64Count++;
      }
    }

    this.offset64Offset = this.offset32Offset + this.objectCount * 4;
    this.packChecksumOffset = this.offset64Offset + offset64Count * 8;
  }

  get offset64Count(): number {
    return (this.packChecksumOffset - this.offset64Offset) / 8;
  }

  get packChecksum(): Uint8Array {
    return this.data.subarray(this.packChecksumOffset, this.packChecksumOffset + OBJECT_ID_LENGTH);
  }

  get indexChecksum(): Uint8Array {
    return this.data.subarray(
      this.packChecksumOffset + OBJECT_ID_LENGTH,
      this.packChecksumOffset + OBJECT_ID_LENGTH * 2,
    );
  }

  findOffset(id: ObjectId): number {
    const position = this.findPosition(id);
    if (position === -1) return -1;
    return this.getOffset(position);
  }

  findPosition(id: ObjectId): number {
    const idBytes = hexToBytes(id);
    const levelOne = idBytes[0];

    const bucketStart = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    const bucketEnd = this.fanoutTable[levelOne];
    const bucketCount = bucketEnd - bucketStart;

    if (bucketCount === 0) return -1;

    // Binary search in names table
    let low = 0;
    let high = bucketCount;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entryOffset = this.namesOffset + (bucketStart + mid) * OBJECT_ID_LENGTH;
      const cmp = compareBytes(this.data, entryOffset, idBytes);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return bucketStart + mid;
      }
    }

    return -1;
  }

  findCRC32(id: ObjectId): number | undefined {
    const position = this.findPosition(id);
    if (position === -1) return undefined;
    return decodeUInt32(this.data, this.crc32Offset + position * 4);
  }

  hasCRC32Support(): boolean {
    return true;
  }

  getObjectId(nthPosition: number): ObjectId {
    const offset = this.namesOffset + nthPosition * OBJECT_ID_LENGTH;
    return bytesToHex(this.data.subarray(offset, offset + OBJECT_ID_LENGTH));
  }

  getOffset(nthPosition: number): number {
    const offset32 = decodeUInt32(this.data, this.offset32Offset + nthPosition * 4);

    // High bit set means index into 64-bit table
    if ((offset32 & 0x80000000) !== 0) {
      const idx = offset32 & 0x7fffffff;
      return decodeUInt64(this.data, this.offset64Offset + idx * 8);
    }

    return offset32;
  }

  *entries(): IterableIterator<PackIndexEntry> {
    for (let i = 0; i < this.objectCount; i++) {
      yield {
        id: this.getObjectId(i),
        offset: this.getOffset(i),
        crc32: decodeUInt32(this.data, this.crc32Offset + i * 4),
      };
    }
  }

  resolve(prefix: string, limit = 10): ObjectId[] {
    const prefixBytes = hexToBytes(prefix.padEnd(40, "0"));
    const prefixLen = Math.floor(prefix.length / 2);
    const levelOne = prefixBytes[0];

    const bucketStart = levelOne > 0 ? this.fanoutTable[levelOne - 1] : 0;
    const bucketEnd = this.fanoutTable[levelOne];
    const bucketCount = bucketEnd - bucketStart;

    if (bucketCount === 0) return [];

    // Binary search to find first match
    let low = 0;
    let high = bucketCount;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entryOffset = this.namesOffset + (bucketStart + mid) * OBJECT_ID_LENGTH;
      const cmp = comparePrefixToBytes(prefixBytes.subarray(0, prefixLen), this.data, entryOffset);

      if (cmp <= 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    // Collect matches
    const matches: ObjectId[] = [];
    for (let i = low; i < bucketCount && matches.length < limit; i++) {
      const entryOffset = this.namesOffset + (bucketStart + i) * OBJECT_ID_LENGTH;
      if (comparePrefixToBytes(prefixBytes.subarray(0, prefixLen), this.data, entryOffset) !== 0) {
        break;
      }
      matches.push(bytesToHex(this.data.subarray(entryOffset, entryOffset + OBJECT_ID_LENGTH)));
    }

    return matches;
  }
}
