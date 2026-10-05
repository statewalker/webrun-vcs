/**
 * CRC32 checksum implementation
 *
 * Standard CRC32 with IEEE polynomial (used in Git pack files, ZIP, etc.)
 */

/**
 * CRC32 lookup table (IEEE polynomial 0xEDB88320)
 */
const CRC32_TABLE = makeCRC32Table();

function makeCRC32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
}

/**
 * Compute CRC32 checksum of data
 *
 * @param data Data to checksum
 * @param crc Initial CRC value (for continuing a checksum), default: 0xFFFFFFFF
 * @returns CRC32 value (finalized)
 */
export function crc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Incremental CRC32 calculator for streaming data
 *
 * Used when CRC32 needs to be computed over multiple chunks.
 */
export class CRC32 {
  private crc = 0xffffffff;

  /**
   * Update the checksum with additional data
   *
   * @param data Data chunk to process
   */
  update(data: Uint8Array): this {
    for (let i = 0; i < data.length; i++) {
      this.crc = CRC32_TABLE[(this.crc ^ data[i]) & 0xff] ^ (this.crc >>> 8);
    }
    return this;
  }

  /**
   * Get the current CRC32 value (finalized)
   *
   * @returns 32-bit unsigned CRC32 checksum
   */
  getValue(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Reset the calculator for reuse
   */
  reset(): void {
    this.crc = 0xffffffff;
  }

  /**
   * Clone the current state
   */
  clone(): CRC32 {
    const cloned = new CRC32();
    cloned.crc = this.crc;
    return cloned;
  }
}
