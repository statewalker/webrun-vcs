/**
 * git's merge strategy options (`-X <option>`, merge-ort's `parse_merge_opt`): the side
 * conflicting hunks are resolved to, the subtree shift, renormalization, and what tunes the
 * diffs of the merge (algorithm, whitespace, rename detection).
 *
 * ```ts
 * const options = parseStrategyOptions(["ignore-space-change", "find-renames=40%"]);
 * ```
 */

import {
  XDF_IGNORE_CR_AT_EOL,
  XDF_IGNORE_WHITESPACE,
  XDF_IGNORE_WHITESPACE_AT_EOL,
  XDF_IGNORE_WHITESPACE_CHANGE,
  type XdiffAlgorithm,
} from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/git-api-error.js";
import { GIT_MAX_SCORE } from "../rename/index.js";
import { configValue } from "./merge-config.js";
import type { OrtMergeOptions } from "./ort-merge.js";

/** What the `-X` options of a merge set (merge-ort's merge_options, as parse_merge_opt fills it). */
export interface MergeStrategyOptions {
  /** `ours` / `theirs`: conflicting hunks resolved to that side (recursive_variant) */
  favor?: "ours" | "theirs";
  /** `subtree` (`""`: the shift detected) or `subtree=<path>` (subtree_shift) */
  subtreeShift?: string;
  /** `patience`, `histogram`, `diff-algorithm=<name>` (the xdl_opts algorithm bits) */
  algorithm?: "myers" | "patience" | "histogram";
  /** `diff-algorithm=minimal` (XDF_NEED_MINIMAL: kept until another algorithm clears it) */
  minimal?: boolean;
  /** `ignore-space-change`, `ignore-all-space`, `ignore-space-at-eol`, `ignore-cr-at-eol` */
  whitespace?: number;
  /** `renormalize` / `no-renormalize` */
  renormalize?: boolean;
  /** `no-renames` (false), `find-renames[=<n>]` / `rename-threshold=<n>` (true) */
  renames?: boolean;
  /** The rename score of `find-renames=<n>` (0..60000; 0: the default 50%) */
  renameScore?: number;
}

/** `fatal: unknown strategy option: -X<option>` (exit 128): git merge's death. */
export class UnknownStrategyOptionError extends GitApiError {
  readonly option: string;

  constructor(option: string) {
    super(`fatal: unknown strategy option: -X${option}`, { exitCode: 128 });
    this.name = "UnknownStrategyOptionError";
    this.option = option;
  }
}

/** diff.c's parse_algorithm_value: the algorithm of a name, undefined when unknown. */
export function parseDiffAlgorithm(
  value: string,
): "myers" | "minimal" | "patience" | "histogram" | undefined {
  const v = value.toLowerCase();
  if (v === "myers" || v === "default") return "myers";
  if (v === "minimal" || v === "patience" || v === "histogram") return v;
  return undefined;
}

/**
 * diff.c's parse_rename_score: `50`, `50%`, `.5`, `0.5` as a score of {@link GIT_MAX_SCORE};
 * with the rest of the text not read (`rest`), as git checks it.
 */
export function parseRenameScore(text: string): { score: number; rest: string } {
  let num = 0;
  let scale = 1;
  let dot = false;
  let i = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (!dot && ch === ".") {
      scale = 1;
      dot = true;
    } else if (ch === "%") {
      scale = dot ? scale * 100 : 100;
      i++;
      break;
    } else if (ch >= "0" && ch <= "9") {
      if (scale < 100000) {
        scale *= 10;
        num = num * 10 + (ch.charCodeAt(0) - 48);
      }
    } else {
      break;
    }
  }
  const score = num >= scale ? GIT_MAX_SCORE : Math.floor((GIT_MAX_SCORE * num) / scale);
  return { score, rest: text.slice(i) };
}

/**
 * merge-ort's parse_merge_opt: applies one `-X` option to `options`; false for an option git
 * does not know (or a value it refuses), leaving `options` as it was.
 */
