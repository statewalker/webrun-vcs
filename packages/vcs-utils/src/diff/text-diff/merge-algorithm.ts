/**
 * Three-way merge algorithm for text content.
 *
 * Based on JGit's MergeAlgorithm, this provides text-level merging
 * capabilities for resolving file conflicts with different strategies.
 *
 * The merge algorithm takes three inputs:
 * - base: The common ancestor version
 * - ours: Our version (typically HEAD)
 * - theirs: Their version (typically the branch being merged)
 *
 * @module
 */

import {
  DEFAULT_ALGORITHM,
  type DiffAlgorithm,
  getAlgorithm,
  type SupportedAlgorithm,
} from "./diff-algorithm.js";
import type { Edit, EditList } from "./edit.js";
import { RawText } from "./raw-text.js";
import { RawTextComparator } from "./raw-text-comparator.js";

/**
 * Content merge strategy for resolving conflicts.
 *
 * This enum mirrors the ContentMergeStrategy in the commands package
 * to avoid circular dependencies.
 */
export enum MergeContentStrategy {
  /** Take our version for conflicts */
  OURS = "ours",
  /** Take their version for conflicts */
  THEIRS = "theirs",
  /** Perform union merge (concatenate both sides) */
  UNION = "union",
}

/**
 * Result of a three-way merge operation.
 */
export interface MergeResult {
  /** The merged content */
  content: Uint8Array;
  /** Whether there were conflicts (when not using auto-resolve strategy) */
  hasConflicts: boolean;
  /** List of conflict regions (line ranges in merged output) */
  conflictRegions: ConflictRegion[];
}

/**
 * A region of conflict in the merged output.
 */
export interface ConflictRegion {
  /** Start line in merged output (0-indexed) */
  startLine: number;
  /** End line in merged output (0-indexed, exclusive) */
  endLine: number;
  /** Start line in base */
  baseStartLine: number;
  /** End line in base */
  baseEndLine: number;
  /** Start line in ours */
  oursStartLine: number;
  /** End line in ours */
  oursEndLine: number;
  /** Start line in theirs */
  theirsStartLine: number;
  /** End line in theirs */
  theirsEndLine: number;
}

/**
 * A chunk in the merge process.
 */
interface MergeChunk {
  /** Type of chunk: common, ours-only, theirs-only, or conflict */
  type: "common" | "ours" | "theirs" | "conflict";
  /** Lines from base (for common/conflict) */
  baseStart: number;
  baseEnd: number;
  /** Lines from ours */
  oursStart: number;
  oursEnd: number;
  /** Lines from theirs */
  theirsStart: number;
  theirsEnd: number;
}

/**
 * Options for the merge operation.
 */
export interface MergeOptions {
  /** Strategy for resolving conflicts */
  strategy?: MergeContentStrategy;
  /** Diff algorithm to use (default: histogram) */
  algorithm?: SupportedAlgorithm;
}

/**
 * Three-way merge algorithm.
 *
 * Merges two versions against a common base, identifying conflicts
 * and resolving them based on the specified strategy.
 */
export class MergeAlgorithm {
  private comparator: RawTextComparator;
  private diffAlgorithm: DiffAlgorithm;

  /**
   * Create a new merge algorithm instance.
   *
   * @param algorithm The diff algorithm to use (default: histogram)
   */
  constructor(algorithm?: SupportedAlgorithm) {
    this.comparator = RawTextComparator.DEFAULT;
    this.diffAlgorithm = getAlgorithm(algorithm ?? DEFAULT_ALGORITHM);
  }

