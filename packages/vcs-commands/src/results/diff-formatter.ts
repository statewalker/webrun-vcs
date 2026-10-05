/**
 * Formatter for generating unified diff output from DiffEntry objects.
 *
 * Based on JGit's DiffFormatter class.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import {
  DEFAULT_ALGORITHM,
  type DiffAlgorithm,
  type EditList,
  getAlgorithm,
  RawText,
  RawTextComparator,
  type SupportedAlgorithm,
} from "@statewalker/vcs-utils";

import { ChangeType, type DiffEntry } from "./diff-entry.js";

/**
 * Options for diff formatting.
 */
export interface DiffFormatterOptions {
  /** Number of context lines around changes (default: 3) */
  contextLines?: number;
  /** Whether to include file headers (default: true) */
  includeHeaders?: boolean;
  /** Whether to abbreviate object IDs (default: true) */
  abbreviateIds?: boolean;
  /** Length of abbreviated object IDs (default: 7) */
  abbreviationLength?: number;
  /** Diff algorithm to use (default: histogram) */
  algorithm?: SupportedAlgorithm;
}

/**
 * A hunk in unified diff format.
 */
export interface DiffHunk {
  /** Starting line in old file (1-based) */
  oldStart: number;
  /** Number of lines from old file */
  oldCount: number;
  /** Starting line in new file (1-based) */
  newStart: number;
  /** Number of lines from new file */
  newCount: number;
  /** Lines in the hunk (prefixed with ' ', '+', or '-') */
  lines: string[];
}

/**
 * Content diff result for a single file.
 */
export interface FileContentDiff {
  /** The original diff entry */
  entry: DiffEntry;
  /** Whether the file is binary */
  isBinary: boolean;
  /** File header line (e.g., "diff --git a/path b/path") */
  header: string;
  /** Old file header (e.g., "--- a/path") */
  oldFileHeader?: string;
  /** New file header (e.g., "+++ b/path") */
  newFileHeader?: string;
  /** Index line (e.g., "index abc123..def456 100644") */
  indexLine?: string;
  /** Hunks of changes */
  hunks: DiffHunk[];
  /** Raw old content (for binary display or further processing) */
  oldContent?: Uint8Array;
  /** Raw new content (for binary display or further processing) */
  newContent?: Uint8Array;
}

/**
 * Format DiffEntry objects into unified diff format.
 *
 * @example
 * ```typescript
 * const formatter = new DiffFormatter(store.blobs);
 *
 * // Get diff entries from DiffCommand
 * const entries = await git.diff().setOldTree(commitA).setNewTree(commitB).call();
 *
 * // Format as unified diff
 * for (const entry of entries) {
 *   const diff = await formatter.format(entry);
 *   console.log(formatter.toString(diff));
 * }
 * ```
 */
export class DiffFormatter {
  private contextLines: number;
  private includeHeaders: boolean;
  private abbreviateIds: boolean;
  private abbreviationLength: number;
  private diffAlgorithm: DiffAlgorithm;

  constructor(
    private readonly blobs: Blobs,
    options: DiffFormatterOptions = {},
  ) {
    this.contextLines = options.contextLines ?? 3;
    this.includeHeaders = options.includeHeaders ?? true;
    this.abbreviateIds = options.abbreviateIds ?? true;
    this.abbreviationLength = options.abbreviationLength ?? 7;
    this.diffAlgorithm = getAlgorithm(options.algorithm ?? DEFAULT_ALGORITHM);
  }

