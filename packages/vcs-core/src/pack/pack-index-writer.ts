/**
 * Pack index file writer
 *
 * Writes .idx files to enable random access to objects within pack files.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/BasePackIndexWriter.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexWriterV1.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexWriterV2.java
 */

import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";

/** Magic bytes for V2+ index: 0xFF, 't', 'O', 'c' */
const TOC_SIGNATURE = new Uint8Array([0xff, 0x74, 0x4f, 0x63]);

/** Number of fanout buckets (one per possible first byte) */
const FANOUT_SIZE = 256;

/** SHA-1 hash size in bytes */
const OBJECT_ID_LENGTH = 20;

/** Maximum offset for V1 format (32-bit unsigned) */
const MAX_OFFSET_V1 = 0xffffffff;

/** Maximum offset for V2 32-bit offset table (high bit is flag for 64-bit table) */
const MAX_OFFSET_32 = 0x7fffffff;

/** Flag indicating the offset is in the 64-bit table */
const IS_OFFSET_64 = 0x80000000;

/**
 * Entry to be written to the pack index
 */
export interface PackIndexWriterEntry {
  /** Object ID (40-char hex string) */
  id: string;
  /** Byte offset within the pack file */
  offset: number;
  /** CRC32 checksum of the packed object data (required for V2) */
  crc32: number;
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
 * Encode a 64-bit unsigned integer to big-endian bytes
 */
function encodeUInt64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  // JavaScript numbers can safely represent integers up to 2^53-1
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  bytes[0] = (high >>> 24) & 0xff;
  bytes[1] = (high >>> 16) & 0xff;
  bytes[2] = (high >>> 8) & 0xff;
  bytes[3] = high & 0xff;
  bytes[4] = (low >>> 24) & 0xff;
  bytes[5] = (low >>> 16) & 0xff;
  bytes[6] = (low >>> 8) & 0xff;
  bytes[7] = low & 0xff;
  return bytes;
}

/**
 * Determine the oldest (most compatible) index format for the given entries
 *
 * Returns 1 if all offsets fit in 32 bits, otherwise returns 2.
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/BasePackIndexWriter.java#oldestPossibleFormat
 *
 * @param entries List of entries to analyze
 * @returns 1 for V1 format, 2 for V2 format
 */
export function oldestPossibleFormat(entries: readonly PackIndexWriterEntry[]): number {
  for (const entry of entries) {
    if (entry.offset > MAX_OFFSET_V1) {
      return 2;
    }
  }
  return 1;
}

/**
 * Check if V1 format can store the given entry
 *
 * V1 can only store offsets up to 4GB (32-bit unsigned).
 */
function canStoreV1(entry: PackIndexWriterEntry): boolean {
  // V1 uses unsigned 32-bit offset, so limit is 0xFFFFFFFF
  return entry.offset <= MAX_OFFSET_V1;
}

/**
 * Build the fanout table from sorted entries
 *
 * The fanout table contains cumulative counts of objects for each
 * possible first byte of the object ID.
 *
 * @param entries Sorted entries
 * @returns Fanout table (256 entries)
 */
function buildFanoutTable(entries: readonly PackIndexWriterEntry[]): number[] {
  const fanout = new Array(FANOUT_SIZE).fill(0);

  // Count objects for each first byte
  for (const entry of entries) {
    const firstByte = parseInt(entry.id.substring(0, 2), 16);
    fanout[firstByte]++;
  }

  // Convert to cumulative counts
  for (let i = 1; i < FANOUT_SIZE; i++) {
    fanout[i] += fanout[i - 1];
  }

  return fanout;
}

/**
 * Write pack index in V1 format
 *
 * V1 format:
 * - Fanout table: 256 x 4 bytes (cumulative object count per first byte)
 * - For each object: 4-byte offset + 20-byte SHA-1
 * - Pack checksum: 20 bytes
 * - Index checksum: 20 bytes
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexWriterV1.java
 *
 * @param entries Sorted list of entries to write (must be sorted by object ID)
 * @param packChecksum SHA-1 checksum of the pack data (last 20 bytes of pack file)
 * @returns Complete index file data
 */
export async function writePackIndexV1(
  entries: readonly PackIndexWriterEntry[],
  packChecksum: Uint8Array,
): Promise<Uint8Array> {
  // Validate all entries can be stored in V1 format
  for (const entry of entries) {
    if (!canStoreV1(entry)) {
      throw new Error(
        `Pack too large for index version 1: offset ${entry.offset} exceeds 4GB limit`,
      );
    }
  }

  // Calculate total size
  const fanoutSize = FANOUT_SIZE * 4;
  const entriesSize = entries.length * (4 + OBJECT_ID_LENGTH);
  const checksumsSize = OBJECT_ID_LENGTH * 2;
  const totalSize = fanoutSize + entriesSize + checksumsSize;

  const result = new Uint8Array(totalSize);
  let offset = 0;

  // Write fanout table
  const fanout = buildFanoutTable(entries);
  for (let i = 0; i < FANOUT_SIZE; i++) {
    result.set(encodeUInt32(fanout[i]), offset);
    offset += 4;
  }

  // Write entries (4-byte offset + 20-byte object ID)
  for (const entry of entries) {
    result.set(encodeUInt32(entry.offset), offset);
    offset += 4;
    result.set(hexToBytes(entry.id), offset);
    offset += OBJECT_ID_LENGTH;
  }

  // Write pack checksum
  result.set(packChecksum, offset);
  offset += OBJECT_ID_LENGTH;

  // Calculate and write index checksum (SHA-1 of everything before it)
  const indexChecksum = await sha1(result.subarray(0, offset));
  result.set(indexChecksum, offset);

  return result;
}

