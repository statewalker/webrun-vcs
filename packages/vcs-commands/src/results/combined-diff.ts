/**
 * git's combined diff (`combine-diff.c`), dense form (`diff --cc`): one result compared with
 * several parents at once, as `git diff` shows a conflicted path, the worktree file against
 * stages 2 ("ours") and 3 ("theirs").
 *
 * @example
 * ```typescript
 * writeCombinedDiff(sink, {
 *   path: "f.txt",
 *   parents: [ours, theirs], // { id, mode, content }
 *   result: { id: NULL_ID, mode: 0o100644, content: worktreeBytes },
 * }, options);
 * // diff --cc f.txt
 * // index 1a2b3c4,5d6e7f8..0000000
 * // ...
 * // @@@ -1,5 -1,5 +1,9 @@@
 * //   1
 * // ++<<<<<<< HEAD
 * ```
 *
 * Each parent is diffed with the result without context (the same xdiff options as the
 * patch); the lines a parent lost hang on the result line after them, merged across parents
 * by their longest common subsequence. A hunk shows only where the result differs from more
 * than one version (dense: a change taken from one parent alone is left out). Function lines
 * of the hunk headers are the last line above the hunk starting with a letter, `_` or `$`,
 * cut at 40 bytes, without its last non-blank byte (as git prints them).
 *
 * @module
 */

import {
  type ByteSink,
  type UnifiedDiffOptions,
  unifiedDiffHunks,
  whitespaceFlags,
  XDF_IGNORE_WHITESPACE,
  XDF_IGNORE_WHITESPACE_CHANGE,
  XDF_WHITESPACE_FLAGS,
  xdlIsSpace,
} from "@statewalker/vcs-utils";

import { quoteTwo } from "./quote-path.js";

/** One version of a combined diff: a parent or the result */
export interface CombinedSide {
  /** Object id (the null id for a worktree file) */
  id: string;
  /** git file mode; 0 for a result that is deleted */
  mode: number;
  /** The content (a symbolic link: its target) */
  content: Uint8Array;
}

/** A path of a combined diff */
export interface CombinedPath {
  path: string;
  parents: CombinedSide[];
  result: CombinedSide;
}

/** Options of {@link writeCombinedDiff} */
export interface CombinedDiffOptions
  extends Pick<
    UnifiedDiffOptions,
    | "algorithm"
    | "indentHeuristic"
    | "histogramRediff"
    | "legacyMinimal"
    | "ignoreWhitespace"
    | "ignoreWhitespaceChange"
    | "ignoreWhitespaceAtEol"
    | "ignoreCrAtEol"
    | "ignoreBlankLines"
  > {
  /** Lines of context (`-U`, default 3) */
  context?: number;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
  /** Treat the files as binary (a `diff` attribute) or text, regardless of content */
  binary?: boolean;
  /** Prefix of old paths (default "a/") */
  srcPrefix?: string;
  /** Prefix of new paths (default "b/") */
  dstPrefix?: string;
  /** The abbreviation of an id in the `index` line (default its first 7 digits) */
  abbreviate?: (id: string) => string;
}

const FIRST_FEW_BYTES = 8000;

interface Lost {
  line: Uint8Array;
  parentMap: number;
}

interface Sline {
  /** Lines lost from parents, coalesced */
  lost: Lost[];
  /** Lines lost from the parent being diffed */
  plost: Lost[];
  /** The line, without its LF (absent for the sentinel after the last line) */
  bol?: Uint8Array;
  flag: number;
  pLno: number[];
}

