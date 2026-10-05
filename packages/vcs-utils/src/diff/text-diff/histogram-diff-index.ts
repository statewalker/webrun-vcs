import { Edit } from "./edit.js";
import type { HashedSequence, HashedSequenceComparator } from "./hashed-sequence.js";
import type { Sequence } from "./sequence.js";

/**
 * Record layout constants for the 64-bit packed record format.
 *
 * Each record stores:
 * - Bits 0-7: occurrence count (8 bits, max 255)
 * - Bits 8-35: element pointer/position (28 bits)
 * - Bits 36-63: next record index in hash chain (28 bits)
 */
const REC_NEXT_SHIFT = 36n;
const REC_PTR_SHIFT = 8n;
const REC_PTR_MASK = (1n << 28n) - 1n;
const REC_CNT_MASK = (1n << 8n) - 1n;

/** Maximum element pointer value (28-bit limit) */
const MAX_PTR = Number(REC_PTR_MASK);

/** Maximum occurrence count (8-bit limit) */
const MAX_CNT = 255;

/**
 * Support {@link HistogramDiff} by computing occurrence counts of elements.
 *
 * Each element in the range being considered is put into a hash table, tracking
 * the number of times that distinct element appears in the sequence. Once all
 * elements have been inserted from sequence A, each element of sequence B is
 * probed in the hash table and the longest common subsequence with the lowest
 * occurrence count in A is used as the result.
 *
 * This is based on JGit's HistogramDiffIndex implementation, which is an
 * extended form of Bram Cohen's patience diff algorithm.
 *
 * @template S Type of the base sequence
 */
export class HistogramDiffIndex<S extends Sequence> {
  /** Maximum hash chain length before signaling fallback */
  private readonly maxChainLength: number;

  /** Comparator for hashed sequences */
  private readonly cmp: HashedSequenceComparator<S>;

  /** First sequence (base/old) */
  private readonly a: HashedSequence<S>;

  /** Second sequence (new) */
  private readonly b: HashedSequence<S>;

  /** Region to compare within sequences */
  private readonly region: Edit;

  /**
   * Hash table keyed by element hash, values are record indices into {@link recs}.
   * Uses open addressing with the hash function distributing keys.
   */
  private readonly table: Int32Array;

  /** Number of low bits to discard from a key to index {@link table} */
  private readonly keyShift: number;

  /**
   * Describes unique elements in sequence A.
   *
   * Each record is a 64-bit packed value containing:
   * - next: index of next record with same hash code
   * - ptr: index of first element in this occurrence chain
   * - cnt: occurrence count for this element (capped at MAX_CNT)
   */
  private recs: BigInt64Array;

  /** Number of elements in {@link recs}; also is the unique element count */
  private recCnt = 0;

  /**
   * For position ptr in A, next[ptr - ptrShift] has the index of the next
   * occurrence of the same element in sequence A.
   *
   * Chains always run from lowest index to largest. Therefore a chain
   * terminates with 0, as 0 would never be a valid next element (we scan
   * backwards so the earliest occurrence is at the start of the chain).
   */
  private readonly next: Int32Array;

  /**
   * For element ptr in A, recIdx[ptr - ptrShift] is the index into {@link recs}
   * for the record describing all occurrences of that element.
   */
  private readonly recIdx: Int32Array;

  /** Value to subtract from element indexes to key {@link next} array */
  private readonly ptrShift: number;

  /** The best LCS found so far */
  private lcs: Edit;

  /** Occurrence count of the best LCS */
  private cnt = 0;

  /** Whether any common elements were found */
  private hasCommon = false;

