import { Edit, type EditList, EditType } from "./edit.js";
import {
  type HashedSequence,
  type HashedSequenceComparator,
  HashedSequencePair,
} from "./hashed-sequence.js";
import { HistogramDiffIndex } from "./histogram-diff-index.js";
import { MyersDiff } from "./myers-diff.js";
import { Sequence, type SequenceComparator } from "./sequence.js";

/**
 * Type for diff algorithm function.
 */
export type DiffAlgorithmFn<S extends Sequence> = (
  cmp: SequenceComparator<S>,
  a: S,
  b: S,
) => EditList;

/**
 * An extended form of Bram Cohen's patience diff algorithm.
 *
 * This implementation was derived by using the 4 rules outlined in
 * Bram Cohen's patience diff blog post, and then was further extended
 * to support low-occurrence common elements.
 *
 * The basic idea of the algorithm is to create a histogram of occurrences for
 * each element of sequence A. Each element of sequence B is then considered in
 * turn. If the element also exists in sequence A, and has a lower occurrence
 * count, the positions are considered as a candidate for the longest common
 * subsequence (LCS). After scanning of B is complete the LCS that has the
 * lowest number of occurrences is chosen as a split point. The region is split
 * around the LCS, and the algorithm is recursively applied to the sections
 * before and after the LCS.
 *
 * By always selecting a LCS position with the lowest occurrence count, this
 * algorithm behaves exactly like Bram Cohen's patience diff whenever there is a
 * unique common element available between the two sequences. When no unique
 * elements exist, the lowest occurrence element is chosen instead. This offers
 * more readable diffs than simply falling back on the standard Myers' O(ND)
 * algorithm would produce.
 *
 * To prevent the algorithm from having an O(N^2) running time, an upper limit
 * on the number of unique elements in a histogram bucket is configured by
 * {@link setMaxChainLength}. If sequence A has more than this many elements
 * that hash into the same hash bucket, the algorithm passes the region to
 * the fallback algorithm. If no fallback algorithm is configured, the region
 * is emitted as a replace edit.
 *
 * So long as maxChainLength is a small constant (such as 64), the algorithm
 * runs in O(N * D) time, where N is the sum of the input lengths and D is
 * the number of edits in the resulting EditList.
 *
 * This implementation has an internal limitation that prevents it from handling
 * sequences with more than 268,435,456 (2^28) elements.
 *
 * @template S The sequence type
 */
export class HistogramDiff<_S extends Sequence> {
  /**
   * Default maximum chain length for hash buckets.
   */
  static readonly DEFAULT_MAX_CHAIN_LENGTH = 64;

  /**
   * Compute the differences between two sequences using the histogram algorithm.
   *
   * @param cmp The comparator for sequence elements
   * @param a The first sequence (old)
   * @param b The second sequence (new)
   * @param options Optional configuration
   * @returns List of edits
   */
  static diff<S extends Sequence>(
    cmp: SequenceComparator<S>,
    a: S,
    b: S,
    options?: {
      maxChainLength?: number;
      fallback?: DiffAlgorithmFn<S> | null;
    },
  ): EditList {
    const pair = new HashedSequencePair(cmp, a, b);
    const hc = pair.getComparator();
    const ha = pair.getA();
    const hb = pair.getB();

    const state = new DiffState(
      hc,
      ha,
      hb,
      cmp,
      a,
      b,
      options?.maxChainLength ?? HistogramDiff.DEFAULT_MAX_CHAIN_LENGTH,
      options?.fallback === undefined ? MyersDiff.diff : options.fallback,
    );

    const region = new Edit(0, a.size(), 0, b.size());
    state.diffRegion(region);

    // Normalize edits to shift them to consistent locations
    return HistogramDiff.normalize(cmp, state.edits, a, b);
  }

