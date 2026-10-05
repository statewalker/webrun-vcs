/**
 * PatchApplier - applies patches to file content
 *
 * Based on JGit's PatchApplier.java
 * Supports:
 * - Text patch application with fuzzy matching
 * - Binary patch application (literal and delta)
 * - Handling different change types (ADD, DELETE, MODIFY, RENAME, COPY)
 */

import { decompressBlock } from "../../compression/index.js";
import { decodeGitBinaryDelta } from "./binary-delta.js";
import { nextLF } from "./buffer-utils.js";
import type { FileHeader } from "./file-header.js";
import type { HunkHeader } from "./hunk-header.js";
import { BinaryHunkType, ChangeType, PatchType } from "./types.js";

/**
 * Result of applying a patch to a single file
 */
export interface FileApplyResult {
  /** Whether the patch was applied successfully */
  success: boolean;
  /** The resulting content after applying the patch */
  content: Uint8Array | null;
  /** List of errors encountered during application */
  errors: string[];
  /** List of warnings */
  warnings: string[];
}

/**
 * Options for patch application
 */
export interface ApplyOptions {
  /** Allow conflicts and insert conflict markers */
  allowConflicts?: boolean;
  /** Maximum number of lines to shift when fuzzy matching (default: 100) */
  maxFuzz?: number;
}

/**
 * Represents a line in the file
 */
interface Line {
  /** Line content as bytes */
  content: Uint8Array;
  /** Whether this line ends with \r\n (CRLF) */
  hasCrLf: boolean;
}

/**
 * PatchApplier applies patches to file content
 */
export class PatchApplier {
  private errors: string[] = [];
  private warnings: string[] = [];
  private readonly allowConflicts: boolean;
  private readonly maxFuzz: number;

  constructor(options: ApplyOptions = {}) {
    this.allowConflicts = options.allowConflicts ?? false;
    this.maxFuzz = options.maxFuzz ?? 100;
  }

  /**
   * Apply a file header patch to content
   *
   * @param fileHeader The file header containing hunks to apply
   * @param oldContent The original file content (null for ADD)
   * @returns Result of applying the patch
   */
  async apply(fileHeader: FileHeader, oldContent: Uint8Array | null): Promise<FileApplyResult> {
    this.errors = [];
    this.warnings = [];

    try {
      // Handle different change types
      switch (fileHeader.changeType) {
        case ChangeType.ADD:
          return await this.applyAdd(fileHeader);

        case ChangeType.DELETE:
          return this.applyDelete();

        case ChangeType.MODIFY:
        case ChangeType.RENAME:
        case ChangeType.COPY:
          if (!oldContent) {
            this.errors.push("Cannot modify/rename/copy: old content is null");
            return this.createResult(false, null);
          }
          return await this.applyModify(fileHeader, oldContent);

        default:
          this.errors.push(`Unknown change type: ${fileHeader.changeType}`);
          return this.createResult(false, null);
      }
    } catch (error) {
      this.errors.push(`Unexpected error: ${error}`);
      return this.createResult(false, null);
    }
  }

  /**
   * Apply ADD operation (create new file)
   */
  private async applyAdd(fileHeader: FileHeader): Promise<FileApplyResult> {
    // Handle binary ADD (new binary file)
    if (fileHeader.patchType === PatchType.GIT_BINARY) {
      return await this.applyBinary(fileHeader, new Uint8Array(0));
    }

    // For text ADD, we start with empty content and apply all hunks
    const emptyLines: Line[] = [];
    return this.applyHunks(fileHeader, emptyLines);
  }

  /**
   * Apply DELETE operation (remove file)
   */
  private applyDelete(): FileApplyResult {
    // DELETE means the file should be removed
    return this.createResult(true, null);
  }

  /**
   * Apply MODIFY operation (modify existing file)
   */
  private async applyModify(
    fileHeader: FileHeader,
    oldContent: Uint8Array,
  ): Promise<FileApplyResult> {
    // Handle binary patches
    if (fileHeader.patchType === PatchType.GIT_BINARY) {
      return await this.applyBinary(fileHeader, oldContent);
    }

    // Parse old content into lines
    const oldLines = this.parseLines(oldContent);

    // Apply text hunks
    return this.applyHunks(fileHeader, oldLines);
  }

