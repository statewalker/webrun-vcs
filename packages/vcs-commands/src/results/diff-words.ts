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
 * Under `log --graph` (`linePrefix`, diff.c's `diff_line_prefix`) hunk headers and context
 * lines start with the prefix as usual, but the word diff places it itself, as git does: where
 * a word hunk starts on a new line (`color_words_output_graph_prefix`) and after each newline
 * inside a piece's text (`fn_out_diff_words_write_helper`); porcelain's `~` lines and most of
 * its `-`/`+` lines go without it. Its chunks are marked for the `LinePrefixSink` the output
 * goes through, which records where the prefix goes. A word hunk's prefix is git's `fputs`,
 * which bypasses `--color-moved`'s buffer: it lands at the start of the patch there.
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
import {
  type ColoredHunk,
  coloredHunkHeader,
  type DiffColors,
  MovedLineBuffer,
} from "./diff-color.js";
import { type LinePrefixSink, markLinePrefix } from "./line-prefix-sink.js";

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
  /**
   * The sink the whole output goes through, placing diff.c's `diff_line_prefix` (`log
   * --graph`'s padding): each chunk is marked with the prefixes git's word diff writes before
   * it, and the sink adds none inside it; unset, the chunks are not marked
   */
  linePrefix?: LinePrefixSink;
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

  /**
   * Prints the piece as `DIFF_SYMBOL_WORD_DIFF` does (`fprintf("%.*s")`): up to its first NUL
   * byte, whatever follows (suffix, reset, newline) dropped with it
   */
  flushTo(sink: ByteSink, prefix: Prefixes | undefined): void {
    const out = (b: Uint8Array) => (prefix ? prefix.push(sink, b) : sink.push(b));
    for (const p of this.parts) {
      const nul = p.indexOf(0);
      if (nul < 0) {
        out(p);
        continue;
      }
      if (nul > 0) out(p.subarray(0, nul));
      break;
    }
    this.parts = [];
  }
}

/**
 * The line prefixes the word diff writes (`DIFF_SYMBOL_WORD_DIFF`s of `diff_line_prefix`),
 * each attached to the next chunk it pushes
 */
class Prefixes {
  private pending = 0;

  constructor(
    /** The output's sink when the writer's sink reaches it in order (no scratch sink) */
    private readonly direct: LinePrefixSink | undefined,
  ) {}

  /** A prefix before whatever is pushed next */
  add(): void {
    this.pending++;
  }

  /**
   * A prefix `fputs` writes to the file (`fn_out_diff_words_aux`): ahead of the symbols
   * `--color-moved` buffers, else where it stands
   */
  addDirect(): void {
    if (this.direct) this.direct.addPoint();
    else this.add();
  }

  /** `bytes`, written by the word diff (no prefix inside it), after the pending prefixes */
  push(sink: ByteSink, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // a view of its own: the mark belongs to the array, and style bytes are pushed often
    sink.push(markLinePrefix(bytes.subarray(0), { before: this.pending, own: true }));
    this.pending = 0;
  }

  /**
   * `bytes` printed through `emit_line_0` (a context line, a hunk header: the prefix at each
   * line start as usual), after the pending prefixes
   */
  pushLine(sink: ByteSink, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    sink.push(
      this.pending > 0
        ? markLinePrefix(bytes.subarray(0), { before: this.pending, own: false })
        : bytes,
    );
    this.pending = 0;
  }
}

/**
 * `fn_out_diff_words_write_helper`: `text` as pieces of `el`, `newline` for each LF, the line
 * prefix (when placed) before each piece after a newline
 */
