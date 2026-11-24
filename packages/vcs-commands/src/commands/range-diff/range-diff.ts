/**
 * git's range-diff.c: the commits of two ranges read as patches (`read_patches`, from the
 * output of a `git log -p` with range-diff's own options), paired first by identical diffs
 * (`find_exact_matches`), then by the cheapest assignment of the others (`get_correspondences`:
 * the size of the diff between two patches, against the cost of creating a patch scaled by
 * the creation factor, solved by {@link computeAssignment}), and shown in the order of the
 * second range with the diff of each pair's patches (`output`). Patches are binary strings
 * (one character per byte), so the output is git's byte for byte.
 *
 * @example
 * ```typescript
 * const a = readRangeDiffPatches(latin1LogOfRange1);
 * const b = readRangeDiffPatches(latin1LogOfRange2);
 * findExactMatches(a, b);
 * getCorrespondences(a, b, 60);
 * const out = await writeRangeDiff(a, b, { abbrev, subject, dualColor: true });
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";
import {
  type FindFunction,
  formatHunkHeader,
  funcnameFindFunction,
  unifiedDiffHunks,
} from "@statewalker/vcs-utils";
import type { DiffColors } from "../../results/diff-color.js";
import { formatStat } from "../../results/diff-output.js";
import {
  checkBlankAtEof,
  isGitSpace,
  WS_BLANK_AT_EOF,
  WS_DEFAULT_RULE,
  wsBlankLine,
  wsCheckEmit,
} from "../../whitespace/index.js";
import { ApplyParser } from "../apply/apply-parse.js";
import { newFilePatch } from "../apply/apply-types.js";
import { bytesToLatin1, latin1ToBytes } from "../apply/latin1.js";
import { computeAssignment } from "./linear-assignment.js";

/** range-diff.h's RANGE_DIFF_CREATION_FACTOR_DEFAULT */
export const RANGE_DIFF_CREATION_FACTOR_DEFAULT = 60;
/** range-diff.h's CREATION_FACTOR_FOR_THE_SAME_SERIES (format-patch from 2.46 on) */
export const CREATION_FACTOR_FOR_THE_SAME_SERIES = 999;
/** linear-assignment.h's COST_MAX */
const COST_MAX = 1 << 16;

/** One commit of a range as range-diff holds it (`struct patch_util`). */
export interface RangeDiffPatch {
  oid: ObjectId;
  /** The whole patch: the metadata, message and diff sections */
  patch: string;
  /** Where the diff starts in {@link patch} (0 when the commit changes nothing) */
  diffOffset: number;
  /** The lines of the diff part */
  diffsize: number;
  /** Its position in its range */
  i: number;
  /** The position of the matching patch in the other range, or -1 */
  matching: number;
  shown: boolean;
}

/** Thrown where range-diff's reading fails (`error(...)`; the command then exits 1). */
export class RangeDiffError extends Error {}

const diffOf = (p: RangeDiffPatch) => p.patch.slice(p.diffOffset);

/**
 * `read_patches`: the patches of a `git log --no-color -p --reverse --date-order
 * --decorate=no --no-prefix --submodule=short --no-abbrev-commit --pretty=medium` output
 * (as a binary string, ordinary `+`/`-`/` ` indicators), each commit's section headers
 * (` ## Metadata ##`, ` ## Commit message ##`, ` ## Notes ##`, ` ## <file> ##`) and hunk
 * lines rewritten as git rewrites them.
 */