/**
 * Write pack index in V2 format
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
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexWriterV2.java
 *
 * @param entries Sorted list of entries to write (must be sorted by object ID)
 * @param packChecksum SHA-1 checksum of the pack data (last 20 bytes of pack file)
 * @returns Complete index file data
 */
export async function writePackIndexV2(
  entries: readonly PackIndexWriterEntry[],
  packChecksum: Uint8Array,
): Promise<Uint8Array> {
  // Count 64-bit offsets needed
  let offset64Count = 0;
  for (const entry of entries) {
    if (entry.offset > MAX_OFFSET_32) {
      offset64Count++;
    }
  }

  // Calculate total size
  const headerSize = 8; // magic + version
  const fanoutSize = FANOUT_SIZE * 4;
  const namesSize = entries.length * OBJECT_ID_LENGTH;
  const crc32Size = entries.length * 4;
  const offset32Size = entries.length * 4;
  const offset64Size = offset64Count * 8;
  const checksumsSize = OBJECT_ID_LENGTH * 2;
  const totalSize =
    headerSize + fanoutSize + namesSize + crc32Size + offset32Size + offset64Size + checksumsSize;

  const result = new Uint8Array(totalSize);
  let offset = 0;

  // Write TOC header
  result.set(TOC_SIGNATURE, offset);
  offset += 4;
  result.set(encodeUInt32(2), offset); // version 2
  offset += 4;

  // Write fanout table
  const fanout = buildFanoutTable(entries);
  for (let i = 0; i < FANOUT_SIZE; i++) {
    result.set(encodeUInt32(fanout[i]), offset);
    offset += 4;
  }

  // Write object names (sorted)
  for (const entry of entries) {
    result.set(hexToBytes(entry.id), offset);
    offset += OBJECT_ID_LENGTH;
  }

  // Write CRC32 checksums
  for (const entry of entries) {
    result.set(encodeUInt32(entry.crc32 >>> 0), offset);
    offset += 4;
  }

  // Write 32-bit offsets (or indices into 64-bit table)
  let offset64Index = 0;
  for (const entry of entries) {
    if (entry.offset <= MAX_OFFSET_32) {
      result.set(encodeUInt32(entry.offset), offset);
    } else {
      // High bit set indicates index into 64-bit offset table
      result.set(encodeUInt32(IS_OFFSET_64 | offset64Index), offset);
      offset64Index++;
    }
    offset += 4;
  }

  // Write 64-bit offsets
  for (const entry of entries) {
    if (entry.offset > MAX_OFFSET_32) {
      result.set(encodeUInt64(entry.offset), offset);
      offset += 8;
    }
  }

  // Write pack checksum
  result.set(packChecksum, offset);
  offset += OBJECT_ID_LENGTH;

  // Calculate and write index checksum (SHA-1 of everything before it)
  const indexChecksum = await sha1(result.subarray(0, offset));
  result.set(indexChecksum, offset);

  return result;
}

/**
 * Write pack index using the most compatible format
 *
 * Automatically selects V1 or V2 based on the entry offsets.
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/BasePackIndexWriter.java#createOldestPossible
 *
 * @param entries Sorted list of entries to write (must be sorted by object ID)
 * @param packChecksum SHA-1 checksum of the pack data (last 20 bytes of pack file)
 * @returns Complete index file data
 */
export async function writePackIndex(
  entries: readonly PackIndexWriterEntry[],
  packChecksum: Uint8Array,
): Promise<Uint8Array> {
  const version = oldestPossibleFormat(entries);
  if (version === 1) {
    return writePackIndexV1(entries, packChecksum);
  }
  return writePackIndexV2(entries, packChecksum);
}

/**
 * Write pack index in a specific version
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/BasePackIndexWriter.java#createVersion
 *
 * @param entries Sorted list of entries to write (must be sorted by object ID)
 * @param packChecksum SHA-1 checksum of the pack data (last 20 bytes of pack file)
 * @param version Index format version (1 or 2)
 * @returns Complete index file data
 */
export async function writePackIndexVersion(
  entries: readonly PackIndexWriterEntry[],
  packChecksum: Uint8Array,
  version: number,
): Promise<Uint8Array> {
  switch (version) {
    case 1:
      return writePackIndexV1(entries, packChecksum);
    case 2:
      return writePackIndexV2(entries, packChecksum);
    default:
      throw new Error(`Unsupported pack index version: ${version}`);
  }
}
