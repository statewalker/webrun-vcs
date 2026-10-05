/**
 * FileHeader - represents a single file's changes in a patch
 *
 * Based on JGit's FileHeader.java
 * Parses Git-style patch headers like:
 *   diff --git a/file.txt b/file.txt
 *   index abc123..def456 100644
 *   --- a/file.txt
 *   +++ b/file.txt
 */

import { BinaryHunk } from "./binary-hunk.js";
import { decode, encodeASCII, isHunkHdr, match, nextLF, parseBase10 } from "./buffer-utils.js";
import { HunkHeader } from "./hunk-header.js";
import { ChangeType, PatchType } from "./types.js";

/** Pattern: "old mode " */
const OLD_MODE = encodeASCII("old mode ");

/** Pattern: "new mode " */
const NEW_MODE = encodeASCII("new mode ");

/** Pattern: "deleted file mode " */
const DELETED_FILE_MODE = encodeASCII("deleted file mode ");

/** Pattern: "new file mode " */
const NEW_FILE_MODE = encodeASCII("new file mode ");

/** Pattern: "index " */
const INDEX = encodeASCII("index ");

/** Pattern: "--- " */
const OLD_NAME = encodeASCII("--- ");

/** Pattern: "+++ " */
const NEW_NAME = encodeASCII("+++ ");

/** Pattern: "similarity index " */
const SIMILARITY_INDEX = encodeASCII("similarity index ");

/** Pattern: "rename from " */
const RENAME_FROM = encodeASCII("rename from ");

/** Pattern: "rename to " */
const RENAME_TO = encodeASCII("rename to ");

/** Pattern: "copy from " */
const COPY_FROM = encodeASCII("copy from ");

/** Pattern: "copy to " */
const COPY_TO = encodeASCII("copy to ");

/** Pattern: "GIT binary patch\n" */
const GIT_BINARY = encodeASCII("GIT binary patch\n");

/** Pattern: "literal " */
const LITERAL = encodeASCII("literal ");

/** Pattern: "delta " */
const DELTA = encodeASCII("delta ");

/**
 * Represents a file's patch header with metadata and hunks
 */
export class FileHeader {
  /** Buffer containing the patch data */
  readonly buffer: Uint8Array;

  /** Start offset of this file header in the buffer */
  readonly startOffset: number;

  /** End offset of this file header in the buffer */
  endOffset: number;

  /** Old (source) file path */
  oldPath: string | null = null;

  /** New (destination) file path */
  newPath: string | null = null;

  /** Old file mode (Unix permissions) */
  oldMode: number | null = null;

  /** New file mode (Unix permissions) */
  newMode: number | null = null;

  /** Old object ID (SHA-1 hash) */
  oldId: string | null = null;

  /** New object ID (SHA-1 hash) */
  newId: string | null = null;

  /** Type of change (ADD, DELETE, MODIFY, RENAME, COPY) */
  changeType: ChangeType = ChangeType.MODIFY;

  /** Type of patch (UNIFIED, BINARY, GIT_BINARY) */
  patchType: PatchType = PatchType.UNIFIED;

  /** Similarity index for renames/copies (0-100) */
  score = 0;

  /** List of text hunks */
  hunks: HunkHeader[] = [];

  /** Forward and reverse binary hunks (for GIT_BINARY patches) */
  forwardBinaryHunk: BinaryHunk | null = null;
  reverseBinaryHunk: BinaryHunk | null = null;

  /**
   * Create a new file header
   *
   * @param buffer Buffer containing patch data
   * @param offset Starting offset in buffer
   */
  constructor(buffer: Uint8Array, offset: number) {
    this.buffer = buffer;
    this.startOffset = offset;
    this.endOffset = offset;
  }

  /**
   * Parse a Git-style file header starting with "diff --git"
   *
   * @param end End of buffer
   * @returns Next offset to continue parsing, or end if complete
   */
  parseGitFileHeader(end: number): number {
    let ptr = this.startOffset;

    // Parse the "diff --git a/... b/..." line
    ptr = this.parseGitFileName(ptr, end);
    if (ptr < 0) {
      this.endOffset = end;
      return end;
    }

    // Parse git extended headers (index, mode, rename, etc.)
    ptr = this.parseGitHeaders(ptr, end);

    // Parse hunks or binary data
    ptr = this.parseHunks(ptr, end);

    this.endOffset = ptr;
    return ptr;
  }

