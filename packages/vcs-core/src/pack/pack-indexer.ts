/**
 * Pack file indexer
 *
 * Creates pack index entries from raw pack data.
 * This is the missing piece for HTTP clone - takes packData bytes
 * and generates entries for writePackIndex().
 *
 * Similar to `git index-pack` command.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackIndexWriter.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/transport/IndexPack.java
 */

import { applyGitDelta, decompressBlockPartial } from "@statewalker/vcs-utils";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import {
  computeObjectId,
  MemoryPackObjectCache,
  type PackObjectCache,
  packTypeToString,
  parsePackHeader,
  readOfsVarintAsync,
  readPackObjectVarintAsync,
} from "@statewalker/vcs-utils/pack";
import { BufferedByteReader } from "@statewalker/vcs-utils/streams";
import type { PackIndexWriterEntry } from "./pack-index-writer.js";
import { PackObjectType } from "./types.js";

/** SHA-1 hash size in bytes */
const OBJECT_ID_LENGTH = 20;

/**
 * Result of indexing a pack file
 */
export interface IndexPackResult {
  /** Index entries for each object (sorted by object ID) */
  entries: PackIndexWriterEntry[];
  /** SHA-1 checksum of the pack (last 20 bytes of pack file) */
  packChecksum: Uint8Array;
  /** Number of objects in the pack */
  objectCount: number;
  /** Pack version */
  version: number;
}

/**
 * Object resolved during indexing
 */
interface ResolvedObject {
  /** Object type (1=commit, 2=tree, 3=blob, 4=tag) */
  type: PackObjectType;
  /** Uncompressed content */
  content: Uint8Array;
  /** Object ID (computed SHA-1) */
  id: string;
}

/**
 * Index a pack file from raw bytes.
 *
 * Parses the pack, resolves all objects (including deltas),
 * computes SHA-1 for each object, and returns entries suitable
 * for writePackIndex().
 *
 * @param packData Raw pack file bytes
 * @returns Index entries and pack checksum
 */
export async function indexPack(packData: Uint8Array): Promise<IndexPackResult> {
  const reader = new PackDataReader(packData);

  // Validate and read header
  const header = reader.readPackHeader();

  // Cache for resolved objects (needed for delta resolution)
  // Key: offset in pack, Value: resolved object
  const objectCache = new Map<number, ResolvedObject>();

  // Also index by object ID for REF_DELTA lookups
  const objectById = new Map<string, ResolvedObject>();

  const entries: PackIndexWriterEntry[] = [];

  // Process each object
  let offset = 12; // Start after header

  for (let i = 0; i < header.objectCount; i++) {
    const entryStart = offset;

    // Read object header
    const objHeader = reader.readObjectHeader(offset);
    offset += objHeader.headerLength;

    // Track CRC32 from entry start
    const crcCalc = new CRC32();

    // Read and decompress content
    const { decompressed, compressedLength } = await reader.decompressAt(offset, objHeader.size);
    offset += compressedLength;

    // Calculate CRC32 of raw entry (header + compressed data)
    const rawEntry = packData.subarray(entryStart, offset);
    crcCalc.update(rawEntry);
    const crc32 = crcCalc.getValue();

    // Resolve object (handle deltas)
    let resolved: ResolvedObject;

    switch (objHeader.type) {
      case PackObjectType.COMMIT:
      case PackObjectType.TREE:
      case PackObjectType.BLOB:
      case PackObjectType.TAG: {
        // Base object - compute SHA-1 directly
        const id = await computeObjectId(packTypeToString(objHeader.type), decompressed);
        resolved = { type: objHeader.type, content: decompressed, id };
        break;
      }

      case PackObjectType.OFS_DELTA: {
        // Delta with offset-based base reference
        if (objHeader.baseOffset === undefined) {
          throw new Error(`OFS_DELTA at offset ${entryStart} missing base offset`);
        }
        const baseOffset = entryStart - objHeader.baseOffset;
        const base = objectCache.get(baseOffset);
        if (!base) {
          throw new Error(
            `OFS_DELTA at offset ${entryStart}: base at ${baseOffset} not found in cache`,
          );
        }
        const content = applyGitDelta(base.content, decompressed);
        const id = await computeObjectId(packTypeToString(base.type), content);
        resolved = { type: base.type, content, id };
        break;
      }

      case PackObjectType.REF_DELTA: {
        // Delta with SHA-1 based reference
        if (objHeader.baseId === undefined) {
          throw new Error(`REF_DELTA at offset ${entryStart} missing base ID`);
        }
        const base = objectById.get(objHeader.baseId);
        if (!base) {
          throw new Error(
            `REF_DELTA at offset ${entryStart}: base ${objHeader.baseId} not found. ` +
              `This may be a thin pack requiring external base objects.`,
          );
        }
        const content = applyGitDelta(base.content, decompressed);
        const id = await computeObjectId(packTypeToString(base.type), content);
        resolved = { type: base.type, content, id };
        break;
      }

      default:
        throw new Error(`Unknown object type ${objHeader.type} at offset ${entryStart}`);
    }

    // Cache resolved object for delta resolution
    objectCache.set(entryStart, resolved);
    objectById.set(resolved.id, resolved);

    // Add index entry
    entries.push({
      id: resolved.id,
      offset: entryStart,
      crc32,
    });
  }

  // Extract pack checksum (last 20 bytes)
  const packChecksum = packData.subarray(packData.length - OBJECT_ID_LENGTH);

  // Sort entries by object ID (required for pack index format)
  entries.sort((a, b) => a.id.localeCompare(b.id));

  return {
    entries,
    packChecksum,
    objectCount: header.objectCount,
    version: header.version,
  };
}

