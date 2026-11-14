/**
 * git's binary delta encoder (diff-delta.c, JGit DeltaIndex/DeltaEncoder), producing what
 * `applyGitDelta` reads: the source is indexed by the hash of its 16-byte blocks (every block boundary;
 * at most HASH_LIMIT entries per bucket, as git, so repetitive sources stay cheap); the target is
 * scanned with a rolling hash of the same window; a hit is verified, extended forward, and
 * backward into the pending literals. Copies are at most 0x10000 bytes, inserts at most 127.
 */
const BLOCK = 16;
/** git's HASH_LIMIT: entries kept per bucket */
const HASH_LIMIT = 64;
const MAX_COPY = 0x10000;
const MAX_INSERT = 0x7f;
const B = 0x01000193;
/** B^BLOCK mod 2^32: removes the byte leaving the rolling window */
const BPOW = (() => {
  let p = 1;
  for (let i = 0; i < BLOCK; i++) p = Math.imul(p, B);
  return p;
})();

function hashAt(d: Uint8Array, p: number): number {
  let h = 0;
  for (let i = 0; i < BLOCK; i++) h = (Math.imul(h, B) + (d[p + i] as number)) | 0;
  return h;
}

export interface GitDeltaIndex {
  source: Uint8Array;
  mask: number;
  /** slot s holds entries [start[s], start[s + 1]) of `pos`/`val` */
  start: Int32Array;
  pos: Int32Array;
  val: Int32Array;
}

/**
 * Source positions indexed: every byte up to 256 KiB, every 2nd up to 1 MiB, every 4th up to
 * 4 MiB, every 16th (git's) beyond. git indexes
 * every 16th (one per block); measured on git's own (base, target) pairs of a text history, that
 * gives 4.3× git's delta bytes here, every 2nd 0.99×, every byte 0.95× — git's encoder finds its
 * long matches in ways a plain block index misses, and a denser index recovers them. An indexed
 * position costs 8 bytes and its share of the slots ~1: ~9×, 4.5×, 2.3×, 0.6× the source.
 */
const indexStep = (n: number) =>
  n <= 256 * 1024 ? 1 : n <= 2 ** 20 ? 2 : n <= 4 * 2 ** 20 ? 4 : BLOCK;

/** Slots for `m` indexed positions: about four per slot, as git's hsize. */
const slotsFor = (m: number) => {
  let size = 16;
  while (size * 4 < m) size <<= 1;
  return size;
};

/** An upper bound of `indexBytes` for a source of `n` bytes (before deduplication and thinning). */
export const gitDeltaIndexEstimate = (n: number) => {
  const m = n < BLOCK ? 0 : Math.floor((n - BLOCK) / indexStep(n)) + 1;
  return (slotsFor(m) + 1) * 4 + m * 8;
};

/**
 * Indexes `source` once, for every target tried against it, as git's create_delta_index: the hash
 * of the 16 bytes at every `indexStep` position; of a run of identical windows only the lowest; a slot over HASH_LIMIT
 * entries thinned evenly across the source (keeping the earliest would drop the one occurrence
 * that continues further on a repetitive source).
 */
export function createGitDeltaIndex(
  source: Uint8Array,
  step = indexStep(source.length),
): GitDeltaIndex {
  const blocks = source.length < BLOCK ? 0 : Math.floor((source.length - BLOCK) / step) + 1;
  const size = slotsFor(blocks);
  const mask = size - 1;
  const vals = new Int32Array(blocks);
  const keep = new Uint8Array(blocks);
  const count = new Int32Array(size + 1);
  for (let b = 0; b < blocks; b++) {
    vals[b] = hashAt(source, b * step);
    // a run of identical blocks: only its first is indexed
    if (b > 0 && vals[b] === vals[b - 1]) continue;
    keep[b] = 1;
    const c = ((vals[b] as number) & mask) + 1;
    count[c] = (count[c] as number) + 1;
  }
  // counting sort into slots, then thin crowded slots evenly
  const at = new Int32Array(size + 1);
  for (let i = 0; i < size; i++) at[i + 1] = (at[i] as number) + (count[i + 1] as number);
  const allPos = new Int32Array(at[size] as number);
  const fill = at.slice(0, size);
  for (let b = 0; b < blocks; b++) {
    if (!keep[b]) continue;
    const slot = (vals[b] as number) & mask;
    allPos[fill[slot] as number] = b * step;
    fill[slot] = (fill[slot] as number) + 1;
  }
  const start = new Int32Array(size + 1);
  let n = 0;
  for (let i = 0; i < size; i++)
    n += Math.min(HASH_LIMIT, (at[i + 1] as number) - (at[i] as number));
  const pos = new Int32Array(n);
  const val = new Int32Array(n);
  n = 0;
  for (let i = 0; i < size; i++) {
    start[i] = n;
    const from = at[i] as number;
    const len = (at[i + 1] as number) - from;
    const k = Math.min(HASH_LIMIT, len);
    for (let j = 0; j < k; j++) {
      const q = allPos[from + Math.floor((j * len) / k)] as number;
      pos[n] = q;
      val[n++] = vals[q / step] as number;
    }
  }
  start[size] = n;
  return { source, mask, start, pos, val };
}