  /**
   * Parse the "diff --git a/path b/path" line
   *
   * @param ptr Current offset
   * @param end End of buffer
   * @returns Next offset after the line
   */
  private parseGitFileName(ptr: number, end: number): number {
    const eol = nextLF(this.buffer, ptr);
    if (eol >= end) {
      return -1;
    }

    // Skip "diff --git " prefix (11 bytes)
    const offset = ptr + 11;

    // Find the paths: "a/path b/path"
    // Look for space separator between the two paths
    let aStart = offset;

    // Skip "a/" prefix
    if (offset + 2 < eol && this.buffer[offset] === 0x61 && this.buffer[offset + 1] === 0x2f) {
      // 'a', '/'
      aStart = offset + 2;
    }

    // Find the space between the two paths
    let sp = aStart;
    while (sp < eol && this.buffer[sp] !== 0x20) {
      // ' '
      sp++;
    }

    if (sp >= eol) {
      // No space found - malformed
      return eol;
    }

    // Extract old path
    this.oldPath = decode(this.buffer, aStart, sp);

    // Skip space and "b/" prefix
    let bStart = sp + 1;
    if (bStart + 2 < eol && this.buffer[bStart] === 0x62 && this.buffer[bStart + 1] === 0x2f) {
      // 'b', '/'
      bStart += 2;
    }

    // Extract new path
    this.newPath = decode(this.buffer, bStart, eol - 1); // -1 to skip newline

    return eol;
  }

  /**
   * Parse Git extended headers (mode, index, rename, etc.)
   *
   * @param ptr Current offset
   * @param end End of buffer
   * @returns Next offset after headers
   */
  private parseGitHeaders(ptr: number, end: number): number {
    let offset = ptr;
    while (offset < end) {
      const eol = nextLF(this.buffer, offset);
      if (eol >= end) {
        return end;
      }

      // Check for various header types
      if (match(this.buffer, offset, OLD_MODE) >= 0) {
        this.oldMode = this.parseFileMode(offset + OLD_MODE.length, eol);
      } else if (match(this.buffer, offset, NEW_MODE) >= 0) {
        this.newMode = this.parseFileMode(offset + NEW_MODE.length, eol);
      } else if (match(this.buffer, offset, DELETED_FILE_MODE) >= 0) {
        this.oldMode = this.parseFileMode(offset + DELETED_FILE_MODE.length, eol);
        this.newMode = 0;
        this.changeType = ChangeType.DELETE;
      } else if (match(this.buffer, offset, NEW_FILE_MODE) >= 0) {
        this.oldMode = 0;
        this.newMode = this.parseFileMode(offset + NEW_FILE_MODE.length, eol);
        this.changeType = ChangeType.ADD;
      } else if (match(this.buffer, offset, INDEX) >= 0) {
        this.parseIndexLine(offset + INDEX.length, eol);
      } else if (match(this.buffer, offset, SIMILARITY_INDEX) >= 0) {
        this.score = this.parsePercentage(offset + SIMILARITY_INDEX.length, eol);
      } else if (match(this.buffer, offset, RENAME_FROM) >= 0) {
        this.oldPath = decode(this.buffer, offset + RENAME_FROM.length, eol - 1);
        this.changeType = ChangeType.RENAME;
      } else if (match(this.buffer, offset, RENAME_TO) >= 0) {
        this.newPath = decode(this.buffer, offset + RENAME_TO.length, eol - 1);
        this.changeType = ChangeType.RENAME;
      } else if (match(this.buffer, offset, COPY_FROM) >= 0) {
        this.oldPath = decode(this.buffer, offset + COPY_FROM.length, eol - 1);
        this.changeType = ChangeType.COPY;
      } else if (match(this.buffer, offset, COPY_TO) >= 0) {
        this.newPath = decode(this.buffer, offset + COPY_TO.length, eol - 1);
        this.changeType = ChangeType.COPY;
      } else if (match(this.buffer, offset, OLD_NAME) >= 0) {
        // Start of actual diff content
        return offset;
      } else if (match(this.buffer, offset, GIT_BINARY) >= 0) {
        // Binary patch - skip the "GIT binary patch\n" line
        this.patchType = PatchType.GIT_BINARY;
        return eol; // Return pointer after this line
      } else if (this.buffer[offset] === 0x40 && this.buffer[offset + 1] === 0x40) {
        // '@' - hunk header without --- +++ (malformed but handle it)
        return offset;
      }

      offset = eol;
    }

    return offset;
  }