function writeHelper(
  sink: ByteSink,
  el: StyleElem,
  newline: Uint8Array,
  text: Uint8Array,
  prefix: Prefixes | undefined,
): void {
  const sb = new Pieces();
  let print = false;
  let at = 0;
  let count = text.length;
  while (count > 0) {
    if (print) prefix?.add();
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
    print = true;
    if (count > 0) sb.flushTo(sink, prefix);
  }
  sb.flushTo(sink, prefix);
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
  /** `diff_words_data.current_plus`, an offset into the added text */
  private currentPlus = 0;
  /** `diff_words_data.last_minus` */
  private lastMinus = 0;

  constructor(
    private readonly sink: ByteSink,
    private readonly regex: PosixRegex | undefined,
    mode: WordDiffMode,
    colors: DiffColors | undefined,
    /** Where `diff_line_prefix` goes, undefined when not placed */
    private readonly prefix: Prefixes | undefined,
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

  /** The line prefix as its own `DIFF_SYMBOL_WORD_DIFF` */
  private writePrefix(): void {
    this.prefix?.add();
  }

  /**
   * `color_words_output_graph_prefix`: at the first hunk when it starts the added text, or
   * where the added text printed so far ends with a newline
   */
  private prefixDue(plus: Uint8Array): boolean {
    return (
      (this.lastMinus === 0 && this.currentPlus === 0) ||
      (this.currentPlus > 0 && plus[this.currentPlus - 1] === NEWLINE)
    );
  }

  /** `diff_words_show` */
  private show(): void {
    const minus = concat(this.minus);
    const plus = concat(this.plus);
    this.minus = [];
    this.plus = [];
    const style = this.style;
    const prefix = this.prefix;
    if (plus.length === 0) {
      // special case: only removal
      this.writePrefix();
      writeHelper(this.sink, style.oldWord, style.newline, minus, prefix);
      return;
    }
    this.currentPlus = 0;
    this.lastMinus = 0;
    const mw = fillWords(minus, this.regex);
    const pw = fillWords(plus, this.regex);
    for (const change of xdiffHunks(mw.lines, pw.lines)) {
      // fn_out_diff_words_aux: a hunk starts at the word before an empty range
      const minusFirst = change.chg1 ? change.i1 + 1 : change.i1;
      const plusFirst = change.chg2 ? change.i2 + 1 : change.i2;
      const [minusBegin, minusEnd] = span(mw.orig, minusFirst, change.chg1);
      const [plusBegin, plusEnd] = span(pw.orig, plusFirst, change.chg2);
      // fputs(line_prefix): straight to the file, past the --color-moved buffer
      if (this.prefixDue(plus)) this.prefix?.addDirect();
      const currentPlus = this.currentPlus;
      if (currentPlus !== plusBegin) {
        writeHelper(
          this.sink,
          style.ctx,
          style.newline,
          plus.subarray(currentPlus, plusBegin),
          prefix,
        );
      }
      if (minusBegin !== minusEnd) {
        writeHelper(
          this.sink,
          style.oldWord,
          style.newline,
          minus.subarray(minusBegin, minusEnd),
          prefix,
        );
      }
      if (plusBegin !== plusEnd) {
        writeHelper(
          this.sink,
          style.newWord,
          style.newline,
          plus.subarray(plusBegin, plusEnd),
          prefix,
        );
      }
      this.currentPlus = plusEnd;
      this.lastMinus = minusFirst;
    }
    if (this.currentPlus !== plus.length) {
      if (this.prefixDue(plus)) this.writePrefix();
      writeHelper(this.sink, style.ctx, style.newline, plus.subarray(this.currentPlus), prefix);
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
function emitLine(set: string, reset: string, line: Uint8Array): Uint8Array {
  let len = line.length;
  const hasNewline = len > 0 && line[len - 1] === NEWLINE;
  if (hasNewline) len--;
  const hasCr = len > 0 && line[len - 1] === 0x0d;
  if (hasCr) len--;
  if (len === 0 || (!set && !reset)) return line;
  return concat([enc(set), line.subarray(0, len), enc(reset), line.subarray(len)]);
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
  const outer = options.linePrefix;
  const prefix = outer
    ? new Prefixes(sink === outer || sink instanceof MovedLineBuffer ? outer : undefined)
    : undefined;
  const state = new WordDiffState(sink, options.regex, options.mode, colors, prefix);
  const emit = (bytes: Uint8Array) => (prefix ? prefix.pushLine(sink, bytes) : sink.push(bytes));
  const context = colors?.context ?? "";
  const reset = colors?.reset ?? "";
  for (const hunk of hunks) {
    state.flush();
    emit(colors ? coloredHunkHeader(hunk.header, colors) : hunk.header);
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
        emit(emitLine(context, reset, concat([Uint8Array.of(0x20), text])));
        // printed with fputs, without the line prefix
        if (prefix) prefix.push(sink, TILDE_LINE.slice());
        else sink.push(TILDE_LINE);
      } else {
        // DIFF_SYMBOL_WORDS: the line without its sign
        emit(emitLine(context, reset, text));
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
