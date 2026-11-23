/**
 * `git log --grep/--author/--committer` matching: grep.c's patterns and expression run over a
 * commit's raw object as revision.c's `commit_match` runs them.
 *
 * @example
 * ```ts
 * const grep = compileCommitGrep({ messages: ["fix"], authors: ["^A U"], allMatch: true });
 * grep.matches(rawCommitBytes); // true when a message line has "fix" and the author starts "A U"
 * ```
 *
 * What git does, kept here:
 * - The buffer is the commit object (headers, an empty line, the message). Lines are matched
 *   one at a time; header patterns (`--author`, `--committer`) only on header lines starting
 *   with `author ` / `committer `, matched after that prefix and up to the last `>` (the
 *   timestamp stripped), message patterns (`--grep`) only from the first empty line on (that
 *   line included, so `--grep=` and `--grep=^$` match every commit with a message part).
 * - Patterns are basic POSIX regexes by default (`grep.patternType`, `grep.extendedRegexp`,
 *   `-E`, `-F`, `--basic-regexp`, `-P`), compiled with `REG_NEWLINE` and `-i` as `REG_ICASE`;
 *   a pattern holding newlines is several patterns.
 * - Without `--all-match`, `--invert-grep` or header patterns, any message pattern on any line
 *   matches. Otherwise the expression is built as `compile_grep_patterns` builds it: the
 *   message patterns or-ed (negated by `--invert-grep`), each header field's patterns or-ed,
 *   and every field and the message part (with `--all-match`: every message pattern) must hit
 *   some line (`chk_hit_marker`); `--invert-grep` rejects a commit where any message pattern
 *   hit a message line (`body_hit`), so it inverts `--grep` only, never `--author`.
 *
 * @module
 */

import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";

import { GitApiError } from "../../errors/index.js";
import type { Mailmap } from "../mailmap.js";

/** git's grep pattern types (`grep.patternType`; `-G`/`--basic-regexp`, `-E`, `-F`, `-P`) */
export type GrepPatternType = "basic" | "extended" | "fixed" | "perl";

/** What a commit grep looks for, as `git log`'s options give it */
export interface CommitGrepOptions {
  /** `--grep` patterns (the message part), in order */
  messages?: readonly string[];
  /** `--author` patterns */
  authors?: readonly string[];
  /** `--committer` patterns */
  committers?: readonly string[];
  /** `--all-match`: every `--grep` pattern must match (header patterns always must) */
  allMatch?: boolean;
  /** `--invert-grep`: commits whose message matches no `--grep` pattern */
  invertGrep?: boolean;
  /** `-i` / `--regexp-ignore-case` */
  ignoreCase?: boolean;
  /** The pattern type (default `basic`) */
  patternType?: GrepPatternType;
  /**
   * The mailmap applied to the `author`/`committer` lines before header patterns are matched
   * (`git log` with `log.mailmap`, its default; never `git rev-list`)
   */
  mailmap?: Mailmap;
}

/**
 * A pattern git cannot compile (`fatal: command line, '<pattern>': <error>`, `header, ` for
 * `--author`/`--committer`; exit 128). A `-P` pattern with a regex character dies too, as in a
 * git built without PCRE (`fatal: cannot use Perl-compatible regexes when not compiled with
 * USE_LIBPCRE`).
 */
export class GrepPatternError extends GitApiError {
  readonly pattern: string;
  /** git's lines */
  readonly lines: string[];

  constructor(pattern: string, line: string) {
    super(line);
    this.name = "GrepPatternError";
    this.pattern = pattern;
    this.lines = [line];
  }
}

/** A compiled commit grep */
export interface CommitGrep {
  /** Whether the commit (its raw object bytes) matches, as `commit_match` answers */
  matches(raw: Uint8Array): boolean;
}

const FIELD_AUTHOR = 0;
const FIELD_COMMITTER = 1;
const FIELD_PREFIX = [new TextEncoder().encode("author "), new TextEncoder().encode("committer ")];

