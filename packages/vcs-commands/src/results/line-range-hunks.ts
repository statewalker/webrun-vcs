/**
 * The hunks of a patch cut to line ranges of its new side, as git 2.5x's `git log -L` prints a
 * commit's diff (diff.c's `line_range_hunk_fn`, `line_range_line_fn` and `flush_rhunk`).
 *
 * @example
 * ```ts
 * // the diff made with at least the widest range's span as context, then cut
 * const hunks = cutToLineRanges(result.hunks, [{ start: 5, end: 9 }]);
 * // one hunk per range that holds a change, headed `@@ -6,4 +6,4 @@`
 * ```
 *
 * The patch is diffed with its context widened to the widest range, so the changes of one
 * range fall into one hunk; each line is then placed by its new-side line number. Context and
 * added lines inside a range are kept, removed lines only when the next context or added line
 * is inside it (they have no new-side line of their own). A range's lines make one hunk,
 * dropped when it holds no change; its header always prints both counts, with the function
 * line of the last hunk the diff gave.
 *
 * @module
 */

import type { EmittedHunk, EmittedLine } from "@statewalker/vcs-utils";
import type { LineRange } from "./diff-entry.js";

/** The widest span of `ranges`: the context a patch cut to them is diffed with (at least) */
export function lineRangesSpan(ranges: readonly LineRange[]): number {
  let span = 0;
  for (const r of ranges) span = Math.max(span, r.end - r.start);
  return span;
}

/** `hunks` cut to the new-side lines of `ranges` (0-based, end exclusive, sorted) */
export function cutToLineRanges(
  hunks: readonly EmittedHunk[],
  ranges: readonly LineRange[],
): EmittedHunk[] {
  const out: EmittedHunk[] = [];
  let cur = 0;
  let lnoPost = 0;
  let lnoPre = 0;
  let func: Uint8Array = new Uint8Array(0);
  let rhunk: EmittedLine[] = [];
  let active = false;
  let hasChanges = false;
  let oldBegin = 0;
  let oldCount = 0;
  let newBegin = 0;
  let newCount = 0;
  let pending: EmittedLine[] = [];
  let pendingPreBegin = 0;

  const flush = () => {
    if (!active) return;
    if (pending.length > 0) {
      rhunk.push(...pending);
      oldCount += pending.length;
      hasChanges = true;
      pending = [];
    }
    active = false;
    if (hasChanges) {
      out.push({
        oldStart: oldBegin,
        oldCount,
        newStart: newBegin,
        newCount,
        func,
        lines: rhunk,
        countsAlways: true,
      });
    }
    rhunk = [];
  };

  for (const hunk of hunks) {
    lnoPost = hunk.newStart;
    lnoPre = hunk.oldStart;
    func = hunk.func;
    for (const line of hunk.lines) {
      if (line.kind === "-") {
        if (pending.length === 0) pendingPreBegin = lnoPre;
        lnoPre++;
        pending.push(line);
        continue;
      }
      const lno = lnoPost - 1;
      const curPre = lnoPre;
      lnoPost++;
      if (line.kind === " ") lnoPre++;
      while (cur < ranges.length && lno >= (ranges[cur] as LineRange).end) {
        flush();
        pending = [];
        cur++;
      }
      if (cur >= ranges.length) {
        pending = [];
        continue;
      }
      if (lno < (ranges[cur] as LineRange).start) {
        pending = [];
        continue;
      }
      if (!active) {
        active = true;
        hasChanges = false;
        newBegin = lno + 1;
        oldBegin = pending.length > 0 ? pendingPreBegin : curPre;
        oldCount = 0;
        newCount = 0;
        rhunk = [];
      }
      if (pending.length > 0) {
        rhunk.push(...pending);
        oldCount += pending.length;
        hasChanges = true;
        pending = [];
      }
      rhunk.push(line);
      newCount++;
      if (line.kind === "+") hasChanges = true;
      else oldCount++;
    }
  }
  flush();
  return out;
}
