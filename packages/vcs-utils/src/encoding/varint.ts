/**
 * Variable-length integer encoding/decoding
 *
 * Git uses multiple varint formats:
 *
 * 1. Standard varint (used in delta headers):
 *    - Each byte has 7 bits of data and 1 continuation bit (MSB)
 *    - Little-endian order (LSB first)
 *    - Continuation bit = 0x80 means more bytes follow
 *
 * 2. OFS_DELTA offset varint:
 *    - Big-endian order
 *    - Each continuation adds 1 to the value
 *
 * 3. Pack object header varint:
 *    - First byte: 3-bit type + 4-bit size
 *    - Subsequent bytes: 7-bit size continuation
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/BinaryDelta.java
 */

/**
 * Result of reading a varint
 */
export interface VarintResult {
  /** The decoded value */
  value: number;
  /** Number of bytes consumed */
  bytesRead: number;
}

/**
 * Result of reading a pack object header
 */
export interface PackHeaderResult {
  /** Object type (1-7) */
  type: number;
  /** Uncompressed size */
  size: number;
  /** Number of bytes consumed */
  bytesRead: number;
}

/**
 * Read a standard varint (little-endian, 7-bit with continuation)
 *
 * Used in: delta base/result size headers
 *
 * @param data Buffer to read from
 * @param offset Starting offset
 * @returns Decoded value and bytes consumed
 */
export function readVarint(data: Uint8Array, offset: number): VarintResult {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (true) {
    if (offset + bytesRead >= data.length) {
      throw new Error("Truncated varint");
    }

    const b = data[offset + bytesRead];
    bytesRead++;

    value |= (b & 0x7f) << shift;
    shift += 7;

    if ((b & 0x80) === 0) {
      break;
    }

    // Safety check for overly long varints
    if (shift > 63) {
      throw new Error("Varint too long");
    }
  }

  return { value, bytesRead };
}

/**
 * Write a standard varint
 *
 * @param value Value to encode
 * @returns Encoded bytes
 */
export function writeVarint(value: number): Uint8Array {
  const bytes: number[] = [];

  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);

  return new Uint8Array(bytes);
}

/**
 * Append a varint to an array (for efficient buffer building)
 *
 * @param output Array to append to
 * @param value Value to encode
 */
export function appendVarint(output: number[], value: number): void {
  while (value > 0x7f) {
    output.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  output.push(value & 0x7f);
}

/**
 * Calculate the size of a varint encoding without actually encoding
 *
 * @param value Value to measure
 * @returns Number of bytes needed to encode the value
 */
export function varintSize(value: number): number {
  let size = 1;
  while (value > 0x7f) {
    value >>>= 7;
    size++;
  }
  return size;
}

/**
 * Read an OFS_DELTA negative offset varint
 *
 * This encoding is used for offset deltas in pack files.
 * The encoding is big-endian and each continuation byte
 * implicitly adds 1 to account for the byte itself.
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackOutputStream.java
 *
 * @param data Buffer to read from
 * @param offset Starting offset
 * @returns Decoded offset value and bytes consumed
 */
export function readOfsVarint(data: Uint8Array, offset: number): VarintResult {
  if (offset >= data.length) {
    throw new Error("Truncated OFS varint");
  }

  let value = data[offset] & 0x7f;
  let bytesRead = 1;

  while ((data[offset + bytesRead - 1] & 0x80) !== 0) {
    if (offset + bytesRead >= data.length) {
      throw new Error("Truncated OFS varint");
    }

    // Each continuation byte adds 1 to account for the previous byte
    value += 1;
    value <<= 7;
    value |= data[offset + bytesRead] & 0x7f;
    bytesRead++;
  }

  return { value, bytesRead };
}

/**
 * Write an OFS_DELTA negative offset varint
 *
 * @param value Offset value to encode
 * @returns Encoded bytes
 */
export function writeOfsVarint(value: number): Uint8Array {
  const bytes: number[] = [];

  // Start with the lowest 7 bits (no continuation)
  bytes.push(value & 0x7f);
  value >>>= 7;

  // Add continuation bytes
  while (value > 0) {
    // Subtract 1 before encoding (reverse of read)
    value -= 1;
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }

  // Reverse to get big-endian order
  bytes.reverse();
  return new Uint8Array(bytes);
}

/**
 * Read a pack object header
 *
 * Format:
 * - Byte 0: MSB = continuation, bits 6-4 = type, bits 3-0 = size (low 4 bits)
 * - Subsequent bytes: MSB = continuation, bits 6-0 = size (shifted)
 *
 * @param data Buffer to read from
 * @param offset Starting offset
 * @returns Object type, size, and bytes consumed
 */
export function readPackHeader(data: Uint8Array, offset: number): PackHeaderResult {
  if (offset >= data.length) {
    throw new Error("Truncated pack header");
  }

  const b = data[offset];
  const type = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let bytesRead = 1;

  while ((data[offset + bytesRead - 1] & 0x80) !== 0) {
    if (offset + bytesRead >= data.length) {
      throw new Error("Truncated pack header");
    }

    const c = data[offset + bytesRead];
    size |= (c & 0x7f) << shift;
    shift += 7;
    bytesRead++;
  }

  return { type, size, bytesRead };
}

/**
 * Write a pack object header
 *
 * @param type Object type (1-7)
 * @param size Uncompressed size
 * @returns Encoded header bytes
 */
export function writePackHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];

  // First byte: type in bits 6-4, low 4 bits of size
  let firstByte = (type << 4) | (size & 0x0f);
  size >>>= 4;

  if (size > 0) {
    firstByte |= 0x80; // Set continuation bit
  }
  bytes.push(firstByte);

  // Remaining bytes: 7 bits of size each
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) {
      b |= 0x80;
    }
    bytes.push(b);
  }

  return new Uint8Array(bytes);
}
