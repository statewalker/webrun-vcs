/**
 * BinaryHunk - represents a binary patch hunk
 *
 * Based on JGit's BinaryHunk.java
 * Parses Git binary patch data in format:
 *   literal <size>
 *   <base85-encoded data>
 * or:
 *   delta <size>
 *   <base85-encoded data>
 */

import { decodeGitBase85 } from "./base85.js";
import { encodeASCII, match, nextLF, parseBase10 } from "./buffer-utils.js";
import { BinaryHunkType } from "./types.js";

/** Pattern: "literal " */
const LITERAL = encodeASCII("literal ");

/** Pattern: "delta " */
const DELTA = encodeASCII("delta ");

/**
 * Represents a binary patch hunk with base85-encoded data
 */
export class BinaryHunk {
  /** Buffer containing the patch data */
  readonly buffer: Uint8Array;

  /** Start offset of this binary hunk in the buffer */
  readonly startOffset: number;

  /** End offset of this binary hunk in the buffer */
  endOffset = 0;

  /** Type of binary hunk (LITERAL_DEFLATED or DELTA_DEFLATED) */
  type: BinaryHunkType = BinaryHunkType.LITERAL_DEFLATED;

  /** Size of the inflated/decoded data */
  size = 0;

  /** Start offset of base85-encoded data */
  dataStart = 0;

  /** End offset of base85-encoded data */
  dataEnd = 0;

  /**
   * Create a new binary hunk
   *
   * @param buffer Buffer containing patch data
   * @param offset Starting offset in buffer
   */
  constructor(buffer: Uint8Array, offset: number) {
    this.buffer = buffer;
    this.startOffset = offset;
    this.endOffset = offset;
  }

  /**
   * Parse a binary hunk starting with "literal" or "delta"
   *
   * @param end End of buffer
   * @returns Next offset to continue parsing
   */
  parse(end: number): number {
    let ptr = this.startOffset;

    // Parse the "literal <size>" or "delta <size>" line
    const eol = nextLF(this.buffer, ptr);
    if (eol >= end) {
      this.endOffset = end;
      return end;
    }

    // Detect type
    if (match(this.buffer, ptr, LITERAL) >= 0) {
      this.type = BinaryHunkType.LITERAL_DEFLATED;
      ptr += LITERAL.length;
    } else if (match(this.buffer, ptr, DELTA) >= 0) {
      this.type = BinaryHunkType.DELTA_DEFLATED;
      ptr += DELTA.length;
    } else {
      // Unknown type, skip to end of line
      this.endOffset = eol;
      return eol;
    }

    // Parse size
    const [size, _afterSize] = parseBase10(this.buffer, ptr);
    this.size = size;
    ptr = eol; // Move to next line

    // Data starts on next line
    this.dataStart = ptr;

    // Define patterns for detection
    const DIFF_GIT = encodeASCII("diff --git");

    // Scan until we find a blank line or another hunk/file header
    while (ptr < end) {
      // Check if this line starts a new file ("diff --git") FIRST
      if (match(this.buffer, ptr, DIFF_GIT) >= 0) {
        // Start of next file - stop here
        this.dataEnd = ptr;
        this.endOffset = ptr;
        return ptr;
      }

      // Check if this line starts a new hunk ("literal" or "delta")
      if (match(this.buffer, ptr, LITERAL) >= 0 || match(this.buffer, ptr, DELTA) >= 0) {
        // Start of next hunk - stop here
        this.dataEnd = ptr;
        this.endOffset = ptr;
        return ptr;
      }

      const lineEnd = nextLF(this.buffer, ptr);
      if (lineEnd >= end) {
        // Reached end of buffer
        this.dataEnd = end;
        this.endOffset = end;
        return end;
      }

      // Check if this line is blank (marks end of base85 data)
      if (lineEnd - ptr <= 1) {
        // Empty line (just newline)
        this.dataEnd = ptr;
        this.endOffset = lineEnd;
        return lineEnd;
      }

      ptr = lineEnd;
    }

    // Reached end of buffer
    this.dataEnd = ptr;
    this.endOffset = ptr;
    return ptr;
  }

  /**
   * Decode the base85-encoded binary data
   *
   * @returns Decoded binary data as Uint8Array
   * @throws Error if decoding fails
   */
  getData(): Uint8Array {
    if (this.dataStart >= this.dataEnd) {
      return new Uint8Array(0);
    }

    // Extract base85-encoded lines
    const encodedData = this.buffer.slice(this.dataStart, this.dataEnd);

    // Decode using base85
    return decodeGitBase85(encodedData);
  }

  /**
   * Get a string representation of this binary hunk
   */
  toString(): string {
    return `BinaryHunk(${this.type}: ${this.size} bytes)`;
  }
}
