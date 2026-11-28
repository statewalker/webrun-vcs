/**
 * Where diff.c's `diff_line_prefix` (the graph's padding under `log --graph`) goes in a diff
 * output: a sink recording a position before every line pushed to it, except in the bytes a
 * writer marks as placing the prefix itself (git's word diff writes it only where
 * `fn_out_diff_words_write_helper` and `color_words_output_graph_prefix` put it). The log
 * inserts the prefix afterwards ({@link insertLinePrefix}), once its graph has printed the
 * commit's header and the padding is known.
 *
 * @example
 * ```typescript
 * const sink = new LinePrefixSink();
 * sink.text("diff --git a/f b/f\n");
 * sink.push(markLinePrefix(encodeGitPath("-old\n"), { before: 0, own: true }));
 * insertLinePrefix(sink.bytes(), sink.points, encodeGitPath("| ")); // "| diff --git a/f b/f\n-old\n"
 * ```
 *
 * Marks follow the chunk itself (a `WeakMap` of arrays), so they survive a sink that holds
 * chunks before passing them on unchanged (`MovedLineBuffer`), but not one that joins them.
 *
 * @module
 */

import { ByteSink } from "@statewalker/vcs-utils";

/** Where a marked chunk has the line prefix */
export interface LinePrefixMark {
  /** How many prefixes go right before the chunk */
  before: number;
  /** The chunk places its prefixes itself: none at its line starts */
  own: boolean;
}

const MARKS = new WeakMap<Uint8Array, LinePrefixMark>();

/**
 * Marks `bytes` for a {@link LinePrefixSink}. The mark belongs to the array object: mark a
 * view of its own (`bytes.subarray(0)`) for each push of shared bytes.
 */
export function markLinePrefix(bytes: Uint8Array, mark: LinePrefixMark): Uint8Array {
  MARKS.set(bytes, mark);
  return bytes;
}

/** A byte sink recording where the line prefix goes: each line start, marked chunks aside */
export class LinePrefixSink extends ByteSink {
  /** The offsets in the output where a prefix goes, ascending (one offset may repeat) */
  readonly points: number[] = [];
  private offset = 0;
  private atLineStart = true;

  /**
   * A prefix at the current end of the output, written straight to the file (diff.c's
   * `fputs(line_prefix)`): ahead of what a `MovedLineBuffer` still holds
   */
  addPoint(): void {
    this.points.push(this.offset);
  }

  override push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const mark = MARKS.get(bytes);
    for (let i = 0; i < (mark?.before ?? 0); i++) this.points.push(this.offset);
    if (mark?.own) {
      super.push(bytes);
      this.offset += bytes.length;
      // whatever git writes next through emit_line_0 (a context line, a hunk header, the
      // next file's header) starts with the prefix
      this.atLineStart = true;
      return;
    }
    super.push(bytes);
    let at = 0;
    while (at < bytes.length) {
      if (this.atLineStart) this.points.push(this.offset + at);
      const nl = bytes.indexOf(0x0a, at);
      this.atLineStart = nl >= 0;
      at = nl < 0 ? bytes.length : nl + 1;
    }
    this.offset += bytes.length;
  }
}

/** `bytes` with `prefix` inserted at each of `points` (ascending offsets) */
export function insertLinePrefix(
  bytes: Uint8Array,
  points: readonly number[],
  prefix: Uint8Array,
): Uint8Array {
  if (points.length === 0 || prefix.length === 0) return bytes;
  const out = new Uint8Array(bytes.length + points.length * prefix.length);
  let size = 0;
  let from = 0;
  for (const point of points) {
    out.set(bytes.subarray(from, point), size);
    size += point - from;
    out.set(prefix, size);
    size += prefix.length;
    from = point;
  }
  out.set(bytes.subarray(from), size);
  return out;
}