  /**
   * Apply binary patch
   */
  private async applyBinary(
    fileHeader: FileHeader,
    oldContent: Uint8Array,
  ): Promise<FileApplyResult> {
    if (!fileHeader.forwardBinaryHunk) {
      this.errors.push("Binary patch has no forward hunk");
      return this.createResult(false, null);
    }

    try {
      const hunk = fileHeader.forwardBinaryHunk;

      // Get base85-decoded data
      const encodedData = hunk.getData();

      // Decompress the data (Git uses ZLIB format)
      let inflatedData: Uint8Array;
      try {
        inflatedData = await decompressBlock(encodedData, { raw: false });
      } catch (err) {
        this.errors.push(`Failed to decompress binary data: ${err}`);
        return this.createResult(false, null);
      }

      // Apply based on hunk type
      let result: Uint8Array;

      switch (hunk.type) {
        case BinaryHunkType.LITERAL_DEFLATED:
          // Literal: decompressed data is the result
          result = inflatedData;
          break;

        case BinaryHunkType.DELTA_DEFLATED:
          // Delta: apply Git binary delta to old content
          try {
            result = decodeGitBinaryDelta(oldContent, inflatedData);
          } catch (err) {
            this.errors.push(`Failed to apply binary delta: ${err}`);
            return this.createResult(false, null);
          }
          break;

        default:
          this.errors.push(`Unknown binary hunk type: ${hunk.type}`);
          return this.createResult(false, null);
      }

      // Verify size matches expected size
      if (result.length !== hunk.size) {
        this.warnings.push(
          `Binary hunk size mismatch: expected ${hunk.size}, got ${result.length}`,
        );
      }

      return this.createResult(true, result);
    } catch (error) {
      this.errors.push(`Binary patch application failed: ${error}`);
      return this.createResult(false, null);
    }
  }

  /**
   * Apply text hunks to content
   */
  private applyHunks(fileHeader: FileHeader, oldLines: Line[]): FileApplyResult {
    const newLines = [...oldLines];
    let afterLastHunk = 0;

    // Apply each hunk
    for (const hunk of fileHeader.hunks) {
      const result = this.applyHunk(hunk, newLines, afterLastHunk);

      if (!result.success) {
        if (this.allowConflicts) {
          this.warnings.push(`Hunk at line ${hunk.oldStartLine} has conflicts`);
          // Insert conflict markers at the expected position
          const conflictResult = this.insertConflictMarkers(hunk, newLines, afterLastHunk);
          afterLastHunk = conflictResult.position;
        } else {
          this.errors.push(`Failed to apply hunk at line ${hunk.oldStartLine}`);
          return this.createResult(false, null);
        }
      } else {
        afterLastHunk = result.position;
      }
    }

    // Convert lines back to bytes
    const content = this.linesToBytes(newLines);
    return this.createResult(true, content);
  }

  /**
   * Apply a single hunk to the content
   */
  private applyHunk(
    hunk: HunkHeader,
    lines: Line[],
    afterLastHunk: number,
  ): { success: boolean; position: number } {
    // Find best position for this hunk using fuzzy matching
    const expectedPosition = hunk.newStartLine - 1;
    const bestPosition = this.findBestHunkPosition(hunk, lines, expectedPosition, afterLastHunk);

    if (bestPosition < 0) {
      return { success: false, position: afterLastHunk };
    }

    // Apply the hunk at the found position
    let currentLine = bestPosition;
    const hunkLines = this.parseHunkLines(hunk);

    for (const hunkLine of hunkLines) {
      switch (hunkLine.type) {
        case " ": // Context line
          currentLine++;
          break;

        case "-": // Deletion
          lines.splice(currentLine, 1);
          break;

        case "+": // Addition
          lines.splice(currentLine, 0, hunkLine.line);
          currentLine++;
          break;
      }
    }

    return { success: true, position: currentLine };
  }