interface Pattern {
  head: boolean;
  field: number;
  test(line: Uint8Array): boolean;
}

type Expr =
  | { k: "true"; hit: boolean }
  | { k: "atom"; p: Pattern; hit: boolean }
  | { k: "not"; x: Expr; hit: boolean }
  | { k: "or"; l: Expr; r: Expr; hit: boolean };

/** Characters that make a pattern a regex (git's `is_regex_special`) */
const REGEX_SPECIAL = new Set([..."$()*+.?[\\^{|"].map((c) => c.charCodeAt(0)));

const encoder = new TextEncoder();

/** git's `do_append_grep_pat`: a pattern with newlines is one pattern per line, in order */
function splitPattern(pattern: string): string[] {
  return pattern.split("\n");
}

function lowerAscii(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 32 : b;
}

/** A literal pattern (`-F`, or one with no regex character) */
function literalMatcher(needle: Uint8Array, ignoreCase: boolean): (line: Uint8Array) => boolean {
  const n = ignoreCase ? needle.map(lowerAscii) : needle;
  return (line) => {
    const last = line.length - n.length;
    outer: for (let i = 0; i <= last; i++) {
      for (let k = 0; k < n.length; k++) {
        const b = line[i + k] as number;
        if ((ignoreCase ? lowerAscii(b) : b) !== n[k]) continue outer;
      }
      return true;
    }
    return false;
  };
}

/** grep.c's compile_regexp for one pattern */
function compilePattern(
  pattern: string,
  type: GrepPatternType,
  ignoreCase: boolean,
  origin: string,
): (line: Uint8Array) => boolean {
  const bytes = encoder.encode(pattern);
  const fail = (error: string): never => {
    throw new GrepPatternError(pattern, `fatal: ${origin}, '${pattern}': ${error}`);
  };
  if (type !== "perl" && bytes.includes(0)) {
    throw new GrepPatternError(
      pattern,
      "fatal: given pattern contains NULL byte (via -f <file>). This is only supported with -P under PCRE v2",
    );
  }
  const isFixed = !bytes.some((b) => REGEX_SPECIAL.has(b));
  if (type === "fixed" || isFixed) return literalMatcher(bytes, ignoreCase);
  if (type === "perl") {
    // a git built without PCRE (NO_PCRE, as the 2.56.1 build here): a pattern with no regex
    // character took the literal path above; any other dies. No JavaScript RegExp ever runs
    // a user's pattern (backtracking without git's PCRE2 match limit)
    throw new GrepPatternError(
      pattern,
      "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE",
    );
  }
  try {
    const re = compilePosixRegex(bytes, { extended: type === "extended", icase: ignoreCase });
    return (line) => re.test(line);
  } catch (e) {
    if (e instanceof PosixRegexError) fail(e.message);
    throw e;
  }
}

/** Where a header line's identity ends: just after its last `>` (grep.c's strip_timestamp) */
function stripTimestamp(line: Uint8Array): Uint8Array {
  for (let i = line.length - 1; i > 0; i--) {
    if (line[i] === 0x3e) return line.subarray(0, i + 1);
  }
  return line;
}

