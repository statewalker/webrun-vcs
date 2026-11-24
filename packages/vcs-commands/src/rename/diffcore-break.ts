/**
 * git's break-rewrite detection (`diffcore-break.c`) and the option parsing of `-M`, `-C`
 * and `-B` (diff.c's `parse_rename_score`, `diff_opt_break_rewrites`).
 */

import { InvalidArgumentError } from "../errors/index.js";
import { GIT_MAX_SCORE, type SimilaritySide, type SpanCounts } from "./git-similarity.js";

/** git's `DEFAULT_BREAK_SCORE`: a pair is broken from 50% of edit on */
export const DEFAULT_BREAK_SCORE = 30000;
/** git's `DEFAULT_MERGE_SCORE`: a broken pair that removed less than 60% is merged back */
export const DEFAULT_MERGE_SCORE = 36000;
/** git's `MINIMUM_BREAK_SIZE`: smaller pairs are never broken */
export const MINIMUM_BREAK_SIZE = 400;

/**
 * diff.c's `parse_rename_score`: `50%`, `5` (tenths, as `.5`), `.5`, `95.5%`; the score in
 * {@link GIT_MAX_SCORE} units and the text left after it.
 */
export function parseRenameScore(text: string): { score: number; rest: string } {
  let num = 0;
  let scale = 1;
  let dot = false;
  let at = 0;
  for (; at < text.length; at++) {
    const ch = text[at] as string;
    if (!dot && ch === ".") {
      scale = 1;
      dot = true;
    } else if (ch === "%") {
      scale = dot ? scale * 100 : 100;
      at++;
      break;
    } else if (ch >= "0" && ch <= "9") {
      if (scale < 100000) {
        scale *= 10;
        num = num * 10 + (ch.charCodeAt(0) - 48);
      }
    } else break;
  }
  const score = num >= scale ? GIT_MAX_SCORE : Math.trunc((GIT_MAX_SCORE * num) / scale);
  return { score, rest: text.slice(at) };
}

/**
 * The score of `-M<n>` / `-C<n>` (`true`: none given, the default threshold); git's
 * `error: invalid argument to <option>` (exit 129) for trailing text.
 */
export function renameScoreOption(
  spec: boolean | string,
  option: "find-renames" | "find-copies",
): number | undefined {
  if (spec === true || spec === false || spec === "") return undefined;
  const { score, rest } = parseRenameScore(spec);
  if (rest !== "") {
    throw new InvalidArgumentError(
      option,
      spec,
      `error: invalid argument to ${option}`,
    ).withExitCode(129);
  }
  return score || undefined;
}

/** The two thresholds of `-B[<n>][/<m>]` */
export interface BreakScores {
  /** Break a pair edited this much (git's `break_score`) */
  breakScore: number;
  /** Merge a broken pair back that removed less than this (git's `merge_score`) */
  mergeScore: number;
}

/** diff.c's `diff_opt_break_rewrites` and diffcore_break's defaults */
export function parseBreakRewrites(spec: boolean | string): BreakScores {
  let text = spec === true || spec === false ? "" : spec;
  const first = parseRenameScore(text);
  text = first.rest;
  let second = 0;
  const invalid = () =>
    new InvalidArgumentError(
      "break-rewrites",
      String(spec),
      "error: break-rewrites expects <n>/<m> form",
    ).withExitCode(129);
  if (text !== "") {
    if (text[0] !== "/") throw invalid();
    const parsed = parseRenameScore(text.slice(1));
    second = parsed.score;
    if (parsed.rest !== "") throw invalid();
  }
  // diffcore_break keeps both in 16 bits; 0 takes the default
  const breakScore = first.score & 0xffff;
  const mergeScore = second & 0xffff;
  return {
    breakScore: breakScore || DEFAULT_BREAK_SCORE,
    mergeScore: mergeScore || DEFAULT_MERGE_SCORE,
  };
}

/**
 * diffcore-delta.c's `diffcore_count_changes`: the bytes of the destination the source has
 * (`copied`) and the bytes it adds (`added`).
 */
export function countChanges(src: SpanCounts, dst: SpanCounts): { copied: number; added: number } {
  let copied = 0;
  let added = 0;
  let d = 0;
  for (const [hash, srcCount] of src) {
    while (d < dst.length && (dst[d] as [number, number])[0] < hash) {
      added += (dst[d] as [number, number])[1];
      d++;
    }
    let dstCount = 0;
    if (d < dst.length && (dst[d] as [number, number])[0] === hash) {
      dstCount = (dst[d] as [number, number])[1];
      d++;
    }
    if (srcCount < dstCount) {
      added += dstCount - srcCount;
      copied += srcCount;
    } else copied += dstCount;
  }
  for (; d < dst.length; d++) added += (dst[d] as [number, number])[1];
  return { copied, added };
}

const S_IFMT = 0o170000;
const isRegular = (mode: number) => (mode & S_IFMT) === 0o100000;

/**
 * diffcore-break.c's `should_break`: whether a modification is better shown as a deletion and
 * a creation, and how much of the source it removed (`mergeScore`, git's `*merge_score_p`).
 * `same` is whether both sides are known to be the same object.
 */
export async function shouldBreak(
  src: SimilaritySide,
  dst: SimilaritySide,
  breakScore: number,
  same: boolean,
): Promise<{ broken: boolean; mergeScore: number }> {
  if (isRegular(src.mode) !== isRegular(dst.mode)) {
    return { broken: true, mergeScore: GIT_MAX_SCORE };
  }
  if (same) return { broken: false, mergeScore: 0 };
  const maxSize = Math.max(src.size, dst.size);
  if (maxSize < MINIMUM_BREAK_SIZE) return { broken: false, mergeScore: 0 };
  if (!src.size) return { broken: false, mergeScore: 0 };
  let { copied, added } = countChanges(await src.spans(), await dst.spans());
  if (src.size < copied) copied = src.size;
  if (dst.size < added + copied) added = copied < dst.size ? dst.size - copied : 0;
  const removed = src.size - copied;
  const mergeScore = Math.trunc((removed * GIT_MAX_SCORE) / src.size);
  if (mergeScore > breakScore) return { broken: true, mergeScore };
  const delta = removed + added;
  if ((delta * GIT_MAX_SCORE) / maxSize < breakScore) {
    return { broken: false, mergeScore };
  }
  if (
    src.size * breakScore < removed * GIT_MAX_SCORE &&
    added * 20 < removed &&
    added * 20 < copied
  ) {
    return { broken: false, mergeScore };
  }
  return { broken: true, mergeScore };
}