export function readRangeDiffPatches(log: string, includeMerges = false): RangeDiffPatch[] {
  const list: RangeDiffPatch[] = [];
  let buf = "";
  let util: RangeDiffPatch | undefined;
  let inHeader = true;
  let currentFilename: string | undefined;
  const parser = new ApplyParser();
  parser.pValue = 0;
  parser.verbosity = -1;
  const push = () => {
    if (util) {
      util.patch = buf;
      list.push(util);
    }
  };
  let at = 0;
  let size = log.length;
  while (size > 0) {
    const nl = log.indexOf("\n", at);
    const hasEol = nl >= 0 && nl < at + size;
    let len = hasEol ? nl + 1 - at : size;
    const line = log.slice(at, hasEol ? nl : at + size);

    if (line.startsWith("commit ")) {
      push();
      buf = "";
      let p = line.slice(7);
      const from = includeMerges ? p.indexOf(" (from ") : -1;
      if (from >= 0) p = p.slice(0, from);
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p))
        throw new RangeDiffError(`could not parse commit '${p}'`);
      util = { oid: p, patch: "", diffOffset: 0, diffsize: 0, i: 0, matching: -1, shown: false };
      inHeader = true;
      size -= len;
      at += len;
      continue;
    }
    if (!util) {
      throw new RangeDiffError(
        `could not parse first line of \`log\` output: did not start with 'commit ': '${line}'`,
      );
    }

    if (line.startsWith("diff --git")) {
      inHeader = false;
      buf += "\n";
      if (!util.diffOffset) util.diffOffset = buf.length;
      const patch = newFilePatch();
      const origLen = len;
      parser.linenr = 0;
      len = parser.readGitDiffHeader(log, at, len, size, patch);
      if (len < 0)
        throw new RangeDiffError(`could not parse git header '${log.slice(at, at + origLen)}'`);
      buf += " ## ";
      if (patch.isNew > 0) buf += `${patch.newName} (new)`;
      else if (patch.isDelete > 0) buf += `${patch.oldName} (deleted)`;
      else if (patch.isRename) buf += `${patch.oldName} => ${patch.newName}`;
      else buf += patch.newName ?? "";
      currentFilename = (patch.isDelete > 0 ? patch.oldName : patch.newName) ?? undefined;
      if (patch.newMode && patch.oldMode && patch.oldMode !== patch.newMode) {
        const o = (m: number) => m.toString(8).padStart(6, "0");
        buf += ` (mode change ${o(patch.oldMode)} => ${o(patch.newMode)})`;
      }
      buf += " ##";
    } else if (inHeader) {
      if (line.startsWith("Author: ")) {
        buf += ` ## Metadata ##\n${line}\n\n ## Commit message ##\n`;
      } else if (line.startsWith("Notes") && line.endsWith(":")) {
        // the trailing colon stripped
        buf += `\n\n ## ${line.slice(0, -1)} ##\n`;
      } else if (line.startsWith("    ")) {
        // the trailing whitespace dropped (git starts before the line's last byte)
        let p = len - 2;
        while (p >= 0 && isGitSpace(log.charCodeAt(at + p))) p--;
        buf += `${log.slice(at, at + p + 1)}\n`;
      }
      size -= len;
      at += len;
      continue;
    } else if (line.startsWith("@@ ")) {
      const rest = line.slice(3);
      const p = rest.indexOf("@@");
      buf += "@@";
      if (p >= 0) {
        const after = rest.slice(p + 2);
        if (currentFilename !== undefined && after.length > 0) buf += ` ${currentFilename}:`;
        buf += after;
      }
    } else if (line.length === 0) {
      // a blank line is not valid in a diff: the separator between commits
      size -= len;
      at += len;
      continue;
    } else if (line[0] === "+") buf += `+${line.slice(1)}`;
    else if (line[0] === "-") buf += `-${line.slice(1)}`;
    else if (line[0] === " ") buf += ` ${line.slice(1)}`;
    else buf += ` ${line}`;

    buf += "\n";
    util.diffsize++;
    size -= len;
    at += len;
  }
  push();
  for (const [i, p] of list.entries()) p.i = i;
  return list;
}

/**
 * `find_exact_matches`: the patches whose diffs are identical paired (several identical ones
 * in `a`: the last one first, as git's hashmap returns them).
 */
export function findExactMatches(a: RangeDiffPatch[], b: RangeDiffPatch[]): void {
  const map = new Map<string, RangeDiffPatch[]>();
  for (const [i, util] of a.entries()) {
    util.i = i;
    const key = diffOf(util);
    const list = map.get(key);
    if (list) list.push(util);
    else map.set(key, [util]);
  }
  for (const [i, util] of b.entries()) {
    util.i = i;
    const list = map.get(diffOf(util));
    const other = list?.pop();
    if (other) {
      if (other.matching >= 0) throw new Error("BUG: already assigned!");
      other.matching = i;
      util.matching = other.i;
    }
  }
}

