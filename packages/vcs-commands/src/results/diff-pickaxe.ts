/**
 * Pickaxe (git's diffcore-pickaxe.c): which pairs of a diff queue mention a string, a regex
 * or an object. `-S<string>` keeps a pair whose two sides hold the string a different number
 * of times, `-G<regex>` a pair whose added or removed lines match the regex, `--find-object`
 * a pair with that object on either side.
 *
 * @example
 * ```ts
 * const pickaxe = DiffPickaxe.compile({ string: "frotz" });
 * const kept = await pickaxe.filter(pairs, (p) => p, outputOptions);
 * ```
 *
 * Both sides are read as the patch reads them: through the path's textconv when one applies,
 * and `-G` passes over binary pairs unless `--text` is given (or textconv makes them text),
 * as git does. `-S` counts non-overlapping occurrences, ASCII case folded under `-i`;
 * `--pickaxe-regex` and `-G` compile POSIX extended regexes with `REG_NEWLINE` (and
 * `REG_ICASE` under `-i`), so no JavaScript `RegExp` ever runs a user's pattern. `-G`
 * diffs the two texts with xdiff's defaults (Myers, no indent heuristic, no whitespace
 * options), whatever the patch shown uses.
 *
 * @module
 */

import {
  compilePosixRegex,
  type PosixRegex,
  PosixRegexError,
  unifiedDiffHunks,
} from "@statewalker/vcs-utils";

import { GitApiError } from "../errors/index.js";
import {
  attrPathOf,
  contentDriver,
  type DiffFilePair,
  type DiffOutputOptions,
  type DiffSideSpec,
  driverOf,
  GIT_DIFF_BIG_FILE_THRESHOLD,
  LoadedSide,
} from "./diff-output.js";

/** What a pickaxe looks for (one kind of `-S`, `-G`, `--find-object`) */
export interface PickaxeSpec {
  /** `-S<string>`: pairs whose sides hold it a different number of times */
  string?: string;
  /** `-G<regex>`: pairs whose added or removed lines match it */
  grep?: string;
  /** `--find-object=<id>`: pairs with one of these objects on either side */
  objects?: ReadonlySet<string>;
  /** `--pickaxe-regex`: `-S` takes a POSIX extended regex */
  regex?: boolean;
  /** `--pickaxe-all`: a match keeps the whole queue, none empties it */
  all?: boolean;
  /** `-i` / `--regexp-ignore-case` */
  ignoreCase?: boolean;
}

const LF = 0x0a;

/** ASCII lowercase (git's `tolower_trans_tbl` in the C locale) */
function lowerAscii(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] as number;
    out[i] = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  }
  return out;
}

/** quote.c's basic_regex_quote_buf: a string as a basic regex matching it literally */
function basicRegexQuote(s: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  // only a leading `^` is special; a leading `*` is literal
  if (s[i] === 0x5e) out.push(0x5c, s[i++] as number);
  if (s[i] === 0x2a) out.push(s[i++] as number);
  for (; i < s.length; i++) {
    const c = s[i] as number;
    if (c === 0x5b || c === 0x2e || c === 0x5c || c === 0x2a) out.push(0x5c, c);
    else if (c === 0x24 && i + 1 === s.length) out.push(0x5c, c);
    else out.push(c);
  }
  return Uint8Array.from(out);
}

/** A pair's side whose object id git knows (`oid_valid`): a worktree file's is not */
function knownId(side: DiffSideSpec | undefined): string | undefined {
  return side && side.idValid !== false ? side.id : undefined;
}

/** The compiled pickaxe of a diff (git's `diffcore_pickaxe`) */
export class DiffPickaxe {
  private constructor(
    private readonly spec: PickaxeSpec,
    /** `-G`, `--pickaxe-regex`, or `-S -i` of a non-ASCII string */
    private readonly regex: PosixRegex | undefined,
    /** `-S`'s string, lowercased under `-i` (kwset) */
    private readonly needle: Uint8Array | undefined,
  ) {}

