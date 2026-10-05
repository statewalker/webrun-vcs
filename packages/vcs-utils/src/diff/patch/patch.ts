/**
 * Patch parser - entry point for parsing Git patch files
 *
 * Based on JGit's Patch.java
 * Supports:
 * - Unified diff format (diff -u)
 * - Git extended diff (diff --git)
 * - Binary patches (GIT binary patch)
 * - Combined diff (diff --cc)
 */

import { encodeASCII, isHunkHdr, match, nextLF } from "./buffer-utils.js";
import { FileHeader } from "./file-header.js";
import type { FormatError } from "./types.js";

/** Pattern: "diff --git " */
const DIFF_GIT = encodeASCII("diff --git ");

/** Pattern: "diff --cc " (combined diff) */
const DIFF_CC = encodeASCII("diff --cc ");

/** Pattern: "diff --combined " */
const DIFF_COMBINED = encodeASCII("diff --combined ");

/** Pattern: "--- " (old file marker) */
const OLD_NAME = encodeASCII("--- ");

/** Pattern: "+++ " (new file marker) */
const NEW_NAME = encodeASCII("+++ ");

/** Pattern: "GIT binary patch\n" */
const _GIT_BINARY = encodeASCII("GIT binary patch\n");

/** Pattern: "-- \n" (signature footer) */
const _SIG_FOOTER = encodeASCII("-- \n");

/**
 * Parsed patch file containing multiple file changes
 */
export class Patch {
  /** List of file changes in the patch */
  private files: FileHeader[] = [];

  /** Formatting errors encountered during parsing */
  private errors: FormatError[] = [];

  /**
   * Get list of files in the patch
   *
   * @returns Array of file headers in order of appearance
   */
  getFiles(): readonly FileHeader[] {
    return this.files;
  }

  /**
   * Get formatting errors
   *
   * @returns Array of errors encountered during parsing
   */
  getErrors(): readonly FormatError[] {
    return this.errors;
  }

  /**
   * Add a formatting error
   *
   * @param message Error message
   * @param offset Byte offset where error occurred
   */
  private addError(message: string, offset: number): void {
    this.errors.push({
      message,
      offset,
      severity: "error",
    });
  }

  /**
   * Parse patch data from bytes
   *
   * @param buffer Patch data to parse
   * @param offset Starting offset in buffer
   * @param end Ending offset in buffer
   */
  parse(buffer: Uint8Array, offset = 0, end?: number): void {
    const finalEnd = end ?? buffer.length;
    let ptr = offset;

    while (ptr < finalEnd) {
      ptr = this.parseFile(buffer, ptr, finalEnd);
    }
  }

  /**
   * Parse a single file from the patch
   *
   * @param buffer Patch data
   * @param offset Current offset
   * @param end End of buffer
   * @returns Next offset to continue parsing
   */
  private parseFile(buffer: Uint8Array, offset: number, end: number): number {
    let ptr = offset;

    while (ptr < end) {
      // Check for disconnected hunk header
      if (isHunkHdr(buffer, ptr, end) >= 1) {
        this.addError("Hunk disconnected from file header", ptr);
        ptr = nextLF(buffer, ptr);
        continue;
      }

      // Check for Git-style patch
      if (match(buffer, ptr, DIFF_GIT) >= 0) {
        return this.parseDiffGit(buffer, ptr, end);
      }

      // Check for combined diff
      if (match(buffer, ptr, DIFF_CC) >= 0) {
        return this.parseDiffCombined(buffer, ptr, end, DIFF_CC);
      }

      if (match(buffer, ptr, DIFF_COMBINED) >= 0) {
        return this.parseDiffCombined(buffer, ptr, end, DIFF_COMBINED);
      }

      // Check for traditional patch format
      const lineEnd = nextLF(buffer, ptr);
      if (lineEnd >= end) {
        // Single line at end - trailing junk
        return end;
      }

      // Minimum header: "--- a/b\n"
      if (lineEnd - ptr < 6) {
        ptr = lineEnd;
        continue;
      }

      // Traditional patch: "--- " followed by "+++ "
      if (match(buffer, ptr, OLD_NAME) >= 0 && match(buffer, lineEnd, NEW_NAME) >= 0) {
        const hunkStart = nextLF(buffer, lineEnd);
        if (hunkStart >= end) {
          return end;
        }

        // Verify next line is a hunk header
        if (isHunkHdr(buffer, hunkStart, end) === 1) {
          return this.parseTraditionalPatch(buffer, ptr, end);
        }
      }

      ptr = lineEnd;
    }

    return end;
  }

  /**
   * Parse a git-style diff ("diff --git a/... b/...")
   */
  private parseDiffGit(buffer: Uint8Array, offset: number, end: number): number {
    const header = new FileHeader(buffer, offset);
    const nextOffset = header.parseGitFileHeader(end);
    this.files.push(header);
    return nextOffset;
  }

  /**
   * Parse a combined diff ("diff --cc" or "diff --combined")
   *
   * Combined diffs are used for merge commits showing changes from multiple parents.
   * Format:
   *   diff --cc file.txt
   *   index abc123,def456..789012
   *   --- a/file.txt
   *   +++ b/file.txt
   *   @@@ -1,5 -1,5 +1,6 @@@
   */
  private parseDiffCombined(
    buffer: Uint8Array,
    offset: number,
    end: number,
    marker: Uint8Array,
  ): number {
    const header = new FileHeader(buffer, offset);
    const nextOffset = header.parseCombinedHeader(end, marker.length);
    this.files.push(header);
    return nextOffset;
  }

  /**
   * Parse a traditional unified diff ("--- ... \\n+++ ...")
   *
   * Traditional patches don't have "diff --git" headers, they just start with:
   *   --- path/to/old
   *   +++ path/to/new
   *   @@ -1,5 +1,6 @@
   */
  private parseTraditionalPatch(buffer: Uint8Array, offset: number, end: number): number {
    const header = new FileHeader(buffer, offset);
    const nextOffset = header.parseTraditionalHeader(end);
    this.files.push(header);
    return nextOffset;
  }
}
