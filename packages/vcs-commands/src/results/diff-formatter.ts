/**
 * Formatter for unified diffs of DiffEntry objects, byte for byte as `git diff` prints them
 * (see {@link formatPatch} for the rules).
 */

import { type Blobs, DEFAULT_BIG_FILE_THRESHOLD } from "@statewalker/vcs-core";
import { ByteSink, type SupportedAlgorithm, type XdiffAlgorithm } from "@statewalker/vcs-utils";

import { ChangeType, type DiffEntry } from "./diff-entry.js";
import {
  blobSide,
  contentSide,
  type DiffFilePair,
  type DiffOutputOptions,
  type DiffSideSpec,
  type PairPatchReport,
  writePairPatch,
} from "./diff-output.js";

/**
 * Options for diff formatting.
 */
export interface DiffFormatterOptions extends Omit<DiffOutputOptions, "algorithm"> {
  /** Number of context lines around changes (default: 3; same as `context`) */
  contextLines?: number;
  /** Whether to include file headers (default: true) */
  includeHeaders?: boolean;
  /** Whether to abbreviate object IDs (default: true) */
  abbreviateIds?: boolean;
  /** Length of abbreviated object IDs (default: 7) */
  abbreviationLength?: number;
  /** Diff algorithm (default: myers, as git's `diff.algorithm`) */
  algorithm?: XdiffAlgorithm | SupportedAlgorithm;
  /**
   * Files larger than this are binary: they show as "Binary files differ" and are
   * never loaded (git's `core.bigFileThreshold`). Default 50 MiB.
   */
  bigFileThreshold?: number;
}

/**
 * A hunk in unified diff format.
 */
export interface DiffHunk {
  /** Starting line in old file, as printed (1-based; the line before for an empty range) */
  oldStart: number;
  /** Number of lines from old file */
  oldCount: number;
  /** Starting line in new file, as printed */
  newStart: number;
  /** Number of lines from new file */
  newCount: number;
  /** The function line of the hunk header ("" when none) */
  functionName?: string;
  /**
   * Lines in the hunk (prefixed with ' ', '+', or '-', without line terminator), with
   * "\ No newline at end of file" after a line without one
   */
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
  /** Old file header (e.g., "--- a/path"), when hunks follow */
  oldFileHeader?: string;
  /** New file header (e.g., "+++ b/path"), when hunks follow */
  newFileHeader?: string;
  /** Index line (e.g., "index abc123..def456 100644") */
  indexLine?: string;
  /** Lines between the `diff --git` line and the file headers, each with its LF */
  extendedHeaders?: string;
  /** Hunks of changes */
  hunks: DiffHunk[];
  /** Raw old content of a text file (binary files are not loaded) */
  oldContent?: Uint8Array;
  /** Raw new content of a text file (binary files are not loaded) */
  newContent?: Uint8Array;
  /** The file's part of `git diff` output, exactly (empty when git prints nothing for it) */
  patch: Uint8Array;
}

const decoder = new TextDecoder();

/** The file pair of a diff entry: blob sides, or the content the entry reads */
export function diffEntryToPair(entry: DiffEntry, blobs: Blobs): DiffFilePair {
  const side = (
    path: string | undefined,
    mode: number | undefined,
    id: string | undefined,
    read: (() => Promise<Uint8Array>) | undefined,
    idValid = false,
  ): DiffSideSpec | undefined => {
    if (path === undefined || id === undefined) return undefined;
    const m = mode ?? 0o100644;
    return read ? contentSide(path, m, id, read, idValid) : blobSide(blobs, path, m, id);
  };
  const status =
    entry.changeType === ChangeType.ADD
      ? "A"
      : entry.changeType === ChangeType.DELETE
        ? "D"
        : entry.changeType === ChangeType.RENAME
          ? "R"
          : entry.changeType === ChangeType.COPY
            ? "C"
            : entry.oldMode !== undefined &&
                entry.newMode !== undefined &&
                (entry.oldMode & 0o170000) !== (entry.newMode & 0o170000)
              ? "T"
              : "M";
  return {
    status,
    old:
      status === "A"
        ? undefined
        : side(entry.oldPath ?? entry.newPath, entry.oldMode, entry.oldId, entry.readOld),
    new:
      status === "D"
        ? undefined
        : side(
            entry.newPath ?? entry.oldPath,
            entry.newMode,
            entry.newId,
            entry.readNew,
            entry.newDirtySubmodule === true,
          ),
    ...(entry.score !== undefined ? { score: entry.score } : {}),
  };
}

