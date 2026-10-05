/**
 * Diff algorithm abstraction and factory.
 *
 * This module provides a unified interface for diff algorithms and a factory
 * for selecting between Myers and Histogram algorithms.
 *
 * @example
 * ```typescript
 * import { getAlgorithm, SupportedAlgorithm, DEFAULT_ALGORITHM } from "./diff-algorithm.js";
 * import { RawTextComparator } from "./raw-text-comparator.js";
 *
 * // Use default algorithm (histogram)
 * const diff = getAlgorithm(DEFAULT_ALGORITHM);
 * const edits = diff(RawTextComparator.DEFAULT, oldText, newText);
 *
 * // Use specific algorithm
 * const myersDiff = getAlgorithm(SupportedAlgorithm.MYERS);
 * const histogramDiff = getAlgorithm(SupportedAlgorithm.HISTOGRAM);
 * ```
 *
 * @module
 */

import type { EditList } from "./edit.js";
import { HistogramDiff } from "./histogram-diff.js";
import { MyersDiff } from "./myers-diff.js";
import type { Sequence, SequenceComparator } from "./sequence.js";

/**
 * Supported diff algorithms.
 *
 * Both algorithms produce correct minimal edit lists, but they may produce
 * different results for the same input due to tie-breaking differences.
 *
 * - **MYERS**: Classic O(ND) algorithm by Eugene Myers. Produces minimal diffs
 *   but may not align well with logical code blocks.
 *
 * - **HISTOGRAM**: Extended Patience algorithm (as implemented in JGit).
 *   Produces more readable diffs by preferring unique lines as anchors.
 *   Falls back to Myers when there are too many duplicate lines.
 */
export enum SupportedAlgorithm {
  /** Myers O(ND) algorithm - produces minimal diffs */
  MYERS = "myers",
  /** Histogram algorithm (extended Patience) - produces readable diffs */
  HISTOGRAM = "histogram",
}

/**
 * Diff algorithm function type.
 *
 * Compare two sequences and produce an edit list describing how to transform
 * sequence A into sequence B.
 *
 * @typeParam S - The sequence type being compared
 * @param cmp - Comparator providing element equality and hashing
 * @param a - The first (old/pre-image) sequence
 * @param b - The second (new/post-image) sequence
 * @returns Edit list describing the differences
 */
export type DiffAlgorithm = <S extends Sequence>(
  cmp: SequenceComparator<S>,
  a: S,
  b: S,
) => EditList;

/**
 * Get a diff algorithm implementation.
 *
 * @param alg - The algorithm to use
 * @returns A function that performs the diff operation
 * @throws Error if an unknown algorithm is specified
 *
 * @example
 * ```typescript
 * const diff = getAlgorithm(SupportedAlgorithm.HISTOGRAM);
 * const edits = diff(RawTextComparator.DEFAULT, oldText, newText);
 * ```
 */
export function getAlgorithm(alg: SupportedAlgorithm): DiffAlgorithm {
  switch (alg) {
    case SupportedAlgorithm.MYERS:
      return MyersDiff.diff;
    case SupportedAlgorithm.HISTOGRAM:
      return HistogramDiff.diff;
    default:
      throw new Error(`Unknown diff algorithm: ${alg}`);
  }
}

/**
 * The default diff algorithm.
 *
 * Histogram is the default because it generally produces more readable diffs,
 * especially for code changes. It aligns better with logical code blocks
 * by preferring unique lines as anchors.
 */
export const DEFAULT_ALGORITHM = SupportedAlgorithm.HISTOGRAM;
