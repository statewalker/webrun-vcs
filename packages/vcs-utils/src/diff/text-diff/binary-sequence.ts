/**
 * A Sequence representing binary data (byte array).
 *
 * Similar to RawText but for binary data instead of text lines.
 * Elements of the sequence are byte blocks of a fixed size.
 *
 * This allows using the Myers diff algorithm on binary data by treating
 * fixed-size blocks as the atomic units for comparison.
 */

import { Sequence } from "./sequence.js";

/**
 * Binary sequence with block-based comparison
 *
 * Instead of comparing individual bytes, we compare blocks of bytes.
 * This is more efficient and produces better diffs for binary data.
 */
export class BinarySequence extends Sequence {
  /** The binary content */
  private readonly content: Uint8Array;

  /** Block size for comparisons (default: 16 bytes) */
  private readonly blockSize: number;

  /** Number of blocks in the sequence */
  private readonly blockCount: number;

  /**
   * Create a new binary sequence
   *
   * @param content Binary data
   * @param blockSize Size of blocks for comparison (default: 16)
   */
  constructor(content: Uint8Array, blockSize = 16) {
    super();
    this.content = content;
    this.blockSize = Math.max(1, blockSize);
    this.blockCount = Math.ceil(content.length / this.blockSize);
  }

  /**
   * Get the total number of blocks in the sequence.
   *
   * @returns Number of blocks
   */
  size(): number {
    return this.blockCount;
  }

  /**
   * Get the block size used for comparisons
   *
   * @returns Block size in bytes
   */
  getBlockSize(): number {
    return this.blockSize;
  }

  /**
   * Get the raw content
   *
   * @returns The binary data
   */
  getContent(): Uint8Array {
    return this.content;
  }

  /**
   * Get the total byte length
   *
   * @returns Total number of bytes
   */
  getByteLength(): number {
    return this.content.length;
  }

  /**
   * Get a block of bytes by index
   *
   * @param index Block index (0-based)
   * @returns Block content (may be smaller than blockSize for last block)
   */
  getBlock(index: number): Uint8Array {
    const start = index * this.blockSize;
    const end = Math.min(start + this.blockSize, this.content.length);
    return this.content.slice(start, end);
  }

  /**
   * Get the byte offset for a block index
   *
   * @param index Block index
   * @returns Byte offset
   */
  getBlockOffset(index: number): number {
    return index * this.blockSize;
  }

  /**
   * Get the actual size of a block (may be less than blockSize for last block)
   *
   * @param index Block index
   * @returns Actual block size in bytes
   */
  getBlockActualSize(index: number): number {
    const start = index * this.blockSize;
    const end = Math.min(start + this.blockSize, this.content.length);
    return end - start;
  }

  /**
   * Get a slice of the content by byte range
   *
   * @param start Start byte offset
   * @param end End byte offset
   * @returns Slice of content
   */
  getSlice(start: number, end: number): Uint8Array {
    return this.content.slice(start, end);
  }

  /**
   * Get a single byte
   *
   * @param index Byte index
   * @returns Byte value
   */
  getByte(index: number): number {
    return this.content[index];
  }

  /**
   * Create a binary sequence from a string (UTF-8 encoded)
   *
   * @param str String to convert
   * @param blockSize Block size (default: 16)
   * @returns Binary sequence
   */
  static fromString(str: string, blockSize?: number): BinarySequence {
    return new BinarySequence(new TextEncoder().encode(str), blockSize);
  }

  /**
   * Create a binary sequence from a base64 string
   *
   * @param base64 Base64 encoded string
   * @param blockSize Block size (default: 16)
   * @returns Binary sequence
   */
  static fromBase64(base64: string, blockSize?: number): BinarySequence {
    // Simple base64 decode
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new BinarySequence(bytes, blockSize);
  }
}
