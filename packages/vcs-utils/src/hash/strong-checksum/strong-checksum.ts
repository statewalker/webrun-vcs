export type ChecksumInput = Uint8Array | number[];

/**
 * Strong checksum using FNV-1a 32-bit hash algorithm.
 * Used to verify block matches after weak checksum filtering.
 */
export class StrongChecksum {
  private hash = 0x811c9dc5 | 0; // FNV-1a offset basis

  /**
   * Update the checksum with additional data.
   * @param data - Data to hash
   * @param offset - Starting offset (default: 0)
   * @param len - Number of bytes to process (default: data.length - offset)
   * @returns this (for chaining)
   */
  update(data: ChecksumInput, offset = 0, len: number = data.length - offset): this {
    let hash = this.hash | 0;
    for (let i = 0; i < len; i++) {
      hash ^= data[offset + i];
      hash = (hash * 0x01000193) >>> 0; // FNV prime (unsigned)
    }
    this.hash = hash;
    return this;
  }

  /**
   * Finalize and return the current hash value.
   * @returns 32-bit FNV-1a hash
   */
  finalize(): number {
    return this.hash >>> 0;
  }

  /**
   * Reset the checksum state for reuse.
   */
  reset(): void {
    this.hash = 0x811c9dc5 | 0;
  }

  /**
   * Clone the current state.
   */
  clone(): StrongChecksum {
    const cloned = new StrongChecksum();
    cloned.hash = this.hash;
    return cloned;
  }
}
