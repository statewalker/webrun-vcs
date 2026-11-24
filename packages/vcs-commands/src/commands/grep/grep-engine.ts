/**
 * git's grep matcher and printer (`grep.c`): the patterns compiled as `compile_grep_patterns`
 * compiles them, each line of a source matched as `grep_source_1` matches it, and the output
 * written as `show_line`, `show_pre_context` and `show_funcname_line` write it.
 *
 * @example
 * ```ts
 * const engine = new GrepEngine([grepPattern("foo")], { lineNumber: true });
 * engine.grepSource({ name: encode("file"), content: encode("a foo\nb\n") });
 * new TextDecoder().decode(engine.output()); // "file:1:a foo\n"
 * ```
 *
 * What git does, kept here:
 * - A pattern with newlines is one pattern per line. Patterns are basic POSIX regexes by
 *   default (`extended`, `fixed`, `perl`), compiled with `REG_NEWLINE`, `-i` as `REG_ICASE`;
 *   one without a regex character (`$()*+.?[\^{|`) is a literal, as with `-F`. A pattern
 *   holding a NUL byte dies unless it is `-P`. `-P` is a git built without PCRE: a literal
 *   `-P` pattern matches, any other dies.
 * - `-w` takes a match only between non-word characters (or the line's ends), and retries
 *   from after the next non-word character as `headerless_match_one_pattern` does.
 * - `--and`, `--not`, `(`, `)` (and `--all-match`) build git's expression tree; `--or` is the
 *   default between patterns. `--column` evaluates every branch, a `--not` swapping the
 *   column of a match and of an inverted one.
 * - Context (`-A`, `-B`), function lines (`-p`) and function bodies (`-W`) through the
 *   source's funcname pattern, or git's default (a line starting with a letter, `_` or `$`).
 * - Several sources print as git's threaded grep prints them (its default): each source's
 *   output starts with a hunk mark (`--`, or an empty line with `--break`), and the first line
 *   of the first output is dropped. {@link GrepEngineOptions.threads} `1` prints as git's
 *   single-threaded grep (`--threads=1`).
 *
 * @module
 */

import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";
import type { FindFunction } from "@statewalker/vcs-utils/diff";

import { GitApiError } from "../../errors/index.js";
import { GrepPatternError, type GrepPatternType } from "../rev-filter/index.js";

/** One element of git's pattern list: a pattern or an expression operator. */
export type GrepToken =
  | {
      kind: "pattern";
      /** The pattern's bytes */
      pattern: Uint8Array;
      /** Where it came from: `-e option`, `command line`, or a `-f` file's name */
      origin: string;
      /** Its line in a `-f` file (1-based, empty lines not counted), else 0 */
      no: number;
    }
  | { kind: "and" }
  | { kind: "not" }
  | { kind: "open" }
  | { kind: "close" };

const encoder = new TextEncoder();

/** A pattern token (`-e <pattern>`), its origin `-e option` unless given. */
export function grepPattern(pattern: string | Uint8Array, origin = "-e option", no = 0): GrepToken {
  return {
    kind: "pattern",
    pattern: typeof pattern === "string" ? encoder.encode(pattern) : pattern,
    origin,
    no,
  };
}

/**
 * The patterns of a `-f` file (builtin/grep.c `file_callback`): one per line (a CR before
 * the newline dropped), empty lines skipped, each numbered by the non-empty lines before it.
 */
export function grepPatternFile(content: string | Uint8Array, name: string): GrepToken[] {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const out: GrepToken[] = [];
  let lno = 0;
  let pos = 0;
  while (pos < bytes.length) {
    let end = bytes.indexOf(0x0a, pos);
    const next = end < 0 ? bytes.length : end + 1;
    if (end < 0) end = bytes.length;
    let stop = end;
    if (end < bytes.length && stop > pos && bytes[stop - 1] === 0x0d) stop--;
    if (stop > pos) out.push(grepPattern(bytes.slice(pos, stop), name, ++lno));
    pos = next;
  }
  return out;
}

/** git's die() of grep (an expression or option it refuses): exit status 128. */
export class GrepError extends GitApiError {
  /** git's lines */
  readonly lines: string[];

  constructor(line: string) {
    super(line, { exitCode: 128 });
    this.name = "GrepError";
    this.lines = [line];
  }
}

