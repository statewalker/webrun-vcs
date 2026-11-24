/**
 * `git diff --check` (diff.c's `builtin_checkdiff` and `checkdiff_consume`): the whitespace
 * errors and leftover conflict markers the new side of a pair adds, one
 * `<file>:<line>: <error>.` line each, followed by the offending line with its errors in the
 * `whitespace` color.
 *
 * @example
 * ```typescript
 * const sink = new ByteSink();
 * const failed = await writePairCheck(sink, pair, { whitespaceRule: () => WS_DEFAULT_RULE });
 * // sink: "x:2: trailing whitespace.\n+foo(); \n"
 * ```
 *
 * @module
 */

import { type ByteSink, unifiedDiffHunks } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  checkBlankAtEof,
  WS_BLANK_AT_EOF,
  WS_DEFAULT_RULE,
  WS_INCOMPLETE_LINE,
  whitespaceErrorString,
  wsCheck,
  wsCheckEmit,
} from "../whitespace/index.js";
import {
  attrPathOf,
  contentDriver,
  type DiffFilePair,
  type DiffOutputOptions,
  driverOf,
  GIT_DIFF_BIG_FILE_THRESHOLD,
  LoadedSide,
} from "./diff-output.js";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
/** `DEFAULT_CONFLICT_MARKER_SIZE` */
export const DEFAULT_CONFLICT_MARKER_SIZE = 7;

/** What {@link writePairCheck} reads besides the diff options */
export interface PairCheckOptions {
  /** The `conflict-marker-size` of a path (`ll_merge_marker_size`), default 7 */
  conflictMarkerSize?: (path: string) => Promise<number> | number;
}

/**
 * merge-ll.c's `ll_merge_marker_size` over a `conflict-marker-size` attribute value: its
 * integer, else 7 (with git's warning for a value that is no integer)
 */
export function conflictMarkerSizeOf(
  attribute: boolean | string | undefined,
  warn?: (message: string) => void,
): number {
  if (attribute === undefined) return DEFAULT_CONFLICT_MARKER_SIZE;
  // strtol_i: base 10, the whole value (set and unset attributes are no integer)
  const text = typeof attribute === "string" ? attribute : "";
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)$/.exec(text);
  const value = m ? Number.parseInt(m[1] as string, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value > 0x7fffffff || value < -0x80000000) {
    warn?.(
      `invalid marker-size '${typeof attribute === "string" ? attribute : attribute ? "true" : "false"}', expecting an integer`,
    );
    return DEFAULT_CONFLICT_MARKER_SIZE;
  }
  return value <= 0 ? DEFAULT_CONFLICT_MARKER_SIZE : value;
}

/** merge-ll.c's `is_conflict_marker_line` over a line (its LF included) */
export function isConflictMarkerLine(line: Uint8Array, markerSize: number): boolean {
  if (line.length < markerSize + 1) return false;
  const first = line[0];
  if (first !== 0x3d && first !== 0x3e && first !== 0x3c && first !== 0x7c) return false;
  for (let i = 1; i < markerSize; i++) if (line[i] !== first) return false;
  const after = line[markerSize] as number;
  if ((first === 0x3c || first === 0x3e) && after !== 0x20) return false;
  // isspace: space, TAB, LF, VT, FF, CR
  return after === 0x20 || (after >= 0x09 && after <= 0x0d);
}

const PLUS = Uint8Array.of(0x2b);

function withNewline(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x0a;
  return out;
}

/**
 * Writes the `--check` report of one pair (`run_checkdiff`); true when it found an error
 * (git's `check_failed`). A tree side or an unmerged pair is not checked; the new side's
 * whitespace rule and marker size are those of its path, and a binary new side is not read.
 */
export async function writePairCheck(
  sink: ByteSink,
  pair: DiffFilePair,
  options: DiffOutputOptions = {},
  check: PairCheckOptions = {},
): Promise<boolean> {
  const { old: one, new: two } = pair;
  if ((one && (one.mode & S_IFMT) === S_IFDIR) || (two && (two.mode & S_IFMT) === S_IFDIR)) {
    return false;
  }
  // run_checkdiff: the second name when it differs, the attributes by it
  const name = (two ?? one)?.path ?? "";
  const attrPath = attrPathOf(two, one, name);
  let wsRule = (await options.whitespaceRule?.(attrPath)) ?? WS_DEFAULT_RULE;
  const markerSize = (await check.conflictMarkerSize?.(attrPath)) ?? DEFAULT_CONFLICT_MARKER_SIZE;
  // a symlink being an incomplete line is no news
  if (two && (two.mode & S_IFMT) === S_IFLNK) wsRule &= ~WS_INCOMPLETE_LINE;
  const threshold = options.bigFileThreshold ?? GIT_DIFF_BIG_FILE_THRESHOLD;
  // diff_filespec_is_binary of the new side alone (no textconv, whatever `-a` says)
  const newSide = new LoadedSide(two, contentDriver(two, await driverOf(options, attrPath)));
  if (await newSide.isBinary(threshold)) return false;
  const oldSide = new LoadedSide(one, undefined);
  const a = await oldSide.read();
  const b = await newSide.read();
  const colors = options.colors;
  const ws = colors?.whitespace ?? "";
  const reset = colors?.reset ?? "";
  const set = colors?.new ?? "";
  const out = {
    str: (s: string) => {
      if (s) sink.push(encodeGitPath(s));
    },
    bytes: (bytes: Uint8Array) => {
      if (bytes.length > 0) sink.push(bytes);
    },
  };
  const text = (s: string) => sink.push(encodeGitPath(s));
  let failed = false;
  // xdi_diff_outf with xpp.flags 0 (Myers, no heuristic) and one line of context
  const result = unifiedDiffHunks(a, b, {
    algorithm: "myers",
    indentHeuristic: false,
    context: 1,
  });
  const lines = result.new;
  for (const hunk of result.hunks) {
    for (const line of hunk.lines) {
      const kind = line.kind;
      if (kind === "-") continue;
      const start = lines.lineStarts[line.index] as number;
      const end = lines.lineStarts[line.index + 1] as number;
      const raw = lines.content.subarray(start, end);
      const complete = raw.length > 0 && raw[raw.length - 1] === 0x0a;
      // xdl_emit_diffrec: an incomplete line gets its LF, then the `\` marker line
      const body = complete ? raw : withNewline(raw);
      const lineno = line.index + 1;
      if (kind === "+") {
        if (isConflictMarkerLine(body, markerSize)) {
          failed = true;
          text(`${name}:${lineno}: leftover conflict marker\n`);
        }
        const bad = wsCheck(body, wsRule);
        if (bad) {
          failed = true;
          text(`${name}:${lineno}: ${whitespaceErrorString(bad)}.\n`);
          // emit_line(set, reset, "+"): the sign in the new color, reset after it
          out.str(set);
          sink.push(PLUS);
          out.str(reset);
          wsCheckEmit(body, wsRule, out, set, reset, ws);
        }
      }
      // the "\ No newline at end of file" line right after a `+` line
      if (!complete && raw.length > 0 && kind === "+" && wsRule & WS_INCOMPLETE_LINE) {
        failed = true;
        text(`${name}:${lineno}: ${whitespaceErrorString(WS_INCOMPLETE_LINE)}.\n`);
      }
    }
  }
  if (wsRule & WS_BLANK_AT_EOF) {
    const at = checkBlankAtEof(a, b).postimage;
    if (at) {
      text(`${name}:${at}: ${whitespaceErrorString(WS_BLANK_AT_EOF)}.\n`);
      failed = true;
    }
  }
  return failed;
}