  /**
   * Format a DiffEntry into a content diff.
   *
   * @param entry The diff entry to format
   * @returns Content diff with hunks
   */
  async format(entry: DiffEntry): Promise<FileContentDiff> {
    // Load content for old and new
    const oldContent = entry.oldId ? await this.loadContent(entry.oldId) : null;
    const newContent = entry.newId ? await this.loadContent(entry.newId) : null;

    // Check for binary content
    const isBinary =
      (oldContent !== null && RawText.isBinary(oldContent)) ||
      (newContent !== null && RawText.isBinary(newContent));

    // Build headers
    const result: FileContentDiff = {
      entry,
      isBinary,
      header: this.buildHeader(entry),
      hunks: [],
    };

    if (this.includeHeaders) {
      result.indexLine = this.buildIndexLine(entry);
      result.oldFileHeader = this.buildOldFileHeader(entry);
      result.newFileHeader = this.buildNewFileHeader(entry);
    }

    if (oldContent) {
      result.oldContent = oldContent;
    }
    if (newContent) {
      result.newContent = newContent;
    }

    // Don't generate text diff for binary files
    if (isBinary) {
      return result;
    }

    // Generate hunks for text files
    const oldText = oldContent ? new RawText(oldContent) : RawText.EMPTY_TEXT;
    const newText = newContent ? new RawText(newContent) : RawText.EMPTY_TEXT;

    const edits = this.diffAlgorithm(RawTextComparator.DEFAULT, oldText, newText);

    if (edits.length > 0) {
      result.hunks = this.formatEdits(oldText, newText, edits);
    }

    return result;
  }

  /**
   * Convert a FileContentDiff to string format.
   *
   * @param diff The content diff to stringify
   * @returns Unified diff string
   */
  toString(diff: FileContentDiff): string {
    const lines: string[] = [];

    if (this.includeHeaders) {
      lines.push(diff.header);
      if (diff.indexLine) {
        lines.push(diff.indexLine);
      }
    }

    if (diff.isBinary) {
      lines.push(
        `Binary files ${diff.entry.oldPath ?? "/dev/null"} and ${diff.entry.newPath ?? "/dev/null"} differ`,
      );
      return lines.join("\n");
    }

    if (this.includeHeaders && diff.hunks.length > 0) {
      if (diff.oldFileHeader) {
        lines.push(diff.oldFileHeader);
      }
      if (diff.newFileHeader) {
        lines.push(diff.newFileHeader);
      }
    }

    for (const hunk of diff.hunks) {
      lines.push(this.formatHunkHeader(hunk));
      lines.push(...hunk.lines);
    }

    return lines.join("\n");
  }

  /**
   * Format all diff entries to a single string.
   *
   * @param entries Array of diff entries
   * @returns Complete unified diff output
   */
  async formatAll(entries: DiffEntry[]): Promise<string> {
    const parts: string[] = [];

    for (const entry of entries) {
      const diff = await this.format(entry);
      parts.push(this.toString(diff));
    }

    return parts.join("\n");
  }