  /**
   * Normalize an EditList to shift INSERT and DELETE edits to consistent locations.
   * This implementation shifts such edits to their latest possible location.
   *
   * @param cmp The comparator supplying the element equivalence function
   * @param e A modifiable edit list comparing the provided sequences
   * @param a The first (old) sequence
   * @param b The second (new) sequence
   * @returns The normalized edit list
   */
  private static normalize<S extends Sequence>(
    cmp: SequenceComparator<S>,
    e: EditList,
    a: S,
    b: S,
  ): EditList {
    let prev: Edit | null = null;
    for (let i = e.length - 1; i >= 0; i--) {
      const cur = e[i];
      const curType = cur.getType();

      const maxA = prev === null ? a.size() : prev.beginA;
      const maxB = prev === null ? b.size() : prev.beginB;

      if (curType === EditType.INSERT) {
        // Shift INSERT edits forward as much as possible
        while (cur.endA < maxA && cur.endB < maxB && cmp.equals(b, cur.beginB, b, cur.endB)) {
          cur.shift(1);
        }
      } else if (curType === EditType.DELETE) {
        // Shift DELETE edits forward as much as possible
        while (cur.endA < maxA && cur.endB < maxB && cmp.equals(a, cur.beginA, a, cur.endA)) {
          cur.shift(1);
        }
      }
      prev = cur;
    }
    return e;
  }
}

/**
 * Internal state for the histogram diff algorithm.
 * Uses an iterative approach with a work queue to avoid stack overflow.
 */
class DiffState<S extends Sequence> {
  /** Comparator for hashed sequences */
  private readonly cmp: HashedSequenceComparator<S>;

  /** First sequence (hashed) */
  private readonly a: HashedSequence<S>;

  /** Second sequence (hashed) */
  private readonly b: HashedSequence<S>;

  /** Original comparator */
  private readonly baseCmp: SequenceComparator<S>;

  /** Original first sequence */
  private readonly baseA: S;

  /** Original second sequence */
  private readonly baseB: S;

  /** Maximum chain length before fallback */
  private readonly maxChainLength: number;

  /** Fallback algorithm when chain length exceeded */
  private readonly fallback: DiffAlgorithmFn<S> | null;

  /** Work queue (LIFO for depth-first processing) */
  private readonly queue: Edit[] = [];

  /** Result edits */
  readonly edits: EditList = [];

  constructor(
    cmp: HashedSequenceComparator<S>,
    a: HashedSequence<S>,
    b: HashedSequence<S>,
    baseCmp: SequenceComparator<S>,
    baseA: S,
    baseB: S,
    maxChainLength: number,
    fallback: DiffAlgorithmFn<S> | null,
  ) {
    this.cmp = cmp;
    this.a = a;
    this.b = b;
    this.baseCmp = baseCmp;
    this.baseA = baseA;
    this.baseB = baseB;
    this.maxChainLength = maxChainLength;
    this.fallback = fallback;
  }

  /**
   * Diff a region, processing the work queue iteratively.
   */
  diffRegion(region: Edit): void {
    // First, strip common prefix and suffix
    const stripped = this.stripCommonPrefixSuffix(region);

    if (stripped.isEmpty()) {
      // Nothing to diff
      return;
    }

    this.diffReplace(stripped);

    // Process work queue iteratively
    while (this.queue.length > 0) {
      const r = this.queue.pop()!;
      this.diff(r);
    }

    // Sort edits by position
    this.edits.sort((a, b) => {
      if (a.beginA !== b.beginA) {
        return a.beginA - b.beginA;
      }
      return a.beginB - b.beginB;
    });
  }

  /**
   * Strip common prefix and suffix from a region.
   */
  private stripCommonPrefixSuffix(region: Edit): Edit {
    let beginA = region.beginA;
    let beginB = region.beginB;
    let endA = region.endA;
    let endB = region.endB;

    // Strip common prefix
    while (beginA < endA && beginB < endB && this.cmp.equals(this.a, beginA, this.b, beginB)) {
      beginA++;
      beginB++;
    }

    // Strip common suffix
    while (beginA < endA && beginB < endB && this.cmp.equals(this.a, endA - 1, this.b, endB - 1)) {
      endA--;
      endB--;
    }

    return new Edit(beginA, endA, beginB, endB);
  }

