// ============================================================================
// ---- Fossil-style Delta Algorithm (Optimized) ----
// Based on Fossil SCM's delta encoding algorithm
// See: https://fossil-scm.org/home/doc/tip/www/delta_encoder_algorithm.wiki

export interface RollingChecksum {
  a: number; // sum of bytes
  b: number; // weighted sum
  n: number; // window size
}

// Initialize rolling checksum (Fossil style)
export function rollingInit(buf: Uint8Array, offset: number, len: number): RollingChecksum {
  let a = 0;
  let b = 0;
  for (let i = 0; i < len; i++) {
    const byte = buf[offset + i];
    a = (a + byte) | 0;
    b = (b + (len - i) * byte) | 0;
  }
  return { a, b, n: len };
}

// Slide the window by one byte (Fossil style)
export function rollingSlide(rc: RollingChecksum, removeByte: number, addByte: number): void {
  rc.a = (rc.a - removeByte + addByte) | 0;
  rc.b = (rc.b - rc.n * removeByte + rc.a) | 0;
}

// Get 32-bit hash value
export function rollingValue(rc: RollingChecksum): number {
  return ((rc.a & 0xffff) | ((rc.b & 0xffff) << 16)) >>> 0;
}

// Convenience: compute weak checksum for a window
export function weakChecksum(buf: Uint8Array, offset: number, len: number): number {
  const rc = rollingInit(buf, offset, len);
  return rollingValue(rc);
}