export function applyStrategyOption(options: MergeStrategyOptions, s: string): boolean {
  if (!s) return false;
  const after = (prefix: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : undefined);
  const whitespace: Record<string, number> = {
    "ignore-space-change": XDF_IGNORE_WHITESPACE_CHANGE,
    "ignore-all-space": XDF_IGNORE_WHITESPACE,
    "ignore-space-at-eol": XDF_IGNORE_WHITESPACE_AT_EOL,
    "ignore-cr-at-eol": XDF_IGNORE_CR_AT_EOL,
  };
  const subtree = after("subtree=");
  const algorithm = after("diff-algorithm=");
  const threshold = after("find-renames=") ?? after("rename-threshold=");
  if (s === "ours" || s === "theirs") options.favor = s;
  else if (s === "subtree") options.subtreeShift = "";
  else if (subtree !== undefined) options.subtreeShift = subtree;
  else if (s === "patience" || s === "histogram") options.algorithm = s;
  else if (algorithm !== undefined) {
    const value = parseDiffAlgorithm(algorithm);
    if (value === undefined) return false;
    // the algorithm bits cleared, XDF_NEED_MINIMAL added (never removed)
    if (value === "minimal") {
      options.algorithm = "myers";
      options.minimal = true;
    } else {
      options.algorithm = value;
    }
  } else if (whitespace[s] !== undefined) {
    options.whitespace = (options.whitespace ?? 0) | whitespace[s];
  } else if (s === "renormalize") options.renormalize = true;
  else if (s === "no-renormalize") options.renormalize = false;
  else if (s === "no-renames") options.renames = false;
  else if (s === "find-renames") {
    options.renames = true;
    options.renameScore = 0;
  } else if (threshold !== undefined) {
    const { score, rest } = parseRenameScore(threshold);
    if (rest !== "") return false;
    options.renameScore = score;
    options.renames = true;
  } else {
    return false;
  }
  return true;
}

/**
 * The `-X` options of a merge, in order (the last of each kind wins); an unknown one throws
 * {@link UnknownStrategyOptionError}, as `git merge` dies, unless `lenient` (the sequencer's
 * do_recursive_merge, which ignores parse_merge_opt's answer).
 */
export function parseStrategyOptions(
  list: readonly string[],
  lenient = false,
): MergeStrategyOptions {
  const options: MergeStrategyOptions = {};
  for (const option of list) {
    if (!applyStrategyOption(options, option) && !lenient) {
      throw new UnknownStrategyOptionError(option);
    }
  }
  return options;
}

/**
 * What the `-X` options make of merge-ort's diff options, over a merge's own: the algorithm
 * (the option, else `diff.algorithm` as init_ui_merge_options reads it, else histogram), the
 * whitespace bits, rename detection and its score. The favored side, renormalization and
 * the subtree shift are the caller's to apply.
 */
export function strategyOrtOptions(
  workingCopy: WorkingCopy | undefined,
  options: MergeStrategyOptions,
): Partial<OrtMergeOptions> {
  const out: Partial<OrtMergeOptions> = {};
  let algorithm: XdiffAlgorithm | undefined;
  if (options.algorithm) algorithm = options.algorithm;
  else if (workingCopy) {
    const configured = configValue(workingCopy, "diff.algorithm");
    const value = configured !== undefined ? parseDiffAlgorithm(configured) : undefined;
    if (value) algorithm = value;
  }
  if (options.minimal && (algorithm ?? "histogram") === "myers") algorithm = "minimal";
  if (algorithm && algorithm !== "histogram") out.algorithm = algorithm;
  if (options.whitespace) out.whitespace = options.whitespace;
  if (options.renames !== undefined) out.renames = options.renames;
  if (options.renameScore) out.renameScore = options.renameScore;
  return out;
}

/** quote.c's quote_cmdline of `-X` options as rebase saves them (`rebase-merge/strategy_opts`). */
export function quoteStrategyOptions(list: readonly string[]): string {
  return list.map((arg) => `"${arg.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(" ");
}

/** split_cmdline of `rebase-merge/strategy_opts`: the options it holds, quotes removed. */
export function splitStrategyOptions(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}