  /**
   * Perform a three-way merge.
   *
   * @param base The common ancestor content
   * @param ours Our version of the content
   * @param theirs Their version of the content
   * @param strategyOrOptions Strategy or options for the merge
   * @returns Merge result with merged content and conflict information
   */
  merge(
    base: Uint8Array | string,
    ours: Uint8Array | string,
    theirs: Uint8Array | string,
    strategyOrOptions?: MergeContentStrategy | MergeOptions,
  ): MergeResult {
    // Handle both old API (strategy only) and new API (options object)
    const options: MergeOptions =
      typeof strategyOrOptions === "string"
        ? { strategy: strategyOrOptions }
        : (strategyOrOptions ?? {});

    const baseText = new RawText(base);
    const oursText = new RawText(ours);
    const theirsText = new RawText(theirs);

    // Use algorithm from options, or fall back to instance algorithm
    const diff = options.algorithm ? getAlgorithm(options.algorithm) : this.diffAlgorithm;

    // Get diffs between base-ours and base-theirs
    const oursEdits = diff(this.comparator, baseText, oursText);
    const theirsEdits = diff(this.comparator, baseText, theirsText);

    // Build merge chunks by combining the edits
    const chunks = this.buildMergeChunks(baseText, oursText, theirsText, oursEdits, theirsEdits);

    // Resolve chunks to produce output
    return this.resolveChunks(baseText, oursText, theirsText, chunks, options.strategy);
  }

  /**
   * Check if two edit regions overlap in base.
   * Two edits overlap if they touch the same region in base, including
   * point insertions at the same position.
   */
  private editsOverlap(edit1: Edit, edit2: Edit): boolean {
    // Handle point insertions (where beginA == endA)
    // Two point insertions at the same position overlap
    if (edit1.beginA === edit1.endA && edit2.beginA === edit2.endA) {
      return edit1.beginA === edit2.beginA;
    }

    // One is point insertion, other is range
    if (edit1.beginA === edit1.endA) {
      // edit1 is insertion at edit1.beginA
      // It overlaps with edit2 if the insertion point is within edit2's range
      return edit1.beginA >= edit2.beginA && edit1.beginA <= edit2.endA;
    }

    if (edit2.beginA === edit2.endA) {
      // edit2 is insertion at edit2.beginA
      return edit2.beginA >= edit1.beginA && edit2.beginA <= edit1.endA;
    }

    // Both are ranges - standard overlap check
    return edit1.beginA < edit2.endA && edit2.beginA < edit1.endA;
  }