/** `diffsize`: the lines (hunk headers included) of the diff of two texts, three of context. */
function diffsize(a: string, b: string): number {
  const result = unifiedDiffHunks(latin1ToBytes(a), latin1ToBytes(b), { context: 3 });
  let count = 0;
  for (const hunk of result.hunks) count += 1 + hunk.lines.length;
  return count;
}

/**
 * `get_correspondences`: the patches not matched exactly paired by the least total cost (the
 * size of the diff between two patches; creating or dropping a patch costs its size times
 * `creationFactor` percent).
 */
export function getCorrespondences(
  a: RangeDiffPatch[],
  b: RangeDiffPatch[],
  creationFactor: number,
): void {
  const n = a.length + b.length;
  const cost = new Int32Array(n * n);
  // C's int division truncates toward zero
  const scaled = (size: number) => Math.trunc((size * creationFactor) / 100);
  for (let i = 0; i < a.length; i++) {
    const aUtil = a[i] as RangeDiffPatch;
    for (let j = 0; j < b.length; j++) {
      const bUtil = b[j] as RangeDiffPatch;
      let c: number;
      if (aUtil.matching === j) c = 0;
      else if (aUtil.matching < 0 && bUtil.matching < 0) c = diffsize(diffOf(aUtil), diffOf(bUtil));
      else c = COST_MAX;
      cost[i + n * j] = c;
    }
    const c = aUtil.matching < 0 ? scaled(aUtil.diffsize) : COST_MAX;
    for (let j = b.length; j < n; j++) cost[i + n * j] = c;
  }
  for (let j = 0; j < b.length; j++) {
    const util = b[j] as RangeDiffPatch;
    const c = util.matching < 0 ? scaled(util.diffsize) : COST_MAX;
    for (let i = a.length; i < n; i++) cost[i + n * j] = c;
  }
  // (the rest stays 0)
  const { columnToRow: a2b } = computeAssignment(n, n, cost);
  for (let i = 0; i < a.length; i++) {
    const j = a2b[i] as number;
    if (j >= 0 && j < b.length) {
      (a[i] as RangeDiffPatch).matching = j;
      (b[j] as RangeDiffPatch).matching = i;
    }
  }
}

/** What {@link writeRangeDiff} prints with. */
export interface RangeDiffOutputOptions {
  /** The palette, or none for no colors */
  colors?: DiffColors;
  /** `dual_color_diffed_diffs` (default true): the outer and inner signs colored apart */
  dualColor?: boolean;
  leftOnly?: boolean;
  rightOnly?: boolean;
  /** `-p`: each pair's diff of patches, also with {@link stat} (shown by default without it) */
  patch?: boolean;
  /** `--stat`: the diffstat of each pair's patches */
  stat?: boolean;
  /** `-s`/`--no-patch`: only the pairs' headers */
  noPatch?: boolean;
  /** A commit id as `find_unique_abbrev` shortens it */
  abbrev(id: ObjectId): Promise<string>;
  /** A commit's oneline subject, as a binary string */
  subject(id: ObjectId): Promise<string>;
}

/** range-diff.c's `section_headers` driver */
let sectionHeaders: FindFunction | undefined;
function sectionHeaderFunction(): FindFunction {
  sectionHeaders ??= funcnameFindFunction({ pattern: "^ ## (.*) ##$\n^.?@@ (.*)$" });
  return sectionHeaders;
}

const PREFIX = "    ";
const REVERSE = "\x1b[7m";

/**
 * `output`: the pairs in the order of the second range, each dropped patch of the first
 * once its predecessors were shown, each pair's header (`n:  <id> = n:  <id> <subject>`, `!`
 * when the patches differ, `<`/`>` for a patch on one side only) and the diff of its
 * patches, four spaces in. The result is a binary string.
 */
