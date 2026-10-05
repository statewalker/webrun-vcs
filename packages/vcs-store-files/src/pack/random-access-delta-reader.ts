/**
 * Random access reader for delta-reconstructed pack objects
 *
 * Enables partial reads from delta chains without full reconstruction
 * by analyzing delta instructions and reading only required portions.
 */

import type { AnalyzedDelta, RandomAccessReader } from "@statewalker/vcs-core";
import { analyzeDelta, findInstructionsForRange } from "@statewalker/vcs-core";
import type { PackReader } from "./pack-reader.js";

/** Default chunk size for streaming (64KB) */
const STREAM_CHUNK_SIZE = 65536;

/**
 * Random access reader for delta objects
 *
 * Instead of reconstructing the entire object, this reader analyzes
 * delta instructions and reads only the portions needed for the
 * requested range.
 */
export class RandomAccessDeltaReader implements RandomAccessReader {
  private readonly packReader: PackReader;
  private readonly offset: number;
  private analyzed: AnalyzedDelta | null = null;
  private baseReader: RandomAccessReader | null = null;
  private _size = 0;
  private initialized = false;

  constructor(packReader: PackReader, objectOffset: number) {
    this.packReader = packReader;
    this.offset = objectOffset;
  }

  get size(): number {
    return this._size;
  }

  /**
   * Get size after initialization
   *
   * Call this instead of the `size` property to ensure the reader
   * is initialized first.
   */
  async getSize(): Promise<number> {
    await this.ensureInitialized();
    return this._size;
  }

  /**
   * Initialize the reader by analyzing the delta
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const header = await this.packReader.readObjectHeader(this.offset);

    if (header.type === 6 || header.type === 7) {
      // Delta object - decompress and analyze
      const deltaBytes = await this.decompress(this.offset + header.headerLength, header.size);
      this.analyzed = analyzeDelta(deltaBytes);
      this._size = this.analyzed.resultSize;
    } else {
      // Non-delta object - size from header
      this._size = header.size;
    }

    this.initialized = true;
  }

  /**
   * Get or create the base reader for recursive reads
   */
  private async getBaseReader(): Promise<RandomAccessReader> {
    if (this.baseReader) return this.baseReader;

    const header = await this.packReader.readObjectHeader(this.offset);

    if (header.type === 6) {
      // OFS_DELTA - base is at relative offset
      if (header.baseOffset === undefined) {
        throw new Error("OFS_DELTA missing base offset");
      }
      const baseOffset = this.offset - header.baseOffset;
      this.baseReader = new RandomAccessDeltaReader(this.packReader, baseOffset);
    } else if (header.type === 7) {
      // REF_DELTA - lookup base by ID
      if (header.baseId === undefined) {
        throw new Error("REF_DELTA missing base ID");
      }
      const baseOffset = this.packReader.index.findOffset(header.baseId);
      if (baseOffset === -1) {
        throw new Error(`Base object not found: ${header.baseId}`);
      }
      this.baseReader = new RandomAccessDeltaReader(this.packReader, baseOffset);
    } else {
      throw new Error(`getBaseReader called on non-delta type: ${header.type}`);
    }

    return this.baseReader;
  }

