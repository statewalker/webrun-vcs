/**
 * SimilarityIndex - computes content similarity between files
 *
 * Based on JGit's SimilarityIndex.java
 *
 * Hashes lines/blocks of content to create a fingerprint that can be
 * efficiently compared with other files. Used for rename detection.
 */

import { RawText } from "@statewalker/vcs-utils";

/**
 * Maximum score (100% match)
 */
export const MAX_SCORE = 100;

/**
 * Default rename threshold (50% similarity)
 */
export const DEFAULT_RENAME_SCORE = 50;

/**
 * Entry in the hash table: key and count stored separately to avoid
 * JavaScript floating-point precision issues.
 */
interface HashEntry {
  key: number;
  count: number;
}

/**
 * Index structure for computing content similarity.
 *
 * Hash-based approach: each line/block is hashed and counts are maintained.
 * Similarity is computed by finding common hashes between two files.
 */
export class SimilarityIndex {
  /** Total bytes hashed */
  private hashedCnt = 0;

  /** Hash table entries, sorted by key for efficient comparison */
  private entries: HashEntry[] = [];

  /** Lookup map during hashing (key -> index in entries) */
  private hashMap = new Map<number, number>();

  /**
   * Create a SimilarityIndex from content bytes.
   */
  static create(content: Uint8Array): SimilarityIndex {
    const idx = new SimilarityIndex();
    idx.hash(content);
    idx.sort();
    return idx;
  }

  /**
   * Check if content is binary (contains NUL bytes in first 8000 bytes)
   */
  static isBinary(content: Uint8Array): boolean {
    return RawText.isBinary(content);
  }

  /**
   * Hash the content.
   */
  hash(content: Uint8Array): void {
    const text = !SimilarityIndex.isBinary(content);
    this.hashedCnt = 0;
    this.entries = [];
    this.hashMap.clear();

    let ptr = 0;
    const end = content.length;

    while (ptr < end) {
      let hash = 5381;
      let blockHashedCnt = 0;
      const start = ptr;

      // Hash one line, or one block (64 bytes), whichever occurs first
      while (ptr < end && ptr - start < 64) {
        const c = content[ptr++];

        // Ignore CR in CRLF sequence if text
        if (text && c === 0x0d && ptr < end && content[ptr] === 0x0a) {
          continue;
        }

        blockHashedCnt++;

        if (c === 0x0a) {
          // LF - end of line
          break;
        }

        // djb2 hash: hash = hash * 33 + c
        hash = ((hash << 5) + hash + c) >>> 0;
      }

      this.hashedCnt += blockHashedCnt;
      this.add(hash, blockHashedCnt);
    }
  }

  /**
   * Sort entries by key for efficient comparison.
   */
  sort(): void {
    this.entries.sort((a, b) => a.key - b.key);
    // Clear the map after sorting as we don't need it anymore
    this.hashMap.clear();
  }

  /**
   * Compute similarity score between this index and another.
   *
   * @param other The other index to compare with
   * @param maxScore Maximum score (default 100)
   * @returns Similarity score from 0 to maxScore
   */
  score(other: SimilarityIndex, maxScore: number = MAX_SCORE): number {
    const max = Math.max(this.hashedCnt, other.hashedCnt);
    if (max === 0) {
      return maxScore; // Both empty = 100% match
    }
    return Math.floor((this.common(other) * maxScore) / max);
  }

  /**
   * Count common bytes between this index and another.
   * Both indices must be sorted.
   */
  private common(other: SimilarityIndex): number {
    const srcEntries = this.entries;
    const dstEntries = other.entries;

    if (srcEntries.length === 0 || dstEntries.length === 0) {
      return 0;
    }

    let srcIdx = 0;
    let dstIdx = 0;
    let commonBytes = 0;

    while (srcIdx < srcEntries.length && dstIdx < dstEntries.length) {
      const srcEntry = srcEntries[srcIdx];
      const dstEntry = dstEntries[dstIdx];

      if (srcEntry.key === dstEntry.key) {
        // Same key - add minimum count to common
        commonBytes += Math.min(srcEntry.count, dstEntry.count);
        srcIdx++;
        dstIdx++;
      } else if (srcEntry.key < dstEntry.key) {
        // Advance source
        srcIdx++;
      } else {
        // Advance destination
        dstIdx++;
      }
    }

    return commonBytes;
  }

  /**
   * Add a hash with count to the table.
   */
  private add(key: number, cnt: number): void {
    // Mix bits and ensure not negative (same as JGit)
    key = ((key * 0x9e370001) >>> 1) >>> 0;

    const existingIdx = this.hashMap.get(key);
    if (existingIdx !== undefined) {
      // Increment count for existing key
      this.entries[existingIdx].count += cnt;
    } else {
      // Add new entry
      const idx = this.entries.length;
      this.entries.push({ key, count: cnt });
      this.hashMap.set(key, idx);
    }
  }
}