/** The escape sequences of the colored output (`color.grep.<slot>`); "" for none. */
export interface GrepColors {
  context: string;
  filename: string;
  function: string;
  lineNumber: string;
  column: string;
  matchContext: string;
  matchSelected: string;
  selected: string;
  separator: string;
}

/** git's default grep colors (`GREP_OPT_INIT`). */
export const DEFAULT_GREP_COLORS: Readonly<GrepColors> = {
  context: "",
  filename: "\x1b[35m",
  function: "",
  lineNumber: "\x1b[32m",
  column: "\x1b[32m",
  matchContext: "\x1b[1;31m",
  matchSelected: "\x1b[1;31m",
  selected: "",
  separator: "\x1b[36m",
};

/** How binary sources are searched (`-a`, `-I`). */
export type GrepBinaryMode = "default" | "text" | "nomatch";

/** What the engine matches and prints (git's `struct grep_opt`). */
export interface GrepEngineOptions {
  /** The pattern type (default basic) */
  patternType?: GrepPatternType;
  /** `-i` */
  ignoreCase?: boolean;
  /** `-w` */
  wordRegexp?: boolean;
  /** `-v` */
  invert?: boolean;
  /** `--all-match` */
  allMatch?: boolean;
  /** `-n` */
  lineNumber?: boolean;
  /** `--column` */
  column?: boolean;
  /** Names before the lines (default true; `-h` false, `-H` true) */
  pathname?: boolean;
  /** `-z`: names followed by NUL, unquoted */
  nullFollowingName?: boolean;
  /** `-o` (ignored with `-v`, as git does) */
  onlyMatching?: boolean;
  /** `-c` */
  count?: boolean;
  /** `-l` */
  nameOnly?: boolean;
  /** `-L` */
  unmatchNameOnly?: boolean;
  /** `-q` */
  statusOnly?: boolean;
  /** `--break` */
  fileBreak?: boolean;
  /** `--heading` */
  heading?: boolean;
  /** `-B` */
  preContext?: number;
  /** `-A` */
  postContext?: number;
  /** `-p` */
  funcname?: boolean;
  /** `-W` */
  funcbody?: boolean;
  /** `-m` (negative: no limit) */
  maxCount?: number;
  /** `-a` (`text`), `-I` (`nomatch`) */
  binary?: GrepBinaryMode;
  /** Colors, or none (undefined) */
  colors?: GrepColors;
  /**
   * The git version whose output and messages to follow (default `2.56`): 2.43 counts `-o`
   * columns after the first from the end of the previous match, keeps a trailing empty line
   * in a `-W` body, and words two expression errors differently
   */
  compatibility?: "2.43" | "2.56";
  /**
   * git's worker threads: undefined or more than one prints as git's threaded grep (its
   * default), 1 as `--threads=1`
   */
  threads?: number;
}

/** One file or blob to search. */
export interface GrepSourceInput {
  /** The name printed for it (relative, quoted, `<rev>:` before it) */
  name: Uint8Array;
  /** Its content (textconv applied when {@link textconv}), undefined when it cannot be read */
  content: Uint8Array | undefined;
  /** The diff driver's verdict (`-diff`, `diff.<driver>.binary`), else the content decides */
  binary?: boolean;
  /** The content is a textconv's output: never binary */
  textconv?: boolean;
  /**
   * The function lines of `-p`/`-W` (the diff driver's funcname pattern); undefined: git's
   * default rule. Asked only when needed; may throw as git dies on a bad pattern.
   */
  findFunction?: () => FindFunction | undefined;
}

type Matcher = (
  buf: Uint8Array,
  bol: number,
  eol: number,
  notbol: boolean,
) => [number, number] | undefined;

interface Pattern {
  token: Extract<GrepToken, { kind: "pattern" }>;
  exec: Matcher;
  word: boolean;
}

type Expr =
  | { k: "atom"; p: Pattern; hit: boolean }
  | { k: "not"; x: Expr; hit: boolean }
  | { k: "and"; l: Expr; r: Expr; hit: boolean }
  | { k: "or"; l: Expr; r: Expr; hit: boolean };

/** Characters that make a pattern a regex (git's `is_regex_special`) */
const REGEX_SPECIAL = new Uint8Array(256);
for (const c of "$()*+.?[\\^{|") REGEX_SPECIAL[c.charCodeAt(0)] = 1;

const isAlpha = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
/** grep.c's word_char: git's ASCII isalnum, or `_` */
const wordChar = (b: number | undefined) =>
  b !== undefined && (isAlpha(b) || isDigit(b) || b === 0x5f);
