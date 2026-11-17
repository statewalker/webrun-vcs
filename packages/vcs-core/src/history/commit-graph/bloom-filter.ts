/**
 * Changed-path Bloom filters, as git's `bloom.c`: each commit's filter holds the paths that
 * differ from its first parent (every leading directory too), hashed with murmur3 (seeds
 * 0x293ae76f and 0x7e646e2c, `num_hashes` probes `h0 + i * h1`).
 *
 * Hash version 1 reads path bytes as signed chars (git's historical bug, on platforms where
 * `char` is signed, as x86 and the default of git's own builds); version 2 reads them unsigned.
 * They differ only for paths with bytes of 0x80 and above.
 */

import type { BloomFilterSettings } from "./commit-graph-format.js";

/** git's DEFAULT_BLOOM_FILTER_SETTINGS: hash version 1, 7 hashes, 10 bits per entry, 512 paths. */
export const DEFAULT_BLOOM_FILTER_SETTINGS: BloomFilterSettings = {
  hashVersion: 1,
  numHashes: 7,
  bitsPerEntry: 10,
  maxChangedPaths: 512,
};

const SEED0 = 0x293ae76f;
const SEED1 = 0x7e646e2c;
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
/** A byte as a C `char` on a signed-char platform, widened to 32 bits. */
const signed = (b: number) => (b << 24) >> 24;

/** git's murmur3_seeded_v1 (signed chars) or murmur3_seeded_v2 (unsigned). */
export function murmur3(seed: number, data: Uint8Array, version: number): number {
  const len = data.length;
  const len4 = len >>> 2;
  const byte = version === 2 ? (b: number) => b : signed;
  let h = seed | 0;
  for (let i = 0; i < len4; i++) {
    const j = 4 * i;
    let k =
      byte(data[j] as number) |
      (byte(data[j + 1] as number) << 8) |
      (byte(data[j + 2] as number) << 16) |
      (byte(data[j + 3] as number) << 24);
    k = Math.imul(k, C1);
    k = rotl(k, 15);
    k = Math.imul(k, C2);
    h ^= k;
    h = (Math.imul(rotl(h, 13), 5) + 0xe6546b64) | 0;
  }
  const tail = 4 * len4;
  let k1 = 0;
  switch (len & 3) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3's tail falls through
    case 3:
      k1 ^= byte(data[tail + 2] as number) << 16;
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3's tail falls through
    case 2:
      k1 ^= byte(data[tail + 1] as number) << 8;
    case 1:
      k1 ^= byte(data[tail] as number);
      k1 = Math.imul(k1, C1);
      k1 = rotl(k1, 15);
      k1 = Math.imul(k1, C2);
      h ^= k1;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** git's bloom_key_fill: the probe positions of one path (unbounded 32-bit values). */
export function bloomKey(path: Uint8Array, settings: BloomFilterSettings): number[] {
  const h0 = murmur3(SEED0, path, settings.hashVersion);
  const h1 = murmur3(SEED1, path, settings.hashVersion);
  const hashes = new Array<number>(settings.numHashes);
  for (let i = 0; i < settings.numHashes; i++) hashes[i] = (h0 + Math.imul(i, h1)) >>> 0;
  return hashes;
}

/** git's add_key_to_filter. */
export function addKeyToFilter(key: number[], filter: Uint8Array): void {
  const mod = filter.length * 8;
  for (const hash of key) {
    const bit = hash % mod;
    filter[bit >>> 3] = (filter[bit >>> 3] as number) | (1 << (bit & 7));
  }
}

/**
 * git's bloom_filter_contains: 1 when every probe is set (the path may have changed), 0 when
 * one is clear (it did not), -1 for an empty filter (unknown).
 */
export function bloomFilterContains(filter: Uint8Array, key: number[]): -1 | 0 | 1 {
  const mod = filter.length * 8;
  if (mod === 0) return -1;
  for (const hash of key) {
    const bit = hash % mod;
    if (!((filter[bit >>> 3] as number) & (1 << (bit & 7)))) return 0;
  }
  return 1;
}

/**
 * Whether `path` (no leading or trailing slash) may have changed in the commit whose filter is
 * `filter`, as git's `bloom_filter_contains_vec` over the path and its leading directories:
 * false means it certainly did not; undefined means the filter cannot tell.
 */
export function bloomMayContainPath(
  filter: Uint8Array,
  path: string | Uint8Array,
  settings: BloomFilterSettings,
): boolean | undefined {
  const bytes = typeof path === "string" ? new TextEncoder().encode(path) : path;
  let result: -1 | 0 | 1 = bloomFilterContains(filter, bloomKey(bytes, settings));
  for (let end = bytes.length - 1; result > 0 && end > 0; end--) {
    if (bytes[end] === 0x2f) {
      result = bloomFilterContains(filter, bloomKey(bytes.subarray(0, end), settings));
    }
  }
  return result < 0 ? undefined : result > 0;
}

/**
 * The filter of a commit whose changed paths (every leading directory included, no
 * duplicates) are `paths`, as git's get_or_compute_bloom_filter builds it: more than
 * `maxChangedPaths` paths give the one-byte "too large" filter 0xff; none give one zero byte.
 */
export function computeBloomFilter(
  paths: readonly Uint8Array[],
  settings: BloomFilterSettings,
): Uint8Array {
  if (paths.length > settings.maxChangedPaths) return Uint8Array.of(0xff);
  const len = Math.floor((paths.length * settings.bitsPerEntry + 7) / 8);
  const filter = new Uint8Array(len === 0 ? 1 : len);
  if (len === 0) return filter;
  for (const p of paths) addKeyToFilter(bloomKey(p, settings), filter);
  return filter;
}