  /**
   * Create a new histogram diff index.
   *
   * @param maxChainLength Maximum hash chain length before fallback
   * @param cmp Comparator for hashed sequences
   * @param a First sequence (base/old)
   * @param b Second sequence (new)
   * @param region Region to compare within sequences
   * @throws Error if region.endA exceeds MAX_PTR
   */
  constructor(
    maxChainLength: number,
    cmp: HashedSequenceComparator<S>,
    a: HashedSequence<S>,
    b: HashedSequence<S>,
    region: Edit,
  ) {
    this.maxChainLength = maxChainLength;
    this.cmp = cmp;
    this.a = a;
    this.b = b;
    this.region = region;
    this.lcs = new Edit(0, 0, 0, 0);

    if (region.endA >= MAX_PTR) {
      throw new Error("Sequence too large for diff algorithm");
    }

    const sz = region.getLengthA();
    const bits = calculateTableBits(sz);
    this.table = new Int32Array(1 << bits);
    this.keyShift = 32 - bits;
    this.ptrShift = region.beginA;

    // Initial capacity for recs, will grow as needed
    this.recs = new BigInt64Array(Math.max(4, sz >>> 3));
    this.next = new Int32Array(sz);
    this.recIdx = new Int32Array(sz);
  }

  /**
   * Find the longest common sequence with the lowest occurrence count.
   *
   * @returns Edit representing the LCS, or null if maxChainLength was exceeded
   *          (signaling that a fallback algorithm should be used)
   */
  findLongestCommonSequence(): Edit | null {
    if (!this.scanA()) {
      return null;
    }

    this.lcs = new Edit(0, 0, 0, 0);
    this.cnt = this.maxChainLength + 1;

    for (let bPtr = this.region.beginB; bPtr < this.region.endB; ) {
      bPtr = this.tryLongestCommonSequence(bPtr);
    }

    return this.hasCommon && this.maxChainLength < this.cnt ? null : this.lcs;
  }

  /**
   * Scan sequence A backwards, building the histogram.
   *
   * Going in reverse places the earliest occurrence of any element at the
   * start of the chain, so we consider earlier matches before later matches.
   *
   * @returns true if scan completed, false if maxChainLength was exceeded
   */
  private scanA(): boolean {
    for (let ptr = this.region.endA - 1; ptr >= this.region.beginA; ptr--) {
      const tIdx = this.hash(this.a, ptr);

      let chainLen = 0;
      let rIdx = this.table[tIdx];
      let foundMatch = false;

      while (rIdx !== 0) {
        const rec = this.recs[rIdx];
        if (this.cmp.equals(this.a, recPtr(rec), this.a, ptr)) {
          // ptr is identical to another element. Insert it onto
          // the front of the existing element chain.
          let newCnt = recCnt(rec) + 1;
          if (newCnt > MAX_CNT) {
            newCnt = MAX_CNT;
          }
          this.recs[rIdx] = recCreate(recNext(rec), ptr, newCnt);
          this.next[ptr - this.ptrShift] = recPtr(rec);
          this.recIdx[ptr - this.ptrShift] = rIdx;
          foundMatch = true;
          break;
        }

        rIdx = recNext(rec);
        chainLen++;
      }

      if (foundMatch) {
        continue;
      }

      if (chainLen === this.maxChainLength) {
        return false;
      }

      // This is the first time we have ever seen this particular
      // element in the sequence. Construct a new chain for it.
      const newRIdx = ++this.recCnt;
      if (newRIdx >= this.recs.length) {
        const newSize = Math.min(this.recs.length * 2, 1 + this.region.getLengthA());
        const newRecs = new BigInt64Array(newSize);
        newRecs.set(this.recs);
        this.recs = newRecs;
      }

      this.recs[newRIdx] = recCreate(this.table[tIdx], ptr, 1);
      this.recIdx[ptr - this.ptrShift] = newRIdx;
      this.table[tIdx] = newRIdx;
    }
    return true;
  }