/** git's isspace: space, tab, LF, CR */
const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const lowerAscii = (b: number) => (b >= 0x41 && b <= 0x5a ? b + 32 : b);

/** A C string: the bytes up to the first NUL, as `%s` prints them */
function cString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return new TextDecoder("latin1").decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}

/** A literal pattern (compile_fixed_regexp: the pattern quoted, `REG_ICASE` for `-i`) */
function literalMatcher(needle: Uint8Array, ignoreCase: boolean): Matcher {
  const n = ignoreCase ? needle.map(lowerAscii) : needle;
  return (buf, bol, eol) => {
    const last = eol - n.length;
    outer: for (let i = bol; i <= last; i++) {
      for (let k = 0; k < n.length; k++) {
        const b = buf[i + k] as number;
        if ((ignoreCase ? lowerAscii(b) : b) !== n[k]) continue outer;
      }
      return [i - bol, i - bol + n.length];
    }
    return undefined;
  };
}

/** grep.c's compile_regexp of one pattern (a git built without PCRE) */
function compilePattern(
  token: Extract<GrepToken, { kind: "pattern" }>,
  type: GrepPatternType,
  ignoreCase: boolean,
): Matcher {
  const bytes = token.pattern;
  const where = token.no
    ? `In '${token.origin}' at ${token.no}, `
    : token.origin
      ? `${token.origin}, `
      : "";
  const text = cString(bytes);
  if (type !== "perl" && bytes.includes(0)) {
    throw new GrepPatternError(
      text,
      "fatal: given pattern contains NULL byte (via -f <file>). This is only supported with -P under PCRE v2",
    );
  }
  const isFixed = !bytes.some((b) => REGEX_SPECIAL[b] === 1);
  // compile_fixed_regexp quotes the pattern as a C string: a `-P` one ends at its first NUL
  if (type === "fixed" || isFixed) return literalMatcher(encodeLatin1(text), ignoreCase);
  if (type === "perl") {
    // a git built without PCRE: no JavaScript RegExp ever runs a user's pattern
    throw new GrepPatternError(
      text,
      "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE",
    );
  }
  try {
    const re = compilePosixRegex(bytes, {
      extended: type === "extended",
      icase: ignoreCase,
      newline: true,
    });
    return (buf, bol, eol, notbol) => {
      const m = re.exec(buf.subarray(bol, eol), eol - bol, 1, notbol);
      return m ? [m.start, m.end] : undefined;
    };
  } catch (e) {
    if (e instanceof PosixRegexError) {
      throw new GrepPatternError(text, `fatal: ${where}'${text}': ${e.message}`);
    }
    throw e;
  }
}

function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The text git prints for a token (`p->pattern`) */
function tokenText(t: GrepToken): string {
  switch (t.kind) {
    case "pattern":
      return cString(t.pattern);
    case "and":
      return "--and";
    case "not":
      return "--not";
    case "open":
      return "(";
    case "close":
      return ")";
  }
}

/** grep.c's compile_pattern_or and friends over the token list */
class ExpressionParser {
  pos = 0;
  constructor(
    private readonly tokens: GrepToken[],
    private readonly patterns: Map<GrepToken, Pattern>,
    private readonly legacy = false,
  ) {}

  private die(message: string): never {
    throw new GrepError(`fatal: ${message}`);
  }

  private get cur(): GrepToken | undefined {
    return this.tokens[this.pos];
  }

  atom(): Expr | undefined {
    const p = this.cur;
    if (!p) return undefined;
    if (p.kind === "pattern") {
      this.pos++;
      return { k: "atom", p: this.patterns.get(p) as Pattern, hit: false };
    }
    if (p.kind === "open") {
      this.pos++;
      const x = this.or();
      if (this.cur?.kind !== "close") {
        this.die(this.legacy ? "unmatched parenthesis" : "unmatched ( for expression group");
      }
      this.pos++;
      return x;
    }
    return undefined;
  }

  not(): Expr | undefined {
    const p = this.cur;
    if (!p) return undefined;
    if (p.kind === "not") {
      if (this.pos + 1 >= this.tokens.length) this.die("--not not followed by pattern expression");
      this.pos++;
      const x = this.not();
      if (!x) this.die("--not followed by non pattern expression");
      return { k: "not", x, hit: false };
    }
    return this.atom();
  }