  /**
   * Parse file mode from octal string
   *
   * @param ptr Start of mode string
   * @param end End of line
   * @returns File mode as number
   */
  private parseFileMode(ptr: number, end: number): number {
    let mode = 0;
    let offset = ptr;
    while (offset < end) {
      const c = this.buffer[offset];
      if (c < 0x30 || c > 0x37) {
        // '0' to '7'
        break;
      }
      mode = (mode << 3) | (c - 0x30);
      offset++;
    }
    return mode;
  }

  /**
   * Parse index line: "abc123..def456 mode"
   *
   * @param ptr Start of index data
   * @param end End of line
   */
  private parseIndexLine(ptr: number, end: number): void {
    // Find ".."
    let dotdot = ptr;
    while (dotdot < end && this.buffer[dotdot] !== 0x2e) {
      // '.'
      dotdot++;
    }

    if (dotdot + 1 < end && this.buffer[dotdot + 1] === 0x2e) {
      // Found ".."
      this.oldId = decode(this.buffer, ptr, dotdot);

      // Find end of new ID (space or newline)
      let idEnd = dotdot + 2;
      while (idEnd < end && this.buffer[idEnd] !== 0x20 && this.buffer[idEnd] !== 0x0a) {
        idEnd++;
      }

      this.newId = decode(this.buffer, dotdot + 2, idEnd);

      // Parse mode if present
      if (idEnd < end && this.buffer[idEnd] === 0x20) {
        const mode = this.parseFileMode(idEnd + 1, end);
        if (this.newMode === null) {
          this.newMode = mode;
        }
        if (this.oldMode === null) {
          this.oldMode = mode;
        }
      }
    }
  }

  /**
   * Parse percentage value (e.g., "95%")
   *
   * @param ptr Start of percentage
   * @param end End of line
   * @returns Percentage value (0-100)
   */
  private parsePercentage(ptr: number, _end: number): number {
    const [value] = parseBase10(this.buffer, ptr);
    return value;
  }

  /**
   * Parse hunks (either text hunks or binary hunks)
   *
   * @param ptr Current offset
   * @param end End of buffer
   * @returns Next offset
   */
  private parseHunks(ptr: number, end: number): number {
    // Handle binary patches
    if (this.patchType === PatchType.GIT_BINARY) {
      return this.parseBinaryHunks(ptr, end);
    }

    let offset = ptr;

    // Skip "--- " line if present (for text patches)
    if (match(this.buffer, offset, OLD_NAME) >= 0) {
      offset = nextLF(this.buffer, offset);
    }

    // Skip "+++ " line if present
    if (offset < end && match(this.buffer, offset, NEW_NAME) >= 0) {
      offset = nextLF(this.buffer, offset);
    }

    // Parse all text hunks in this file
    while (offset < end && isHunkHdr(this.buffer, offset, end) === 1) {
      const hunk = new HunkHeader(this.buffer, offset);
      offset = hunk.parse(end);
      this.hunks.push(hunk);
    }

    return offset;
  }

  /**
   * Parse binary hunks (forward and reverse)
   *
   * @param ptr Current offset
   * @param end End of buffer
   * @returns Next offset
   */
  private parseBinaryHunks(ptr: number, end: number): number {
    let offset = ptr;

    // Parse forward binary hunk (literal or delta)
    if (
      offset < end &&
      (match(this.buffer, offset, LITERAL) >= 0 || match(this.buffer, offset, DELTA) >= 0)
    ) {
      const hunk = new BinaryHunk(this.buffer, offset);
      offset = hunk.parse(end);
      this.forwardBinaryHunk = hunk;
    }

    // Parse reverse binary hunk (for reversible patches)
    if (
      offset < end &&
      (match(this.buffer, offset, LITERAL) >= 0 || match(this.buffer, offset, DELTA) >= 0)
    ) {
      const hunk = new BinaryHunk(this.buffer, offset);
      offset = hunk.parse(end);
      this.reverseBinaryHunk = hunk;
    }

    return offset;
  }

