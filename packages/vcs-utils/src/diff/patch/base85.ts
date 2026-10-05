/**
 * Git's base85 encoding/decoding (RFC 1924 variant)
 *
 * Git uses a variant of base85 encoding for binary patches.
 * This is NOT standard Ascii85 - Git uses a different character set.
 *
 * Format:
 * - Each line starts with a length byte ('A' + output_length - 1)
 * - Followed by base85 encoded data (5 chars → 4 bytes)
 * - Lines are newline terminated
 *
 * @see https://github.com/git/git/blob/master/base85.c
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/util/Base85.java
 */

/**
 * Git's base85 character set (85 printable ASCII characters)
 * Ordered from 0-84
 */
const BASE85_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

/**
 * Reverse lookup table for base85 decoding
 * Maps ASCII character code to base85 value (0-84)
 */
const BASE85_DECODE: number[] = new Array(256).fill(-1);
for (let i = 0; i < BASE85_CHARS.length; i++) {
  BASE85_DECODE[BASE85_CHARS.charCodeAt(i)] = i;
}

/**
 * Decode Git base85 encoded data
 *
 * @param encoded Base85 encoded data with length prefixes
 * @returns Decoded binary data
 * @throws Error if invalid base85 character or format
 */
export function decodeGitBase85(encoded: Uint8Array): Uint8Array {
  const result: number[] = [];
  let offset = 0;

  while (offset < encoded.length) {
    // Find line boundaries
    const lineStart = offset;
    let lineEnd = offset;
    while (lineEnd < encoded.length && encoded[lineEnd] !== 0x0a) {
      lineEnd++;
    }

    // Skip empty lines
    if (lineEnd === lineStart) {
      offset = lineEnd + 1;
      continue;
    }

    // First character encodes the output byte count for this line
    const lengthChar = encoded[lineStart];
    const outputLength = lengthChar - 0x41 + 1; // 'A' = 1 byte, 'B' = 2, etc.

    // Git allows up to 'z' (122) which gives 58 bytes per line
    // This is more than the typical 52 bytes but is used in practice
    if (outputLength < 1 || outputLength > 58) {
      throw new Error(
        `Invalid base85 length character: ${String.fromCharCode(lengthChar)} (expected A-z, got ${outputLength})`,
      );
    }

    // Decode the rest of the line
    const lineData = encoded.slice(lineStart + 1, lineEnd);
    const decoded = decodeLine(lineData, outputLength);
    result.push(...decoded);

    offset = lineEnd + 1;
  }

  return new Uint8Array(result);
}

/**
 * Decode a single line of base85 data (without length prefix)
 *
 * @param line Line data (5n characters)
 * @param outputLength Expected output byte count
 * @returns Decoded bytes
 */
function decodeLine(line: Uint8Array, outputLength: number): number[] {
  const result: number[] = [];
  let offset = 0;

  while (offset < line.length && result.length < outputLength) {
    // Read 5 base85 characters → 4 bytes
    let acc = 0;
    let charCount = 0;

    for (let i = 0; i < 5 && offset < line.length; i++) {
      const ch = line[offset++];
      const value = BASE85_DECODE[ch];

      if (value === -1) {
        throw new Error(`Invalid base85 character: ${String.fromCharCode(ch)} (code ${ch})`);
      }

      acc = acc * 85 + value;
      charCount++;
    }

    // Special case: if we have fewer than 5 characters,
    // we need to pad with zeros for decoding
    if (charCount < 5) {
      acc *= 85 ** (5 - charCount);
    }

    // Extract 4 bytes (big-endian)
    const bytes = [(acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff];

    // Only add the bytes we need
    const bytesToAdd = Math.min(4, outputLength - result.length);
    for (let i = 0; i < bytesToAdd; i++) {
      result.push(bytes[i]);
    }
  }

  return result;
}

/**
 * Encode binary data to Git base85 format
 *
 * @param data Binary data to encode
 * @returns Base85 encoded data with length prefixes and newlines
 */
export function encodeGitBase85(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  let offset = 0;

  while (offset < data.length) {
    // Encode up to 52 bytes per line (13 groups of 4 bytes)
    const lineBytes = Math.min(52, data.length - offset);
    const lineData = data.slice(offset, offset + lineBytes);

    // Add length prefix
    result.push(0x41 + lineBytes - 1); // 'A' + length - 1

    // Encode the line data
    const encoded = encodeLine(lineData);
    result.push(...encoded);

    // Add newline
    result.push(0x0a);

    offset += lineBytes;
  }

  return new Uint8Array(result);
}

/**
 * Encode a line of binary data (without length prefix or newline)
 *
 * @param data Binary data (up to 52 bytes)
 * @returns Base85 encoded characters
 */
function encodeLine(data: Uint8Array): number[] {
  const result: number[] = [];
  let offset = 0;

  while (offset < data.length) {
    // Read 4 bytes → 5 base85 characters
    let acc = 0;
    let byteCount = 0;

    for (let i = 0; i < 4 && offset < data.length; i++) {
      // Use >>> 0 to ensure unsigned 32-bit arithmetic
      acc = ((acc << 8) | data[offset++]) >>> 0;
      byteCount++;
    }

    // Pad with zeros if we have fewer than 4 bytes
    if (byteCount < 4) {
      acc = (acc << ((4 - byteCount) * 8)) >>> 0;
    }

    // Extract 5 base85 digits (matching JGit's algorithm)
    // JGit writes digits in reverse order (indices 4 to 0)
    // Use unsigned division
    const digits: number[] = new Array(5);
    for (let i = 4; i >= 0; i--) {
      digits[i] = (acc >>> 0) % 85;
      acc = Math.floor((acc >>> 0) / 85);
    }

    // Convert to characters - always output exactly 5 characters
    for (let i = 0; i < 5; i++) {
      result.push(BASE85_CHARS.charCodeAt(digits[i]));
    }
  }

  return result;
}