  and(): Expr | undefined {
    const x = this.not();
    const p = this.cur;
    if (p && p.kind === "and") {
      if (!x) this.die("--and not preceded by pattern expression");
      if (this.pos + 1 >= this.tokens.length) this.die("--and not followed by pattern expression");
      this.pos++;
      const y = this.and();
      if (!y) this.die("--and not followed by pattern expression");
      return { k: "and", l: x, r: y, hit: false };
    }
    return x;
  }

  or(): Expr | undefined {
    const x = this.and();
    const p = this.cur;
    if (x && p && p.kind !== "close") {
      const y = this.or();
      if (!y) this.die(`not a pattern expression ${tokenText(p)}`);
      return { k: "or", l: x, r: y, hit: false };
    }
    return x;
  }
}

/** A growing byte buffer */
class Out {
  chunks: Uint8Array[] = [];
  length = 0;
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const NL = new Uint8Array([0x0a]);
const NUL = new Uint8Array([0]);
const HUNK = encoder.encode("--");
const RESET = encoder.encode("\x1b[m");
const FIRST_FEW_BYTES = 8000;

/** `buffer_is_binary`: a NUL among the first 8000 bytes */
export function bufferIsBinary(content: Uint8Array): boolean {
  const end = Math.min(content.length, FIRST_FEW_BYTES);
  for (let i = 0; i < end; i++) if (content[i] === 0) return true;
  return false;
}

/**
 * Matches sources and collects git grep's output. Create one per `git grep` run (its hunk
 * marks depend on what earlier sources printed); {@link output} gives what was printed.
 *
 * @throws GrepPatternError, GrepError (from the constructor) where git dies compiling
 */
export class GrepEngine {
  private readonly patterns: Pattern[] = [];
  private readonly expr?: Expr;
  private readonly allMatch: boolean;
  private readonly o: Required<
    Omit<GrepEngineOptions, "colors" | "threads" | "patternType" | "compatibility">
  >;
  private readonly colors?: GrepColors;
  private readonly threaded: boolean;
  /** git 2.43 compatibility */
  private readonly legacy: boolean;
  private readonly skipFirstLineSetting: boolean;
  private skipFirstLine: boolean;
  private lastShown = 0;
  private showHunkMark = false;
  private readonly out = new Out();
  private cur = new Out();
  /** The current source's funcname matcher: undefined not asked yet, null the default rule */
  private findFunc: FindFunction | null | undefined;
  private source?: GrepSourceInput;
  private buf: Uint8Array = new Uint8Array(0);

  constructor(tokens: readonly GrepToken[], options: GrepEngineOptions = {}) {
    const type = options.patternType ?? "basic";
    this.legacy = options.compatibility === "2.43";
    const ignoreCase = !!options.ignoreCase;
    const word = !!options.wordRegexp;
    // do_append_grep_pat: a pattern with newlines is one pattern per line
    const list: GrepToken[] = [];
    for (const t of tokens) {
      if (t.kind !== "pattern" || !t.pattern.includes(0x0a)) {
        list.push(t);
        continue;
      }
      let pos = 0;
      for (;;) {
        const nl = t.pattern.indexOf(0x0a, pos);
        const end = nl < 0 ? t.pattern.length : nl;
        list.push({ ...t, pattern: t.pattern.slice(pos, end) });
        if (nl < 0) break;
        pos = nl + 1;
      }
    }
    if (list.length === 0) throw new GrepError("fatal: no pattern given");
    const byToken = new Map<GrepToken, Pattern>();
    let extended = false;
    for (const t of list) {
      if (t.kind !== "pattern") {
        extended = true;
        continue;
      }
      const p: Pattern = { token: t, exec: compilePattern(t, type, ignoreCase), word };
      this.patterns.push(p);
      byToken.set(t, p);
    }
    if (options.allMatch) extended = true;
    if (extended) {
      const parser = new ExpressionParser(list, byToken, this.legacy);
      this.expr = parser.or();
      const left = list[parser.pos];
      if (left) {
        const what = this.legacy
          ? "incomplete pattern expression"
          : "incomplete pattern expression group";
        throw new GrepError(`fatal: ${what}: ${tokenText(left)}`);
      }
    }
    this.allMatch = !!options.allMatch && this.expr !== undefined;
    const invert = !!options.invert;
    this.o = {
      ignoreCase,
      wordRegexp: word,
      invert,
      allMatch: !!options.allMatch,
      lineNumber: !!options.lineNumber,
      column: !!options.column,
      pathname: options.pathname ?? true,
      nullFollowingName: !!options.nullFollowingName,
      onlyMatching: !invert && !!options.onlyMatching,
      count: !!options.count,
      nameOnly: !!options.nameOnly,
      unmatchNameOnly: !!options.unmatchNameOnly,
      statusOnly: !!options.statusOnly,
      fileBreak: !!options.fileBreak,
      heading: !!options.heading,
      preContext: Math.max(0, options.preContext ?? 0),
      postContext: Math.max(0, options.postContext ?? 0),
      funcname: !!options.funcname,
      funcbody: !!options.funcbody,
      maxCount: options.maxCount ?? -1,
      binary: options.binary ?? "default",
    };
    this.colors = options.colors;
    this.threaded = options.threads === undefined || options.threads > 1;
    const o = this.o;
    this.skipFirstLineSetting =
      this.threaded &&
      !(o.nameOnly || o.unmatchNameOnly || o.count) &&
      (o.preContext > 0 || o.postContext > 0 || o.fileBreak || o.funcbody);
    this.skipFirstLine = this.skipFirstLineSetting;
  }

