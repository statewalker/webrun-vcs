/**
 * Rolling checksum (Rabin-Karp style) for efficient sliding window hashing.
 * Used in delta compression to find matching blocks.
 */
export class RollingChecksum {
  private s1 = 0; // sum of bytes
  private s2 = 0; // weighted sum
  private n = 0; // window size

  /**
   * Initialize rolling checksum for a window of data.
   * @param buf - Source buffer
   * @param offset - Starting offset in buffer
   * @param len - Window size (number of bytes)
   * @returns this (for chaining)
   */
  init(buf: Uint8Array, offset: number, len: number): this {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < len; i++) {
      s1 = (s1 + buf[offset + i]) | 0;
      s2 = (s2 + s1) | 0;
    }
    this.s1 = s1;
    this.s2 = s2;
    this.n = len;
    return this;
  }

  /**
   * Slide the window by one byte.
   * @param removeByte - Byte leaving the window (oldest)
   * @param addByte - Byte entering the window (newest)
   * @returns The new checksum value after sliding
   */
  update(removeByte: number, addByte: number): number {
    // All math in 32-bit signed, but we mask later
    this.s1 = (this.s1 - removeByte + addByte) | 0;
    this.s2 = (this.s2 - this.n * removeByte + this.s1) | 0;
    return this.value();
  }

  /**
   * Get the current checksum value without modifying state.
   * @returns 32-bit weak checksum
   */
  value(): number {
    // Keep it close to Fossil's pattern: lower 16 bits of s1, lower 16 of s2
    const s1 = this.s1 & 0xffff;
    const s2 = this.s2 & 0xffff;
    return (s1 | (s2 << 16)) >>> 0;
  }

  /**
   * Get the window size.
   */
  get windowSize(): number {
    return this.n;
  }

  /**
   * Reset the checksum state.
   */
  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
    this.n = 0;
  }
}