/**
 * Format DiffEntry objects into unified diff format, as `git diff` prints them.
 *
 * @example
 * ```typescript
 * const formatter = new DiffFormatter(store.blobs);
 *
 * // Get diff entries from DiffCommand
 * const entries = await git.diff().setOldTree(commitA).setNewTree(commitB).call();
 *
 * // Format as unified diff
 * process.stdout.write(await formatter.formatAll(entries));
 * ```
 */
export class DiffFormatter {
  private readonly includeHeaders: boolean;
  private readonly output: DiffOutputOptions;

  constructor(
    private readonly blobs: Blobs,
    options: DiffFormatterOptions = {},
  ) {
    const {
      contextLines,
      includeHeaders,
      abbreviateIds,
      abbreviationLength,
      algorithm,
      bigFileThreshold,
      ...rest
    } = options;
    this.includeHeaders = includeHeaders ?? true;
    this.output = {
      ...rest,
      context: rest.context ?? contextLines ?? 3,
      algorithm: (algorithm ? String(algorithm) : "myers") as XdiffAlgorithm,
      abbrev: abbreviationLength ?? rest.abbrev ?? 7,
      fullIndex: rest.fullIndex ?? abbreviateIds === false,
      bigFileThreshold: bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD,
    };
  }

  /**
   * Format a DiffEntry into a content diff.
   *
   * Each side is probed first (its size, and a NUL byte in its first 8000
   * bytes, as git checks). A side over `bigFileThreshold` or binary makes the
   * entry binary, and then the other side is not loaded. Text sides are loaded
   * whole, as the diff algorithms need them, by the same single read as the probe.
   *
   * @param entry The diff entry to format
   * @returns Content diff with hunks
   */
  async format(entry: DiffEntry): Promise<FileContentDiff> {
    const sink = new ByteSink();
    const report: PairPatchReport = { binary: false, gitLine: "", extended: "" };
    await writePairPatch(sink, diffEntryToPair(entry, this.blobs), this.output, report);
    const result: FileContentDiff = {
      entry,
      isBinary: report.binary,
      header: report.gitLine,
      hunks: [],
      patch: sink.bytes(),
    };
    if (this.includeHeaders) {
      result.extendedHeaders = report.extended;
      const index = /^index .*$/m.exec(report.extended);
      if (index) result.indexLine = index[0];
      if (report.oldLabel) result.oldFileHeader = report.oldLabel;
      if (report.newLabel) result.newFileHeader = report.newLabel;
    }
    const diff = report.result;
    if (diff) {
      if (entry.changeType !== ChangeType.ADD) result.oldContent = diff.old.content;
      if (entry.changeType !== ChangeType.DELETE) result.newContent = diff.new.content;
      for (const hunk of diff.hunks) {
        const lines: string[] = [];
        for (const line of hunk.lines) {
          const rec = (line.kind === "-" ? diff.old : diff.new).line(line.index);
          const complete = rec.length > 0 && rec[rec.length - 1] === 0x0a;
          lines.push(line.kind + decoder.decode(complete ? rec.subarray(0, -1) : rec));
          if (!complete) lines.push("\\ No newline at end of file");
        }
        result.hunks.push({
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          newStart: hunk.newStart,
          newCount: hunk.newCount,
          functionName: decoder.decode(hunk.func),
          lines,
        });
      }
    }
    return result;
  }

  /**
   * The file's part of the diff as text: exactly git's output (LF-terminated lines), or
   * without the file headers when `includeHeaders` is false.
   *
   * @param diff The content diff to stringify
   * @returns Unified diff string
   */
  toString(diff: FileContentDiff): string {
    const text = decoder.decode(diff.patch);
    if (this.includeHeaders) return text;
    const at = text.search(/^(@@ |Binary files )/m);
    return at < 0 ? "" : text.slice(at);
  }

  /**
   * Format all diff entries to a single string, as `git diff` prints them.
   *
   * @param entries Array of diff entries
   * @returns Complete unified diff output
   */
  async formatAll(entries: DiffEntry[]): Promise<string> {
    const parts: string[] = [];
    for (const entry of entries) parts.push(this.toString(await this.format(entry)));
    return parts.join("");
  }

  /**
   * All diff entries as the bytes `git diff` prints (content that is not UTF-8 kept as it is).
   */
  async formatBytes(entries: DiffEntry[]): Promise<Uint8Array> {
    const sink = new ByteSink();
    for (const entry of entries) sink.push((await this.format(entry)).patch);
    return sink.bytes();
  }
}