  /** Everything printed so far */
  output(): Uint8Array {
    return this.out.bytes();
  }

  /** Searches one source (grep.c's `grep_source`); returns whether it hit. */
  grepSource(source: GrepSourceInput): boolean {
    this.source = source;
    this.cur = new Out();
    let hit: boolean;
    if (!this.allMatch) {
      hit = this.grepSource1(source, false);
    } else {
      const expr = this.expr as Expr;
      clearHitMarkers(expr);
      this.grepSource1(source, true);
      hit = checkHitMarkers(expr) ? this.grepSource1(source, false) : false;
    }
    this.workDone();
    this.source = undefined;
    return hit;
  }

  /** builtin/grep.c's work_done: the source's output, the first line of all dropped when threaded */
  private workDone(): void {
    if (this.cur.length === 0) return;
    let bytes = this.cur.bytes();
    if (this.skipFirstLine) {
      const nl = bytes.indexOf(0x0a);
      bytes = nl < 0 ? new Uint8Array(0) : bytes.subarray(nl + 1);
      this.skipFirstLine = false;
    }
    this.out.push(bytes);
  }

  private emit(bytes: Uint8Array): void {
    this.cur.push(bytes);
  }

  private emitColor(bytes: Uint8Array, color: string | undefined): void {
    if (this.colors && color) {
      this.emit(encoder.encode(color));
      this.emit(bytes);
      this.emit(RESET);
    } else this.emit(bytes);
  }

  private emitSep(sign: number): void {
    if (this.o.nullFollowingName) this.emit(NUL);
    else this.emitColor(new Uint8Array([sign]), this.colors?.separator);
  }

  private showName(name: Uint8Array): void {
    this.emitColor(name, this.colors?.filename);
    this.emit(this.o.nullFollowingName ? NUL : NL);
  }

  /** headerless_match_one_pattern: `[so, eo]` from `bol` */
  private matchOne(
    p: Pattern,
    bol: number,
    eol: number,
    notbolIn: boolean,
  ): [number, number] | undefined {
    const buf = this.buf;
    const start = bol;
    let notbol = notbolIn;
    for (;;) {
      const m = p.exec(buf, bol, eol, notbol);
      let hit = m !== undefined;
      if (m && p.word) {
        const [so, eo] = m;
        const okStart = so === 0 || !wordChar(buf[bol + so - 1]);
        const okEnd = eo === eol - bol || !wordChar(buf[bol + eo]);
        if (!(okStart && okEnd)) hit = false;
        // words consist of at least one character
        if (so === eo) hit = false;
        if (!hit && bol + so + 1 < eol) {
          // a later match may be a word: retry after the next non-word character
          bol = bol + so + 1;
          while (wordChar(buf[bol - 1]) && bol < eol) bol++;
          notbol = true;
          if (bol < eol) continue;
        }
      }
      if (!hit || !m) return undefined;
      return [m[0] + bol - start, m[1] + bol - start];
    }
  }

