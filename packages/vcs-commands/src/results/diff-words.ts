/**
 * git's word diff (diff.c's `diff_words_*` and `fn_out_diff_words_*`): `--word-diff=plain`,
 * `--word-diff=color` (`--color-words`) and `--word-diff=porcelain`, byte for byte as git
 * prints the hunks of a text pair.
 *
 * @example
 * ```typescript
 * const words = compileWordRegex("[a-z]+");
 * writeWordDiffHunks(sink, hunks, { mode: "plain", regex: words });
 * // "@@ -1 +1 @@\nh(4),{+hh+}[44]\n"
 * ```
 *
 * The removed and added lines between two context lines are gathered, split into words
 * (each match of the word regex, cut at a newline; without one, each run of non-spaces),
 * and the two word lists are diffed as lines (xdiff with no context, the common tail
 * trimmed). The added side's text is printed with the removed words before the added ones
 * that replace them: `[-old-]{+new+}` in plain mode, the `old` and `new` colors in color
 * mode, one `-`/`+`/` ` line per piece with `~` for each newline in porcelain mode. Context
 * lines are printed without their sign (porcelain: with it, followed by `~`).
 *
 * Not reproduced: under `log --graph` git writes the graph's line prefix in word mode only
 * where a word hunk starts on a new line or a piece's text has a newline, so porcelain lines
 * (and some plain or color lines) go without it; `git log` prefixes every line of ours.
 *
 * @module
 */

import {
  type ByteSink,
  compilePosixRegex,
  type PosixRegex,
  xdiffHunks,
} from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../errors/index.js";
import { type ColoredHunk, coloredHunkHeader, type DiffColors } from "./diff-color.js";

/** `--word-diff=<mode>` (`--color-words` is `color`) */
export type WordDiffMode = "plain" | "color" | "porcelain";

/** The modes `--word-diff=` takes (`none` turns the word diff off) */
export const WORD_DIFF_MODES = ["plain", "color", "porcelain", "none"] as const;

/** What {@link writeWordDiffHunks} prints with */
export interface WordDiffOptions {
  mode: WordDiffMode;
  /** The word regex (`--word-diff-regex`, the driver's, `diff.wordRegex`); unset, non-spaces */
  regex?: PosixRegex;
  /** The palette of `--color`; unset, no colors */
  colors?: DiffColors;
}

/** One kind of piece of a style (diff.c's `diff_words_style_elem`) */
interface StyleElem {
  prefix: Uint8Array;
  suffix: Uint8Array;
  color: string | undefined;
}

/** diff.c's `diff_words_style` */
interface Style {
  newWord: StyleElem;
  oldWord: StyleElem;
  ctx: StyleElem;
  newline: Uint8Array;
}

const enc = (s: string) => encodeGitPath(s);

/** diff.c's `diff_words_styles` */
function styleOf(mode: WordDiffMode, colors: DiffColors | undefined): Style {
  const elem = (prefix: string, suffix: string, color: string | undefined): StyleElem => ({
    prefix: enc(prefix),
    suffix: enc(suffix),
    color,
  });
  const c = colors;
  switch (mode) {
    case "porcelain":
      return {
        newWord: elem("+", "\n", c?.new),
        oldWord: elem("-", "\n", c?.old),
        ctx: elem(" ", "\n", c?.context),
        newline: enc("~\n"),
      };
    case "plain":
      return {
        newWord: elem("{+", "+}", c?.new),
        oldWord: elem("[-", "-]", c?.old),
        ctx: elem("", "", c?.context),
        newline: enc("\n"),
      };
    default:
      return {
        newWord: elem("", "", c?.new),
        oldWord: elem("", "", c?.old),
        ctx: elem("", "", c?.context),
        newline: enc("\n"),
      };
  }
}

/** `GIT_COLOR_RESET`, which ends a colored word whatever `DiffColors.reset` says */
const GIT_COLOR_RESET = enc("\x1b[m");
const TILDE_LINE = enc("~\n");
const NEWLINE = 0x0a;

/** git's `isspace` (space, TAB, LF, CR) */
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** Compiled word regexes by pattern: a log compiles each once */
const compiled = new Map<string, PosixRegex>();

/**
 * The word regex as `init_diff_words_data` compiles it (`REG_EXTENDED | REG_NEWLINE`).
 *
 * @throws GitApiError git's `fatal: invalid regular expression: <regex>` (exit 128)
 */
