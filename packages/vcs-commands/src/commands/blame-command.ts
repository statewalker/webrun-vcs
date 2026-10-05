import type { Commit, ObjectId, PersonIdent, TreeEntry } from "@statewalker/vcs-core";
import type { Edit } from "@statewalker/vcs-utils";
import {
  DEFAULT_ALGORITHM,
  type DiffAlgorithm,
  getAlgorithm,
  RawText,
  RawTextComparator,
  type SupportedAlgorithm,
} from "@statewalker/vcs-utils";

import { RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { DEFAULT_RENAME_SCORE, SimilarityIndex } from "../rename/index.js";

/**
 * A single blame entry - represents authorship of one or more consecutive lines.
 */
export interface BlameEntry {
  /** The commit that introduced these lines */
  commit: Commit;
  /** The commit ID */
  commitId: ObjectId;
  /** Original path in the source commit (may differ due to renames) */
  sourcePath: string;
  /** Starting line number in the original file (1-based) */
  sourceStart: number;
  /** Starting line number in the result file (1-based) */
  resultStart: number;
  /** Number of lines in this region */
  lineCount: number;
}

/**
 * Detailed tracking information for a single line.
 *
 * Based on JGit's per-line tracking arrays in BlameResult.
 * This provides complete origin information for each line in the result file.
 */
export interface LineTracking {
  /** Line number in the result file (1-based) */
  resultLine: number;
  /** The commit that introduced this line */
  commit: Commit;
  /** The commit ID */
  commitId: ObjectId;
  /** Path in the source commit where this line originated (may differ due to renames) */
  sourcePath: string;
  /** Line number in the source file (1-based) */
  sourceLine: number;
}

/**
 * Result of a blame operation.
 *
 * Contains per-line authorship information for a file.
 */
export interface BlameResult {
  /** Path of the blamed file */
  path: string;
  /** Total number of lines in the file */
  lineCount: number;
  /** Blame entries covering all lines */
  entries: BlameEntry[];
  /**
   * Get the blame entry for a specific line (1-based).
   *
   * @param line Line number (1-based)
   * @returns Blame entry for that line, or undefined if out of range
   */
  getEntry(line: number): BlameEntry | undefined;
  /**
   * Get the commit that introduced a specific line.
   *
   * @param line Line number (1-based)
   * @returns Commit or undefined if out of range
   */
  getSourceCommit(line: number): Commit | undefined;
  /**
   * Get the author of a specific line.
   *
   * @param line Line number (1-based)
   * @returns PersonIdent or undefined if out of range
   */
  getSourceAuthor(line: number): PersonIdent | undefined;
  /**
   * Get the source line number in the original file.
   *
   * This returns the line number in the source commit where this line originated.
   * When a file has been modified through history with insertions/deletions,
   * the source line number may differ from the result line number.
   *
   * @param line Line number in the result file (1-based)
   * @returns Source line number (1-based), or undefined if out of range
   */
  getSourceLine(line: number): number | undefined;
  /**
   * Get the source path for a specific line.
   *
   * This returns the file path in the source commit. When rename tracking
   * is enabled, this may differ from the result path if the line originated
   * from a file with a different name.
   *
   * @param line Line number in the result file (1-based)
   * @returns Source path, or undefined if out of range
   */
  getSourcePath(line: number): string | undefined;
  /**
   * Get detailed tracking information for all lines.
   *
   * Returns an array of LineTracking objects, one per line in the result file.
   * Each object contains complete origin information including the commit,
   * source path, and source line number.
   *
   * @returns Array of LineTracking objects ordered by result line number
   */
  getLineTracking(): LineTracking[];
}

/**
 * Annotate each line of a file with authorship information.
 *
 * Equivalent to `git blame`.
 *
 * Based on JGit's BlameCommand and BlameGenerator.
 *
 * This command tracks line-by-line history to determine which commit
 * introduced each line in a file. It walks commit history backward,
 * using diff algorithms to trace the origin of each line.
 *
 * @example
 * ```typescript
 * // Blame a file at HEAD
 * const result = await git.blame()
 *   .setFilePath("src/main.ts")
 *   .call();
 *
 * // Get author of line 42
 * const author = result.getSourceAuthor(42);
 * console.log(`Line 42 written by: ${author?.name}`);
 *
 * // Blame at a specific commit
 * const result = await git.blame()
 *   .setFilePath("README.md")
 *   .setStartCommit(commitId)
 *   .call();
 *
 * // Iterate over blame entries
 * for (const entry of result.entries) {
 *   console.log(`Lines ${entry.resultStart}-${entry.resultStart + entry.lineCount - 1}: ${entry.commit.author.name}`);
 * }
 * ```
 */

/**
 * Represents a region of the result file that still needs blame attribution.
 * Modeled after JGit's Region class.
 *
 * Regions track both the position in the result file and the current source position
 * (which may differ as we trace back through history due to insertions/deletions).
 */
interface BlameRegion {
  /** Position in the result file (1-based) */
  resultStart: number;
  /** Position in the current source file being examined (1-based) */
  sourceStart: number;
  /** Number of lines in this region */
  length: number;
}

/**
 * Represents a candidate commit that may have contributed lines to the result.
 * Modeled after JGit's Candidate class.
 */
interface BlameCandidate {
  /** The commit being examined */
  commit: Commit;
  /** Commit ID */
  commitId: ObjectId;
  /** Current path being tracked */
  path: string;
  /** Blob ID of the file in this commit */
  blobId: ObjectId;
  /** Content of the file */
  content: Uint8Array;
  /** RawText for diff operations */
  rawText: RawText;
  /** Regions this candidate is responsible for */
  regions: BlameRegion[];
  /** Commit time for priority queue ordering */
  time: number;
}

export class BlameCommand extends GitCommand<BlameResult> {
  private filePath?: string;
  private startCommit?: ObjectId;
  private followRenames = false;
  private renameScore = DEFAULT_RENAME_SCORE;
  private diffAlgorithm: DiffAlgorithm = getAlgorithm(DEFAULT_ALGORITHM);

  /**
   * Set the file path to blame.
   *
   * @param path Repository-relative path to the file
   */
  setFilePath(path: string): this {
    this.checkCallable();
    this.filePath = path;
    return this;
  }

  /**
   * Set the starting commit for blame.
   *
   * If not set, defaults to HEAD.
   *
   * @param commit ObjectId of the starting commit
   */
  setStartCommit(commit: ObjectId): this {
    this.checkCallable();
    this.startCommit = commit;
    return this;
  }

  /**
   * Set whether to follow file renames.
   *
   * When enabled, the blame will track lines through renames.
   * This is more accurate but slower.
   *
   * @param follow Whether to follow renames
   */
  setFollowRenames(follow: boolean): this {
    this.checkCallable();
    this.followRenames = follow;
    return this;
  }

  /**
   * Set the minimum similarity score for rename detection.
   *
   * @param score Similarity threshold (0-100, default 50)
   */
  setRenameScore(score: number): this {
    this.checkCallable();
    this.renameScore = Math.max(0, Math.min(100, score));
    return this;
  }

  /**
   * Set the diff algorithm to use.
   *
   * @param algorithm The algorithm to use (default: histogram)
   */
  setAlgorithm(algorithm: SupportedAlgorithm): this {
    this.checkCallable();
    this.diffAlgorithm = getAlgorithm(algorithm);
    return this;
  }

  /**
   * Execute the blame command.
   *
   * Uses a queue-based algorithm similar to JGit's BlameGenerator.
   * For merge commits, checks all parents to correctly attribute lines.
   *
   * @returns BlameResult with per-line authorship
   */
  async call(): Promise<BlameResult> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.filePath) {
      throw new Error("File path must be set");
    }

    // Resolve starting commit
    let startId = this.startCommit;
    if (!startId) {
      const head = await this.refsStore.resolve("HEAD");
      if (!head?.objectId) {
        throw new Error("No HEAD commit found");
      }
      startId = head.objectId;
    }

    const resultPath = this.filePath;
    const entries: BlameEntry[] = [];

    // Load the file content at the starting commit
    const startCommit = await this.commits.load(startId);
    if (!startCommit) {
      throw new RefNotFoundError(`Cannot find commit: ${startId}`);
    }
    const blobId = await this.getFileBlob(startCommit.tree, resultPath);

    if (!blobId) {
      throw new Error(`File not found: ${resultPath}`);
    }

    // Get file content and count lines
    const content = await this.collectBlob(blobId);
    const lineCount = this.countLines(content);

    if (lineCount === 0) {
      // Empty file
      return this.createBlameResult(resultPath, 0, []);
    }

    // Initialize the candidate queue with the starting commit
    // Queue is sorted by commit time descending (most recent first)
    const queue: BlameCandidate[] = [];
    const seen = new Set<ObjectId>();

    const initialCandidate: BlameCandidate = {
      commit: startCommit,
      commitId: startId,
      path: resultPath,
      blobId,
      content,
      rawText: new RawText(content),
      regions: [{ resultStart: 1, sourceStart: 1, length: lineCount }],
      time: startCommit.author.timestamp * 1000,
    };

    this.pushCandidate(queue, initialCandidate, seen);

    // Track remaining lines to blame
    let remaining = lineCount;

    // Process candidates until all lines are blamed or queue is empty
    while (queue.length > 0 && remaining > 0) {
      const candidate = queue.shift();
      if (!candidate) break;

      if (candidate.regions.length === 0) {
        continue;
      }

      const parentCount = candidate.commit.parents.length;

      if (parentCount === 0) {
        // Root commit - blame all remaining regions to this commit
        this.blameRegions(entries, candidate);
        remaining -= this.countRegionLines(candidate.regions);
      } else if (parentCount === 1) {
        // Single parent - process normally
        const blamed = await this.processOneParent(candidate, queue, seen, entries);
        remaining -= blamed;
      } else {
        // Merge commit - process all parents (JGit's processMerge)
        const blamed = await this.processMerge(candidate, queue, seen, entries);
        remaining -= blamed;
      }
    }

    // Sort entries by result line number
    entries.sort((a, b) => a.resultStart - b.resultStart);

    // Merge adjacent entries from the same commit and path
    const mergedEntries = this.mergeAdjacentEntries(entries);

    return this.createBlameResult(resultPath, lineCount, mergedEntries);
  }

  /**
   * Process a commit with a single parent.
   *
   * @returns Number of lines blamed to this commit
   */
  private async processOneParent(
    candidate: BlameCandidate,
    queue: BlameCandidate[],
    seen: Set<ObjectId>,
    entries: BlameEntry[],
  ): Promise<number> {
    const parentId = candidate.commit.parents[0];
    const parentCommit = await this.commits.load(parentId);
    if (!parentCommit) {
      // Parent commit not found - blame all regions to this commit
      this.blameRegions(entries, candidate);
      return this.countRegionLines(candidate.regions);
    }

    // Check if file exists in parent
    let parentBlobId = await this.getFileBlob(parentCommit.tree, candidate.path);
    let parentPath = candidate.path;

    // If file doesn't exist in parent and rename following is enabled, search for rename
    if (!parentBlobId && this.followRenames) {
      const rename = await this.findRename(
        parentCommit.tree,
        candidate.commit.tree,
        candidate.path,
        candidate.content,
      );

      if (rename) {
        parentBlobId = rename.oldBlobId;
        parentPath = rename.oldPath;
      }
    }

    if (!parentBlobId) {
      // File was introduced in this commit - blame all regions
      this.blameRegions(entries, candidate);
      return this.countRegionLines(candidate.regions);
    }

    // If blob is identical, pass blame to parent without diffing
    if (parentBlobId === candidate.blobId) {
      const parentContent = await this.collectBlob(parentBlobId);
      const parentCandidate: BlameCandidate = {
        commit: parentCommit,
        commitId: parentId,
        path: parentPath,
        blobId: parentBlobId,
        content: parentContent,
        rawText: new RawText(parentContent),
        regions: candidate.regions,
        time: parentCommit.author.timestamp * 1000,
      };
      this.pushCandidate(queue, parentCandidate, seen);
      return 0;
    }

    // Compute diff and split blame
    const parentContent = await this.collectBlob(parentBlobId);
    const parentRawText = new RawText(parentContent);

    return this.splitBlame(
      candidate,
      parentCommit,
      parentId,
      parentPath,
      parentBlobId,
      parentContent,
      parentRawText,
      queue,
      seen,
      entries,
    );
  }

  /**
   * Process a merge commit with multiple parents.
   * Based on JGit's processMerge() algorithm.
   *
   * Key algorithm:
   * 1. If any parent has identical blob, pass all blame to that parent
   * 2. Otherwise, for each parent that has the file, compute diff
   * 3. Lines that match a parent go to that parent's history
   * 4. Lines that don't match any parent (conflict resolution) are blamed to merge commit
   *
   * @returns Number of lines blamed to the merge commit
   */
  private async processMerge(
    candidate: BlameCandidate,
    queue: BlameCandidate[],
    seen: Set<ObjectId>,
    entries: BlameEntry[],
  ): Promise<number> {
    const parentCount = candidate.commit.parents.length;

    // Collect parent info
    interface ParentInfo {
      commit: Commit;
      commitId: ObjectId;
      blobId: ObjectId;
      path: string;
      content: Uint8Array;
      rawText: RawText;
    }

    const parentInfos: (ParentInfo | null)[] = [];

    // First pass: check all parents for the file
    for (let pIdx = 0; pIdx < parentCount; pIdx++) {
      const parentId = candidate.commit.parents[pIdx];
      const parentCommit = await this.commits.load(parentId);
      if (!parentCommit) {
        parentInfos.push(null);
        continue;
      }

      let parentBlobId = await this.getFileBlob(parentCommit.tree, candidate.path);
      let parentPath = candidate.path;

      // Check for rename if file not found
      if (!parentBlobId && this.followRenames) {
        const rename = await this.findRename(
          parentCommit.tree,
          candidate.commit.tree,
          candidate.path,
          candidate.content,
        );
        if (rename) {
          parentBlobId = rename.oldBlobId;
          parentPath = rename.oldPath;
        }
      }

      if (parentBlobId) {
        // If any parent has identical blob, pass all blame to that parent
        if (parentBlobId === candidate.blobId) {
          const parentContent = await this.collectBlob(parentBlobId);
          const parentCandidate: BlameCandidate = {
            commit: parentCommit,
            commitId: parentId,
            path: parentPath,
            blobId: parentBlobId,
            content: parentContent,
            rawText: new RawText(parentContent),
            regions: candidate.regions,
            time: parentCommit.author.timestamp * 1000,
          };
          this.pushCandidate(queue, parentCandidate, seen);
          return 0;
        }

        const parentContent = await this.collectBlob(parentBlobId);
        parentInfos.push({
          commit: parentCommit,
          commitId: parentId,
          blobId: parentBlobId,
          path: parentPath,
          content: parentContent,
          rawText: new RawText(parentContent),
        });
      } else {
        parentInfos.push(null);
      }
    }

    // If no parents have the file, blame everything to this commit
    const validParents = parentInfos.filter((p): p is ParentInfo => p !== null);
    if (validParents.length === 0) {
      this.blameRegions(entries, candidate);
      return this.countRegionLines(candidate.regions);
    }

    // Process each parent and split blame
    // We track which regions have been passed to parents
    let currentRegions = candidate.regions;

    for (const parentInfo of validParents) {
      if (currentRegions.length === 0) break;

      // Compute diff between parent and candidate
      const comparator = RawTextComparator.DEFAULT;
      const edits = this.diffAlgorithm(comparator, parentInfo.rawText, candidate.rawText);

      // Split regions between parent and candidate
      const { parentRegions, childRegions } = this.takeBlame(edits, currentRegions);

      // Push parent candidate if it has regions
      if (parentRegions.length > 0) {
        const parentCandidate: BlameCandidate = {
          commit: parentInfo.commit,
          commitId: parentInfo.commitId,
          path: parentInfo.path,
          blobId: parentInfo.blobId,
          content: parentInfo.content,
          rawText: parentInfo.rawText,
          regions: parentRegions,
          time: parentInfo.commit.author.timestamp * 1000,
        };
        this.pushCandidate(queue, parentCandidate, seen);
      }

      // Remaining regions stay with the merge commit
      currentRegions = childRegions;
    }

    // Any remaining regions are blamed to the merge commit
    // (these are conflict resolution lines)
    if (currentRegions.length > 0) {
      const mergeCandidate: BlameCandidate = {
        ...candidate,
        regions: currentRegions,
      };
      this.blameRegions(entries, mergeCandidate);
      return this.countRegionLines(currentRegions);
    }

    return 0;
  }

  /**
   * Split blame between a candidate and its parent using diff edits.
   * Based on JGit's Candidate.takeBlame() method.
   *
   * For each line in the child that is unchanged (not covered by an edit),
   * we need to find where that line came from in the parent. Due to insertions
   * and deletions, unchanged lines in the child may not be contiguous in the parent.
   *
   * @returns Object with regions for parent and regions remaining with child
   */
  private takeBlame(
    edits: Edit[],
    regions: BlameRegion[],
  ): { parentRegions: BlameRegion[]; childRegions: BlameRegion[] } {
    const parentRegions: BlameRegion[] = [];
    const childRegions: BlameRegion[] = [];

    // Process each region against the edit list
    // Edits are in terms of 0-based line numbers
    // Regions use 1-based line numbers

    for (const region of regions) {
      // Convert to 0-based for comparison with edits
      const regionStart = region.sourceStart - 1;
      const regionEnd = regionStart + region.length;

      // Track what parts of this region are covered by edits (changes)
      // and what parts are unchanged (should go to parent)
      const changedRanges: Array<{ start: number; end: number }> = [];

      for (const edit of edits) {
        // Edit's B side (child/new) tells us which lines in the child are different
        const editStart = edit.beginB;
        const editEnd = edit.endB;

        // Check if edit overlaps with region
        if (editEnd <= regionStart || editStart >= regionEnd) {
          continue; // No overlap
        }

        // Compute overlap
        const overlapStart = Math.max(editStart, regionStart);
        const overlapEnd = Math.min(editEnd, regionEnd);

        if (overlapEnd > overlapStart) {
          changedRanges.push({ start: overlapStart, end: overlapEnd });
        }
      }

      // Sort and merge overlapping changed ranges
      changedRanges.sort((a, b) => a.start - b.start);
      const mergedChanges: Array<{ start: number; end: number }> = [];
      for (const range of changedRanges) {
        if (
          mergedChanges.length === 0 ||
          mergedChanges[mergedChanges.length - 1].end < range.start
        ) {
          mergedChanges.push({ ...range });
        } else {
          mergedChanges[mergedChanges.length - 1].end = Math.max(
            mergedChanges[mergedChanges.length - 1].end,
            range.end,
          );
        }
      }

      // Now split the region: unchanged parts go to parent, changed parts stay with child
      // For unchanged parts, we need to create separate regions for each contiguous block
      // in the parent, since mapping through edits may create gaps.
      let pos = regionStart;

      for (const change of mergedChanges) {
        // Unchanged part before this change - process line by line to handle non-contiguous mapping
        if (change.start > pos) {
          this.addParentRegionsForUnchangedBlock(
            pos,
            change.start,
            region.resultStart,
            regionStart,
            edits,
            parentRegions,
          );
        }

        // Changed part stays with child
        if (change.end > change.start) {
          childRegions.push({
            resultStart: region.resultStart + (change.start - regionStart),
            sourceStart: change.start + 1, // Convert back to 1-based
            length: change.end - change.start,
          });
        }

        pos = change.end;
      }

      // Remaining unchanged part after last change
      if (pos < regionEnd) {
        this.addParentRegionsForUnchangedBlock(
          pos,
          regionEnd,
          region.resultStart,
          regionStart,
          edits,
          parentRegions,
        );
      }
    }

    return { parentRegions, childRegions };
  }

  /**
   * Add parent regions for an unchanged block of lines.
   * Since lines may map to non-contiguous positions in the parent
   * (due to deletions), we need to create separate regions for each
   * contiguous block in the parent.
   */
  private addParentRegionsForUnchangedBlock(
    startPos: number,
    endPos: number,
    resultStart: number,
    regionStart: number,
    edits: Edit[],
    parentRegions: BlameRegion[],
  ): void {
    // Map each line position and group into contiguous regions in the parent
    let currentParentStart = -1;
    let currentResultStart = -1;
    let currentLength = 0;
    let lastParentPos = -1;

    for (let childPos = startPos; childPos < endPos; childPos++) {
      const parentPos = this.mapPositionToParent(childPos, edits);

      if (currentLength === 0) {
        // Start a new region
        currentParentStart = parentPos;
        currentResultStart = resultStart + (childPos - regionStart);
        currentLength = 1;
        lastParentPos = parentPos;
      } else if (parentPos === lastParentPos + 1) {
        // Extend current region (contiguous in parent)
        currentLength++;
        lastParentPos = parentPos;
      } else {
        // Gap in parent - push current region and start new one
        parentRegions.push({
          resultStart: currentResultStart,
          sourceStart: currentParentStart + 1, // Convert to 1-based
          length: currentLength,
        });
        currentParentStart = parentPos;
        currentResultStart = resultStart + (childPos - regionStart);
        currentLength = 1;
        lastParentPos = parentPos;
      }
    }

    // Push final region
    if (currentLength > 0) {
      parentRegions.push({
        resultStart: currentResultStart,
        sourceStart: currentParentStart + 1, // Convert to 1-based
        length: currentLength,
      });
    }
  }

  /**
   * Map a position in the child file back to the corresponding position in the parent.
   * Takes into account insertions and deletions.
   *
   * @param childPos 0-based position in child
   * @param edits Edit list from diff
   * @returns 0-based position in parent
   */
  private mapPositionToParent(childPos: number, edits: Edit[]): number {
    let offset = 0;

    for (const edit of edits) {
      if (edit.endB <= childPos) {
        // This edit is before our position
        // Adjust offset: lengthA - lengthB gives the shift
        const lengthA = edit.endA - edit.beginA;
        const lengthB = edit.endB - edit.beginB;
        offset += lengthA - lengthB;
      } else if (edit.beginB <= childPos) {
        // Position is within an edit - this shouldn't happen for unchanged lines
        // but handle gracefully by mapping to edit start in parent
        return edit.beginA;
      }
    }

    return childPos + offset;
  }

  /**
   * Split blame between a candidate and a single parent.
   *
   * @returns Number of lines blamed to the candidate
   */
  private async splitBlame(
    candidate: BlameCandidate,
    parentCommit: Commit,
    parentId: ObjectId,
    parentPath: string,
    parentBlobId: ObjectId,
    parentContent: Uint8Array,
    parentRawText: RawText,
    queue: BlameCandidate[],
    seen: Set<ObjectId>,
    entries: BlameEntry[],
  ): Promise<number> {
    // Compute diff
    const comparator = RawTextComparator.DEFAULT;
    const edits = this.diffAlgorithm(comparator, parentRawText, candidate.rawText);

    if (edits.length === 0) {
      // No changes (might happen with whitespace-ignoring comparator)
      const parentCandidate: BlameCandidate = {
        commit: parentCommit,
        commitId: parentId,
        path: parentPath,
        blobId: parentBlobId,
        content: parentContent,
        rawText: parentRawText,
        regions: candidate.regions,
        time: parentCommit.author.timestamp * 1000,
      };
      this.pushCandidate(queue, parentCandidate, seen);
      return 0;
    }

    // Split regions
    const { parentRegions, childRegions } = this.takeBlame(edits, candidate.regions);

    // Push parent candidate
    if (parentRegions.length > 0) {
      const parentCandidate: BlameCandidate = {
        commit: parentCommit,
        commitId: parentId,
        path: parentPath,
        blobId: parentBlobId,
        content: parentContent,
        rawText: parentRawText,
        regions: parentRegions,
        time: parentCommit.author.timestamp * 1000,
      };
      this.pushCandidate(queue, parentCandidate, seen);
    }

    // Blame child regions to this commit
    if (childRegions.length > 0) {
      const childCandidate: BlameCandidate = {
        ...candidate,
        regions: childRegions,
      };
      this.blameRegions(entries, childCandidate);
      return this.countRegionLines(childRegions);
    }

    return 0;
  }

  /**
   * Push a candidate onto the queue, maintaining descending time order.
   * Handles merging of candidates for the same commit.
   */
  private pushCandidate(
    queue: BlameCandidate[],
    candidate: BlameCandidate,
    seen: Set<ObjectId>,
  ): void {
    // Check if we already have a candidate for this commit
    if (seen.has(candidate.commitId)) {
      // Find and merge with existing candidate
      const existing = queue.find(
        (c) => c.commitId === candidate.commitId && c.path === candidate.path,
      );
      if (existing) {
        // Merge regions
        existing.regions = this.mergeBlameRegions(existing.regions, candidate.regions);
        return;
      }
    }

    seen.add(candidate.commitId);

    // Insert in descending time order
    let insertIdx = 0;
    while (insertIdx < queue.length && queue[insertIdx].time > candidate.time) {
      insertIdx++;
    }
    queue.splice(insertIdx, 0, candidate);
  }

  /**
   * Merge two region lists, maintaining sorted order by resultStart.
   */
  private mergeBlameRegions(a: BlameRegion[], b: BlameRegion[]): BlameRegion[] {
    const result: BlameRegion[] = [...a, ...b];
    result.sort((x, y) => x.resultStart - y.resultStart);

    // Merge adjacent regions
    const merged: BlameRegion[] = [];
    for (const region of result) {
      if (merged.length === 0) {
        merged.push({ ...region });
      } else {
        const last = merged[merged.length - 1];
        if (
          last.resultStart + last.length === region.resultStart &&
          last.sourceStart + last.length === region.sourceStart
        ) {
          last.length += region.length;
        } else {
          merged.push({ ...region });
        }
      }
    }

    return merged;
  }

  /**
   * Blame all regions in a candidate to its commit.
   */
  private blameRegions(entries: BlameEntry[], candidate: BlameCandidate): void {
    for (const region of candidate.regions) {
      entries.push({
        commit: candidate.commit,
        commitId: candidate.commitId,
        sourcePath: candidate.path,
        sourceStart: region.sourceStart,
        resultStart: region.resultStart,
        lineCount: region.length,
      });
    }
  }

  /**
   * Count total lines in a list of regions.
   */
  private countRegionLines(regions: BlameRegion[]): number {
    return regions.reduce((sum, r) => sum + r.length, 0);
  }

  /**
   * Find a rename candidate for a file that doesn't exist in the parent commit.
   *
   * Searches for deleted files in the parent that have similar content to the
   * file in the current commit.
   *
   * @param parentTreeId Tree ID of the parent commit
   * @param currentTreeId Tree ID of the current commit
   * @param newPath Path of the file in the current commit
   * @param newContent Content of the file in the current commit
   * @returns Rename information if found, undefined otherwise
   */
  private async findRename(
    parentTreeId: ObjectId,
    currentTreeId: ObjectId,
    _newPath: string,
    newContent: Uint8Array,
  ): Promise<{ oldPath: string; oldBlobId: ObjectId; score: number } | undefined> {
    // Skip binary files for rename detection
    if (SimilarityIndex.isBinary(newContent)) {
      return undefined;
    }

    // Collect all blob entries from both trees
    const parentBlobs = new Map<string, TreeEntry>();
    const currentBlobs = new Map<string, TreeEntry>();

    await this.collectTreeEntries(parentTreeId, "", parentBlobs);
    await this.collectTreeEntries(currentTreeId, "", currentBlobs);

    // Find files that exist in parent but not in current (potential rename sources)
    const deletedFiles: Array<{ path: string; entry: TreeEntry }> = [];
    for (const [path, entry] of parentBlobs) {
      if (!currentBlobs.has(path)) {
        deletedFiles.push({ path, entry });
      }
    }

    if (deletedFiles.length === 0) {
      return undefined;
    }

    // Compute similarity index for the new file
    const newIndex = SimilarityIndex.create(newContent);

    // Find the best matching deleted file
    let bestMatch: { path: string; blobId: ObjectId; score: number } | undefined;

    for (const { path: oldPath, entry } of deletedFiles) {
      // Load the old file content
      const oldContent = await this.collectBlob(entry.id);

      // Skip binary files
      if (SimilarityIndex.isBinary(oldContent)) {
        continue;
      }

      // Compute similarity
      const oldIndex = SimilarityIndex.create(oldContent);
      const score = newIndex.score(oldIndex);

      // Check if this is a better match than what we have
      if (score >= this.renameScore && (!bestMatch || score > bestMatch.score)) {
        bestMatch = {
          path: oldPath,
          blobId: entry.id,
          score,
        };
      }
    }

    if (bestMatch) {
      return {
        oldPath: bestMatch.path,
        oldBlobId: bestMatch.blobId,
        score: bestMatch.score,
      };
    }

    return undefined;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, TreeEntry>,
  ): Promise<void> {
    const TREE_MODE = 0o40000;

    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === TREE_MODE) {
        // Recurse into subtree
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        // Blob entry
        entries.set(path, entry);
      }
    }
  }

  /**
   * Collect blob content into a single buffer.
   */
  private async collectBlob(blobId: ObjectId): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    const blobContent = await this.blobs.load(blobId);
    if (blobContent) {
      for await (const chunk of blobContent) {
        chunks.push(chunk);
        totalLength += chunk.length;
      }
    }

    // Combine chunks into single buffer
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Get blob ID for a file in a tree.
   */
  private async getFileBlob(treeId: ObjectId, path: string): Promise<ObjectId | undefined> {
    const parts = path.split("/").filter((p) => p.length > 0);
    let currentTreeId = treeId;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;

      const entry = await this.trees.getEntry(currentTreeId, name);
      if (!entry) {
        return undefined;
      }

      if (isLast) {
        return entry.id;
      }

      // Navigate into subtree
      currentTreeId = entry.id;
    }

    return undefined;
  }

  /**
   * Count lines in content.
   *
   * Recognizes three types of line endings:
   * - LF (\n) - Unix style
   * - CRLF (\r\n) - Windows style (counts as one line ending)
   * - CR (\r) - Classic Mac style (standalone CR without following LF)
   */
  private countLines(content: Uint8Array): number {
    if (content.length === 0) {
      return 0;
    }

    let count = 1;
    for (let i = 0; i < content.length; i++) {
      const byte = content[i];
      if (byte === 0x0a) {
        // '\n' - LF (Unix) or second byte of CRLF (Windows)
        count++;
      } else if (byte === 0x0d) {
        // '\r' - Check if it's CRLF or standalone CR
        if (i + 1 < content.length && content[i + 1] === 0x0a) {
          // CRLF - skip the CR, the LF will be handled in next iteration
          continue;
        }
        // Standalone CR (classic Mac style)
        count++;
      }
    }

    // If file ends with newline (LF or CR), don't count the empty "line" after it
    const lastByte = content[content.length - 1];
    if (lastByte === 0x0a || lastByte === 0x0d) {
      count--;
    }

    return count;
  }

  /**
   * Merge adjacent entries from the same commit and source path.
   */
  private mergeAdjacentEntries(entries: BlameEntry[]): BlameEntry[] {
    if (entries.length <= 1) {
      return entries;
    }

    const merged: BlameEntry[] = [];
    let current = entries[0];

    for (let i = 1; i < entries.length; i++) {
      const next = entries[i];

      // Check if can merge: same commit, same source path, and adjacent lines
      if (
        current.commitId === next.commitId &&
        current.sourcePath === next.sourcePath &&
        current.resultStart + current.lineCount === next.resultStart
      ) {
        // Merge
        current = {
          ...current,
          lineCount: current.lineCount + next.lineCount,
        };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  /**
   * Create a BlameResult from entries.
   */
  private createBlameResult(path: string, lineCount: number, entries: BlameEntry[]): BlameResult {
    // Build line-to-entry index for fast lookups
    const lineToEntry = new Map<number, BlameEntry>();
    for (const entry of entries) {
      for (let i = 0; i < entry.lineCount; i++) {
        lineToEntry.set(entry.resultStart + i, entry);
      }
    }

    /**
     * Get the source line number for a given result line.
     * The source line is computed based on the entry's sourceStart and the offset
     * within the entry.
     */
    function getSourceLineForResult(line: number): number | undefined {
      const entry = lineToEntry.get(line);
      if (!entry) return undefined;
      // Compute offset within the entry and add to sourceStart
      const offset = line - entry.resultStart;
      return entry.sourceStart + offset;
    }

    return {
      path,
      lineCount,
      entries,

      getEntry(line: number): BlameEntry | undefined {
        return lineToEntry.get(line);
      },

      getSourceCommit(line: number): Commit | undefined {
        const entry = lineToEntry.get(line);
        return entry?.commit;
      },

      getSourceAuthor(line: number): PersonIdent | undefined {
        const entry = lineToEntry.get(line);
        return entry?.commit.author;
      },

      getSourceLine(line: number): number | undefined {
        return getSourceLineForResult(line);
      },

      getSourcePath(line: number): string | undefined {
        const entry = lineToEntry.get(line);
        return entry?.sourcePath;
      },

      getLineTracking(): LineTracking[] {
        const tracking: LineTracking[] = [];
        for (let line = 1; line <= lineCount; line++) {
          const entry = lineToEntry.get(line);
          if (entry) {
            const offset = line - entry.resultStart;
            tracking.push({
              resultLine: line,
              commit: entry.commit,
              commitId: entry.commitId,
              sourcePath: entry.sourcePath,
              sourceLine: entry.sourceStart + offset,
            });
          }
        }
        return tracking;
      },
    };
  }
}