  /** match_expr_eval; `col` and `icol` are the earliest match and inverted match columns */
  private evaluate(
    x: Expr,
    bol: number,
    eol: number,
    col: { v: number },
    icol: { v: number },
    collect: boolean,
  ): boolean {
    let h = false;
    switch (x.k) {
      case "atom": {
        const m = this.matchOne(x.p, bol, eol, false);
        h = m !== undefined;
        if (m && (col.v < 0 || m[0] < col.v)) col.v = m[0];
        break;
      }
      case "not":
        // a NOT swaps the columns
        h = !this.evaluate(x.x, bol, eol, icol, col, false);
        break;
      case "and":
        h = this.evaluate(x.l, bol, eol, col, icol, false);
        if (h || this.o.column) {
          h = this.evaluate(x.r, bol, eol, col, icol, false) && h;
        }
        break;
      case "or":
        if (!(collect || this.o.column)) {
          return (
            this.evaluate(x.l, bol, eol, col, icol, false) ||
            this.evaluate(x.r, bol, eol, col, icol, false)
          );
        }
        h = this.evaluate(x.l, bol, eol, col, icol, false);
        if (collect) x.l.hit ||= h;
        h = this.evaluate(x.r, bol, eol, col, icol, collect) || h;
        break;
    }
    if (collect) x.hit ||= h;
    return h;
  }

  /** match_line */
  private matchLine(
    bol: number,
    eol: number,
    col: { v: number },
    icol: { v: number },
    collect: boolean,
  ): boolean {
    if (this.expr) return this.evaluate(this.expr, bol, eol, col, icol, collect);
    let hit = false;
    for (const p of this.patterns) {
      const m = this.matchOne(p, bol, eol, false);
      if (!m) continue;
      hit = true;
      // with --column every pattern is asked, for the earliest match
      if (!this.o.column) break;
      if (col.v < 0 || m[0] < col.v) col.v = m[0];
    }
    return hit;
  }

  /** grep_next_match over every pattern: the earliest match (the longest of those) */
  private nextMatch(bol: number, eol: number, notbol: boolean): [number, number] | undefined {
    let best: [number, number] | undefined;
    if (bol >= eol) return undefined;
    for (const p of this.patterns) {
      const m = this.matchOne(p, bol, eol, notbol);
      if (!m) continue;
      if (best && (m[0] > best[0] || (m[0] === best[0] && m[1] < best[1]))) continue;
      best = m;
    }
    return best;
  }

  private showLineHeader(name: Uint8Array, lno: number, cno: number, sign: number): void {
    const o = this.o;
    if (o.heading && this.lastShown === 0) {
      this.emitColor(name, this.colors?.filename);
      this.emit(NL);
    }
    this.lastShown = lno;
    if (!o.heading && o.pathname) {
      this.emitColor(name, this.colors?.filename);
      this.emitSep(sign);
    }
    if (o.lineNumber) {
      this.emitColor(encoder.encode(String(lno)), this.colors?.lineNumber);
      this.emitSep(sign);
    }
    if (o.column && cno) {
      this.emitColor(encoder.encode(String(cno)), this.colors?.column);
      this.emitSep(sign);
    }
  }

  /** show_line */
  private showLine(bol: number, eol: number, lno: number, cnoIn: number, sign: number): void {
    const o = this.o;
    const buf = this.buf;
    const name = (this.source as GrepSourceInput).name;
    let cno = cnoIn;
    if (o.fileBreak && this.lastShown === 0) {
      if (this.showHunkMark) this.emit(NL);
    } else if (o.preContext || o.postContext || o.funcbody) {
      if (this.lastShown === 0) {
        if (this.showHunkMark) {
          this.emitColor(HUNK, this.colors?.separator);
          this.emit(NL);
        }
      } else if (lno > this.lastShown + 1) {
        this.emitColor(HUNK, this.colors?.separator);
        this.emit(NL);
      }
    }
    if (!o.onlyMatching) this.showLineHeader(name, lno, cno, sign);
    let at = bol;
    if (this.colors || o.onlyMatching) {
      let matchColor: string | undefined;
      let lineColor: string | undefined;
      if (this.colors) {
        matchColor = sign === 0x3a ? this.colors.matchSelected : this.colors.matchContext;
        if (sign === 0x3a) lineColor = this.colors.selected;
        else if (sign === 0x2d) lineColor = this.colors.context;
        else if (sign === 0x3d) lineColor = this.colors.function;
      }
      let notbol = false;
      for (;;) {
        const m = this.nextMatch(at, eol, notbol);
        if (!m || m[0] === m[1]) break;
        // 2.43 starts from the line's column and adds each match's end
        if (!this.legacy) cno = at - bol + m[0] + 1;
        if (o.onlyMatching) this.showLineHeader(name, lno, cno, sign);
        else this.emitColor(buf.subarray(at, at + m[0]), lineColor);
        this.emitColor(buf.subarray(at + m[0], at + m[1]), matchColor);
        if (o.onlyMatching) this.emit(NL);
        at += m[1];
        if (this.legacy) cno += m[1];
        notbol = true;
      }
      if (!o.onlyMatching) {
        this.emitColor(buf.subarray(at, eol), lineColor);
        this.emit(NL);
      }
      return;
    }
    this.emit(buf.subarray(at, eol));
    this.emit(NL);
  }

