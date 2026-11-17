/**
 * CRC32 checksum implementation
 *
 * Standard CRC32 with IEEE polynomial (used in Git pack files, ZIP, etc.)
 */

/**
 * CRC32 lookup tables (IEEE polynomial 0xEDB88320) for slicing-by-8: table `k` (at `k * 256`)
 * advances a byte's CRC through `k` more zero bytes, so eight bytes are folded per step.
 */
const T = makeTables();

function makeTables(): Int32Array {
  const t = new Int32Array(8 * 256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    t[i] = crc;
  }
  for (let i = 0; i < 256; i++) {
    let crc = t[i] as number;
    for (let k = 1; k < 8; k++) {
      crc = (t[crc & 0xff] as number) ^ (crc >>> 8);
      t[k * 256 + i] = crc;
    }
  }
  return t;
}

/** Folds `data` into the running (unfinalized) CRC `crc`. */
function update(crc: number, data: Uint8Array): number {
  const t = T;
  const n = data.length;
  let i = 0;
  for (const end = n & ~7; i < end; i += 8) {
    const lo =
      crc ^
      ((data[i] as number) |
        ((data[i + 1] as number) << 8) |
        ((data[i + 2] as number) << 16) |
        ((data[i + 3] as number) << 24));
    crc =
      (t[1792 + (lo & 0xff)] as number) ^
      (t[1536 + ((lo >>> 8) & 0xff)] as number) ^
      (t[1280 + ((lo >>> 16) & 0xff)] as number) ^
      (t[1024 + (lo >>> 24)] as number) ^
      (t[768 + (data[i + 4] as number)] as number) ^
      (t[512 + (data[i + 5] as number)] as number) ^
      (t[256 + (data[i + 6] as number)] as number) ^
      (t[data[i + 7] as number] as number);
  }
  for (; i < n; i++) crc = (t[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return crc;
}

/**
 * Compute CRC32 checksum of data
 *
 * @param data Data to checksum
 * @param crc Initial CRC value (for continuing a checksum), default: 0xFFFFFFFF
 * @returns CRC32 value (finalized)
 */
export function crc32(data: Uint8Array, crc = 0xffffffff): number {
  return (update(crc | 0, data) ^ 0xffffffff) >>> 0;
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
    this.crc = update(this.crc, data);
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
