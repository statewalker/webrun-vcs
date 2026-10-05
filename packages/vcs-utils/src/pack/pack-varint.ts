/**
 * Async pack object header varint reader
 *
 * Reads pack object type + size from a byte-at-a-time source.
 * Used by streaming pack parsers that read from BufferedByteReader.
 */

/**
 * Read a pack object header (type + size) from a byte-at-a-time source.
 *
 * Format:
 * - Byte 0: MSB = continuation, bits 6-4 = type, bits 3-0 = size (low 4 bits)
 * - Subsequent bytes: MSB = continuation, bits 6-0 = size (shifted)
 *
 * @param readByte Function that reads the next byte
 * @returns Object type and uncompressed size
 */
export async function readPackObjectVarintAsync(
  readByte: () => Promise<number>,
): Promise<{ type: number; size: number }> {
  const first = await readByte();
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;

  let current = first;
  while ((current & 0x80) !== 0) {
    current = await readByte();
    size |= (current & 0x7f) << shift;
    shift += 7;
  }

  return { type, size };
}

/**
 * Read an OFS_DELTA offset varint from a byte-at-a-time source.
 *
 * Big-endian encoding where each continuation byte implicitly adds 1.
 *
 * @param readByte Function that reads the next byte
 * @returns Decoded offset value
 */
export async function readOfsVarintAsync(readByte: () => Promise<number>): Promise<number> {
  let b = await readByte();
  let value = b & 0x7f;

  while ((b & 0x80) !== 0) {
    value += 1;
    value <<= 7;
    b = await readByte();
    value |= b & 0x7f;
  }

  return value;
}
