/**
 * Binary sequence comparator using rolling checksums
 *
 * Implements SequenceComparator for BinarySequence, using rolling checksums
 * for efficient block comparison.
 */

import { RollingChecksum } from "../../hash/index.js";
import type { BinarySequence } from "./binary-sequence.js";
import type { SequenceComparator } from "./sequence.js";

/**
 * Comparator for binary sequences using rolling checksums
 *
 * This comparator treats blocks as the atomic units for comparison.
 * It uses rolling checksums for fast hashing and byte-by-byte comparison
 * for equality checks.
 */
export class BinaryComparator implements SequenceComparator<BinarySequence> {
  /**
   * Compare two blocks for equality
   *
   * @param a First sequence
   * @param ai Block index in first sequence
   * @param b Second sequence
   * @param bi Block index in second sequence
   * @returns true if blocks are equal
   */
  equals(a: BinarySequence, ai: number, b: BinarySequence, bi: number): boolean {
    const blockA = a.getBlock(ai);
    const blockB = b.getBlock(bi);

    // Quick length check
    if (blockA.length !== blockB.length) {
      return false;
    }

    // Byte-by-byte comparison
    for (let i = 0; i < blockA.length; i++) {
      if (blockA[i] !== blockB[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compute hash for a block
   *
   * Uses rolling checksum for fast hashing
   *
   * @param seq Sequence
   * @param index Block index
   * @returns Hash value
   */
  private readonly rc = new RollingChecksum();

  hash(seq: BinarySequence, index: number): number {
    const block = seq.getBlock(index);
    this.rc.reset();
    return this.rc.init(block, 0, block.length).value();
  }
}

/**
 * Byte-level comparator (treats each byte as an element)
 *
 * This is slower but more precise than block-based comparison.
 * Use for small files or when precise byte-level diffs are needed.
 */
export class ByteLevelComparator implements SequenceComparator<BinarySequence> {
  equals(a: BinarySequence, ai: number, b: BinarySequence, bi: number): boolean {
    return a.getByte(ai) === b.getByte(bi);
  }

  hash(seq: BinarySequence, index: number): number {
    // Simple hash: just the byte value itself
    // This is sufficient for byte-level comparison
    return seq.getByte(index);
  }
}
