/**
 * HunkHeader - represents a single hunk within a file patch
 *
 * Based on JGit's HunkHeader.java
 * Parses hunk headers like: @@ -10,7 +10,8 @@ optional context
 *
 * A hunk contains a continuous block of changes:
 * - Context lines (start with ' ')
 * - Deleted lines (start with '-')
 * - Added lines (start with '+')
 * - No newline marker (starts with '\')
 */

import { nextLF, parseBase10 } from "./buffer-utils.js";

/**
 * Represents a single hunk within a file patch
 */
export class HunkHeader {
  /** Buffer containing the patch data */
  readonly buffer: Uint8Array;

  /** Start offset of this hunk's "@@ ..." line */
  readonly startOffset: number;

  /** End offset of this hunk (1 past the last line) */
  endOffset = 0;

  /** Old file start line number (1-based) */
  oldStartLine = 0;

  /** Old file line count */
  oldLineCount = 0;

  /** New file start line number (1-based) */
  newStartLine = 0;

  /** New file line count */
  newLineCount = 0;

  /** Number of context lines (unchanged) */
  contextLineCount = 0;

  /** Number of lines deleted from old file */
  deletedLineCount = 0;

  /** Number of lines added to new file */
  addedLineCount = 0;

  /** Optional context text after "@@" */
  context: string | null = null;

  /**
   * Create a new hunk header
   *
   * @param buffer Buffer containing patch data
   * @param offset Starting offset of the "@@ ..." line
   */
  constructor(buffer: Uint8Array, offset: number) {
    this.buffer = buffer;
    this.startOffset = offset;
  }

  /**
   * Parse the hunk header and body
   *
   * @param end End of buffer (or start of next hunk/file)
   * @returns Next offset after this hunk
   */
  parse(end: number): number {
    this.parseHeader();
    return this.parseBody(end);
  }

  /**
   * Parse the "@@ -oldStart,oldCount +newStart,newCount @@" line
   */
  private parseHeader(): void {
    let ptr = this.startOffset;
    const eol = nextLF(this.buffer, ptr);

    // Skip "@@ "
    ptr += 3;

    // Parse "-oldStart,oldCount"
    const [oldStart, afterOldStart] = parseBase10(this.buffer, ptr);
    this.oldStartLine = -oldStart; // Stored as negative, make positive
    ptr = afterOldStart;

    if (ptr < eol && this.buffer[ptr] === 0x2c) {
      // ','
      const [oldCount, afterOldCount] = parseBase10(this.buffer, ptr + 1);
      this.oldLineCount = oldCount;
      ptr = afterOldCount;
    } else {
      this.oldLineCount = 1;
    }

    // Skip space and "+"
    while (ptr < eol && (this.buffer[ptr] === 0x20 || this.buffer[ptr] === 0x2b)) {
      ptr++;
    }

    // Parse "newStart,newCount"
    const [newStart, afterNewStart] = parseBase10(this.buffer, ptr);
    this.newStartLine = newStart;
    ptr = afterNewStart;

    if (ptr < eol && this.buffer[ptr] === 0x2c) {
      // ','
      const [newCount, afterNewCount] = parseBase10(this.buffer, ptr + 1);
      this.newLineCount = newCount;
      ptr = afterNewCount;
    } else {
      this.newLineCount = 1;
    }

    // Skip to closing "@@"
    while (ptr < eol && this.buffer[ptr] !== 0x40) {
      // '@'
      ptr++;
    }

    // Skip "@@" and optional space
    if (ptr + 2 < eol && this.buffer[ptr] === 0x40 && this.buffer[ptr + 1] === 0x40) {
      ptr += 2;
      if (ptr < eol && this.buffer[ptr] === 0x20) {
        ptr++;
      }

      // Extract optional context
      if (ptr < eol - 1) {
        // -1 to skip newline
        this.context = new TextDecoder().decode(this.buffer.slice(ptr, eol - 1));
      }
    }
  }

  /**
   * Parse the hunk body (the actual diff lines)
   *
   * @param end End of buffer or start of next hunk
   * @returns Offset after this hunk
   */
  private parseBody(end: number): number {
    let ptr = nextLF(this.buffer, this.startOffset); // Skip header line
    let _lastPtr = ptr;

    this.deletedLineCount = 0;
    this.addedLineCount = 0;
    this.contextLineCount = 0;

    // Scan through hunk body
    while (ptr < end) {
      const lineStart = ptr;
      const nextLine = nextLF(this.buffer, ptr);

      if (lineStart >= end) {
        break;
      }

      const firstChar = this.buffer[lineStart];

      // Check what type of line this is
      if (firstChar === 0x20 || firstChar === 0x0a) {
        // ' ' or '\n' - context line
        this.contextLineCount++;
      } else if (firstChar === 0x2d) {
        // '-' could be deleted line OR start of "--- " (new file in traditional diff)
        // Check for "--- " pattern (traditional patch file boundary)
        if (
          lineStart + 4 <= end &&
          this.buffer[lineStart + 1] === 0x2d && // '-'
          this.buffer[lineStart + 2] === 0x2d && // '-'
          this.buffer[lineStart + 3] === 0x20 // ' '
        ) {
          // "--- " - start of next traditional patch file
          this.endOffset = lineStart;
          return lineStart;
        }
        this.deletedLineCount++;
      } else if (firstChar === 0x2b) {
        // '+' - added line
        this.addedLineCount++;
      } else if (firstChar === 0x5c) {
        // '\' - "\ No newline at end of file"
        // Don't count this line
      } else if (firstChar === 0x40 && lineStart + 1 < end && this.buffer[lineStart + 1] === 0x40) {
        // "@@" - start of next hunk
        this.endOffset = lineStart;
        return lineStart;
      } else if (
        lineStart + 4 < end &&
        this.buffer[lineStart] === 0x64 && // 'd'
        this.buffer[lineStart + 1] === 0x69 && // 'i'
        this.buffer[lineStart + 2] === 0x66 && // 'f'
        this.buffer[lineStart + 3] === 0x66 // 'f'
      ) {
        // "diff" - start of next file
        this.endOffset = lineStart;
        return lineStart;
      } else {
        // Unknown line type - might be end of hunk
        break;
      }

      _lastPtr = ptr;
      ptr = nextLine;
    }

    this.endOffset = ptr;
    return ptr;
  }

  /**
   * Get line type for a specific line in the hunk
   *
   * @param lineOffset Offset of the line start
   * @returns ' ' for context, '-' for delete, '+' for add, '\' for no newline
   */
  getLineType(lineOffset: number): string {
    if (lineOffset >= this.buffer.length) {
      return "";
    }

    const char = this.buffer[lineOffset];
    if (char === 0x20) return " ";
    if (char === 0x2d) return "-";
    if (char === 0x2b) return "+";
    if (char === 0x5c) return "\\";
    if (char === 0x0a) return " "; // Empty line treated as context
    return "";
  }

  /**
   * Get string representation of this hunk
   */
  toString(): string {
    return `@@ -${this.oldStartLine},${this.oldLineCount} +${this.newStartLine},${this.newLineCount} @@${
      this.context ? ` ${this.context}` : ""
    }`;
  }
}