  /**
   * Compiles a pickaxe as diffcore_pickaxe does; an invalid regex throws git's `fatal:
   * invalid regex: <glibc's message>` (exit 128).
   */
  static compile(spec: PickaxeSpec): DiffPickaxe {
    const compile = (pattern: Uint8Array | string, extended: boolean): PosixRegex => {
      try {
        return compilePosixRegex(pattern, {
          extended,
          newline: true,
          icase: spec.ignoreCase ?? false,
        });
      } catch (e) {
        if (e instanceof PosixRegexError) {
          throw new GitApiError(`fatal: invalid regex: ${e.message}`).withExitCode(128);
        }
        throw e;
      }
    };
    if (spec.grep !== undefined) return new DiffPickaxe(spec, compile(spec.grep, true), undefined);
    if (spec.string !== undefined) {
      if (spec.regex) return new DiffPickaxe(spec, compile(spec.string, true), undefined);
      const bytes = new TextEncoder().encode(spec.string);
      if (spec.ignoreCase && bytes.some((b) => b >= 0x80)) {
        // has_non_ascii: a quoted basic regex, REG_ICASE | REG_NEWLINE
        return new DiffPickaxe(spec, compile(basicRegexQuote(bytes), false), undefined);
      }
      return new DiffPickaxe(spec, undefined, spec.ignoreCase ? lowerAscii(bytes) : bytes);
    }
    return new DiffPickaxe(spec, undefined, undefined);
  }

  /** Whether the pickaxe reads the blobs of the pairs (`-S`, `-G`; not `--find-object`) */
  get readsContent(): boolean {
    return this.spec.objects === undefined;
  }

  /**
   * The queue the pickaxe leaves (git's `pickaxe`): the items whose pair matches, or, under
   * `--pickaxe-all`, every item when one matches and none otherwise. An item without a pair
   * (an unmerged path) never matches.
   */
  async filter<T>(
    queue: readonly T[],
    pairOf: (item: T) => DiffFilePair | undefined,
    options: DiffOutputOptions,
  ): Promise<T[]> {
    if (this.spec.all) {
      for (const item of queue) {
        const pair = pairOf(item);
        if (pair && (await this.matches(pair, options))) return [...queue];
      }
      return [];
    }
    const out: T[] = [];
    for (const item of queue) {
      const pair = pairOf(item);
      if (pair && (await this.matches(pair, options))) out.push(item);
    }
    return out;
  }

  /** pickaxe_match: whether one pair matches */
  async matches(pair: DiffFilePair, options: DiffOutputOptions): Promise<boolean> {
    if (!pair.old && !pair.new) return false;
    const objects = this.spec.objects;
    if (objects) {
      const a = knownId(pair.old);
      const b = knownId(pair.new);
      return (a !== undefined && objects.has(a)) || (b !== undefined && objects.has(b));
    }
    const threshold = options.bigFileThreshold ?? GIT_DIFF_BIG_FILE_THRESHOLD;
    const pathOne = pair.old?.path ?? pair.new?.path ?? "";
    const pathTwo = pair.new?.path ?? pair.old?.path ?? "";
    const attrOne = attrPathOf(pair.old, pair.new, pathOne);
    const attrTwo = attrPathOf(pair.new, pair.old, pathTwo);
    const oneDriver = await driverOf(options, attrOne);
    const twoDriver = attrTwo === attrOne ? oneDriver : await driverOf(options, attrTwo);
    const one = new LoadedSide(pair.old, contentDriver(pair.old, oneDriver), pair.new?.id);
    const two = new LoadedSide(pair.new, contentDriver(pair.new, twoDriver), pair.old?.id);
    // get_textconv: the drivers whose textconv applies (valid regular files only)
    const textconvOne = one.driver?.textconv ? one.driver : undefined;
    const textconvTwo = two.driver?.textconv ? two.driver : undefined;
    const sameTextconv =
      textconvOne === textconvTwo ||
      (textconvOne !== undefined &&
        textconvTwo !== undefined &&
        textconvOne.name === textconvTwo.name);
    if (sameTextconv && unmodifiedPair(pair)) return false;
    if (
      this.spec.grep !== undefined &&
      !options.text &&
      ((!textconvOne && (await one.isBinary(threshold))) ||
        (!textconvTwo && (await two.isBinary(threshold))))
    ) {
      return false;
    }
    const fill = async (side: LoadedSide, attrPath: string): Promise<Uint8Array> => {
      const textconv = side.driver?.textconv;
      if (!side.valid) return new Uint8Array(0);
      if (!textconv) return side.read();
      try {
        return await textconv(await side.textconvInput(), attrPath);
      } catch (e) {
        // fill_textconv: run_textconv's error, then the death
        const message = e instanceof Error ? e.message : String(e);
        throw new GitApiError(
          `${message ? `${message}\n` : ""}fatal: unable to read files to diff`,
        ).withExitCode(128);
      }
    };
    const a = await fill(one, attrOne);
    const b = await fill(two, attrTwo);
    if (this.spec.grep !== undefined) return this.diffGrep(a, b, options);
    // has_changes: the second count stops one past the first
    const c1 = this.contains(a, 0);
    return c1 !== this.contains(b, c1 + 1);
  }