export function compileWordRegex(pattern: string | Uint8Array): PosixRegex {
  const key = typeof pattern === "string" ? `s${pattern}` : `b${Array.from(pattern).join(",")}`;
  let re = compiled.get(key);
  if (!re) {
    try {
      re = compilePosixRegex(pattern, { extended: true, newline: true });
    } catch {
      const text =
        typeof pattern === "string" ? pattern : new TextDecoder("latin1").decode(pattern);
      throw new GitApiError(`fatal: invalid regular expression: ${text}`);
    }
    if (compiled.size >= 64) compiled.clear();
    compiled.set(key, re);
  }
  return re;
}

/** The bytes of one word diff, gathered as git's `strbuf` and printed per symbol */
class Pieces {
  private parts: Uint8Array[] = [];

  bytes(b: Uint8Array): void {
    if (b.length > 0) this.parts.push(b);
  }

  str(s: string | undefined): void {
    if (s) this.parts.push(enc(s));
  }

  flushTo(sink: ByteSink): void {
    for (const p of this.parts) sink.push(p);
    this.parts = [];
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }
}

/** `fn_out_diff_words_write_helper`: `text` as pieces of `el`, `newline` for each LF */
function writeHelper(sink: ByteSink, el: StyleElem, newline: Uint8Array, text: Uint8Array): void {
  const sb = new Pieces();
  let at = 0;
  let count = text.length;
  while (count > 0) {
    const nl = text.subarray(at, at + count).indexOf(NEWLINE);
    if (nl !== 0) {
      const colored = el.color !== undefined && el.color !== "";
      if (colored) sb.str(el.color);
      sb.bytes(el.prefix);
      sb.bytes(text.subarray(at, nl < 0 ? at + count : at + nl));
      sb.bytes(el.suffix);
      if (colored) sb.bytes(GIT_COLOR_RESET);
    }
    if (nl < 0) break;
    sb.bytes(newline);
    count -= nl + 1;
    at += nl + 1;
    if (count > 0) sb.flushTo(sink);
  }
  sb.flushTo(sink);
}

/** One side's words (diff.c's `diff_words_buffer`): `orig[0]` is the empty 0th word */
interface WordList {
  /** The words, one per line, as xdiff diffs them */
  lines: Uint8Array;
  /** Each word's `[begin, end)` in the text, after the empty 0th */
  orig: [number, number][];
}

/** `find_word_boundaries`: the next word at or after `begin`, or undefined */
function findWord(
  text: Uint8Array,
  regex: PosixRegex | undefined,
  start: number,
): [number, number] | undefined {
  let begin = start;
  const size = text.length;
  while (regex && begin < size) {
    const m = regex.exec(text.subarray(begin), size - begin, 1);
    if (!m) return undefined;
    const from = begin + m.start;
    const nl = text.subarray(from, begin + m.end).indexOf(NEWLINE);
    const end = nl >= 0 ? from + nl : begin + m.end;
    begin = from;
    if (begin === end) begin++;
    else return begin > end ? undefined : [begin, end];
  }
  while (begin < size && isSpace(text[begin] as number)) begin++;
  if (begin >= size) return undefined;
  let end = begin + 1;
  while (end < size && !isSpace(text[end] as number)) end++;
  return [begin, end];
}

/** `diff_words_fill`: the words of `text`, one per line */
function fillWords(text: Uint8Array, regex: PosixRegex | undefined): WordList {
  const orig: [number, number][] = [[0, 0]];
  const words: [number, number][] = [];
  let size = 0;
  for (let i = 0; i < text.length; ) {
    const found = findWord(text, regex, i);
    if (!found) break;
    orig.push(found);
    words.push(found);
    size += found[1] - found[0] + 1;
    i = found[1];
  }
  const lines = new Uint8Array(size);
  let at = 0;
  for (const [b, e] of words) {
    lines.set(text.subarray(b, e), at);
    at += e - b;
    lines[at++] = NEWLINE;
  }
  return { lines, orig };
}

/** The removed and added lines gathered since the last context line (`diff_words_data`) */
class WordDiffState {
  private minus: Uint8Array[] = [];
  private plus: Uint8Array[] = [];
  private readonly style: Style;

  constructor(
    private readonly sink: ByteSink,
    private readonly regex: PosixRegex | undefined,
    mode: WordDiffMode,
    colors: DiffColors | undefined,
  ) {
    this.style = styleOf(mode, colors);
  }

  /** `diff_words_append`: a line without its sign, its LF included */
  append(kind: "-" | "+", line: Uint8Array): void {
    (kind === "-" ? this.minus : this.plus).push(line);
  }

