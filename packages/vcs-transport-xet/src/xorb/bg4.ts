/**
 * ByteGrouping4 (xet-core `bg4_split_together`): byte `4i + g` of a chunk goes to group `g`, the
 * four groups one after another; LZ4 then compresses the grouped bytes (compression type 2).
 */

/** groups 0…3 back into one buffer (the inverse of `bg4Split`) */
export function bg4Regroup(grouped: Uint8Array): Uint8Array {
  const n = grouped.length;
  const split = Math.floor(n / 4);
  const rem = n % 4;
  const out = new Uint8Array(n);
  let base = 0;
  for (let g = 0; g < 4; g++) {
    const size = split + (g < rem ? 1 : 0);
    for (let i = 0; i < size; i++) out[4 * i + g] = grouped[base + i] as number;
    base += size;
  }
  return out;
}

/** byte k of every 4-byte group into group k */
export function bg4Split(data: Uint8Array): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (let g = 0; g < 4; g++) for (let i = g; i < n; i += 4) out[at++] = data[i] as number;
  return out;
}