  /**
   * Load blob content from storage.
   */
  private async loadContent(objectId: ObjectId): Promise<Uint8Array> {
    const content = await this.blobs.load(objectId);
    if (!content) {
      throw new Error(`Blob not found: ${objectId}`);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }

    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Build the diff header line.
   */
  private buildHeader(entry: DiffEntry): string {
    const oldPath = entry.oldPath ?? entry.newPath;
    const newPath = entry.newPath ?? entry.oldPath;
    return `diff --git a/${oldPath} b/${newPath}`;
  }

  /**
   * Build the index line.
   */
  private buildIndexLine(entry: DiffEntry): string {
    const oldId = this.abbreviateId(entry.oldId ?? "0000000");
    const newId = this.abbreviateId(entry.newId ?? "0000000");
    const mode = entry.newMode ?? entry.oldMode;
    const modeStr = mode ? ` ${mode.toString(8)}` : "";
    return `index ${oldId}..${newId}${modeStr}`;
  }

  /**
   * Build the old file header line.
   */
  private buildOldFileHeader(entry: DiffEntry): string {
    if (entry.changeType === ChangeType.ADD) {
      return "--- /dev/null";
    }
    return `--- a/${entry.oldPath}`;
  }

  /**
   * Build the new file header line.
   */
  private buildNewFileHeader(entry: DiffEntry): string {
    if (entry.changeType === ChangeType.DELETE) {
      return "+++ /dev/null";
    }
    return `+++ b/${entry.newPath}`;
  }

  /**
   * Abbreviate an object ID.
   */
  private abbreviateId(id: string): string {
    if (!this.abbreviateIds) {
      return id;
    }
    return id.slice(0, this.abbreviationLength);
  }

  /**
   * Format the hunk header.
   */
  private formatHunkHeader(hunk: DiffHunk): string {
    return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  }

  /**
   * Format edits into hunks.
   */
  private formatEdits(oldText: RawText, newText: RawText, edits: EditList): DiffHunk[] {
    const hunks: DiffHunk[] = [];

    // Merge edits that are close together
    const combinedEdits = this.combineEdits(edits, oldText.size(), newText.size());

    for (const combinedEdit of combinedEdits) {
      const hunk = this.createHunk(oldText, newText, combinedEdit.edits, combinedEdit.contextStart);
      if (hunk.lines.length > 0) {
        hunks.push(hunk);
      }
    }

    return hunks;
  }

  /**
   * Combine edits that are within context range of each other.
   */
  private combineEdits(
    edits: EditList,
    _oldSize: number,
    _newSize: number,
  ): { edits: EditList; contextStart: number }[] {
    if (edits.length === 0) {
      return [];
    }

    const result: { edits: EditList; contextStart: number }[] = [];
    let currentEdits: EditList = [edits[0]];
    let contextStart = Math.max(0, edits[0].beginA - this.contextLines);

    for (let i = 1; i < edits.length; i++) {
      const prevEdit = currentEdits[currentEdits.length - 1];
      const nextEdit = edits[i];

      // Check if edits are close enough to merge
      const gap = nextEdit.beginA - prevEdit.endA;
      if (gap <= this.contextLines * 2) {
        // Merge into current group
        currentEdits.push(nextEdit);
      } else {
        // Start new group
        result.push({ edits: currentEdits, contextStart });
        currentEdits = [nextEdit];
        contextStart = Math.max(0, nextEdit.beginA - this.contextLines);
      }
    }

    result.push({ edits: currentEdits, contextStart });
    return result;
  }

  /**
   * Create a hunk from a group of edits.
   */
  private createHunk(
    oldText: RawText,
    newText: RawText,
    edits: EditList,
    contextStart: number,
  ): DiffHunk {
    const lines: string[] = [];

    const firstEdit = edits[0];
    const lastEdit = edits[edits.length - 1];

    // Calculate hunk bounds
    const oldStart = contextStart;
    const oldEnd = Math.min(oldText.size(), lastEdit.endA + this.contextLines);
    const newStart = contextStart + (firstEdit.beginB - firstEdit.beginA);
    const newEnd = Math.min(newText.size(), lastEdit.endB + this.contextLines);

    let oldPos = oldStart;

    for (const edit of edits) {
      // Add context lines before this edit
      while (oldPos < edit.beginA) {
        lines.push(` ${oldText.getString(oldPos)}`);
        oldPos++;
      }

      // Add deleted lines
      for (let i = edit.beginA; i < edit.endA; i++) {
        lines.push(`-${oldText.getString(i)}`);
      }
      oldPos = edit.endA;

      // Add inserted lines
      for (let i = edit.beginB; i < edit.endB; i++) {
        lines.push(`+${newText.getString(i)}`);
      }
    }

    // Add trailing context
    while (oldPos < oldEnd) {
      lines.push(` ${oldText.getString(oldPos)}`);
      oldPos++;
    }

    return {
      oldStart: oldStart + 1, // Convert to 1-based
      oldCount: oldEnd - oldStart,
      newStart: newStart + 1, // Convert to 1-based
      newCount: newEnd - newStart,
      lines,
    };
  }
}