  /** `diff_words_flush` */
  flush(): void {
    if (this.minus.length > 0 || this.plus.length > 0) this.show();
  }

  /** `diff_words_show` */
  private show(): void {
    const minus = concat(this.minus);
    const plus = concat(this.plus);
    this.minus = [];
    this.plus = [];
    const style = this.style;
    if (plus.length === 0) {
      // special case: only removal
      writeHelper(this.sink, style.oldWord, style.newline, minus);
      return;
    }
    let currentPlus = 0;
    const mw = fillWords(minus, this.regex);
    const pw = fillWords(plus, this.regex);
    for (const change of xdiffHunks(mw.lines, pw.lines)) {
      // fn_out_diff_words_aux: a hunk starts at the word before an empty range
      const minusFirst = change.chg1 ? change.i1 + 1 : change.i1;
      const plusFirst = change.chg2 ? change.i2 + 1 : change.i2;
      const [minusBegin, minusEnd] = span(mw.orig, minusFirst, change.chg1);
      const [plusBegin, plusEnd] = span(pw.orig, plusFirst, change.chg2);
      if (currentPlus !== plusBegin) {
        writeHelper(this.sink, style.ctx, style.newline, plus.subarray(currentPlus, plusBegin));
      }
      if (minusBegin !== minusEnd) {
        writeHelper(this.sink, style.oldWord, style.newline, minus.subarray(minusBegin, minusEnd));
      }
      if (plusBegin !== plusEnd) {
        writeHelper(this.sink, style.newWord, style.newline, plus.subarray(plusBegin, plusEnd));
      }
      currentPlus = plusEnd;
    }
    if (currentPlus !== plus.length) {
      writeHelper(this.sink, style.ctx, style.newline, plus.subarray(currentPlus));
    }
  }
}

/** The text a hunk of words covers: from its first word's start to its last word's end */
function span(orig: [number, number][], first: number, len: number): [number, number] {
  if (len === 0) {
    const end = (orig[first] as [number, number])[1];
    return [end, end];
  }
  return [(orig[first] as [number, number])[0], (orig[first + len - 1] as [number, number])[1]];
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** diff.c's `emit_line_0` without a sign: `set` before the text, the reset after it */
function emitLine(sink: ByteSink, set: string, reset: string, line: Uint8Array): void {
  let len = line.length;
  const hasNewline = len > 0 && line[len - 1] === NEWLINE;
  if (hasNewline) len--;
  const hasCr = len > 0 && line[len - 1] === 0x0d;
  if (hasCr) len--;
  if (len > 0) {
    if (set) sink.push(enc(set));
    sink.push(line.subarray(0, len));
    if (reset) sink.push(enc(reset));
  }
  if (hasCr) sink.push(Uint8Array.of(0x0d));
  if (hasNewline) sink.push(Uint8Array.of(NEWLINE));
}

/**
 * The hunks of a text pair as diff.c's `fn_out_consume` prints them under `--word-diff`:
 * each header as usual (in color, `frag` and `func`), the removed and added lines between
 * two context lines as their word diff, context lines without their sign (porcelain mode:
 * with it, then `~`). An incomplete last line counts as ending in a newline; git's
 * "\ No newline at end of file" is not printed.
 */
export function writeWordDiffHunks(
  sink: ByteSink,
  hunks: readonly ColoredHunk[],
  options: WordDiffOptions,
): void {
  const colors = options.colors;
  const state = new WordDiffState(sink, options.regex, options.mode, colors);
  const context = colors?.context ?? "";
  const reset = colors?.reset ?? "";
  for (const hunk of hunks) {
    state.flush();
    sink.push(colors ? coloredHunkHeader(hunk.header, colors) : hunk.header);
    for (const line of hunk.lines) {
      const bytes = line.bytes;
      // xdl_emit_diffrec: an incomplete line gets its LF (the marker after it is eaten)
      const text =
        bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE ? withNewline(bytes) : bytes;
      if (line.kind === "-" || line.kind === "+") {
        state.append(line.kind, text);
        continue;
      }
      state.flush();
      if (options.mode === "porcelain") {
        // DIFF_SYMBOL_WORDS_PORCELAIN: the line with its sign, then "~"
        emitLine(sink, context, reset, concat([Uint8Array.of(0x20), text]));
        sink.push(TILDE_LINE);
      } else {
        // DIFF_SYMBOL_WORDS: the line without its sign
        emitLine(sink, context, reset, text);
      }
    }
  }
  state.flush();
}

function withNewline(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = NEWLINE;
  return out;
}
