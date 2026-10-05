import { Sequence, type SequenceComparator } from "./sequence.js";

/**
 * Wraps a Sequence to assign hash codes to elements.
 *
 * This sequence acts as a proxy for the real sequence, caching element hash
 * codes so they don't need to be recomputed each time. Sequences of this type
 * must be used with a HashedSequenceComparator.
 *
 * @template S The base sequence type
 */
export class HashedSequence<S extends Sequence> extends Sequence {
  /** The base sequence */
  readonly base: S;

  /** Cached hash codes for each element */
  readonly hashes: number[];

  /**
   * Create a new hashed sequence.
   *
   * @param base The base sequence
   * @param hashes The cached hash codes
   */
  constructor(base: S, hashes: number[]) {
    super();
    this.base = base;
    this.hashes = hashes;
  }

  /**
   * Get the size of the sequence.
   *
   * @returns Size of the sequence
   */
  size(): number {
    return this.base.size();
  }
}

/**
 * Wrap another comparator for use with HashedSequence.
 *
 * This comparator acts as a proxy for the real comparator, evaluating the
 * cached hash code before testing the underlying comparator's equality.
 *
 * @template S The base sequence type
 */
export class HashedSequenceComparator<S extends Sequence>
  implements SequenceComparator<HashedSequence<S>>
{
  /** The base comparator */
  private readonly cmp: SequenceComparator<S>;

  /**
   * Create a new hashed sequence comparator.
   *
   * @param cmp The base comparator
   */
  constructor(cmp: SequenceComparator<S>) {
    this.cmp = cmp;
  }

  /**
   * Compare two items to determine if they are equal.
   *
   * @param a First sequence
   * @param ai Index in first sequence
   * @param b Second sequence
   * @param bi Index in second sequence
   * @returns true if the elements are equal
   */
  equals(a: HashedSequence<S>, ai: number, b: HashedSequence<S>, bi: number): boolean {
    return a.hashes[ai] === b.hashes[bi] && this.cmp.equals(a.base, ai, b.base, bi);
  }

  /**
   * Get the hash code for an item.
   *
   * @param seq The sequence
   * @param ptr Index in the sequence
   * @returns Hash code
   */
  hash(seq: HashedSequence<S>, ptr: number): number {
    return seq.hashes[ptr];
  }
}

/**
 * Wraps two Sequences to cache their element hash codes.
 *
 * @template S The base sequence type
 */
export class HashedSequencePair<S extends Sequence> {
  private readonly cmp: SequenceComparator<S>;
  private readonly baseA: S;
  private readonly baseB: S;
  private cachedA?: HashedSequence<S>;
  private cachedB?: HashedSequence<S>;

  /**
   * Construct a pair to provide fast hash codes.
   *
   * @param cmp The base comparator for the sequence elements
   * @param a The A sequence
   * @param b The B sequence
   */
  constructor(cmp: SequenceComparator<S>, a: S, b: S) {
    this.cmp = cmp;
    this.baseA = a;
    this.baseB = b;
  }

  /**
   * Get a comparator that uses the cached hash codes.
   *
   * @returns Hashed sequence comparator
   */
  getComparator(): HashedSequenceComparator<S> {
    return new HashedSequenceComparator(this.cmp);
  }

  /**
   * Get wrapper around A that includes cached hash codes.
   *
   * @returns Hashed sequence A
   */
  getA(): HashedSequence<S> {
    if (!this.cachedA) {
      this.cachedA = this.wrap(this.baseA);
    }
    return this.cachedA;
  }

  /**
   * Get wrapper around B that includes cached hash codes.
   *
   * @returns Hashed sequence B
   */
  getB(): HashedSequence<S> {
    if (!this.cachedB) {
      this.cachedB = this.wrap(this.baseB);
    }
    return this.cachedB;
  }

  /**
   * Wrap a base sequence with hash codes.
   *
   * @param base The base sequence
   * @returns Hashed sequence
   */
  private wrap(base: S): HashedSequence<S> {
    const end = base.size();
    const hashes = new Array<number>(end);
    for (let ptr = 0; ptr < end; ptr++) {
      hashes[ptr] = this.cmp.hash(base, ptr);
    }
    return new HashedSequence(base, hashes);
  }
}