export async function writeRangeDiff(
  a: RangeDiffPatch[],
  b: RangeDiffPatch[],
  options: RangeDiffOutputOptions,
): Promise<string> {
  let out = "";
  const width = String(1 + Math.max(a.length, b.length)).length;
  let dashes = "";
  const c = options.colors;
  const color = (slot: keyof DiffColors) => (c ? c[slot] : "");
  const shows = !options.noPatch && (options.stat || showsPatch(options));

  const header = async (aUtil: RangeDiffPatch | undefined, bUtil: RangeDiffPatch | undefined) => {
    const oid = (aUtil ?? bUtil) as RangeDiffPatch;
    if (!dashes) dashes = "-".repeat((await options.abbrev(oid.oid)).length);
    const reset = color("reset");
    const old = color("old");
    const nw = color("new");
    const commit = color("commit");
    let status: string;
    let col: string;
    if (!bUtil) {
      col = old;
      status = "<";
    } else if (!aUtil) {
      col = nw;
      status = ">";
    } else if (aUtil.patch !== bUtil.patch) {
      col = commit;
      status = "!";
    } else {
      col = commit;
      status = "=";
    }
    let line = status === "!" ? old : col;
    line += aUtil
      ? `${String(aUtil.i + 1).padStart(width)}:  ${await options.abbrev(aUtil.oid)} `
      : `${"-".padStart(width)}:  ${dashes} `;
    if (status === "!") line += reset + col;
    line += status;
    if (status === "!") line += reset + nw;
    line += bUtil
      ? ` ${String(bUtil.i + 1).padStart(width)}:  ${await options.abbrev(bUtil.oid)}`
      : ` ${"-".padStart(width)}:  ${dashes}`;
    if (status === "!") line += reset + col;
    line += ` ${await options.subject(oid.oid)}`;
    out += `${line}${reset}\n`;
  };

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    // the commits of the first range already shown skipped
    while (i < a.length && (a[i] as RangeDiffPatch).shown) i++;
    // an unmatched commit of the first range whose predecessors were shown
    if (i < a.length && (a[i] as RangeDiffPatch).matching < 0) {
      if (!options.rightOnly) await header(a[i], undefined);
      i++;
      continue;
    }
    // the unmatched commits of the second range
    while (j < b.length && (b[j] as RangeDiffPatch).matching < 0) {
      if (!options.leftOnly) await header(undefined, b[j]);
      j++;
    }
    // a matching pair
    if (j < b.length) {
      const bUtil = b[j] as RangeDiffPatch;
      const aUtil = a[bUtil.matching] as RangeDiffPatch;
      await header(aUtil, bUtil);
      if (shows) out += patchDiff(aUtil.patch, bUtil.patch, options);
      aUtil.shown = true;
      j++;
    }
  }
  return out;
}

/** Whether the output format holds the patch (the default when no other is asked for) */
const showsPatch = (o: RangeDiffOutputOptions) => !o.noPatch && (!!o.patch || !o.stat);