  /**
   * Build merge chunks by combining edits from both sides.
   *
   * This identifies regions that are:
   * - Common (unchanged in both)
   * - Changed only by ours
   * - Changed only by theirs
   * - Changed by both (conflict if different changes)
   */
  private buildMergeChunks(
    base: RawText,
    ours: RawText,
    theirs: RawText,
    oursEdits: EditList,
    theirsEdits: EditList,
  ): MergeChunk[] {
    const chunks: MergeChunk[] = [];

    // Pointers into base, ours, theirs
    let basePtr = 0;
    let oursPtr = 0;
    let theirsPtr = 0;

    // Edit list pointers
    let oursIdx = 0;
    let theirsIdx = 0;

    while (basePtr < base.size() || oursIdx < oursEdits.length || theirsIdx < theirsEdits.length) {
      // Get current edits if any
      const oursEdit = oursIdx < oursEdits.length ? oursEdits[oursIdx] : null;
      const theirsEdit = theirsIdx < theirsEdits.length ? theirsEdits[theirsIdx] : null;

      // Find the next event position in base
      const nextOurs = oursEdit ? oursEdit.beginA : base.size();
      const nextTheirs = theirsEdit ? theirsEdit.beginA : base.size();
      const nextBase = Math.min(nextOurs, nextTheirs);

      // If we're before any edits, emit common region
      if (basePtr < nextBase) {
        const commonLen = nextBase - basePtr;
        chunks.push({
          type: "common",
          baseStart: basePtr,
          baseEnd: nextBase,
          oursStart: oursPtr,
          oursEnd: oursPtr + commonLen,
          theirsStart: theirsPtr,
          theirsEnd: theirsPtr + commonLen,
        });
        basePtr = nextBase;
        oursPtr += commonLen;
        theirsPtr += commonLen;
        continue;
      }

      // Now we're at an edit point
      // Check if edits overlap (conflict potential)
      if (oursEdit && theirsEdit && this.editsOverlap(oursEdit, theirsEdit)) {
        // Overlapping edits - determine if they conflict
        const mergedBaseStart = Math.min(oursEdit.beginA, theirsEdit.beginA);
        const mergedBaseEnd = Math.max(oursEdit.endA, theirsEdit.endA);

        // Check if the changes are identical
        const isIdentical = this.areRegionsIdentical(
          ours,
          oursEdit.beginB,
          oursEdit.endB,
          theirs,
          theirsEdit.beginB,
          theirsEdit.endB,
        );

        if (isIdentical) {
          // Same change on both sides - not a conflict, use ours
          chunks.push({
            type: "ours",
            baseStart: mergedBaseStart,
            baseEnd: mergedBaseEnd,
            oursStart: oursEdit.beginB,
            oursEnd: oursEdit.endB,
            theirsStart: theirsEdit.beginB,
            theirsEnd: theirsEdit.endB,
          });
        } else {
          // Different changes - conflict
          chunks.push({
            type: "conflict",
            baseStart: mergedBaseStart,
            baseEnd: mergedBaseEnd,
            oursStart: oursEdit.beginB,
            oursEnd: oursEdit.endB,
            theirsStart: theirsEdit.beginB,
            theirsEnd: theirsEdit.endB,
          });
        }

        // Advance pointers
        basePtr = mergedBaseEnd;
        // Calculate how much ours and theirs moved past their edits
        oursPtr = oursEdit.endB + (mergedBaseEnd - oursEdit.endA);
        theirsPtr = theirsEdit.endB + (mergedBaseEnd - theirsEdit.endA);

        // Move past consumed edits
        oursIdx++;
        theirsIdx++;
        continue;
      }

      // Non-overlapping edit - take whichever comes first
      if (oursEdit && (!theirsEdit || oursEdit.beginA <= theirsEdit.beginA)) {
        // Ours edit only
        chunks.push({
          type: "ours",
          baseStart: oursEdit.beginA,
          baseEnd: oursEdit.endA,
          oursStart: oursEdit.beginB,
          oursEnd: oursEdit.endB,
          theirsStart: theirsPtr,
          theirsEnd: theirsPtr + (oursEdit.endA - oursEdit.beginA),
        });

        basePtr = oursEdit.endA;
        oursPtr = oursEdit.endB;
        theirsPtr += oursEdit.endA - oursEdit.beginA;
        oursIdx++;
      } else if (theirsEdit) {
        // Theirs edit only
        chunks.push({
          type: "theirs",
          baseStart: theirsEdit.beginA,
          baseEnd: theirsEdit.endA,
          oursStart: oursPtr,
          oursEnd: oursPtr + (theirsEdit.endA - theirsEdit.beginA),
          theirsStart: theirsEdit.beginB,
          theirsEnd: theirsEdit.endB,
        });

        basePtr = theirsEdit.endA;
        oursPtr += theirsEdit.endA - theirsEdit.beginA;
        theirsPtr = theirsEdit.endB;
        theirsIdx++;
      }
    }

    // Handle remaining common region
    if (basePtr < base.size()) {
      const remaining = base.size() - basePtr;
      chunks.push({
        type: "common",
        baseStart: basePtr,
        baseEnd: base.size(),
        oursStart: oursPtr,
        oursEnd: oursPtr + remaining,
        theirsStart: theirsPtr,
        theirsEnd: theirsPtr + remaining,
      });
    }

    return chunks;
  }