  /**
   * Insert conflict markers when a hunk cannot be applied
   */
  private insertConflictMarkers(
    hunk: HunkHeader,
    lines: Line[],
    afterLastHunk: number,
  ): { position: number } {
    const expectedPosition = hunk.newStartLine - 1;
    const insertPosition = Math.max(afterLastHunk, Math.min(expectedPosition, lines.length));

    // Parse the hunk to get the expected old content and new content
    const hunkLines = this.parseHunkLines(hunk);

    // Extract "ours" (current content at that location) and "theirs" (what patch wants)
    const oursLines: Line[] = [];
    const theirsLines: Line[] = [];

    // Collect what the patch expects to find (context and deletions) as "ours"
    // and what it wants to add (additions) as "theirs"
    for (const hl of hunkLines) {
      if (hl.type === " " || hl.type === "-") {
        // Context and deletion lines represent what was there ("ours")
        oursLines.push(hl.line);
      }
      if (hl.type === " " || hl.type === "+") {
        // Context and addition lines represent what should be there ("theirs")
        theirsLines.push(hl.line);
      }
    }

    // Create conflict marker lines
    const encoder = new TextEncoder();
    const conflictStart: Line = {
      content: encoder.encode("<<<<<<< ours"),
      hasCrLf: false,
    };
    const conflictSeparator: Line = {
      content: encoder.encode("======="),
      hasCrLf: false,
    };
    const conflictEnd: Line = {
      content: encoder.encode(">>>>>>> theirs"),
      hasCrLf: false,
    };

    // Build the conflict block
    const conflictBlock: Line[] = [
      conflictStart,
      ...oursLines,
      conflictSeparator,
      ...theirsLines,
      conflictEnd,
    ];

    // Remove the old lines at the conflict position (if they exist and match context/deletion count)
    const oldLineCount = hunkLines.filter((hl) => hl.type === " " || hl.type === "-").length;
    const linesToRemove = Math.min(oldLineCount, lines.length - insertPosition);

    // Replace old content with conflict block
    lines.splice(insertPosition, linesToRemove, ...conflictBlock);

    // Return position after the conflict block
    return { position: insertPosition + conflictBlock.length };
  }

  /**
   * Find the best position to apply a hunk using fuzzy matching
   */
  private findBestHunkPosition(
    hunk: HunkHeader,
    lines: Line[],
    expectedPosition: number,
    afterLastHunk: number,
  ): number {
    const oldLinesInHunk = hunk.contextLineCount + hunk.deletedLineCount;

    // Can't do fuzzy matching without context
    if (oldLinesInHunk <= 1) {
      if (this.canApplyAt(hunk, lines, expectedPosition)) {
        return expectedPosition;
      }
      return -1;
    }

    // Try shifting backwards first (prefer earlier positions)
    const maxBackShift = Math.min(expectedPosition - afterLastHunk, this.maxFuzz);
    for (let shift = 0; shift <= maxBackShift; shift++) {
      const pos = expectedPosition - shift;
      if (this.canApplyAt(hunk, lines, pos)) {
        if (shift > 0) {
          this.warnings.push(`Applied hunk at line ${pos + 1} (shifted by -${shift} lines)`);
        }
        return pos;
      }
    }

    // Try shifting forwards
    const maxForwardShift = Math.min(
      lines.length - expectedPosition - oldLinesInHunk,
      this.maxFuzz,
    );
    for (let shift = 1; shift <= maxForwardShift; shift++) {
      const pos = expectedPosition + shift;
      if (this.canApplyAt(hunk, lines, pos)) {
        this.warnings.push(`Applied hunk at line ${pos + 1} (shifted by +${shift} lines)`);
        return pos;
      }
    }

    return -1;
  }

  /**
   * Check if a hunk can be applied at a specific position
   */
  private canApplyAt(hunk: HunkHeader, lines: Line[], position: number): boolean {
    const hunkLines = this.parseHunkLines(hunk);
    let currentLine = position;

    for (const hunkLine of hunkLines) {
      if (hunkLine.type === "+") {
        // Addition doesn't need to match
        continue;
      }

      // Check if we have enough lines
      if (currentLine >= lines.length) {
        return false;
      }

      // Context and deletion lines must match
      if (hunkLine.type === " " || hunkLine.type === "-") {
        const fileLine = lines[currentLine];
        if (!this.linesMatch(hunkLine.line, fileLine)) {
          return false;
        }
        currentLine++;
      }
    }

    return true;
  }