  /**
   * Read bytes from a specific offset in the reconstructed content
   */
  async readAt(offset: number, length: number): Promise<Uint8Array> {
    await this.ensureInitialized();

    // Clamp to valid range
    if (offset < 0) offset = 0;
    if (offset >= this._size) return new Uint8Array(0);
    const actualLength = Math.min(length, this._size - offset);
    if (actualLength <= 0) return new Uint8Array(0);

    // Non-delta object - read directly from pack
    if (!this.analyzed) {
      return this.readDirect(offset, actualLength);
    }

    // Delta object - find instructions and reconstruct
    const instructions = findInstructionsForRange(this.analyzed, offset, actualLength);
    const result = new Uint8Array(actualLength);
    let resultPos = 0;

    for (const instr of instructions) {
      // Calculate overlap between instruction and requested range
      const instrEnd = instr.resultStart + instr.length;
      const overlapStart = Math.max(offset, instr.resultStart);
      const overlapEnd = Math.min(offset + actualLength, instrEnd);
      const overlapLen = overlapEnd - overlapStart;

      if (overlapLen <= 0) continue;

      // Offset within this instruction's contribution
      const instrOffset = overlapStart - instr.resultStart;

      if (instr.instruction.type === "insert") {
        // Data is embedded in delta - extract directly
        const dataStart = instr.instruction.dataOffset + instrOffset;
        result.set(this.analyzed.rawDelta.subarray(dataStart, dataStart + overlapLen), resultPos);
      } else {
        // COPY from base - recursively read
        const baseReader = await this.getBaseReader();
        const baseOffset = instr.instruction.baseOffset + instrOffset;
        const baseData = await baseReader.readAt(baseOffset, overlapLen);
        result.set(baseData, resultPos);
      }

      resultPos += overlapLen;
    }

    return result.subarray(0, resultPos);
  }

  /**
   * Read directly from a non-delta object
   */
  private async readDirect(offset: number, length: number): Promise<Uint8Array> {
    const header = await this.packReader.readObjectHeader(this.offset);
    const fullContent = await this.decompress(this.offset + header.headerLength, header.size);
    return fullContent.subarray(offset, offset + length);
  }

  /**
   * Decompress data from pack file using PackReader's public API
   */
  private async decompress(packOffset: number, expectedSize: number): Promise<Uint8Array> {
    return this.packReader.decompressAt(packOffset, expectedSize);
  }

  /**
   * Stream content starting at a specific offset
   */
  async *stream(offset = 0, length?: number): AsyncIterable<Uint8Array> {
    await this.ensureInitialized();

    const actualLength = length ?? this._size - offset;
    let remaining = Math.min(actualLength, this._size - offset);
    let currentOffset = offset;

    while (remaining > 0) {
      const chunkSize = Math.min(remaining, STREAM_CHUNK_SIZE);
      const chunk = await this.readAt(currentOffset, chunkSize);
      if (chunk.length === 0) break;
      yield chunk;
      currentOffset += chunk.length;
      remaining -= chunk.length;
    }
  }
}

/**
 * Direct reader for non-delta pack objects
 *
 * Base case for the recursive structure - reads directly from
 * decompressed pack object content.
 */
export class DirectPackObjectReader implements RandomAccessReader {
  private readonly packReader: PackReader;
  private readonly offset: number;
  private content: Uint8Array | null = null;
  private _size = 0;

  constructor(packReader: PackReader, objectOffset: number) {
    this.packReader = packReader;
    this.offset = objectOffset;
  }

  get size(): number {
    return this._size;
  }

  async getSize(): Promise<number> {
    await this.ensureLoaded();
    return this._size;
  }

  /**
   * Load the full object content (cached)
   */
  private async ensureLoaded(): Promise<void> {
    if (this.content !== null) return;

    const obj = await this.packReader.load(this.offset);
    this.content = obj.content;
    this._size = obj.size;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    await this.ensureLoaded();

    if (offset < 0) offset = 0;
    if (offset >= this._size || this.content === null) return new Uint8Array(0);

    const actualLength = Math.min(length, this._size - offset);
    return this.content.subarray(offset, offset + actualLength);
  }

  async *stream(offset = 0, length?: number): AsyncIterable<Uint8Array> {
    await this.ensureLoaded();

    if (this.content === null) return;

    const actualLength = length ?? this._size - offset;
    const endOffset = Math.min(offset + actualLength, this._size);

    // Yield in chunks
    let currentOffset = offset;
    while (currentOffset < endOffset) {
      const chunkSize = Math.min(STREAM_CHUNK_SIZE, endOffset - currentOffset);
      yield this.content.subarray(currentOffset, currentOffset + chunkSize);
      currentOffset += chunkSize;
    }
  }
}