// ---- Strong checksum (FNV-1a 32-bit, loop unrolled) ----
export function strongChecksum(buf: Uint8Array, offset: number, len: number): number {
  let hash = 0x811c9dc5 | 0;
  const end = offset + len;
  let i = offset;

  // Process 4 bytes at a time
  const end4 = offset + (len & ~3);
  while (i < end4) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193);
    hash ^= buf[i + 1];
    hash = Math.imul(hash, 0x01000193);
    hash ^= buf[i + 2];
    hash = Math.imul(hash, 0x01000193);
    hash ^= buf[i + 3];
    hash = Math.imul(hash, 0x01000193);
    i += 4;
  }

  // Handle remaining bytes
  while (i < end) {
    hash ^= buf[i++];
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

// ============================================================================
// ---- Fossil-style Hash Table ----
// Uses fixed-size arrays instead of Map for O(1) lookups

export interface SourceIndex {
  blockSize: number;
  source: Uint8Array;
  // Fossil-style hash table: landmark[hash] = first block index, collide[i] = next block index
  landmark: Int32Array; // hash -> first block index (-1 = empty)
  collide: Int32Array; // block index -> next block index (-1 = end of chain)
  // Parallel arrays for block data (faster than array of objects)
  blockPos: Uint32Array; // block positions
  blockWeak: Uint32Array; // weak checksums
  blockStrong: Uint32Array; // strong checksums
  hashMask: number; // mask for hash index (power of 2 - 1)
}

export const DEFAULT_BLOCK_SIZE = 16;

// Maximum hash chain length to bound worst-case (Fossil uses 250)
const MAX_CHAIN_LENGTH = 250;

export function buildSourceIndex(
  source: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): SourceIndex {
  const nBlocks = Math.floor(source.length / blockSize);
  if (nBlocks === 0) {
    return {
      blockSize,
      source,
      landmark: new Int32Array(1).fill(-1),
      collide: new Int32Array(0),
      blockPos: new Uint32Array(0),
      blockWeak: new Uint32Array(0),
      blockStrong: new Uint32Array(0),
      hashMask: 0,
    };
  }

  // Hash table size: next power of 2 >= nBlocks (Fossil style)
  let hashSize = 1;
  while (hashSize < nBlocks) hashSize <<= 1;
  const hashMask = hashSize - 1;

  const landmark = new Int32Array(hashSize).fill(-1);
  const collide = new Int32Array(nBlocks).fill(-1);
  // Use typed arrays for block data (faster access, less GC pressure)
  const blockPos = new Uint32Array(nBlocks);
  const blockWeak = new Uint32Array(nBlocks);
  const blockStrong = new Uint32Array(nBlocks);

  for (let i = 0; i < nBlocks; i++) {
    const pos = i * blockSize;
    const weak = weakChecksum(source, pos, blockSize);
    const strong = strongChecksum(source, pos, blockSize);
    blockPos[i] = pos;
    blockWeak[i] = weak;
    blockStrong[i] = strong;

    // Insert into hash table (prepend to chain)
    const h = weak & hashMask;
    collide[i] = landmark[h];
    landmark[h] = i;
  }

  return { blockSize, source, landmark, collide, blockPos, blockWeak, blockStrong, hashMask };
}

// ============================================================================
// ---- Delta range definitions ----

import type { DeltaRange } from "./types.js";

interface RangeAccumulator {
  last?: DeltaRange;
}

/**
 * Merge-adjacent range emitter.
 * Keeps state in `acc.last` and yields only when necessary.
 */
export function* emitRange(
  acc: RangeAccumulator,
  next: DeltaRange | undefined,
): Generator<DeltaRange> {
  if (!next) {
    return;
  }

  const prev = acc.last;
  if (prev && prev.from === next.from && prev.start + prev.len === next.start) {
    // Extend previous range
    prev.len += next.len;
    return;
  }

  if (prev) {
    yield prev;
  }

  acc.last = { ...next };
}

// ============================================================================
// ---- Optimized byte comparison using Uint32Array views ----

// Helper to create aligned Uint32Array view (may return null if not possible)
function tryGetUint32View(arr: Uint8Array): Uint32Array | null {
  // Check if buffer is properly aligned and sized
  if (arr.byteOffset === 0 && (arr.buffer.byteLength & 3) === 0) {
    return new Uint32Array(arr.buffer);
  }
  return null;
}

// Compare bytes forward using Uint32Array when possible
function matchForward(
  src: Uint8Array,
  srcStart: number,
  tgt: Uint8Array,
  tgtStart: number,
  src32?: Uint32Array | null,
  tgt32?: Uint32Array | null,
): number {
  const maxLen = Math.min(src.length - srcStart, tgt.length - tgtStart);
  if (maxLen <= 0) return 0;

  let len = 0;

  // Use Uint32Array fast path if both positions are aligned
  if (src32 && tgt32 && (srcStart & 3) === 0 && (tgtStart & 3) === 0 && maxLen >= 16) {
    const srcIdx = srcStart >>> 2;
    const tgtIdx = tgtStart >>> 2;
    const fastEnd = (maxLen >>> 2) - 1;

    let i = 0;
    // Compare 4 uint32 values at a time (16 bytes)
    const fastEnd4 = fastEnd - 3;
    while (i < fastEnd4) {
      if (
        src32[srcIdx + i] !== tgt32[tgtIdx + i] ||
        src32[srcIdx + i + 1] !== tgt32[tgtIdx + i + 1] ||
        src32[srcIdx + i + 2] !== tgt32[tgtIdx + i + 2] ||
        src32[srcIdx + i + 3] !== tgt32[tgtIdx + i + 3]
      ) {
        break;
      }
      i += 4;
    }
    // Compare remaining uint32 values
    while (i < fastEnd && src32[srcIdx + i] === tgt32[tgtIdx + i]) {
      i++;
    }
    len = i << 2;
  }

  // Finish with byte-by-byte
  while (len < maxLen && src[srcStart + len] === tgt[tgtStart + len]) {
    len++;
  }

  return len;
}

// Compare bytes backward (byte-by-byte is fine for backward)
function matchBackward(
  src: Uint8Array,
  srcEnd: number,
  tgt: Uint8Array,
  tgtEnd: number,
  tgtLimit: number,
): number {
  const maxBack = Math.min(srcEnd, tgtEnd - tgtLimit);
  if (maxBack <= 0) return 0;

  let len = 0;
  while (len < maxBack && src[srcEnd - len - 1] === tgt[tgtEnd - len - 1]) {
    len++;
  }
  return len;
}

// ============================================================================
// ---- Fast array-based implementation (no generator overhead) ----

// Push range to array, merging with previous if adjacent
function pushRange(ranges: DeltaRange[], next: DeltaRange): void {
  const len = ranges.length;
  if (len > 0) {
    const prev = ranges[len - 1];
    if (prev.from === next.from && prev.start + prev.len === next.start) {
      prev.len += next.len;
      return;
    }
  }
  ranges.push(next);
}

// Fast non-generator version - returns array directly
export function createFossilLikeRangesArray(
  source: Uint8Array,
  target: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): DeltaRange[] {
  const ranges: DeltaRange[] = [];
  const index = buildSourceIndex(source, blockSize);

  // No block possible => entire target is an insert
  if (target.length < blockSize || index.blockPos.length === 0) {
    if (target.length > 0) {
      ranges.push({ from: "target", start: 0, len: target.length });
    }
    return ranges;
  }

  const { landmark, collide, blockPos, blockWeak, blockStrong, hashMask } = index;

  // Create Uint32Array views for fast comparison (if buffers are aligned)
  const src32 = tryGetUint32View(source);
  const tgt32 = tryGetUint32View(target);

  let tPos = 0;
  let insertStart = 0;

  // Inline rolling checksum state (avoid object allocation per iteration)
  let rcA = 0;
  let rcB = 0;
  let rcInitialized = false;

  while (tPos + blockSize <= target.length) {
    // Initialize or slide checksum (inlined for performance)
    if (!rcInitialized) {
      rcA = 0;
      rcB = 0;
      for (let i = 0; i < blockSize; i++) {
        const byte = target[tPos + i];
        rcA = (rcA + byte) | 0;
        rcB = (rcB + (blockSize - i) * byte) | 0;
      }
      rcInitialized = true;
    } else {
      const removeByte = target[tPos - 1];
      const addByte = target[tPos + blockSize - 1];
      rcA = (rcA - removeByte + addByte) | 0;
      rcB = (rcB - blockSize * removeByte + rcA) | 0;
    }

    const weak = ((rcA & 0xffff) | ((rcB & 0xffff) << 16)) >>> 0;
    const h = weak & hashMask;

    let bestSrcPos = -1;
    let bestTgtPos = tPos;
    let bestLen = 0;

    // Walk the hash chain
    let blockIdx = landmark[h];
    let chainLen = 0;
    let targetStrong = -1;

    while (blockIdx >= 0 && chainLen < MAX_CHAIN_LENGTH) {
      chainLen++;

      // Access block data from parallel arrays (faster than objects)
      const candWeak = blockWeak[blockIdx];
      if (candWeak === weak) {
        if (targetStrong < 0) {
          targetStrong = strongChecksum(target, tPos, blockSize);
        }

        const candStrong = blockStrong[blockIdx];
        if (candStrong === targetStrong) {
          const candPos = blockPos[blockIdx];
          const backLen = matchBackward(source, candPos, target, tPos, insertStart);
          const s = candPos - backLen;
          const tt = tPos - backLen;
          // Use Uint32Array views for fast forward matching
          const fwdLen = matchForward(source, candPos, target, tPos, src32, tgt32);
          const totalLen = backLen + fwdLen;

          if (totalLen >= blockSize) {
            bestLen = totalLen;
            bestSrcPos = s;
            bestTgtPos = tt;
            break;
          }
        }
      }

      blockIdx = collide[blockIdx];
    }

    if (bestLen >= blockSize) {
      if (bestTgtPos > insertStart) {
        pushRange(ranges, { from: "target", start: insertStart, len: bestTgtPos - insertStart });
      }
      pushRange(ranges, { from: "source", start: bestSrcPos, len: bestLen });

      const newTPos = bestTgtPos + bestLen;
      tPos = newTPos;
      insertStart = newTPos;
      rcInitialized = false;
    } else {
      tPos++;
    }
  }

  if (insertStart < target.length) {
    pushRange(ranges, { from: "target", start: insertStart, len: target.length - insertStart });
  }

  return ranges;
}

// Generator wrapper for backward compatibility
export function* createFossilLikeRanges(
  source: Uint8Array,
  target: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): Generator<DeltaRange> {
  const ranges = createFossilLikeRangesArray(source, target, blockSize);
  for (const range of ranges) {
    yield range;
  }
}
