/**
 * Delta Index - Hash table for finding matching blocks
 *
 * Based on JGit's DeltaIndex. Builds a hash table index of 16-byte blocks
 * in source data for efficient delta computation.
 *
 * The index maps block hashes to their positions in the source buffer,
 * allowing O(1) lookup of potential match locations.
 */

import {
  JGIT_BLOCK_SIZE as BLKSZ,
  jgitHashBlock as hashBlock,
  MAX_CHAIN_LENGTH,
  jgitHashStep as step,
  jgitTableSize as tableSize,
} from "@statewalker/vcs-utils";

/**
 * Entry in the delta index
 *
 * Combines hash and offset in a single 64-bit value (stored as two 32-bit parts).
 */
interface IndexEntry {
  /** 32-bit block hash */
  hash: number;
  /** Byte offset in source buffer */
  offset: number;
}

/**
 * DeltaIndex - Hash table for matching source blocks
 *
 * Build an index from source data, then use it to find matches
 * when computing deltas against target data.
 *
 * @example
 * ```typescript
 * const index = new DeltaIndex(sourceData);
 * const matches = index.findMatches(hash);
 * for (const offset of matches) {
 *   // Check if actual data matches at this offset
 * }
 * ```
 */
export class DeltaIndex {
  /** Source data buffer */
  private readonly src: Uint8Array;

  /** Hash table: hash -> first entry index (-1 if empty) */
  private readonly table: Int32Array;

  /** Table size mask for fast modulo: (table.length - 1) */
  private readonly tableMask: number;

  /** Entries array: (hash, offset) pairs */
  private readonly entries: IndexEntry[];

  /** Next pointers for collision chains: entry index -> next entry index (-1 if end) */
  private readonly next: Int32Array;

  /**
   * Build a delta index from source data
   *
   * @param src Source data to index
   */
  constructor(src: Uint8Array) {
    this.src = src;

    if (src.length < BLKSZ) {
      // Too small to index
      this.table = new Int32Array(1).fill(-1);
      this.tableMask = 0;
      this.entries = [];
      this.next = new Int32Array(0);
      return;
    }

    // Calculate number of blocks
    const blockCount = Math.floor(src.length / BLKSZ);
    const tblSize = tableSize(blockCount);

    // Initialize hash table with -1 (empty)
    this.table = new Int32Array(tblSize).fill(-1);
    this.tableMask = tblSize - 1;

    // Build entries by scanning source
    const tempEntries: IndexEntry[] = [];
    const tempNext: number[] = [];

    // Scan backwards so earlier offsets appear first in chains
    for (let ptr = (blockCount - 1) * BLKSZ; ptr >= 0; ptr -= BLKSZ) {
      const hash = hashBlock(src, ptr);
      const slot = hash & this.tableMask;
      const entryIdx = tempEntries.length;

      tempEntries.push({ hash, offset: ptr });

      // Link into chain
      tempNext.push(this.table[slot]);
      this.table[slot] = entryIdx;
    }

    // Truncate long chains and compact entries
    this.entries = [];
    this.next = new Int32Array(tempEntries.length).fill(-1);

    const newIndices = new Int32Array(tempEntries.length).fill(-1);

    for (let slot = 0; slot < tblSize; slot++) {
      const chainHead = this.table[slot];
      if (chainHead === -1) continue;

      let chainLen = 0;
      let prevNewIdx = -1;
      let current = chainHead;

      while (current !== -1 && chainLen < MAX_CHAIN_LENGTH) {
        const entry = tempEntries[current];
        const newIdx = this.entries.length;
        newIndices[current] = newIdx;
        this.entries.push(entry);

        if (prevNewIdx === -1) {
          this.table[slot] = newIdx;
        } else {
          this.next[prevNewIdx] = newIdx;
        }

        prevNewIdx = newIdx;
        current = tempNext[current];
        chainLen++;
      }
    }

    // Resize next array to final size
    const finalNext = new Int32Array(this.entries.length).fill(-1);
    for (let i = 0; i < tempEntries.length; i++) {
      if (newIndices[i] !== -1) {
        const oldNext = tempNext[i];
        if (oldNext !== -1 && newIndices[oldNext] !== -1) {
          finalNext[newIndices[i]] = newIndices[oldNext];
        }
      }
    }
    (this as unknown as { next: Int32Array }).next = finalNext;
  }

  /**
   * Get source data
   */
  getSource(): Uint8Array {
    return this.src;
  }

  /**
   * Get source length
   */
  getSourceLength(): number {
    return this.src.length;
  }

  /**
   * Find all potential match offsets for a given hash
   *
   * @param hash Block hash to look up
   * @yields Byte offsets in source where blocks with matching hash exist
   */
  *findMatches(hash: number): Generator<number> {
    const slot = hash & this.tableMask;
    let idx = this.table[slot];

    while (idx !== -1) {
      const entry = this.entries[idx];
      if (entry.hash === hash) {
        yield entry.offset;
      }
      idx = this.next[idx];
    }
  }

