import { Sequence } from "./sequence.js";

/**
 * A Sequence supporting text in Uint8Array format with various line endings.
 *
 * Elements of the sequence are the lines of the file, as delimited by:
 * - LF ('\n') - Unix style line endings
 * - CRLF ('\r\n') - Windows style line endings (counts as one line ending)
 * - CR ('\r') - Classic Mac style line endings (standalone CR)
 *
 * The file content is treated as 8 bit binary text, with no assumptions or
 * requirements on character encoding.
 *
 * Note that the first line of the file is element 0, as defined by the Sequence
 * interface API. Traditionally in a text editor a patch file the first line is
 * line number 1. Callers may need to subtract 1 prior to invoking methods if
 * they are converting from "line number" to "element index".
 */
export class RawText extends Sequence {
  /** The file content for this sequence. */
  protected readonly content: Uint8Array;

  /** Map of line number to starting position within content. */
  protected readonly lines: number[];

  /** A RawText of length 0 */
  static readonly EMPTY_TEXT = new RawText(new Uint8Array(0));

  /**
   * Create a new sequence from an existing content byte array.
   *
   * The entire array is used as the content.
   *
   * @param input The content array (Uint8Array or string)
   */
  constructor(input: Uint8Array | string) {
    super();
    if (typeof input === "string") {
      this.content = new TextEncoder().encode(input);
    } else {
      this.content = input;
    }
    this.lines = this.buildLineMap();
  }

  /**
   * Build the line map from the content.
   *
   * Recognizes three types of line endings:
   * - LF (\n) - Unix style
   * - CRLF (\r\n) - Windows style (counts as one line ending)
   * - CR (\r) - Classic Mac style (standalone CR without following LF)
   *
   * @returns Array with line start positions.
   *          Index 0 is sentinel (Integer.MIN_VALUE in Java, we use 0),
   *          Index 1 is start of line 0,
   *          Last entry is total length (sentinel)
   */
  private buildLineMap(): number[] {
    const lines: number[] = [0]; // Sentinel at index 0
    lines.push(0); // Line 0 starts at position 0
    for (let i = 0; i < this.content.length; i++) {
      const byte = this.content[i];
      if (byte === 0x0a) {
        // '\n' - LF (Unix) or second byte of CRLF (Windows)
        lines.push(i + 1);
      } else if (byte === 0x0d) {
        // '\r' - Check if it's CRLF or standalone CR
        if (i + 1 < this.content.length && this.content[i + 1] === 0x0a) {
          // CRLF - skip the CR, the LF will be handled in next iteration
          continue;
        }
        // Standalone CR (classic Mac style)
        lines.push(i + 1);
      }
    }
    // Always add final sentinel if not already there
    if (lines[lines.length - 1] !== this.content.length) {
      lines.push(this.content.length);
    }
    return lines;
  }

  /**
   * Get the raw content.
   *
   * @returns The raw, unprocessed content
   */
  getRawContent(): Uint8Array {
    return this.content;
  }

  /**
   * Get the total number of lines in the sequence.
   *
   * @returns Total number of lines
   */
  size(): number {
    // The line map is always 2 entries larger than the number of lines in
    // the file. Index 0 is padded out/unused. The last index is the total
    // length of the buffer, and acts as a sentinel.
    return this.lines.length - 2;
  }

  /**
   * Get the starting position of a line.
   *
   * @param i Index of the line (0-based)
   * @returns Starting byte position of the line
   */
  protected getStart(i: number): number {
    return this.lines[i + 1];
  }

  /**
   * Get the ending position of a line.
   *
   * @param i Index of the line (0-based)
   * @returns Ending byte position of the line
   */
  protected getEnd(i: number): number {
    return this.lines[i + 2];
  }

  /**
   * Determine if the file ends with a line ending (LF, CRLF, or CR).
   *
   * @returns true if the last line is missing a line ending; false otherwise
   */
  isMissingNewlineAtEnd(): boolean {
    const end = this.lines[this.lines.length - 1];
    if (end === 0) {
      return true;
    }
    const lastByte = this.content[end - 1];
    // Check for LF (\n) or CR (\r)
    return lastByte !== 0x0a && lastByte !== 0x0d;
  }

  /**
   * Get the text for a single line.
   *
   * @param i Index of the line to extract (0-based)
   * @returns The text for the line, without trailing LF or CRLF
   */
  getString(i: number): string {
    const start = this.getStart(i);
    let end = this.getEnd(i);
    // Strip trailing LF
    if (end > start && this.content[end - 1] === 0x0a) {
      // '\n'
      end--;
    }
    // Strip trailing CR (for CRLF line endings)
    if (end > start && this.content[end - 1] === 0x0d) {
      // '\r'
      end--;
    }
    return new TextDecoder().decode(this.content.slice(start, end));
  }

  /**
   * Get the raw bytes for a single line.
   *
   * @param i Index of the line to extract (0-based)
   * @returns The bytes for the line, without trailing LF or CRLF
   */
  getRawString(i: number): Uint8Array {
    const start = this.getStart(i);
    let end = this.getEnd(i);
    // Strip trailing LF
    if (end > start && this.content[end - 1] === 0x0a) {
      // '\n'
      end--;
    }
    // Strip trailing CR (for CRLF line endings)
    if (end > start && this.content[end - 1] === 0x0d) {
      // '\r'
      end--;
    }
    return this.content.slice(start, end);
  }

  /**
   * Check if the content appears to be binary.
   *
   * Simple heuristic: check for NUL bytes.
   *
   * @param raw The content to check
   * @param length The length to check
   * @returns true if the content appears to be binary
   */
  static isBinary(raw: Uint8Array, length?: number): boolean {
    const len = length ?? raw.length;
    for (let ptr = 0; ptr < len && ptr < raw.length; ptr++) {
      if (raw[ptr] === 0) {
        // NUL byte
        return true;
      }
    }
    return false;
  }
}