  /**
   * Check if two regions in different texts are identical.
   */
  private areRegionsIdentical(
    text1: RawText,
    start1: number,
    end1: number,
    text2: RawText,
    start2: number,
    end2: number,
  ): boolean {
    const len1 = end1 - start1;
    const len2 = end2 - start2;

    if (len1 !== len2) return false;

    for (let i = 0; i < len1; i++) {
      if (!this.comparator.equals(text1, start1 + i, text2, start2 + i)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Resolve merge chunks to produce output content.
   */
  private resolveChunks(
    _base: RawText,
    ours: RawText,
    theirs: RawText,
    chunks: MergeChunk[],
    strategy?: MergeContentStrategy,
  ): MergeResult {
    const outputLines: string[] = [];
    const conflictRegions: ConflictRegion[] = [];
    let hasConflicts = false;
    let currentLine = 0;

    for (const chunk of chunks) {
      switch (chunk.type) {
        case "common":
          // Emit common lines from ours (identical to base in this region)
          for (let i = chunk.oursStart; i < chunk.oursEnd; i++) {
            outputLines.push(ours.getString(i));
          }
          currentLine += chunk.oursEnd - chunk.oursStart;
          break;

        case "ours":
          // Only ours changed - take ours
          for (let i = chunk.oursStart; i < chunk.oursEnd; i++) {
            outputLines.push(ours.getString(i));
          }
          currentLine += chunk.oursEnd - chunk.oursStart;
          break;

        case "theirs":
          // Only theirs changed - take theirs
          for (let i = chunk.theirsStart; i < chunk.theirsEnd; i++) {
            outputLines.push(theirs.getString(i));
          }
          currentLine += chunk.theirsEnd - chunk.theirsStart;
          break;

        case "conflict":
          if (strategy === MergeContentStrategy.OURS) {
            // Take ours
            for (let i = chunk.oursStart; i < chunk.oursEnd; i++) {
              outputLines.push(ours.getString(i));
            }
            currentLine += chunk.oursEnd - chunk.oursStart;
          } else if (strategy === MergeContentStrategy.THEIRS) {
            // Take theirs
            for (let i = chunk.theirsStart; i < chunk.theirsEnd; i++) {
              outputLines.push(theirs.getString(i));
            }
            currentLine += chunk.theirsEnd - chunk.theirsStart;
          } else if (strategy === MergeContentStrategy.UNION) {
            // Union: concatenate both (ours first, then theirs)
            // Skip theirs lines that are identical to any ours line to avoid duplication
            const oursLines: string[] = [];
            for (let i = chunk.oursStart; i < chunk.oursEnd; i++) {
              oursLines.push(ours.getString(i));
              outputLines.push(ours.getString(i));
            }
            currentLine += chunk.oursEnd - chunk.oursStart;

            // Add theirs lines, skipping duplicates
            for (let i = chunk.theirsStart; i < chunk.theirsEnd; i++) {
              const theirsLine = theirs.getString(i);
              if (!oursLines.includes(theirsLine)) {
                outputLines.push(theirsLine);
                currentLine++;
              }
            }
          } else {
            // No strategy - produce conflict markers
            hasConflicts = true;
            const startLine = currentLine;

            outputLines.push("<<<<<<< OURS");
            currentLine++;

            for (let i = chunk.oursStart; i < chunk.oursEnd; i++) {
              outputLines.push(ours.getString(i));
              currentLine++;
            }

            outputLines.push("=======");
            currentLine++;

            for (let i = chunk.theirsStart; i < chunk.theirsEnd; i++) {
              outputLines.push(theirs.getString(i));
              currentLine++;
            }

            outputLines.push(">>>>>>> THEIRS");
            currentLine++;

            conflictRegions.push({
              startLine,
              endLine: currentLine,
              baseStartLine: chunk.baseStart,
              baseEndLine: chunk.baseEnd,
              oursStartLine: chunk.oursStart,
              oursEndLine: chunk.oursEnd,
              theirsStartLine: chunk.theirsStart,
              theirsEndLine: chunk.theirsEnd,
            });
          }
          break;
      }
    }

    // Build output content
    const outputStr = outputLines.join("\n") + (outputLines.length > 0 ? "\n" : "");
    const content = new TextEncoder().encode(outputStr);

    return {
      content,
      hasConflicts,
      conflictRegions,
    };
  }
}

/**
 * Convenience function for performing a three-way merge.
 *
 * @param base The common ancestor content
 * @param ours Our version of the content
 * @param theirs Their version of the content
 * @param options Merge options (strategy and algorithm)
 * @returns Merge result
 *
 * @example
 * ```typescript
 * // Using default algorithm (histogram)
 * const result = merge3Way(base, ours, theirs);
 *
 * // Using specific algorithm
 * import { SupportedAlgorithm } from "./diff-algorithm.js";
 * const result = merge3Way(base, ours, theirs, {
 *   algorithm: SupportedAlgorithm.MYERS,
 *   strategy: MergeContentStrategy.OURS
 * });
 * ```
 */
export function merge3Way(
  base: Uint8Array | string,
  ours: Uint8Array | string,
  theirs: Uint8Array | string,
  options?: MergeOptions,
): MergeResult {
  const algorithm = new MergeAlgorithm(options?.algorithm);
  return algorithm.merge(base, ours, theirs, options);
}
