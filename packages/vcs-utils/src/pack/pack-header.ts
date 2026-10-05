/**
 * Pack file header parsing
 *
 * Extracts version and object count from the 12-byte pack file header.
 * Shared between pack-entries-parser, pack-indexer, and transport.
 */

/** Pack file signature "PACK" as 32-bit big-endian */
const PACK_SIGNATURE = 0x5041434b;

/**
 * Parse and validate a pack file header (first 12 bytes).
 *
 * @param data At least 12 bytes of pack header
 * @returns Pack version and object count
 */
export function parsePackHeader(data: Uint8Array): { version: number; objectCount: number } {
  if (data.length < 12) {
    throw new Error("Pack data too short for header");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const signature = view.getUint32(0, false);
  if (signature !== PACK_SIGNATURE) {
    throw new Error(`Invalid pack signature: 0x${signature.toString(16)}`);
  }

  const version = view.getUint32(4, false);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported pack version: ${version}`);
  }

  const objectCount = view.getUint32(8, false);
  return { version, objectCount };
}