  /** match_funcname */
  private matchFuncname(bol: number, eol: number): boolean {
    if (this.findFunc === undefined) {
      this.findFunc = this.source?.findFunction?.() ?? null;
    }
    if (this.findFunc) return this.findFunc(this.buf.subarray(bol, eol)) !== undefined;
    if (bol === eol) return false;
    const c = this.buf[bol] ?? 0;
    return isAlpha(c) || c === 0x5f || c === 0x24;
  }

  private isEmptyLine(bol: number, eol: number): boolean {
    let at = bol;
    while (at < eol && at < this.buf.length && isSpace(this.buf[at] as number)) at++;
    return at === eol;
  }

  /** show_funcname_line */
  private showFuncnameLine(bolIn: number, lnoIn: number): void {
    const buf = this.buf;
    let bol = bolIn;
    let lno = lnoIn;
    while (bol > 0) {
      const eol = --bol;
      while (bol > 0 && buf[bol - 1] !== 0x0a) bol--;
      lno--;
      if (lno <= this.lastShown) break;
      if (this.matchFuncname(bol, eol)) {
        this.showLine(bol, eol, lno, 0, 0x3d);
        break;
      }
    }
  }

  /** show_pre_context */
  private showPreContext(bolIn: number, end: number, lno: number): void {
    const o = this.o;
    const buf = this.buf;
    let bol = bolIn;
    let cur = lno;
    let from = 1;
    let funcnameLno = 0;
    let funcnameNeeded = o.funcname;
    let commentNeeded = false;
    if (o.preContext < lno) from = lno - o.preContext;
    if (from <= this.lastShown) from = this.lastShown + 1;
    const origFrom = from;
    if (o.funcbody) {
      if (this.matchFuncname(bol, end)) commentNeeded = true;
      else funcnameNeeded = true;
      from = this.lastShown + 1;
    }
    // rewind
    while (bol > 0 && cur > from) {
      const nextBol = bol;
      const eol = --bol;
      while (bol > 0 && buf[bol - 1] !== 0x0a) bol--;
      cur--;
      if (commentNeeded && (this.isEmptyLine(bol, eol) || this.matchFuncname(bol, eol))) {
        commentNeeded = false;
        from = origFrom;
        if (cur < from) {
          cur++;
          bol = nextBol;
          break;
        }
      }
      if (funcnameNeeded && this.matchFuncname(bol, eol)) {
        funcnameLno = cur;
        funcnameNeeded = false;
        if (o.funcbody) commentNeeded = true;
        else from = origFrom;
      }
    }
    // a function signature further back
    if (o.funcname && funcnameNeeded) this.showFuncnameLine(bol, cur);
    // back forward
    while (cur < lno) {
      let eol = bol;
      while (buf[eol] !== 0x0a) eol++;
      this.showLine(bol, eol, cur, 0, cur === funcnameLno ? 0x3d : 0x2d);
      bol = eol + 1;
      cur++;
    }
  }