function isBinaryBuffer(content: Uint8Array): boolean {
  const n = Math.min(content.length, FIRST_FEW_BYTES);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

/** combine-diff.c's `match_string_spaces` */
function matchStringSpaces(a: Uint8Array, b: Uint8Array, flags: number): boolean {
  let len1 = a.length;
  let len2 = b.length;
  if (flags & XDF_WHITESPACE_FLAGS) {
    while (len1 > 0 && xdlIsSpace(a[len1 - 1])) len1--;
    while (len2 > 0 && xdlIsSpace(b[len2 - 1])) len2--;
  }
  if (!(flags & (XDF_IGNORE_WHITESPACE | XDF_IGNORE_WHITESPACE_CHANGE))) {
    if (len1 !== len2) return false;
    for (let i = 0; i < len1; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  while (len1 > 0 && len2 > 0) {
    len1--;
    len2--;
    if (xdlIsSpace(a[len1]) || xdlIsSpace(b[len2])) {
      if (flags & XDF_IGNORE_WHITESPACE_CHANGE && (!xdlIsSpace(a[len1]) || !xdlIsSpace(b[len2]))) {
        return false;
      }
      while (len1 > 0 && xdlIsSpace(a[len1])) len1--;
      while (len2 > 0 && xdlIsSpace(b[len2])) len2--;
    }
    if (a[len1] !== b[len2]) return false;
  }
  if (flags & XDF_IGNORE_WHITESPACE) {
    while (len1 > 0 && xdlIsSpace(a[len1 - 1])) len1--;
    while (len2 > 0 && xdlIsSpace(b[len2 - 1])) len2--;
  }
  return len1 === 0 && len2 === 0;
}

const MATCH = 0;
const BASE = 1;
const NEW = 2;

/** combine-diff.c's `coalesce_lines`: `newLines` merged into `base` by their LCS */
function coalesceLines(base: Lost[], newLines: Lost[], parent: number, flags: number): Lost[] {
  if (newLines.length === 0) return base;
  if (base.length === 0) return newLines;
  const nb = base.length;
  const nn = newLines.length;
  const lcs: Int32Array[] = [];
  const dir: Uint8Array[] = [];
  for (let i = 0; i <= nb; i++) {
    lcs.push(new Int32Array(nn + 1));
    const d = new Uint8Array(nn + 1);
    d[0] = BASE;
    dir.push(d);
  }
  for (let j = 1; j <= nn; j++) dir[0][j] = NEW;
  for (let i = 1; i <= nb; i++) {
    for (let j = 1; j <= nn; j++) {
      if (matchStringSpaces(base[i - 1].line, newLines[j - 1].line, flags)) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
        dir[i][j] = MATCH;
      } else if (lcs[i][j - 1] >= lcs[i - 1][j]) {
        lcs[i][j] = lcs[i][j - 1];
        dir[i][j] = NEW;
      } else {
        lcs[i][j] = lcs[i - 1][j];
        dir[i][j] = BASE;
      }
    }
  }
  const out = [...base];
  let i = nb;
  let j = nn;
  while (i !== 0 || j !== 0) {
    if (dir[i][j] === MATCH) {
      out[i - 1].parentMap |= 1 << parent;
      i--;
      j--;
    } else if (dir[i][j] === NEW) {
      // after base line i (before everything when i is 0)
      out.splice(i, 0, newLines[j - 1]);
      j--;
    } else {
      i--;
    }
  }
  return out;
}

/** combine-diff.c's `combine_diff`: one parent's changes recorded in `sline` */
function combineDiff(
  parent: CombinedSide,
  result: Uint8Array,
  sline: Sline[],
  cnt: number,
  n: number,
  options: CombinedDiffOptions,
  flags: number,
): void {
  const nmask = 1 << n;
  const diff = unifiedDiffHunks(parent.content, result, {
    algorithm: options.algorithm,
    indentHeuristic: options.indentHeuristic,
    histogramRediff: options.histogramRediff,
    legacyMinimal: options.legacyMinimal,
    ignoreWhitespace: options.ignoreWhitespace,
    ignoreWhitespaceChange: options.ignoreWhitespaceChange,
    ignoreWhitespaceAtEol: options.ignoreWhitespaceAtEol,
    ignoreCrAtEol: options.ignoreCrAtEol,
    ignoreBlankLines: options.ignoreBlankLines,
    context: 0,
    interHunkContext: 0,
  });
  for (const hunk of diff.hunks) {
    // consume_hunk: lost lines hang on the line after them
    const nb = hunk.newStart;
    let lno = nb;
    const bucket = hunk.newCount === 0 ? sline[nb] : sline[nb - 1];
    for (const line of hunk.lines) {
      if (line.kind === "-") {
        let bytes = diff.old.line(line.index);
        if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) {
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        bucket.plost.push({ line: bytes, parentMap: nmask });
      } else if (line.kind === "+") {
        sline[lno - 1].flag |= nmask;
        lno++;
      }
    }
  }
  let pLno = 1;
  let lno = 0;
  for (; lno <= cnt; lno++) {
    const sl = sline[lno];
    sl.pLno[n] = pLno;
    if (sl.plost.length > 0) {
      sl.lost = coalesceLines(sl.lost, sl.plost, n, flags);
      sl.plost = [];
    }
    for (const ll of sl.lost) if (ll.parentMap & nmask) pLno++;
    if (lno < cnt && !(sl.flag & nmask)) pLno++;
  }
  sline[lno].pLno[n] = pLno;
}

/** combine-diff.c's `reuse_combine_diff`: parent `i` is the same blob as parent `j` */
function reuseCombineDiff(sline: Sline[], cnt: number, i: number, j: number): void {
  const imask = 1 << i;
  const jmask = 1 << j;
  for (let lno = 0; lno <= cnt; lno++) {
    const sl = sline[lno];
    sl.pLno[i] = sl.pLno[j];
    for (const ll of sl.lost) if (ll.parentMap & jmask) ll.parentMap |= imask;
    if (sl.flag & jmask) sl.flag |= imask;
  }
  sline[cnt + 1].pLno[i] = sline[cnt + 1].pLno[j];
}

function interesting(sl: Sline, allMask: number): boolean {
  return (sl.flag & allMask) !== 0 || sl.lost.length > 0;
}

function adjustHunkTail(sline: Sline[], allMask: number, hunkBegin: number, i: number): number {
  if (hunkBegin + 1 <= i && !(sline[i - 1].flag & allMask)) return i - 1;
  return i;
}

function findNext(
  sline: Sline[],
  mark: number,
  start: number,
  cnt: number,
  lookForUninteresting: boolean,
): number {
  let i = start;
  while (i <= cnt) {
    if (lookForUninteresting ? !(sline[i].flag & mark) : sline[i].flag & mark) return i;
    i++;
  }
  return i;
}

function giveContext(sline: Sline[], cnt: number, numParent: number, context: number): boolean {
  const allMask = (1 << numParent) - 1;
  const mark = 1 << numParent;
  const noPreDelete = 2 << numParent;
  let i = findNext(sline, mark, 0, cnt, false);
  if (cnt < i) return false;
  while (i <= cnt) {
    let j = context < i ? i - context : 0;
    while (j < i) {
      if (!(sline[j].flag & mark)) sline[j].flag |= noPreDelete;
      sline[j++].flag |= mark;
    }
    for (;;) {
      j = findNext(sline, mark, i, cnt, true);
      if (cnt < j) return true;
      let k = findNext(sline, mark, j, cnt, false);
      j = adjustHunkTail(sline, allMask, i, j);
      if (k < j + context) {
        while (j < k) sline[j++].flag |= mark;
        i = k;
        continue;
      }
      i = k;
      k = j + context < cnt + 1 ? j + context : cnt + 1;
      while (j < k) sline[j++].flag |= mark;
      break;
    }
  }
  return true;
}

/** combine-diff.c's `make_hunks`, dense */
function makeHunks(sline: Sline[], cnt: number, numParent: number, context: number): boolean {
  const allMask = (1 << numParent) - 1;
  const mark = 1 << numParent;
  for (let i = 0; i <= cnt; i++) {
    if (interesting(sline[i], allMask)) sline[i].flag |= mark;
    else sline[i].flag &= ~mark;
  }
  let i = 0;
  while (i <= cnt) {
    while (i <= cnt && !(sline[i].flag & mark)) i++;
    if (cnt < i) break;
    const hunkBegin = i;
    let j = i + 1;
    for (; j <= cnt; j++) {
      if (!(sline[j].flag & mark)) {
        // an interesting line after this hunk within the context span continues it
        let la = adjustHunkTail(sline, allMask, hunkBegin, j);
        la = la + context < cnt + 1 ? la + context : cnt + 1;
        let contin = false;
        while (la && j <= --la) {
          if (sline[la].flag & mark) {
            contin = true;
            break;
          }
        }
        if (!contin) break;
        j = la;
      }
    }
    const hunkEnd = j;
    // only two versions, the result one of them: not interesting
    let sameDiff = 0;
    let hasInteresting = false;
    for (j = i; j < hunkEnd && !hasInteresting; j++) {
      let thisDiff = sline[j].flag & allMask;
      if (thisDiff) {
        if (!sameDiff) sameDiff = thisDiff;
        else if (sameDiff !== thisDiff) {
          hasInteresting = true;
          break;
        }
      }
      for (const ll of sline[j].lost) {
        if (hasInteresting) break;
        thisDiff = ll.parentMap;
        if (!sameDiff) sameDiff = thisDiff;
        else if (sameDiff !== thisDiff) hasInteresting = true;
      }
    }
    if (!hasInteresting && sameDiff !== allMask) {
      for (j = hunkBegin; j < hunkEnd; j++) sline[j].flag &= ~mark;
    }
    i = hunkEnd;
  }
  return giveContext(sline, cnt, numParent, context);
}

/** git's `isalpha` (ASCII) or `_` or `$`: a line fit for a hunk header comment */
function hunkCommentLine(bol: Uint8Array | undefined): boolean {
  if (!bol || bol.length === 0) return false;
  const ch = bol[0];
  return (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || ch === 0x5f || ch === 0x24;
}

/** `show_line_to_eol` without colors: the line and an LF */
function lineToEol(sink: ByteSink, line: Uint8Array): void {
  sink.push(line);
  sink.text("\n");
}

/** combine-diff.c's `dump_sline` */
function dumpSline(
  sink: ByteSink,
  sline: Sline[],
  cnt: number,
  numParent: number,
  context: number,
  resultDeleted: boolean,
): void {
  const mark = 1 << numParent;
  const noPreDelete = 2 << numParent;
  if (resultDeleted) return;
  let lno = 0;
  for (;;) {
    let hunkComment: Uint8Array | undefined;
    let nullContext = 0;
    while (lno <= cnt && !(sline[lno].flag & mark)) {
      if (hunkCommentLine(sline[lno].bol)) hunkComment = sline[lno].bol;
      lno++;
    }
    if (cnt < lno) break;
    let hunkEnd = lno + 1;
    for (; hunkEnd <= cnt; hunkEnd++) if (!(sline[hunkEnd].flag & mark)) break;
    let rlines = hunkEnd - lno;
    if (cnt < hunkEnd) rlines--;
    if (!context) {
      for (let j = lno; j < hunkEnd; j++) if (!(sline[j].flag & (mark - 1))) nullContext++;
      rlines -= nullContext;
    }
    let head = "@".repeat(numParent + 1);
    for (let i = 0; i < numParent; i++) {
      const l0 = sline[lno].pLno[i];
      const l1 = sline[hunkEnd].pLno[i];
      head += ` -${l0},${l1 - l0 - nullContext}`;
    }
    head += ` +${lno + 1},${rlines} ${"@".repeat(numParent + 1)}`;
    sink.text(head);
    if (hunkComment) {
      let commentEnd = 0;
      for (let i = 0; i < 40 && i < hunkComment.length; i++) {
        const ch = hunkComment[i];
        if (ch === 0 || ch === 0x0a) break;
        if (!xdlIsSpace(ch)) commentEnd = i;
      }
      if (commentEnd) {
        sink.text(" ");
        sink.push(hunkComment.subarray(0, commentEnd));
      }
    }
    sink.text("\n");
    while (lno < hunkEnd) {
      const sl = sline[lno++];
      const lost = sl.flag & noPreDelete ? [] : sl.lost;
      for (const ll of lost) {
        let marks = "";
        for (let j = 0; j < numParent; j++) marks += ll.parentMap & (1 << j) ? "-" : " ";
        sink.text(marks);
        lineToEol(sink, ll.line);
      }
      if (cnt < lno) break;
      if (!(sl.flag & (mark - 1)) && !context) continue;
      let marks = "";
      for (let j = 0; j < numParent; j++) marks += sl.flag & (1 << j) ? "+" : " ";
      sink.text(marks);
      lineToEol(sink, sl.bol ?? new Uint8Array(0));
    }
  }
}

function octal6(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}

/** combine-diff.c's `show_combined_header` (dense, from the worktree) */
function writeHeader(
  sink: ByteSink,
  elem: CombinedPath,
  options: CombinedDiffOptions,
  modeDiffers: boolean,
  showFileHeader: boolean,
): void {
  const quote = options.quotePath ?? true;
  const abbreviate = options.abbreviate ?? ((id: string) => id.slice(0, 7));
  sink.text(`diff --cc ${quoteTwo("", elem.path, quote)}\n`);
  sink.text(
    `index ${elem.parents.map((p) => abbreviate(p.id)).join(",")}..${abbreviate(elem.result.id)}\n`,
  );
  const deleted = !elem.result.mode;
  if (modeDiffers) {
    // the parents of a conflicted path are never all absent: no "new file mode"
    let line = deleted ? "deleted file mode " : "mode ";
    line += elem.parents.map((p) => octal6(p.mode)).join(",");
    if (elem.result.mode) line += `..${octal6(elem.result.mode)}`;
    sink.text(`${line}\n`);
  }
  if (!showFileHeader) return;
  const aPrefix = options.srcPrefix ?? "a/";
  const bPrefix = options.dstPrefix ?? "b/";
  sink.text(`--- ${quoteTwo(aPrefix, elem.path, quote)}\n`);
  sink.text(deleted ? "+++ /dev/null\n" : `+++ ${quoteTwo(bPrefix, elem.path, quote)}\n`);
}

/**
 * The dense combined diff of a path whose result is a worktree file (`show_patch_diff` with
 * `working_tree_file`): always printed, with its header, even when no hunk is left.
 */
export function writeCombinedDiff(
  sink: ByteSink,
  elem: CombinedPath,
  options: CombinedDiffOptions = {},
): void {
  const context = options.context ?? 3;
  const numParent = elem.parents.length;
  const resultDeleted = !elem.result.mode;
  const result = resultDeleted ? new Uint8Array(0) : elem.result.content;
  const modeDiffers = elem.parents.some((p) => p.mode !== elem.result.mode);
  const binary =
    options.binary ??
    (isBinaryBuffer(result) || elem.parents.some((p) => isBinaryBuffer(p.content)));
  if (binary) {
    writeHeader(sink, elem, options, modeDiffers, false);
    sink.text("Binary files differ\n");
    return;
  }
  // the result's lines (an incomplete last line counts)
  let cnt = 0;
  for (let i = 0; i < result.length; i++) if (result[i] === 0x0a) cnt++;
  if (result.length > 0 && result[result.length - 1] !== 0x0a) cnt++;
  const sline: Sline[] = [];
  for (let i = 0; i < cnt + 2; i++) {
    sline.push({ lost: [], plost: [], flag: 0, pLno: new Array(numParent).fill(0) });
  }
  let start = 0;
  let lno = 0;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === 0x0a) {
      sline[lno++].bol = result.subarray(start, i);
      start = i + 1;
    }
  }
  if (start < result.length) sline[lno].bol = result.subarray(start);
  const flags = whitespaceFlags(options);
  for (let i = 0; i < numParent; i++) {
    let j = 0;
    for (; j < i; j++) {
      if (elem.parents[i].id === elem.parents[j].id) {
        reuseCombineDiff(sline, cnt, i, j);
        break;
      }
    }
    if (i <= j && !resultDeleted) {
      combineDiff(elem.parents[i], result, sline, cnt, i, options, flags);
    }
  }
  makeHunks(sline, cnt, numParent, context);
  writeHeader(sink, elem, options, modeDiffers, true);
  dumpSline(sink, sline, cnt, numParent, context, resultDeleted);
}
