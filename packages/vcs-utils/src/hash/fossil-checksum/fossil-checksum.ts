/**
 * Fossil-style incremental checksum calculator.
 * Processes data in 4-byte groups with 16-byte block optimization.
 * Used for delta integrity verification.
 */
export class FossilChecksum {
  private sum0 = 0;
  private sum1 = 0;
  private sum2 = 0;
  private sum3 = 0;
  private buffer: Uint8Array = new Uint8Array(4);
  private bufferCount = 0;

  /**
   * Update the checksum with additional data.
   * @param arr - Data buffer
   * @param pos - Starting position in buffer
   * @param len - Number of bytes to process
   */
  update(arr: Uint8Array, pos: number, len: number): void {
    let z = pos;
    let N = Math.min(len, arr.length - pos);

    // First, try to complete any buffered bytes to form a 4-byte group
    if (this.bufferCount > 0 && N > 0) {
      const needed = 4 - this.bufferCount;
      const available = Math.min(needed, N);

      // Copy available bytes to buffer
      for (let i = 0; i < available; i++) {
        this.buffer[this.bufferCount + i] = arr[z + i];
      }

      this.bufferCount += available;
      z += available;
      N -= available;

      // If we completed a 4-byte group, process it
      if (this.bufferCount === 4) {
        this.sum0 = (this.sum0 + this.buffer[0]) | 0;
        this.sum1 = (this.sum1 + this.buffer[1]) | 0;
        this.sum2 = (this.sum2 + this.buffer[2]) | 0;
        this.sum3 = (this.sum3 + this.buffer[3]) | 0;
        this.bufferCount = 0;
      } else {
        // Still not enough bytes to complete a group, return early
        return;
      }
    }

    // Process 16-byte blocks
    while (N >= 16) {
      this.sum0 = (this.sum0 + arr[z + 0]) | 0;
      this.sum1 = (this.sum1 + arr[z + 1]) | 0;
      this.sum2 = (this.sum2 + arr[z + 2]) | 0;
      this.sum3 = (this.sum3 + arr[z + 3]) | 0;
      this.sum0 = (this.sum0 + arr[z + 4]) | 0;
      this.sum1 = (this.sum1 + arr[z + 5]) | 0;
      this.sum2 = (this.sum2 + arr[z + 6]) | 0;
      this.sum3 = (this.sum3 + arr[z + 7]) | 0;
      this.sum0 = (this.sum0 + arr[z + 8]) | 0;
      this.sum1 = (this.sum1 + arr[z + 9]) | 0;
      this.sum2 = (this.sum2 + arr[z + 10]) | 0;
      this.sum3 = (this.sum3 + arr[z + 11]) | 0;
      this.sum0 = (this.sum0 + arr[z + 12]) | 0;
      this.sum1 = (this.sum1 + arr[z + 13]) | 0;
      this.sum2 = (this.sum2 + arr[z + 14]) | 0;
      this.sum3 = (this.sum3 + arr[z + 15]) | 0;
      z += 16;
      N -= 16;
    }

    // Process 4-byte blocks
    while (N >= 4) {
      this.sum0 = (this.sum0 + arr[z + 0]) | 0;
      this.sum1 = (this.sum1 + arr[z + 1]) | 0;
      this.sum2 = (this.sum2 + arr[z + 2]) | 0;
      this.sum3 = (this.sum3 + arr[z + 3]) | 0;
      z += 4;
      N -= 4;
    }

    // Buffer any remaining bytes (1-3 bytes)
    this.bufferCount = N;
    for (let i = 0; i < N; i++) {
      this.buffer[i] = arr[z + i];
    }
  }

  /**
   * Finalize and return the checksum value.
   * Can be called multiple times (idempotent).
   * @returns 32-bit unsigned checksum
   */
  finalize(): number {
    const sum0 = this.sum0;
    const sum1 = this.sum1;
    const sum2 = this.sum2;
    let sum3 = this.sum3;
    const N = this.bufferCount;

    sum3 = (((((sum3 + (sum2 << 8)) | 0) + (sum1 << 16)) | 0) + (sum0 << 24)) | 0;

    if (N === 3) {
      sum3 = (sum3 + (this.buffer[2] << 8)) | 0;
      sum3 = (sum3 + (this.buffer[1] << 16)) | 0;
      sum3 = (sum3 + (this.buffer[0] << 24)) | 0;
    } else if (N === 2) {
      sum3 = (sum3 + (this.buffer[1] << 16)) | 0;
      sum3 = (sum3 + (this.buffer[0] << 24)) | 0;
    } else if (N === 1) {
      sum3 = (sum3 + (this.buffer[0] << 24)) | 0;
    }

    return sum3 >>> 0;
  }

  /**
   * Reset the checksum state for reuse.
   */
  reset(): void {
    this.sum0 = 0;
    this.sum1 = 0;
    this.sum2 = 0;
    this.sum3 = 0;
    this.buffer = new Uint8Array(4);
    this.bufferCount = 0;
  }
}