  /** diff_grep: whether an added or removed line of the xdiff of `a` and `b` matches */
  private diffGrep(a: Uint8Array, b: Uint8Array, options: DiffOutputOptions): boolean {
    const regex = this.regex as PosixRegex;
    const result = unifiedDiffHunks(a, b, {
      algorithm: "myers",
      indentHeuristic: false,
      context: options.context ?? 3,
      interHunkContext: options.interHunkContext ?? 0,
    });
    for (const hunk of result.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === " ") continue;
        const lines = line.kind === "-" ? result.old : result.new;
        const start = lines.start(line.index);
        const end = lines.start(line.index + 1);
        // xdiff_outf hands the line on with its LF (one is added after a last line without)
        const text = lines.content.subarray(start, end);
        if (regex.test(text)) return true;
        if (end > start && text[text.length - 1] !== LF) {
          const withLf = new Uint8Array(text.length + 1);
          withLf.set(text);
          withLf[text.length] = LF;
          if (regex.test(withLf)) return true;
        }
      }
    }
    return false;
  }

  /** contains(): the occurrences in `data`, up to `limit` (0: all) */
  private contains(data: Uint8Array, limit: number): number {
    let count = 0;
    const regex = this.regex;
    if (regex) {
      // regexec_buf in a loop: REG_NOTBOL after the first match, a step past an empty one
      const subject = regex.fold(data);
      let at = 0;
      let notbol = false;
      while (at < subject.length) {
        const m = regex.exec(subject.subarray(at), undefined, 1, { notbol, folded: true });
        if (!m) break;
        notbol = true;
        at += m.end;
        if (at < subject.length && m.start === m.end) at++;
        count++;
        if (limit && count === limit) return count;
      }
      return count;
    }
    const needle = this.needle as Uint8Array;
    const hay = this.spec.ignoreCase ? lowerAscii(data) : data;
    const n = needle.length;
    if (n === 0) return 0;
    const first = needle[0] as number;
    let at = 0;
    while (at + n <= hay.length) {
      const i = hay.indexOf(first, at);
      if (i < 0 || i + n > hay.length) break;
      let k = 1;
      while (k < n && hay[i + k] === needle[k]) k++;
      if (k < n) {
        at = i + 1;
        continue;
      }
      count++;
      if (limit && count === limit) return count;
      at = i + n;
    }
    return count;
  }
}

/** diff_unmodified_pair: both sides valid, at one path, of one mode and known equal content */
function unmodifiedPair(pair: DiffFilePair): boolean {
  const { old: one, new: two } = pair;
  if (!one || !two) return false;
  if (one.mode !== two.mode || one.path !== two.path) return false;
  const oneValid = one.idValid !== false;
  const twoValid = two.idValid !== false;
  if (oneValid && twoValid && one.id === two.id && !one.submoduleDirt && !two.submoduleDirt) {
    return true;
  }
  return !oneValid && !twoValid;
}
