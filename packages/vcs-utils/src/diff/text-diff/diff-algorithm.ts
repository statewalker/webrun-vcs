/**
 * Names of git's line diff algorithms, as `diff.algorithm` spells them.
 *
 * @example
 * ```typescript
 * xdiff(a, b, { algorithm: SupportedAlgorithm.HISTOGRAM });
 * ```
 *
 * All diffs run on the xdiff port ({@link xdiff}); this enum names the two most common of its
 * algorithms (`XdiffAlgorithm` names all four: myers, minimal, patience, histogram).
 *
 * @module
 */

/**
 * Supported diff algorithms.
 *
 * - **MYERS**: git's default, Myers' O(ND) algorithm with xdiff's heuristics.
 * - **HISTOGRAM**: git's histogram diff (an extended patience diff).
 */
export enum SupportedAlgorithm {
  /** Myers O(ND) algorithm, git's default */
  MYERS = "myers",
  /** Histogram algorithm (extended Patience) */
  HISTOGRAM = "histogram",
}