  /**
   * Parse a combined diff header ("diff --cc" or "diff --combined")
   *
   * Combined diffs are used for merge commits showing changes from multiple parents.
   * The format differs from regular diffs in that each line may have multiple
   * prefix characters (one per parent).
   *
   * @param end End of buffer
   * @param markerLength Length of the marker ("diff --cc " or "diff --combined ")
   * @returns Next offset to continue parsing, or end if complete
   */
  parseCombinedHeader(end: number, markerLength: number): number {
    let ptr = this.startOffset;

    // Parse the "diff --cc path" or "diff --combined path" line
    const eol = nextLF(this.buffer, ptr);
    if (eol >= end) {
      this.endOffset = end;
      return end;
    }

    // Extract path (skip the marker)
    const pathStart = ptr + markerLength;
    const pathEnd = eol - 1; // Skip newline
    this.oldPath = decode(this.buffer, pathStart, pathEnd);
    this.newPath = this.oldPath;
    ptr = eol;

    // Parse headers until we hit hunks or end
    while (ptr < end) {
      const lineEnd = nextLF(this.buffer, ptr);

      // Check for index line (can have multiple parent IDs: "index abc,def..ghi")
      if (match(this.buffer, ptr, INDEX) >= 0) {
        this.parseCombinedIndexLine(ptr + INDEX.length, lineEnd);
        ptr = lineEnd;
        continue;
      }

      // Check for mode lines
      if (match(this.buffer, ptr, OLD_MODE) >= 0) {
        this.oldMode = this.parseFileMode(ptr + OLD_MODE.length, lineEnd);
        ptr = lineEnd;
        continue;
      }
      if (match(this.buffer, ptr, NEW_MODE) >= 0) {
        this.newMode = this.parseFileMode(ptr + NEW_MODE.length, lineEnd);
        ptr = lineEnd;
        continue;
      }

      // Check for --- line (combined diffs can have multiple --- lines)
      if (match(this.buffer, ptr, OLD_NAME) >= 0) {
        ptr = lineEnd;
        continue;
      }

      // Check for +++ line
      if (match(this.buffer, ptr, NEW_NAME) >= 0) {
        ptr = lineEnd;
        continue;
      }

      // Check for combined hunk header (@@@ or more @)
      if (this.isCombinedHunkHdr(ptr, end)) {
        ptr = this.parseCombinedHunks(ptr, end);
        break;
      }

      // Unknown line - move to next
      ptr = lineEnd;
    }

    this.endOffset = ptr;
    return ptr;
  }

  /**
   * Check if current position is a combined hunk header (@@@ or more)
   */
  private isCombinedHunkHdr(ptr: number, end: number): boolean {
    // Combined hunks start with 3+ @ characters
    if (ptr + 3 > end) return false;
    return (
      this.buffer[ptr] === 0x40 && this.buffer[ptr + 1] === 0x40 && this.buffer[ptr + 2] === 0x40
    );
  }

  /**
   * Parse combined diff index line (e.g., "abc123,def456..789012")
   */
  private parseCombinedIndexLine(ptr: number, end: number): void {
    // Find ".." separator
    let dotdot = ptr;
    while (dotdot < end - 1) {
      if (this.buffer[dotdot] === 0x2e && this.buffer[dotdot + 1] === 0x2e) {
        break;
      }
      dotdot++;
    }

    if (dotdot < end - 1) {
      // Everything before ".." is parent IDs (comma-separated)
      // Everything after ".." is the result ID
      let idEnd = dotdot + 2;
      while (idEnd < end && this.buffer[idEnd] !== 0x20 && this.buffer[idEnd] !== 0x0a) {
        idEnd++;
      }
      this.newId = decode(this.buffer, dotdot + 2, idEnd);
    }
  }

  /**
   * Parse combined diff hunks
   *
   * Combined hunks have a different format:
   *   @@@ -1,5 -1,5 +1,6 @@@
   * Each line has N prefix characters (one per parent)
   */
  private parseCombinedHunks(ptr: number, end: number): number {
    // For now, parse combined hunks similarly to regular hunks
    // but handle the extended hunk header format
    while (ptr < end && this.isCombinedHunkHdr(ptr, end)) {
      const hunk = new HunkHeader(this.buffer, ptr);
      // Parse the hunk with combined format awareness
      ptr = this.parseCombinedHunk(hunk, ptr, end);
      this.hunks.push(hunk);
    }
    return ptr;
  }

