/**
 * Hand-built pack files for edge cases git never writes (REF on REF, forward
 * references, cycles, duplicates, wrong counts, bombs, deep chains), for tests
 * of pack readers and indexers. Portable: no Node APIs.
 */
import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

/** One pack entry: a whole object (kind 1-4) or a delta (6 OFS_DELTA, 7 REF_DELTA). */
export interface CraftEntry {
  /** 1 commit, 2 tree, 3 blob, 4 tag, 6 OFS_DELTA, 7 REF_DELTA */
  kind: number;
  /** The object's content, or the delta's bytes */
  data: Uint8Array;
  /** REF_DELTA: the base object id */
  baseOid?: string;
  /** OFS_DELTA: the index of an earlier entry */
  baseIdx?: number;
  /** OFS_DELTA: an explicit back-offset (to point anywhere) */
  back?: number;
  /** Explicit zlib bytes instead of compressing `data` */
  rawZ?: Uint8Array;
  /** A header size different from `data.length` */
  sizeOverride?: number;
}

/** The git object id of `data` stored as `type`. */
export function oidOf(type: string, data: Uint8Array): string {
  const h = createSha1();
  h.update(new TextEncoder().encode(`${type} ${data.length}\0`));
  h.update(data);
  return bytesToHex(h.digest());
}

/** git's delta-size varint (7 bits per byte, little-endian). */
export function deltaVarint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/** A delta from its sizes and raw instruction bytes. */
export function craftDelta(baseLen: number, resultLen: number, ops: number[]): Uint8Array {
  return Uint8Array.from([...deltaVarint(baseLen), ...deltaVarint(resultLen), ...ops]);
}

/** The instruction copying [0, n) of the base (1 <= n <= 0xffffff; a size of 0 means 0x10000). */
export function copyAll(n: number): number[] {
  return [0x80 | 0x10 | 0x20 | 0x40, n & 255, (n >> 8) & 255, (n >> 16) & 255];
}

/**
 * A pack (version 2 unless asked) with a correct SHA-1 trailer.
 *
 * @example
 * ```typescript
 * const blob = new TextEncoder().encode("hello\n");
 * const pack = buildPack([
 *   { kind: 3, data: blob },
 *   { kind: 6, baseIdx: 0, data: craftDelta(6, 6, copyAll(6)) },
 * ]);
 * ```
 */
export function buildPack(
  entries: CraftEntry[],
  options: { count?: number; version?: number } = {},
): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  parts.push(
    0x50,
    0x41,
    0x43,
    0x4b,
    ...u32(options.version ?? 2),
    ...u32(options.count ?? entries.length),
  );
  const offsets: number[] = [];
  for (const e of entries) {
    const off = parts.length;
    offsets.push(off);
    let size = e.sizeOverride ?? e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      parts.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    parts.push(b);
    if (e.kind === 6) {
      let back = e.back ?? off - (offsets[e.baseIdx as number] as number);
      const bs = [back & 127];
      back = Math.floor(back / 128);
      while (back) {
        back--;
        bs.unshift(0x80 | (back & 127));
        back = Math.floor(back / 128);
      }
      parts.push(...bs);
    }
    if (e.kind === 7) parts.push(...hexToBytes(e.baseOid as string));
    const z = e.rawZ ?? compressBlockPako(e.data);
    for (const x of z) parts.push(x);
  }
  const body = Uint8Array.from(parts);
  const trailer = createSha1().update(body).digest();
  const out = new Uint8Array(body.length + trailer.length);
  out.set(body);
  out.set(trailer, body.length);
  return out;
}