  /** grep_source_1 */
  private grepSource1(source: GrepSourceInput, collect: boolean): boolean {
    const o = this.o;
    if (o.preContext || o.postContext || o.fileBreak || o.funcbody) {
      // hunk marks, except before the first file (threaded: always, the first line dropped)
      if (this.lastShown) this.showHunkMark = true;
      if (this.threaded) this.showHunkMark = true;
    }
    this.lastShown = 0;
    let binaryMatchOnly = false;
    if (!source.textconv) {
      const binary = source.binary ?? (source.content ? bufferIsBinary(source.content) : false);
      if (o.binary === "default" && binary) binaryMatchOnly = true;
      else if (o.binary === "nomatch" && binary) return false;
    }
    this.findFunc = undefined;
    const buf = source.content;
    if (!buf) return false;
    this.buf = buf;
    const size = buf.length;
    let bol = 0;
    let left = size;
    let lno = 1;
    let lastHit = 0;
    let count = 0;
    let showFunction = false;
    let peekBol = -1;
    // should_lookahead: plain patterns, no inversion
    const tryLookahead = !this.expr && !o.invert;
    while (left) {
      if (tryLookahead && !(lastHit && (showFunction || lno <= lastHit + o.postContext))) {
        // look_ahead: skip to the line of the earliest match in the rest of the buffer
        let earliest = -1;
        for (const p of this.patterns) {
          const m = p.exec(buf, bol, size, false);
          if (m && (earliest < 0 || m[0] < earliest)) earliest = m[0];
        }
        if (earliest < 0) break;
        let sp = bol + earliest;
        while (sp > bol && buf[sp - 1] !== 0x0a) sp--;
        for (let at = buf.indexOf(0x0a, bol); at >= 0 && at < sp; at = buf.indexOf(0x0a, at + 1)) {
          lno++;
        }
        left -= sp - bol;
        bol = sp;
      }
      let eol = buf.indexOf(0x0a, bol);
      if (eol < 0) eol = size;
      left = size - eol;
      const col = { v: -1 };
      const icol = { v: -1 };
      let hit = this.matchLine(bol, eol, col, icol, collect);
      if (!collect) {
        if (o.invert) hit = !hit;
        if (o.unmatchNameOnly) {
          if (hit) return false;
        } else if (hit && (o.maxCount < 0 || count < o.maxCount)) {
          count++;
          if (o.statusOnly) return true;
          if (o.nameOnly) {
            this.showName(source.name);
            return true;
          }
          if (!o.count) {
            if (binaryMatchOnly) {
              this.emit(encoder.encode("Binary file "));
              this.emitColor(source.name, this.colors?.filename);
              this.emit(encoder.encode(" matches\n"));
              return true;
            }
            // the pre-context lines not shown yet
            if (o.preContext || o.funcbody) this.showPreContext(bol, eol, lno);
            else if (o.funcname) this.showFuncnameLine(bol, lno);
            let cno = o.invert ? icol.v : col.v;
            if (cno < 0) cno = 0;
            this.showLine(bol, eol, lno, cno + 1, 0x3a);
            lastHit = lno;
            if (o.funcbody) showFunction = true;
          }
        } else {
          if (showFunction && (peekBol < 0 || peekBol < bol)) {
            // trailing empty lines are not interesting: peek past them (the byte after the
            // buffer reads as git's terminating NUL)
            let peekLeft = left;
            let peekEol = eol;
            peekBol = bol;
            while (this.isEmptyLine(peekBol, peekEol)) {
              peekBol = peekEol + 1;
              let e = peekBol;
              while (peekLeft && (e < size ? buf[e] : 0) !== 0x0a) {
                peekLeft--;
                e++;
              }
              peekEol = e;
            }
            // git 2.43 has no end-of-buffer check: a trailing empty line stays in the body
            if ((!this.legacy && peekBol >= size) || this.matchFuncname(peekBol, peekEol)) {
              showFunction = false;
            }
          }
          if (showFunction || (lastHit && lno <= lastHit + o.postContext)) {
            // within the post-context of the last hit
            this.showLine(bol, eol, lno, col.v + 1, 0x2d);
          }
        }
      }
      bol = eol + 1;
      if (!left) break;
      left--;
      lno++;
    }
    if (collect) return false;
    if (o.statusOnly) return o.unmatchNameOnly;
    if (o.unmatchNameOnly) {
      // no hit: the name is shown
      this.showName(source.name);
      return true;
    }
    if (o.count && count) {
      if (o.pathname) {
        this.emitColor(source.name, this.colors?.filename);
        this.emitSep(0x3a);
      }
      this.emit(encoder.encode(`${count}\n`));
      return true;
    }
    return lastHit !== 0;
  }
}

/** clr_hit_marker: the top-level or chain's markers */
function clearHitMarkers(xIn: Expr): void {
  let x = xIn;
  for (;;) {
    x.hit = false;
    if (x.k !== "or") return;
    x.l.hit = false;
    x = x.r;
  }
}

/** chk_hit_marker: every term of the top-level or chain hit some line */
function checkHitMarkers(xIn: Expr): boolean {
  let x = xIn;
  for (;;) {
    if (x.k !== "or") return x.hit;
    if (!x.l.hit) return false;
    x = x.r;
  }
}