  /**
   * Parse a single combined hunk
   */
  private parseCombinedHunk(hunk: HunkHeader, ptr: number, end: number): number {
    // Parse the header line: @@@ -start,count -start,count +start,count @@@
    const headerEnd = nextLF(this.buffer, ptr);

    // Skip to after header line (startOffset is set in constructor)
    ptr = headerEnd;

    // Parse hunk body lines
    while (ptr < end) {
      const lineEnd = nextLF(this.buffer, ptr);

      // Check if this is a new combined hunk header
      if (this.isCombinedHunkHdr(ptr, end)) {
        break;
      }

      // Check for next file (diff --cc, diff --git, etc.)
      if (this.isNextFileStart(ptr)) {
        break;
      }

      ptr = lineEnd;
    }

    hunk.endOffset = ptr;
    return ptr;
  }

  /**
   * Check if current position starts a new file header
   */
  private isNextFileStart(ptr: number): boolean {
    const DIFF = encodeASCII("diff ");
    return match(this.buffer, ptr, DIFF) >= 0;
  }

  /**
   * Parse a traditional unified diff header ("--- ... \n+++ ...")
   *
   * Traditional diffs don't have "diff --git" prefix or extended headers.
   * They start directly with the old/new file markers.
   *
   * @param end End of buffer
   * @returns Next offset to continue parsing, or end if complete
   */
  parseTraditionalHeader(end: number): number {
    let ptr = this.startOffset;

    // Parse "--- path" line
    if (match(this.buffer, ptr, OLD_NAME) >= 0) {
      const eol = nextLF(this.buffer, ptr);
      this.oldPath = this.parseTraditionalPath(ptr + OLD_NAME.length, eol);
      ptr = eol;
    } else {
      // Invalid format
      this.endOffset = end;
      return end;
    }

    // Parse "+++ path" line
    if (ptr < end && match(this.buffer, ptr, NEW_NAME) >= 0) {
      const eol = nextLF(this.buffer, ptr);
      this.newPath = this.parseTraditionalPath(ptr + NEW_NAME.length, eol);
      ptr = eol;
    } else {
      // Invalid format
      this.endOffset = end;
      return end;
    }

    // Determine change type based on paths
    if (this.oldPath === "/dev/null") {
      this.changeType = ChangeType.ADD;
      this.oldPath = null;
    } else if (this.newPath === "/dev/null") {
      this.changeType = ChangeType.DELETE;
      this.newPath = null;
    } else {
      this.changeType = ChangeType.MODIFY;
    }

    // Parse all text hunks in this file
    while (ptr < end && isHunkHdr(this.buffer, ptr, end) === 1) {
      const hunk = new HunkHeader(this.buffer, ptr);
      ptr = hunk.parse(end);
      this.hunks.push(hunk);
    }

    this.endOffset = ptr;
    return ptr;
  }

  /**
   * Parse a traditional path from "--- " or "+++ " line
   *
   * Traditional paths can have various formats:
   *   --- a/path/file.txt
   *   --- path/file.txt
   *   --- /dev/null
   *   --- a/path/file.txt\t2024-01-01 12:00:00
   *
   * @param ptr Start of path
   * @param end End of line
   * @returns Extracted path
   */
  private parseTraditionalPath(ptr: number, end: number): string {
    // Skip leading whitespace
    while (ptr < end && (this.buffer[ptr] === 0x20 || this.buffer[ptr] === 0x09)) {
      ptr++;
    }

    // Find end of path (tab, newline, or end of buffer)
    let pathEnd = ptr;
    while (pathEnd < end) {
      const c = this.buffer[pathEnd];
      if (c === 0x09 || c === 0x0a || c === 0x0d) {
        // Tab, LF, or CR
        break;
      }
      pathEnd++;
    }

    let path = decode(this.buffer, ptr, pathEnd);

    // Strip "a/" or "b/" prefix if present (Git-style in traditional)
    if (path.startsWith("a/") || path.startsWith("b/")) {
      path = path.slice(2);
    }

    return path;
  }

  /**
   * Get a string representation of this file header
   */
  toString(): string {
    return `FileHeader(${this.changeType}: ${this.oldPath} -> ${this.newPath})`;
  }
}