  /**
   * Try to find the longest common sequence starting at position bPtr in B.
   *
   * @param bPtr Starting position in sequence B
   * @returns Next position in B to consider
   */
  private tryLongestCommonSequence(bPtr: number): number {
    let bNext = bPtr + 1;
    let rIdx = this.table[this.hash(this.b, bPtr)];

    while (rIdx !== 0) {
      const rec = this.recs[rIdx];

      // If there are more occurrences in A, don't use this chain.
      if (recCnt(rec) > this.cnt) {
        if (!this.hasCommon) {
          this.hasCommon = this.cmp.equals(this.a, recPtr(rec), this.b, bPtr);
        }
        rIdx = recNext(rec);
        continue;
      }

      let as = recPtr(rec);
      if (!this.cmp.equals(this.a, as, this.b, bPtr)) {
        rIdx = recNext(rec);
        continue;
      }

      this.hasCommon = true;

      // Try all locations of this element in A
      while (true) {
        let np = this.next[as - this.ptrShift];
        let bs = bPtr;
        let ae = as + 1;
        let be = bs + 1;
        let rc = recCnt(rec);

        // Extend backwards
        while (
          this.region.beginA < as &&
          this.region.beginB < bs &&
          this.cmp.equals(this.a, as - 1, this.b, bs - 1)
        ) {
          as--;
          bs--;
          if (rc > 1) {
            rc = Math.min(rc, recCnt(this.recs[this.recIdx[as - this.ptrShift]]));
          }
        }

        // Extend forwards
        while (
          ae < this.region.endA &&
          be < this.region.endB &&
          this.cmp.equals(this.a, ae, this.b, be)
        ) {
          if (rc > 1) {
            rc = Math.min(rc, recCnt(this.recs[this.recIdx[ae - this.ptrShift]]));
          }
          ae++;
          be++;
        }

        if (bNext < be) {
          bNext = be;
        }

        if (this.lcs.getLengthA() < ae - as || rc < this.cnt) {
          // If this region is the longest, or there are fewer
          // occurrences of it in A, it's now our LCS.
          this.lcs.beginA = as;
          this.lcs.beginB = bs;
          this.lcs.endA = ae;
          this.lcs.endB = be;
          this.cnt = rc;
        }

        // Because we added elements in reverse order, index 0
        // cannot possibly be the next position. It's the first
        // element of the sequence and thus would have been the
        // value of as at the start of the TRY_LOCATIONS loop.
        if (np === 0) {
          break;
        }

        // Skip locations that were within the LCS we just examined
        while (np < ae) {
          np = this.next[np - this.ptrShift];
          if (np === 0) {
            break;
          }
        }

        if (np === 0) {
          break;
        }

        as = np;
      }

      rIdx = recNext(rec);
    }

    return bNext;
  }

  /**
   * Compute hash table index for an element.
   *
   * @param s Sequence containing the element
   * @param idx Index of the element
   * @returns Hash table index
   */
  private hash(s: HashedSequence<S>, idx: number): number {
    // Mix bits using golden ratio prime, then shift to table index
    return ((this.cmp.hash(s, idx) * 0x9e370001) >>> 0) >>> this.keyShift;
  }
}

/**
 * Create a packed record from its components.
 *
 * @param next Index of next record in hash chain
 * @param ptr Index of first element position
 * @param cnt Occurrence count
 * @returns Packed 64-bit record
 */
function recCreate(next: number, ptr: number, cnt: number): bigint {
  return (BigInt(next) << REC_NEXT_SHIFT) | (BigInt(ptr) << REC_PTR_SHIFT) | BigInt(cnt);
}

/**
 * Extract next record index from a packed record.
 *
 * @param rec Packed record
 * @returns Next record index
 */
function recNext(rec: bigint): number {
  return Number(rec >> REC_NEXT_SHIFT);
}

/**
 * Extract element pointer from a packed record.
 *
 * @param rec Packed record
 * @returns Element position
 */
function recPtr(rec: bigint): number {
  return Number((rec >> REC_PTR_SHIFT) & REC_PTR_MASK);
}

/**
 * Extract occurrence count from a packed record.
 *
 * @param rec Packed record
 * @returns Occurrence count
 */
function recCnt(rec: bigint): number {
  return Number(rec & REC_CNT_MASK);
}

/**
 * Calculate the number of bits needed for a hash table of the given size.
 *
 * @param sz Size of the sequence
 * @returns Number of bits for the hash table
 */
function calculateTableBits(sz: number): number {
  if (sz <= 0) {
    return 1;
  }
  let bits = 31 - Math.clz32(sz);
  if (bits === 0) {
    bits = 1;
  }
  if (1 << bits < sz) {
    bits++;
  }
  return bits;
}
