/**
 * Random access interfaces for delta-reconstructed content
 *
 * Enables partial reads from delta chains without full reconstruction.
 */

/**
 * Random access reader for reconstructed delta content
 *
 * Enables reading from specific offsets in delta-reconstructed objects
 * without fully reconstructing the entire chain.
 */
export interface RandomAccessReader {
  /**
   * Total size of the reconstructed content
   *
   * Note: This returns 0 before first async operation. Use getSize()
   * for reliable size access.
   */
  readonly size: number;

  /**
   * Get size with initialization
   *
   * Unlike the `size` property, this ensures the reader is initialized
   * before returning the size.
   */
  getSize(): Promise<number>;

  /**
   * Read bytes from a specific offset in the reconstructed content
   *
   * @param offset Starting byte position (0-indexed)
   * @param length Number of bytes to read
   * @returns Promise resolving to the requested bytes
   */
  readAt(offset: number, length: number): Promise<Uint8Array>;

  /**
   * Stream content starting at a specific offset
   *
   * @param offset Starting position (default: 0)
   * @param length Maximum bytes to stream (default: rest of content)
   */
  stream(offset?: number, length?: number): AsyncIterable<Uint8Array>;
}

/**
 * Positioned delta instruction
 *
 * Maps a range in the result to its source (base or insert data).
 */
export interface PositionedInstruction {
  /** Start position in the result (0-indexed) */
  resultStart: number;
  /** Length of bytes this instruction contributes */
  length: number;
  /** Instruction details */
  instruction: { type: "copy"; baseOffset: number } | { type: "insert"; dataOffset: number };
}

/**
 * Analyzed delta with positioned instructions
 *
 * Pre-parsed delta ready for random access queries.
 */
export interface AnalyzedDelta {
  /** Base object size (from delta header) */
  baseSize: number;
  /** Result object size (from delta header) */
  resultSize: number;
  /** Instructions with result positions */
  instructions: PositionedInstruction[];
  /** Raw delta bytes (for INSERT data extraction) */
  rawDelta: Uint8Array;
}