/** Index memory, for window accounting. */
export const gitDeltaIndexBytes = (i: GitDeltaIndex) => i.start.byteLength + i.pos.byteLength * 2;

/** A growable byte buffer (a number[] costs 8+ bytes per byte and a copy at the end). */
class Sink {
  buf = new Uint8Array(256);
  length = 0;
  push(b: number) {
    if (this.length === this.buf.length) {
      const g = new Uint8Array(this.buf.length * 2);
      g.set(this.buf);
      this.buf = g;
    }
    this.buf[this.length++] = b;
  }
  varint(n: number) {
    while (n >= 0x80) {
      this.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.push(n);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * A delta turning `index.source` into `target`, or undefined once it would exceed `maxSize` bytes
 * (git's max_size: the search gives up early).
 *
 * @example
 * ```typescript
 * const index = createGitDeltaIndex(base); // once per base, reused for many targets
 * const delta = encodeGitDelta(index, target, target.length / 2);
 * if (delta) applyGitDelta(base, delta); // equals target
 * ```
 */
export function encodeGitDelta(
  index: GitDeltaIndex,
  target: Uint8Array,
  maxSize = Number.POSITIVE_INFINITY,
): Uint8Array | undefined {
  const src = index.source;
  const out = new Sink();
  out.varint(src.length);
  out.varint(target.length);
  let insertFrom = 0; // the pending literals start here
  const flushInsert = (to: number) => {
    while (insertFrom < to) {
      const n = Math.min(MAX_INSERT, to - insertFrom);
      out.push(n);
      for (let i = 0; i < n; i++) out.push(target[insertFrom + i] as number);
      insertFrom += n;
    }
  };
  const copy = (off: number, len: number) => {
    while (len > 0) {
      const n = Math.min(MAX_COPY, len);
      const size = n === MAX_COPY ? 0 : n; // size 0 means 0x10000
      const ob = [0, 1, 2, 3].map((i) => Math.floor(off / 2 ** (8 * i)) & 0xff);
      const sb = [0, 1, 2].map((i) => (size >> (8 * i)) & 0xff);
      let cmd = 0x80;
      ob.forEach((b, i) => {
        if (b) cmd |= 1 << i;
      });
      sb.forEach((b, i) => {
        if (b) cmd |= 0x10 << i;
      });
      out.push(cmd);
      for (const b of ob) if (b) out.push(b);
      for (const b of sb) if (b) out.push(b);
      off += n;
      len -= n;
    }
  };
  let p = 0;
  let h = target.length >= BLOCK ? hashAt(target, 0) : 0;
  while (p + BLOCK <= target.length) {
    // pending literals count too: they will be written
    if (out.length + (p - insertFrom) > maxSize) return undefined;
    let bestLen = 0;
    let bestOff = 0;
    const slot = h & index.mask;
    for (let e = index.start[slot] as number; e < (index.start[slot + 1] as number); e++) {
      if (index.val[e] !== h) continue; // another hash in this slot
      const s = index.pos[e] as number;
      const lim = Math.min(src.length - s, target.length - p);
      let len = 0;
      while (len < lim && src[s + len] === target[p + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = s;
        if (len >= MAX_COPY) break;
      }
    }
    if (bestLen >= BLOCK) {
      let back = 0;
      while (
        back < p - insertFrom &&
        back < bestOff &&
        src[bestOff - back - 1] === target[p - back - 1]
      )
        back++;
      flushInsert(p - back);
      copy(bestOff - back, bestLen + back);
      p += bestLen;
      insertFrom = p;
      if (p + BLOCK <= target.length) h = hashAt(target, p);
      continue;
    }
    if (p + BLOCK < target.length)
      h =
        (Math.imul(h, B) - Math.imul(target[p] as number, BPOW) + (target[p + BLOCK] as number)) |
        0;
    p++;
  }
  flushInsert(target.length);
  if (out.length > maxSize) return undefined;
  return out.bytes();
}