function startsWith(line: Uint8Array, prefix: Uint8Array): boolean {
  if (line.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (line[i] !== prefix[i]) return false;
  return true;
}

/**
 * Compiles git's commit grep; throws {@link GrepPatternError} for a pattern git refuses
 * (header patterns are compiled first, as `prep_header_patterns` does).
 */
export function compileCommitGrep(options: CommitGrepOptions): CommitGrep {
  const type = options.patternType ?? "basic";
  const ignoreCase = !!options.ignoreCase;
  const headerList: Pattern[] = [];
  const addHeader = (field: number, list: readonly string[] | undefined) => {
    const prefix = FIELD_PREFIX[field] as Uint8Array;
    for (const pattern of list ?? []) {
      for (const part of splitPattern(pattern)) {
        const match = compilePattern(part, type, ignoreCase, "header");
        headerList.push({
          head: true,
          field,
          test: (line) =>
            startsWith(line, prefix) && match(stripTimestamp(line.subarray(prefix.length))),
        });
      }
    }
  };
  addHeader(FIELD_AUTHOR, options.authors);
  addHeader(FIELD_COMMITTER, options.committers);
  const bodyList: Pattern[] = [];
  for (const pattern of options.messages ?? []) {
    for (const part of splitPattern(pattern)) {
      bodyList.push({
        head: false,
        field: -1,
        test: compilePattern(part, type, ignoreCase, "command line"),
      });
    }
  }
  if (bodyList.length === 0 && headerList.length === 0) return { matches: () => true };

  // prep_header_patterns: each field's patterns or-ed (newest first), fields or-ed in field
  // order before a TRUE node
  let headerExpr: Expr | undefined;
  const groups: (Expr | undefined)[] = [undefined, undefined];
  for (const p of headerList) {
    const atom: Expr = { k: "atom", p, hit: false };
    const g = groups[p.field];
    groups[p.field] = g ? { k: "or", l: atom, r: g, hit: false } : atom;
  }
  for (const g of groups) {
    if (!g) continue;
    headerExpr ??= { k: "true", hit: false };
    headerExpr = { k: "or", l: g, r: headerExpr, hit: false };
  }

  let allMatch = !!options.allMatch;
  const invert = !!options.invertGrep;
  const extended = allMatch || invert || !!headerExpr;
  let expr: Expr | undefined;
  if (extended) {
    // compile_pattern_or over the message atoms: p1 OR (p2 OR (...))
    let body: Expr | undefined;
    for (let i = bodyList.length - 1; i >= 0; i--) {
      const atom: Expr = { k: "atom", p: bodyList[i] as Pattern, hit: false };
      body = body ? { k: "or", l: atom, r: body, hit: false } : atom;
    }
    if (invert && body) body = { k: "not", x: body, hit: false };
    expr = body;
    if (headerExpr) {
      if (!body) expr = headerExpr;
      else if (allMatch) expr = spliceOr(headerExpr, body);
      else expr = { k: "or", l: body, r: headerExpr, hit: false };
      allMatch = true;
    }
  }

  let bodyHit = false;
  const matchOne = (p: Pattern, line: Uint8Array, head: boolean): boolean => {
    if (p.head !== head) return false;
    return p.test(line);
  };
  const evaluate = (x: Expr, line: Uint8Array, head: boolean, collect: boolean): boolean => {
    let h = false;
    switch (x.k) {
      case "true":
        h = true;
        break;
      case "atom":
        h = matchOne(x.p, line, head);
        if (!x.p.head) bodyHit ||= h;
        break;
      case "not":
        h = !evaluate(x.x, line, head, false);
        break;
      case "or":
        if (!collect) return evaluate(x.l, line, head, false) || evaluate(x.r, line, head, false);
        h = evaluate(x.l, line, head, false);
        x.l.hit ||= h;
        h = evaluate(x.r, line, head, collect) || h;
        break;
    }
    if (collect) x.hit ||= h;
    return h;
  };
  const matchLine = (line: Uint8Array, head: boolean, collect: boolean): boolean => {
    if (expr) return evaluate(expr, line, head, collect);
    for (const p of bodyList) if (matchOne(p, line, head)) return true;
    return false;
  };
  /** grep_source_1 with status_only: whether some line hits (collect: marks hits only) */
  const pass = (buf: Uint8Array, collect: boolean): boolean => {
    let head = true;
    let bol = 0;
    let left = buf.length;
    while (left > 0) {
      let eol = bol;
      while (left > 0 && buf[eol] !== 0x0a) {
        eol++;
        left--;
      }
      if (head && eol === bol) head = false;
      const hit = matchLine(buf.subarray(bol, eol), head, collect);
      if (!collect && hit) return true;
      bol = eol + 1;
      if (left === 0) break;
      left--;
    }
    return false;
  };

  const mailmap = options.mailmap && !options.mailmap.empty ? options.mailmap : undefined;
  return {
    matches(raw: Uint8Array): boolean {
      const buf = mailmap && headerList.length > 0 ? applyMailmapToHeader(raw, mailmap) : raw;
      if (!allMatch && !invert) return pass(buf, false);
      if (!expr) return true;
      clearHitMarkers(expr);
      bodyHit = false;
      pass(buf, true);
      if (allMatch && !checkHitMarkers(expr)) return false;
      if (invert && bodyHit) return false;
      return pass(buf, false);
    },
  };
}

/** grep_splice_or: the header chain's TRUE replaced by the message expression */
function spliceOr(x: Expr, y: Expr): Expr {
  let node: Expr | undefined = x;
  while (node && node.k === "or") {
    if (node.r.k === "true") {
      node.r = y;
      break;
    }
    node = node.r;
  }
  return x;
}

/** clr_hit_marker: the top-level or chain's markers */
function clearHitMarkers(x: Expr): void {
  for (;;) {
    x.hit = false;
    if (x.k !== "or") return;
    x.l.hit = false;
    x = x.r;
  }
}

/** chk_hit_marker: every term of the top-level or chain hit some line */
function checkHitMarkers(x: Expr): boolean {
  for (;;) {
    if (x.k !== "or") return x.hit;
    if (!x.l.hit) return false;
    x = x.r;
  }
}

const decoder = new TextDecoder();

/**
 * ident.c's apply_mailmap_to_header: the `author`/`committer` lines of the header part
 * rewritten to the mailmap's name and email (`Name <email>`, the rest of the line kept).
 */
export function applyMailmapToHeader(raw: Uint8Array, mailmap: Mailmap): Uint8Array {
  const parts: Uint8Array[] = [];
  let changed = false;
  let pos = 0;
  while (pos < raw.length && raw[pos] !== 0x0a) {
    let end = raw.indexOf(0x0a, pos);
    if (end < 0) end = raw.length;
    const line = raw.subarray(pos, end);
    const prefix = FIELD_PREFIX.find((p) => startsWith(line, p));
    let out: Uint8Array = line;
    if (prefix) {
      const mapped = rewriteIdent(line.subarray(prefix.length), mailmap);
      if (mapped) {
        out = concat([prefix, mapped]);
        changed = true;
      }
    }
    parts.push(out);
    if (end < raw.length) parts.push(NEWLINE);
    pos = end + 1;
  }
  if (!changed) return raw;
  if (pos < raw.length) parts.push(raw.subarray(pos));
  return concat(parts);
}

const NEWLINE = new Uint8Array([0x0a]);

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

/** rewrite_ident_line: the person part of an ident line mapped, or undefined if unmapped */
function rewriteIdent(person: Uint8Array, mailmap: Mailmap): Uint8Array | undefined {
  const lt = person.indexOf(0x3c);
  if (lt < 0) return undefined;
  const mailBegin = lt + 1;
  let nameEnd = 0;
  for (let i = mailBegin - 2; i >= 0; i--) {
    if (!isSpace(person[i] as number)) {
      nameEnd = i + 1;
      break;
    }
  }
  const mailEnd = person.indexOf(0x3e, mailBegin);
  if (mailEnd < 0) return undefined;
  const name = decoder.decode(person.subarray(0, nameEnd));
  const email = decoder.decode(person.subarray(mailBegin, mailEnd));
  const mapped = mailmap.lookup(name, email);
  if (!mapped) return undefined;
  return concat([encoder.encode(`${mapped.name} <${mapped.email}>`), person.subarray(mailEnd + 1)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