/** `patch_diff`: the diff of two patches (files "a" and "b", no diff headers, four in). */
function patchDiff(a: string, b: string, options: RangeDiffOutputOptions): string {
  const showPatch = showsPatch(options);
  const oldBytes = latin1ToBytes(a);
  const newBytes = latin1ToBytes(b);
  const result = unifiedDiffHunks(oldBytes, newBytes, {
    context: 3,
    indentHeuristic: true,
    findFunction: sectionHeaderFunction(),
  });
  let out = "";
  if (result.hunks.length === 0) return out;
  const c = options.colors;
  const dual = options.dualColor !== false;
  if (options.stat) {
    let added = 0;
    let deleted = 0;
    for (const hunk of result.hunks)
      for (const line of hunk.lines) {
        if (line.kind === "+") added++;
        else if (line.kind === "-") deleted++;
      }
    const stat = formatStat(
      [{ fromName: "a", name: "b", isRenamed: true, isBinary: false, added, deleted }],
      c ? { colors: c } : {},
    );
    for (const line of stat.split("\n").slice(0, -1)) out += `${PREFIX}${line}\n`;
    // the separator between the stat and the patch
    if (showPatch) out += `${PREFIX}\n`;
  }
  if (!showPatch) return out;
  const color = (slot: keyof DiffColors) => (c ? c[slot] : "");
  const reset = color("reset");
  // emit_line_0: the prefix, the sign's color (reversed for dual colors), the sign, the
  // text's color, the text, the reset
  const emit = (
    setSign: string | undefined,
    set: string | undefined,
    reverse: boolean,
    sign: string,
    text: string,
  ) => {
    let line = PREFIX;
    let body = text;
    let eol = "";
    if (body.endsWith("\n")) {
      body = body.slice(0, -1);
      eol = "\n";
    }
    let cr = "";
    if (body.endsWith("\r")) {
      body = body.slice(0, -1);
      cr = "\r";
    }
    let needsReset = false;
    if (body.length > 0 || sign) {
      if (reverse && c) {
        line += REVERSE;
        needsReset = true;
      }
      if (setSign !== undefined) {
        line += setSign;
        needsReset = true;
      }
      line += sign;
      if (body.length > 0) {
        if (set !== undefined) {
          if (setSign !== undefined) line += reset;
          line += set;
          needsReset = true;
        }
        line += body;
        needsReset = true;
      }
    }
    if (needsReset) line += reset;
    return `${line}${cr}${eol}`;
  };
  // blank-at-eof of the plain coloring (dual colors drop the whitespace marks)
  const wsRule = WS_DEFAULT_RULE;
  let blankPre = 0;
  let blankPost = 0;
  if (c && !dual && wsRule & WS_BLANK_AT_EOF) {
    const at = checkBlankAtEof(oldBytes, newBytes);
    blankPre = at.preimage;
    blankPost = at.postimage;
  }
  for (const hunk of result.hunks) {
    // emit_hunk_header without the line counts
    const full = bytesToLatin1(formatHunkHeader(hunk));
    const ep = full.indexOf("@@", 2) + 2;
    let rest = full.slice(ep);
    if (rest.endsWith("\n")) rest = rest.slice(0, -1);
    let headerLine = `${dual && c ? REVERSE : ""}${color("frag")}@@${reset}`;
    let k = 0;
    while (k < rest.length && (rest[k] === " " || rest[k] === "\t")) k++;
    if (k > 0) headerLine += `${color("context")}${rest.slice(0, k)}${reset}`;
    if (k < rest.length) headerLine += `${color("func")}${rest.slice(k)}${reset}`;
    out += `${PREFIX}${headerLine}\n`;
    let lnoPre = hunk.oldStart;
    let lnoPost = hunk.newStart;
    for (const line of hunk.lines) {
      const lines = line.kind === "-" ? result.old : result.new;
      const text = bytesToLatin1(lines.line(line.index));
      const first = text[0];
      if (line.kind === " ") {
        lnoPre++;
        lnoPost++;
        let set = color("context");
        if (dual) {
          if (first === "+") set = color("new");
          else if (first === "@") set = color("frag");
          else if (first === "-") set = color("old");
        }
        out += emit(set, undefined, false, " ", text);
      } else if (line.kind === "+") {
        lnoPost++;
        if (dual) {
          const sign = color("new");
          let set: string;
          if (first === "-") set = color("oldBold");
          else if (first === "@") set = color("frag");
          else if (first === "+") set = color("newBold");
          else set = color("contextBold");
          out += emit(sign, set, true, "+", text);
        } else if (c?.whitespace) {
          // emit_line_ws_markup with the whitespace errors of new lines
          const bytes = lines.line(line.index);
          const blankAtEof =
            blankPre > 0 &&
            blankPost > 0 &&
            blankPre <= lnoPre &&
            blankPost <= lnoPost &&
            wsBlankLine(bytes, 0, bytes.length);
          if (blankAtEof) out += emit(c.whitespace, undefined, false, "+", text);
          else {
            let marked = `${PREFIX}${c.new}+${reset}`;
            const parts: string[] = [];
            wsCheckEmit(
              bytes,
              wsRule,
              {
                str: (s) => parts.push(s),
                bytes: (bb) => parts.push(bytesToLatin1(bb)),
              },
              c.new,
              reset,
              c.whitespace,
            );
            marked += parts.join("");
            out += marked;
          }
        } else out += emit(color("new"), undefined, false, "+", text);
      } else {
        lnoPre++;
        if (dual) {
          const sign = color("old");
          let set: string;
          if (first === "+") set = color("newDimmed");
          else if (first === "@") set = color("frag");
          else if (first === "-") set = color("oldDimmed");
          else set = color("contextDimmed");
          out += emit(sign, set, true, "-", text);
        } else out += emit(color("old"), undefined, false, "-", text);
      }
    }
  }
  return out;
}
