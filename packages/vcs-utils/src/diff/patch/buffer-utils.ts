/**
 * Buffer parsing utilities for patch files
 *
 * These utilities work on Uint8Array buffers representing patch data,
 * providing efficient byte-level parsing operations.
 *
 * Based on JGit's RawParseUtils.java
 */

/**
 * Check if the buffer contains a specific pattern at the given offset
 *
 * @param buffer The buffer to search in
 * @param offset Starting position in the buffer
 * @param pattern Pattern bytes to match
 * @returns Length of match if pattern found at offset, -1 otherwise
 */
export function match(buffer: Uint8Array, offset: number, pattern: Uint8Array): number {
  if (offset + pattern.length > buffer.length) {
    return -1;
  }

  for (let i = 0; i < pattern.length; i++) {
    if (buffer[offset + i] !== pattern[i]) {
      return -1;
    }
  }

  return pattern.length;
}

/**
 * Find the next line feed ('\n') character
 *
 * @param buffer The buffer to search in
 * @param offset Starting position in the buffer
 * @returns Index of next '\n', or buffer.length if not found
 */
export function nextLF(buffer: Uint8Array, offset: number): number {
  while (offset < buffer.length) {
    if (buffer[offset] === 0x0a) {
      // '\n'
      return offset + 1;
    }
    offset++;
  }
  return buffer.length;
}

/**
 * Find the previous line feed ('\n') character
 *
 * @param buffer The buffer to search in
 * @param offset Starting position in the buffer
 * @returns Index after previous '\n', or 0 if not found
 */
export function prevLF(buffer: Uint8Array, offset: number): number {
  while (offset > 0) {
    if (buffer[offset - 1] === 0x0a) {
      // '\n'
      return offset;
    }
    offset--;
  }
  return 0;
}

/**
 * Check if the line at offset is a hunk header (starts with "@@")
 *
 * Hunk headers have the format: "@@ -oldStart,oldCount +newStart,newCount @@"
 *
 * @param buffer The buffer to check in
 * @param offset Starting position (should be start of line)
 * @param end End of buffer
 * @returns 1 if valid hunk header, 0 otherwise
 */
export function isHunkHdr(buffer: Uint8Array, offset: number, end: number): number {
  const lineEnd = Math.min(nextLF(buffer, offset), end);

  // Minimum hunk header: "@@ -0,0 +0,0 @@"
  if (lineEnd - offset < 11) {
    return 0;
  }

  // Must start with "@@"
  if (buffer[offset] !== 0x40 || buffer[offset + 1] !== 0x40) {
    // '@'
    return 0;
  }

  // Must have " -" after "@@"
  if (buffer[offset + 2] !== 0x20 || buffer[offset + 3] !== 0x2d) {
    // ' ', '-'
    return 0;
  }

  return 1;
}

/**
 * Extract ASCII string from buffer
 *
 * @param buffer The buffer to read from
 * @param start Starting offset
 * @param end Ending offset (exclusive)
 * @returns Decoded string
 */
export function decode(buffer: Uint8Array, start: number, end: number): string {
  return new TextDecoder("utf-8").decode(buffer.slice(start, end));
}

/**
 * Encode ASCII string to bytes
 *
 * @param str String to encode
 * @returns Encoded bytes
 */
export function encodeASCII(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Parse a signed decimal number from buffer
 *
 * @param buffer The buffer to read from
 * @param offset Starting offset
 * @returns Tuple of [number, nextOffset] or [0, offset] if no number found
 */
export function parseBase10(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let negative = false;
  const start = offset;

  // Check for negative sign
  if (offset < buffer.length && buffer[offset] === 0x2d) {
    // '-'
    negative = true;
    offset++;
  }

  // Parse digits
  while (offset < buffer.length) {
    const c = buffer[offset];
    if (c < 0x30 || c > 0x39) {
      // '0' to '9'
      break;
    }
    value = value * 10 + (c - 0x30);
    offset++;
  }

  // No digits found?
  if (offset === start || (negative && offset === start + 1)) {
    return [0, start];
  }

  return [negative ? -value : value, offset];
}