  /**
   * Handle a replace region by finding LCS and splitting.
   */
  private diffReplace(r: Edit): void {
    const index = new HistogramDiffIndex(this.maxChainLength, this.cmp, this.a, this.b, r);
    const lcs = index.findLongestCommonSequence();

    if (lcs !== null) {
      // LCS found
      if (lcs.isEmpty()) {
        // No common elements, emit as REPLACE
        this.edits.push(r);
      } else {
        // Split around LCS and add to queue (LIFO order)
        // Add "after" first so "before" is processed first
        const after = r.after(lcs);
        const before = r.before(lcs);

        if (!after.isEmpty()) {
          this.queue.push(after);
        }
        if (!before.isEmpty()) {
          this.queue.push(before);
        }
      }
    } else {
      // Chain length exceeded, use fallback
      if (this.fallback !== null) {
        // Create subsequences for the region
        const subEdits = this.diffSubsequence(r);
        this.edits.push(...subEdits);
      } else {
        // No fallback, emit as REPLACE
        this.edits.push(r);
      }
    }
  }

  /**
   * Diff a subsequence using the fallback algorithm.
   */
  private diffSubsequence(r: Edit): EditList {
    // Create a wrapper to diff just the region
    const subA = new SubsequenceWrapper(this.baseA, r.beginA, r.endA);
    const subB = new SubsequenceWrapper(this.baseB, r.beginB, r.endB);
    const subCmp = new SubsequenceComparator(this.baseCmp);

    // Use type assertions to satisfy TypeScript - the wrapper pattern requires this
    // since the comparator works with SubsequenceWrapper<S> internally but the
    // fallback algorithm signature expects S
    const subEdits =
      this.fallback?.(
        subCmp as unknown as SequenceComparator<S>,
        subA as unknown as S,
        subB as unknown as S,
      ) ?? [];

    // Adjust edit positions to original coordinates
    return subEdits.map(
      (e) =>
        new Edit(e.beginA + r.beginA, e.endA + r.beginA, e.beginB + r.beginB, e.endB + r.beginB),
    );
  }

  /**
   * Process an edit from the work queue.
   */
  private diff(r: Edit): void {
    const type = r.getType();

    switch (type) {
      case EditType.INSERT:
      case EditType.DELETE:
        // Pure inserts/deletes can be added directly
        this.edits.push(r);
        break;

      case EditType.REPLACE:
        // For single-element replaces, add directly
        if (r.getLengthA() === 1 && r.getLengthB() === 1) {
          this.edits.push(r);
        } else {
          // Strip common prefix/suffix and continue diffing
          const stripped = this.stripCommonPrefixSuffix(r);
          if (!stripped.isEmpty()) {
            this.diffReplace(stripped);
          }
        }
        break;

      case EditType.EMPTY:
        // Empty edits should not be in the queue
        break;
    }
  }
}

/**
 * Wrapper to create a subsequence view of a sequence.
 */
class SubsequenceWrapper<S extends Sequence> extends Sequence {
  constructor(
    private readonly base: S,
    private readonly offset: number,
    private readonly end: number,
  ) {
    super();
  }

  size(): number {
    return this.end - this.offset;
  }

  getBase(): S {
    return this.base;
  }

  getOffset(): number {
    return this.offset;
  }
}

/**
 * Comparator that works with subsequence wrappers.
 */
class SubsequenceComparator<S extends Sequence>
  implements SequenceComparator<SubsequenceWrapper<S>>
{
  constructor(private readonly base: SequenceComparator<S>) {}

  equals(a: SubsequenceWrapper<S>, ai: number, b: SubsequenceWrapper<S>, bi: number): boolean {
    return this.base.equals(a.getBase(), ai + a.getOffset(), b.getBase(), bi + b.getOffset());
  }

  hash(seq: SubsequenceWrapper<S>, index: number): number {
    return this.base.hash(seq.getBase(), index + seq.getOffset());
  }
}