  /**
   * Check if a region in source matches a region in target
   *
   * @param srcOffset Offset in source data
   * @param target Target data buffer
   * @param targetOffset Offset in target data
   * @param maxLen Maximum length to compare
   * @returns Number of matching bytes
   */
  matchLength(srcOffset: number, target: Uint8Array, targetOffset: number, maxLen: number): number {
    const srcEnd = Math.min(this.src.length, srcOffset + maxLen);
    const targetEnd = Math.min(target.length, targetOffset + maxLen);
    const maxCompare = Math.min(srcEnd - srcOffset, targetEnd - targetOffset);

    let len = 0;
    while (len < maxCompare && this.src[srcOffset + len] === target[targetOffset + len]) {
      len++;
    }
    return len;
  }

  /**
   * Extend match backwards from a starting point
   *
   * @param srcOffset Current source position
   * @param target Target data
   * @param targetOffset Current target position
   * @returns Number of bytes that match going backwards
   */
  matchLengthBackward(srcOffset: number, target: Uint8Array, targetOffset: number): number {
    let len = 0;
    while (
      srcOffset - len > 0 &&
      targetOffset - len > 0 &&
      this.src[srcOffset - len - 1] === target[targetOffset - len - 1]
    ) {
      len++;
    }
    return len;
  }

  /**
   * Get estimated memory usage
   */
  getIndexSize(): number {
    const headerSize = 32; // Object overhead estimate
    const srcSize = this.src.length;
    const tableSize = this.table.length * 4; // Int32Array
    const entriesSize = this.entries.length * 16; // Two numbers + object overhead
    const nextSize = this.next.length * 4; // Int32Array
    return headerSize + srcSize + tableSize + entriesSize + nextSize;
  }
}

/**
 * Compute delta between source and target using rolling hash
 *
 * This is the main entry point for delta computation.
 * Returns delta instructions as copy/insert operations.
 *
 * @param src Source (base) data
 * @param target Target (result) data
 * @returns Delta instructions or null if delta would be larger than target
 */
export function computeDeltaInstructions(
  src: Uint8Array,
  target: Uint8Array,
): DeltaInstruction[] | null {
  if (target.length < BLKSZ) {
    // Target too small for delta, just insert everything
    return [{ type: "insert", data: target }];
  }

  const index = new DeltaIndex(src);
  const instructions: DeltaInstruction[] = [];

  let targetPos = 0;
  let insertStart = 0;

  // Track hash position for rolling - JGit rolling hash diverges after multiple steps,
  // so we recompute with hashBlock when position changes by more than 1
  let hashPos = -1;
  let hash = 0;

  while (targetPos <= target.length - BLKSZ) {
    // Update hash - recompute if position jumped (after match) or first iteration
    // Use rolling update only for single-step advances to match JGit behavior
    if (hashPos === targetPos - 1 && hashPos >= 0) {
      // Single-step advance - use rolling hash (accurate for 1 step)
      hash = step(hash, target[hashPos], target[targetPos + BLKSZ - 1]);
    } else {
      // Position jumped or first iteration - recompute hash
      hash = hashBlock(target, targetPos);
    }
    hashPos = targetPos;

    let bestMatchSrcOffset = -1;
    let bestMatchLen = BLKSZ - 1; // Must beat minimum block size
    let bestBackwardLen = 0;

    // Look for matches
    for (const srcOffset of index.findMatches(hash)) {
      // Extend match forward
      const forwardLen = index.matchLength(srcOffset, target, targetPos, target.length - targetPos);

      // Extend match backward, but not past insertStart to avoid overlap
      const maxBackward = Math.min(srcOffset, targetPos - insertStart);
      let backwardLen = 0;
      while (
        backwardLen < maxBackward &&
        index.getSource()[srcOffset - backwardLen - 1] === target[targetPos - backwardLen - 1]
      ) {
        backwardLen++;
      }

      const totalLen = forwardLen + backwardLen;

      if (totalLen > bestMatchLen) {
        bestMatchLen = totalLen;
        bestMatchSrcOffset = srcOffset - backwardLen;
        bestBackwardLen = backwardLen;
      }
    }

    if (bestMatchSrcOffset >= 0 && bestMatchLen >= BLKSZ) {
      // Found a good match - flush pending inserts up to where the match starts
      const matchStartInTarget = targetPos - bestBackwardLen;
      if (insertStart < matchStartInTarget) {
        instructions.push({
          type: "insert",
          data: target.slice(insertStart, matchStartInTarget),
        });
      }

      // Add copy instruction
      instructions.push({
        type: "copy",
        offset: bestMatchSrcOffset,
        length: bestMatchLen,
      });

      // Advance past the entire match (including backward extension)
      targetPos = matchStartInTarget + bestMatchLen;
      insertStart = targetPos;
    } else {
      // No match, advance by one byte
      targetPos++;
    }
  }

  // Handle remaining bytes
  if (insertStart < target.length) {
    instructions.push({
      type: "insert",
      data: target.slice(insertStart),
    });
  }

  return instructions;
}

/**
 * Delta instruction types
 */
export type DeltaInstruction =
  | { type: "copy"; offset: number; length: number }
  | { type: "insert"; data: Uint8Array };