/**
 * Index a pack file from an async stream.
 *
 * Streaming equivalent of indexPack — processes pack data incrementally
 * via BufferedByteReader without accumulating the entire pack in memory.
 *
 * @param stream Async iterable of pack data chunks
 * @param cache Optional PackObjectCache for delta resolution (defaults to MemoryPackObjectCache)
 * @returns Index result with entries, checksum, object count, and version
 */
export async function indexPackFromStream(
  stream: AsyncIterable<Uint8Array>,
  cache?: PackObjectCache,
): Promise<IndexPackResult> {
  const ownedCache = !cache;
  if (!cache) {
    cache = new MemoryPackObjectCache();
  }

  try {
    const reader = new BufferedByteReader(stream[Symbol.asyncIterator]());
    let position = 0;

    // Read 12-byte pack header
    const headerData = await reader.readExact(12);
    position += 12;
    const { version, objectCount } = parsePackHeader(headerData);

    const offsetToId = new Map<number, string>();
    const idToType = new Map<string, number>();
    const entries: PackIndexWriterEntry[] = [];

    for (let i = 0; i < objectCount; i++) {
      const entryStart = position;
      const crc = new CRC32();

      // Position-tracking + CRC32-tracking byte reader
      const readByte = async (): Promise<number> => {
        const b = await reader.readExact(1);
        position += 1;
        crc.update(b);
        return b[0];
      };

      // Read object header (type + uncompressed size)
      const { type, size } = await readPackObjectVarintAsync(readByte);

      // Read delta base reference if applicable
      let ofsBaseOffset: number | undefined;
      let refBaseId: string | undefined;

      if (type === PackObjectType.OFS_DELTA) {
        const ofsValue = await readOfsVarintAsync(readByte);
        ofsBaseOffset = entryStart - ofsValue;
      } else if (type === PackObjectType.REF_DELTA) {
        const baseIdBytes = await reader.readExact(OBJECT_ID_LENGTH);
        position += OBJECT_ID_LENGTH;
        crc.update(baseIdBytes);
        refBaseId = bytesToHex(baseIdBytes);
      }

      // Read compressed data (for CRC tracking and decompression)
      const compressedData = await reader.readCompressedObject(size);
      position += compressedData.length;
      crc.update(compressedData);

      // Decompress to get content
      const { data: decompressed } = await decompressBlockPartial(compressedData);

      // Resolve object
      let resolvedId: string;
      let resolvedType: number;

      switch (type) {
        case PackObjectType.COMMIT:
        case PackObjectType.TREE:
        case PackObjectType.BLOB:
        case PackObjectType.TAG: {
          const objectType = packTypeToString(type);
          resolvedId = await computeObjectId(objectType, decompressed);
          resolvedType = type;

          await cache.save(resolvedId, objectType, singleChunk(decompressed));
          break;
        }

        case PackObjectType.OFS_DELTA: {
          if (ofsBaseOffset === undefined) {
            throw new Error(`OFS_DELTA at position ${entryStart} missing base offset`);
          }
          const baseId = offsetToId.get(ofsBaseOffset);
          if (!baseId) {
            throw new Error(
              `OFS_DELTA at position ${entryStart}: base at ${ofsBaseOffset} not found`,
            );
          }
          const baseType = idToType.get(baseId);
          if (baseType === undefined) {
            throw new Error(
              `OFS_DELTA at position ${entryStart}: type for base ${baseId} not found`,
            );
          }
          const baseContent = await collectBytes(cache.read(baseId));
          const content = applyGitDelta(baseContent, decompressed);
          const objectType = packTypeToString(baseType);
          resolvedId = await computeObjectId(objectType, content);
          resolvedType = baseType;

          await cache.save(resolvedId, objectType, singleChunk(content));
          break;
        }

        case PackObjectType.REF_DELTA: {
          if (!refBaseId) {
            throw new Error(`REF_DELTA at position ${entryStart} missing base ID`);
          }
          const baseType = idToType.get(refBaseId);
          if (baseType === undefined) {
            throw new Error(`REF_DELTA at position ${entryStart}: base ${refBaseId} not found`);
          }
          const baseContent = await collectBytes(cache.read(refBaseId));
          const content = applyGitDelta(baseContent, decompressed);
          const objectType = packTypeToString(baseType);
          resolvedId = await computeObjectId(objectType, content);
          resolvedType = baseType;

          await cache.save(resolvedId, objectType, singleChunk(content));
          break;
        }

        default:
          throw new Error(`Unknown object type ${type} at position ${entryStart}`);
      }

      offsetToId.set(entryStart, resolvedId);
      idToType.set(resolvedId, resolvedType);

      entries.push({
        id: resolvedId,
        offset: entryStart,
        crc32: crc.getValue(),
      });
    }

    // Read 20-byte pack checksum
    const packChecksum = await reader.readExact(OBJECT_ID_LENGTH);

    // Sort entries by object ID
    entries.sort((a, b) => a.id.localeCompare(b.id));

    return { entries, packChecksum, objectCount, version };
  } finally {
    if (ownedCache && cache) {
      await cache.dispose();
    }
  }
}

