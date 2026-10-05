/**
 * Pack-aware stream reader.
 *
 * Reads exactly one Git pack from a byte stream by parsing the pack header
 * and object boundaries. Stops after the checksum without consuming more data.
 *
 * Uses `decompressBlockPartial` from vcs-utils to detect compressed data
 * boundaries for each object — the only reliable way to find where one object's
 * compressed data ends and the next begins.
 */

import { BufferedByteReader } from "@statewalker/vcs-utils/streams";

/** Pack file signature "PACK" (0x5041434B) */
const PACK_SIGNATURE = 0x5041434b;

/** SHA-1 hash size in bytes */
const HASH_SIZE = 20;

/** Pack header size: 4 (magic) + 4 (version) + 4 (count) */
const PACK_HEADER_SIZE = 12;

/** OFS_DELTA object type */
const OFS_DELTA = 6;

/** REF_DELTA object type */
const REF_DELTA = 7;

/**
 * Read exactly one pack from a byte stream.
 *
 * Parses the pack header to learn the object count, reads each object's
 * header and compressed data using boundary detection, reads the trailing
 * checksum, then stops — without consuming any bytes beyond the pack.
 *
 * @param stream - Raw byte stream (e.g., from a duplex after pkt-line drain)
 * @yields Chunks of pack data as they are read
 */
export async function* readPackFromStream(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, Uint8Array> {
  const reader = new BufferedByteReader(stream[Symbol.asyncIterator]());

  // 1. Read and yield the 12-byte pack header
  const header = await reader.readExact(PACK_HEADER_SIZE);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  const magic = view.getUint32(0, false);
  if (magic !== PACK_SIGNATURE) {
    throw new Error(`Invalid pack signature: 0x${magic.toString(16)}`);
  }

  const version = view.getUint32(4, false);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported pack version: ${version}`);
  }

  const objectCount = view.getUint32(8, false);
  yield header;

  // 2. Read each object: varint header + optional delta header + compressed data
  for (let i = 0; i < objectCount; i++) {
    // Read enough bytes for the varint header (max ~10 bytes typically)
    // The varint header is at most ceil(64/7) ≈ 10 bytes for 64-bit sizes
    const headerBuf = await reader.readExact(1);
    const firstByte = headerBuf[0];
    const type = (firstByte >> 4) & 0x07;
    let size = firstByte & 0x0f;
    let shift = 4;

    // Read continuation bytes
    const headerBytes: number[] = [firstByte];
    let lastByte = firstByte;
    while ((lastByte & 0x80) !== 0) {
      const nextBuf = await reader.readExact(1);
      lastByte = nextBuf[0];
      headerBytes.push(lastByte);
      size |= (lastByte & 0x7f) << shift;
      shift += 7;
    }

    yield new Uint8Array(headerBytes);

    // Handle delta-specific headers
    if (type === OFS_DELTA) {
      // OFS_DELTA: read variable-length negative offset
      // First byte
      const ofsBytes: number[] = [];
      let ofsBuf = await reader.readExact(1);
      ofsBytes.push(ofsBuf[0]);
      while ((ofsBytes[ofsBytes.length - 1] & 0x80) !== 0) {
        ofsBuf = await reader.readExact(1);
        ofsBytes.push(ofsBuf[0]);
      }
      yield new Uint8Array(ofsBytes);
    } else if (type === REF_DELTA) {
      // REF_DELTA: read 20-byte base object ID
      const baseId = await reader.readExact(HASH_SIZE);
      yield baseId;
    }

    // Read compressed object data
    const compressedData = await reader.readCompressedObject(size);
    yield compressedData;
  }

  // 3. Read and yield the 20-byte pack checksum
  const checksum = await reader.readExact(HASH_SIZE);
  yield checksum;

  // Return any leftover bytes so the caller can restore them
  // to the pkt-line reader's buffer (prevents dangling iterator issues)
  return reader.getLeftover();
}
