/**
 * Arbitrary sequence of elements.
 *
 * A sequence of elements is defined to contain elements in the index range
 * [0, size()), like a standard JavaScript Array.
 * Unlike an Array, the members of the sequence are not directly obtainable.
 *
 * Implementations of Sequence are primarily intended for use in content
 * difference detection algorithms, to produce an EditList of Edit instances
 * describing how two Sequence instances differ.
 *
 * To be compared against another Sequence of the same type, a supporting
 * SequenceComparator must also be supplied.
 */
export abstract class Sequence {
  /**
   * Get the total number of items in the sequence.
   * @returns Total number of items in the sequence
   */
  abstract size(): number;
}

/**
 * Comparison function for sequences.
 *
 * @template S The type of sequence being compared
 */
export interface SequenceComparator<S extends Sequence> {
  /**
   * Compare two items to determine if they are equal.
   *
   * @param a First sequence
   * @param ai Index of item in first sequence
   * @param b Second sequence
   * @param bi Index of item in second sequence
   * @returns true if the elements are equal
   */
  equals(a: S, ai: number, b: S, bi: number): boolean;

  /**
   * Get the hash code for an item in a sequence.
   *
   * @param seq Sequence
   * @param index Index of item
   * @returns Hash code for the item
   */
  hash(seq: S, index: number): number;
}