/** Yield a single Uint8Array chunk as an async iterable */
async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** Collect an async iterable of Uint8Array into a single buffer */
async function collectBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  if (chunks.length === 1) return chunks[0];
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/**
 * In-memory pack data reader
 */
class PackDataReader {
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /**
   * Read and validate pack header
   */
  readPackHeader(): { version: number; objectCount: number } {
    return parsePackHeader(this.data);
  }

  /**
   * Read object header at offset
   */
  readObjectHeader(offset: number): {
    type: PackObjectType;
    size: number;
    baseOffset?: number;
    baseId?: string;
    headerLength: number;
  } {
    let pos = offset;

    // First byte: type in bits 4-6, size in bits 0-3
    let c = this.data[pos++];
    const type = ((c >> 4) & 0x07) as PackObjectType;
    let size = c & 0x0f;
    let shift = 4;

    // Continue reading size (variable-length encoding)
    while ((c & 0x80) !== 0) {
      c = this.data[pos++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }

    let headerLength = pos - offset;
    let baseOffset: number | undefined;
    let baseId: string | undefined;

    // For delta types, read base reference
    if (type === PackObjectType.OFS_DELTA) {
      // OFS_DELTA: negative offset encoded as variable-length integer
      c = this.data[pos++];
      baseOffset = c & 0x7f;
      while ((c & 0x80) !== 0) {
        baseOffset++;
        c = this.data[pos++];
        baseOffset <<= 7;
        baseOffset += c & 0x7f;
      }
      headerLength = pos - offset;
    } else if (type === PackObjectType.REF_DELTA) {
      // REF_DELTA: 20-byte base object ID
      baseId = bytesToHex(this.data.subarray(pos, pos + OBJECT_ID_LENGTH));
      pos += OBJECT_ID_LENGTH;
      headerLength = pos - offset;
    }

    return { type, size, baseOffset, baseId, headerLength };
  }

  /**
   * Decompress zlib data at offset
   *
   * Returns decompressed data and the number of compressed bytes consumed.
   * Uses decompressBlockPartial which handles trailing data in pack files.
   */
  async decompressAt(
    offset: number,
    expectedSize: number,
  ): Promise<{ decompressed: Uint8Array; compressedLength: number }> {
    // Provide data from offset to end of pack (minus checksum)
    // decompressBlockPartial will determine the exact boundary
    const compressed = this.data.subarray(offset, this.data.length - 20);

    const result = await decompressBlockPartial(compressed, { raw: false });

    if (result.data.length !== expectedSize) {
      throw new Error(
        `Decompression size mismatch: expected ${expectedSize}, got ${result.data.length}`,
      );
    }

    return { decompressed: result.data, compressedLength: result.bytesRead };
  }
}

/**
 * Verify pack checksum
 */
export async function verifyPackChecksum(packData: Uint8Array): Promise<boolean> {
  if (packData.length < 20) {
    return false;
  }

  const dataWithoutChecksum = packData.subarray(0, packData.length - OBJECT_ID_LENGTH);
  const storedChecksum = packData.subarray(packData.length - OBJECT_ID_LENGTH);
  const computedChecksum = await sha1(dataWithoutChecksum);

  for (let i = 0; i < OBJECT_ID_LENGTH; i++) {
    if (storedChecksum[i] !== computedChecksum[i]) {
      return false;
    }
  }

  return true;
}