  /**
   * Check if two lines match (ignoring trailing whitespace)
   */
  private linesMatch(line1: Line, line2: Line): boolean {
    // Compare content, ignoring trailing whitespace
    const content1 = this.trimTrailingWhitespace(line1.content);
    const content2 = this.trimTrailingWhitespace(line2.content);

    if (content1.length !== content2.length) {
      return false;
    }

    for (let i = 0; i < content1.length; i++) {
      if (content1[i] !== content2[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Trim trailing whitespace from a line
   */
  private trimTrailingWhitespace(content: Uint8Array): Uint8Array {
    let end = content.length;
    while (end > 0 && (content[end - 1] === 0x20 || content[end - 1] === 0x09)) {
      // space or tab
      end--;
    }
    return content.slice(0, end);
  }

  /**
   * Parse lines from a hunk
   */
  private parseHunkLines(hunk: HunkHeader): Array<{ type: string; line: Line }> {
    const result: Array<{ type: string; line: Line }> = [];
    let ptr = hunk.startOffset;

    // Skip hunk header line
    ptr = nextLF(hunk.buffer, ptr);

    // Parse each line in the hunk
    while (ptr < hunk.endOffset) {
      const lineType = hunk.getLineType(ptr);

      if (lineType === "\\") {
        // "No newline at end of file" marker
        ptr = nextLF(hunk.buffer, ptr);
        continue;
      }

      if (lineType !== " " && lineType !== "-" && lineType !== "+") {
        // End of hunk or unknown line type
        break;
      }

      // Extract line content (skip the +/- prefix)
      const lineEnd = nextLF(hunk.buffer, ptr);
      const contentStart = ptr + 1; // Skip the type character

      // Check for CRLF
      let contentEnd = lineEnd - 1; // Skip newline
      const hasCrLf = contentEnd > contentStart && hunk.buffer[contentEnd - 1] === 0x0d;
      if (hasCrLf) {
        contentEnd--; // Skip CR
      }

      const content = hunk.buffer.slice(contentStart, contentEnd);
      result.push({
        type: lineType,
        line: { content, hasCrLf },
      });

      ptr = lineEnd;
    }

    return result;
  }

  /**
   * Parse content into lines
   */
  private parseLines(content: Uint8Array): Line[] {
    const lines: Line[] = [];
    let offset = 0;

    while (offset < content.length) {
      const lineEnd = nextLF(content, offset);

      // Extract line content
      let contentEnd = lineEnd;
      if (contentEnd > offset && content[contentEnd - 1] === 0x0a) {
        contentEnd--; // Skip LF
      }

      const hasCrLf = contentEnd > offset && content[contentEnd - 1] === 0x0d;
      if (hasCrLf) {
        contentEnd--; // Skip CR
      }

      const lineContent = content.slice(offset, contentEnd);
      lines.push({ content: lineContent, hasCrLf });

      offset = lineEnd;
      if (offset >= content.length) {
        break;
      }
    }

    return lines;
  }

  /**
   * Convert lines back to bytes
   */
  private linesToBytes(lines: Line[]): Uint8Array {
    // Calculate total size
    let totalSize = 0;
    for (const line of lines) {
      totalSize += line.content.length;
      if (line.hasCrLf) {
        totalSize += 2; // CR + LF
      } else {
        totalSize += 1; // LF
      }
    }

    // Allocate buffer and copy lines
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const line of lines) {
      result.set(line.content, offset);
      offset += line.content.length;

      if (line.hasCrLf) {
        result[offset++] = 0x0d; // CR
        result[offset++] = 0x0a; // LF
      } else {
        result[offset++] = 0x0a; // LF
      }
    }

    return result;
  }

  /**
   * Create a result object
   */
  private createResult(success: boolean, content: Uint8Array | null): FileApplyResult {
    return {
      success,
      content,
      errors: [...this.errors],
      warnings: [...this.warnings],
    };
  }

  /**
   * Get errors from the last apply operation
   */
  getErrors(): string[] {
    return [...this.errors];
  }

  /**
   * Get warnings from the last apply operation
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }
}
