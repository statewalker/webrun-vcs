/**
 * POSIX regular expressions over bytes, matched as glibc's `regcomp`/`regexec` match them in
 * the C locale: leftmost-longest overall match, subexpressions placed as glibc places them,
 * extended (`REG_EXTENDED`) or basic syntax with the GNU extensions (`\w`, `\s`, `\b`, `\<`,
 * back-references, `\|`, `\+`, `\?`), `REG_ICASE` folding ASCII only.
 *
 * @example
 * ```ts
 * const re = compilePosixRegex("^(a|ab)", { extended: true });
 * re.exec(new TextEncoder().encode("abc def"));
 * // { start: 0, end: 2, groups: [[0, 2]] }
 * ```
 *
 * git runs the funcname patterns of diff drivers (`diff.<driver>.xfuncname`, the builtin
 * `cpp`, `java`, ... drivers) through glibc, so a hunk header shows what glibc matches: the
 * longest alternative rather than the first (`^(a|ab)` takes `ab`), back-references in basic
 * patterns, `a{,2}`, `\s` without byte 0xA0. JavaScript's backtracking `RegExp` gives other
 * matches and can take exponential time on nested quantifiers; this matcher runs in time
 * linear in the subject (times the pattern size) for patterns without back-references.
 *
 * How it works: the pattern is parsed into glibc's syntax tree (same rules for what is an
 * operator, an anchor or a literal, same errors) and laid out as glibc's NFA. The overall
 * match is found by simulating the NFA on all start positions at once, keeping for each NFA
 * state the thread that started first (Pike's construction), so the first start that matches
 * wins and the last position where it matches gives the longest match. Subexpressions are
 * then placed by glibc's own walk (`set_regs`): from the start, at each choice take the first
 * branch from which the match end is still reachable, leaving a loop whose body was entered
 * without consuming anything. Patterns with back-references are matched by backtracking.
 *
 * @module
 */

/** A pattern that glibc's `regcomp` rejects */
export class PosixRegexError extends Error {
  constructor(
    message: string,
    /** glibc's error code name, e.g. `REG_BADRPT` */
    readonly code: string,
  ) {
    super(message);
    this.name = "PosixRegexError";
  }
}

/** Options of {@link compilePosixRegex} */
export interface PosixRegexOptions {
  /** Extended syntax (`REG_EXTENDED`); basic syntax (with GNU extensions) otherwise */
  extended?: boolean;
  /** Case-insensitive (`REG_ICASE`): ASCII letters only, as the C locale folds */
  icase?: boolean;
}

/** A match: overall `[start, end)` and the subexpressions' (undefined when unset) */
export interface PosixMatch {
  start: number;
  end: number;
  /** Subexpression `i + 1` at index `i` */
  groups: ([number, number] | undefined)[];
}

/** A compiled pattern */
export interface PosixRegex {
  /** Number of subexpressions (`re_nsub`) */
  readonly groupCount: number;
  /**
   * The match in `subject[0, end)`, or undefined. `groups` holds at most `nmatch - 1`
   * subexpressions (default all); with `nmatch` 1 they are not placed at all (faster).
   */
  exec(subject: Uint8Array, end?: number, nmatch?: number): PosixMatch | undefined;
  /** Whether `subject[0, end)` matches */
  test(subject: Uint8Array, end?: number): boolean;
}

// --- syntax tree (glibc's bin_tree_t) ---------------------------------------------------

const A_LINE_FIRST: number = 1;
const A_LINE_LAST: number = 2;
const A_WORD_FIRST: number = 3;
const A_WORD_LAST: number = 4;
const A_INSIDE_WORD: number = 5;
const A_INSIDE_NOTWORD: number = 6;

type Tree =
  | { k: "set"; set: Uint8Array }
  | { k: "anchor"; a: number }
  | { k: "backref"; n: number }
  | { k: "sub"; idx: number; body: Tree | null; opt: boolean }
  | { k: "cat"; l: Tree; r: Tree }
  | { k: "alt"; l: Tree | null; r: Tree | null }
  | { k: "star"; body: Tree }
  | { k: "open"; idx: number; opt: boolean }
  | { k: "close"; idx: number; opt: boolean }
  | { k: "end" };

/** glibc's `duplicate_tree`: a copy, its groups no longer optional (`create_token_tree`) */
function dupTree(t: Tree | null): Tree | null {
  if (!t) return null;
  switch (t.k) {
    case "sub":
      return { k: "sub", idx: t.idx, body: dupTree(t.body), opt: false };
    case "cat":
      return { k: "cat", l: dupTree(t.l) as Tree, r: dupTree(t.r) as Tree };
    case "alt":
      return { k: "alt", l: dupTree(t.l), r: dupTree(t.r) };
    case "star":
      return { k: "star", body: dupTree(t.body) as Tree };
    default:
      return { ...t };
  }
}

function markOpt(t: Tree | null, idx: number): void {
  if (!t) return;
  switch (t.k) {
    case "sub":
      if (t.idx === idx) t.opt = true;
      markOpt(t.body, idx);
      return;
    case "cat":
      markOpt(t.l, idx);
      markOpt(t.r, idx);
      return;
    case "alt":
      markOpt(t.l, idx);
      markOpt(t.r, idx);
      return;
    case "star":
      markOpt(t.body, idx);
      return;
  }
}

// --- character classes in the C locale --------------------------------------------------

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}
function isWordByte(c: number): boolean {
  return isAlpha(c) || isDigit(c) || c === 0x5f;
}
function toUpper(c: number): number {
  return c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
}

const CLASS_TESTS: Record<string, (c: number) => boolean> = {
  alpha: isAlpha,
  upper: (c) => c >= 0x41 && c <= 0x5a,
  lower: (c) => c >= 0x61 && c <= 0x7a,
  digit: isDigit,
  xdigit: (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
  space: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  print: (c) => c >= 0x20 && c <= 0x7e,
  punct: (c) => c >= 0x21 && c <= 0x7e && !isAlpha(c) && !isDigit(c),
  graph: (c) => c >= 0x21 && c <= 0x7e,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  blank: (c) => c === 0x20 || c === 0x09,
  alnum: (c) => isAlpha(c) || isDigit(c),
};

function classSet(test: (c: number) => boolean, negate: boolean): Uint8Array {
  const set = new Uint8Array(256);
  for (let c = 0; c < 256; c++) set[c] = test(c) !== negate ? 1 : 0;
  return set;
}

// --- parser (glibc's regcomp.c) ---------------------------------------------------------

const T_CHAR: number = 0;
const T_END: number = 1;
const T_ALT: number = 2;
const T_STAR: number = 3;
const T_PLUS: number = 4;
const T_QUESTION: number = 5;
const T_OPEN_DUP: number = 6;
const T_CLOSE_DUP: number = 7;
const T_OPEN_SUB: number = 8;
const T_CLOSE_SUB: number = 9;
const T_BRACKET: number = 10;
const T_PERIOD: number = 11;
const T_ANCHOR: number = 12;
const T_BACKREF: number = 13;
const T_WORD: number = 14;
const T_NOTWORD: number = 15;
const T_SPACE: number = 16;
const T_NOTSPACE: number = 17;
const T_BACKSLASH: number = 18;
const T_ANCHOR_WORD_DELIM: number = 19;
const T_ANCHOR_NOT_WORD_DELIM: number = 20;

const RE_DUP_MAX = 0x7fff;
/** Largest NFA built (glibc has no such limit but would need the memory) */
const MAX_NODES = 1 << 20;

interface Token {
  type: number;
  /** The byte (folded under icase; the raw byte after a backslash) */
  c: number;
  len: number;
  /** Anchor kind, back-reference index */
  arg: number;
}

class Parser {
  private pos = 0;
  private tok: Token = { type: T_END, c: 0, len: 0, arg: 0 };
  nsub = 0;
  private completed = 0;
  nbackref = 0;
  private nodes = 0;

  constructor(
    private readonly pat: Uint8Array,
    private readonly extended: boolean,
    private readonly icase: boolean,
  ) {}

  private byte(i: number): number {
    const c = this.pat[i];
    return this.icase ? toUpper(c) : c;
  }

  private fail(code: string, message: string): never {
    throw new PosixRegexError(message, code);
  }

  private count(): void {
    if (++this.nodes > MAX_NODES) this.fail("REG_ESIZE", "Regular expression too big");
  }

  /** `peek_token` at `at` */
  private peek(at: number, caretHere: boolean): Token {
    const pat = this.pat;
    if (at >= pat.length) return { type: T_END, c: 0, len: 0, arg: 0 };
    const c = this.byte(at);
    if (pat[at] === 0x5c) {
      if (at + 1 >= pat.length) return { type: T_BACKSLASH, c, len: 1, arg: 0 };
      const c2 = pat[at + 1];
      const t: Token = { type: T_CHAR, c: c2, len: 2, arg: 0 };
      const ext = this.extended;
      switch (c2) {
        case 0x7c: // |
          if (!ext) t.type = T_ALT;
          break;
        case 0x31:
        case 0x32:
        case 0x33:
        case 0x34:
        case 0x35:
        case 0x36:
        case 0x37:
        case 0x38:
        case 0x39:
          t.type = T_BACKREF;
          t.arg = c2 - 0x31;
          break;
        case 0x3c: // <
          t.type = T_ANCHOR;
          t.arg = A_WORD_FIRST;
          break;
        case 0x3e: // >
          t.type = T_ANCHOR;
          t.arg = A_WORD_LAST;
          break;
        case 0x62: // b
          t.type = T_ANCHOR_WORD_DELIM;
          break;
        case 0x42: // B
          t.type = T_ANCHOR_NOT_WORD_DELIM;
          break;
        case 0x77:
          t.type = T_WORD;
          break;
        case 0x57:
          t.type = T_NOTWORD;
          break;
        case 0x73:
          t.type = T_SPACE;
          break;
        case 0x53:
          t.type = T_NOTSPACE;
          break;
        case 0x60: // `
          t.type = T_ANCHOR;
          t.arg = A_LINE_FIRST;
          break;
        case 0x27: // '
          t.type = T_ANCHOR;
          t.arg = A_LINE_LAST;
          break;
        case 0x28:
          if (!ext) t.type = T_OPEN_SUB;
          break;
        case 0x29:
          if (!ext) t.type = T_CLOSE_SUB;
          break;
        case 0x2b:
          if (!ext) t.type = T_PLUS;
          break;
        case 0x3f:
          if (!ext) t.type = T_QUESTION;
          break;
        case 0x7b:
          if (!ext) t.type = T_OPEN_DUP;
          break;
        case 0x7d:
          if (!ext) t.type = T_CLOSE_DUP;
          break;
      }
      return t;
    }
    const t: Token = { type: T_CHAR, c, len: 1, arg: 0 };
    const ext = this.extended;
    switch (pat[at]) {
      case 0x7c:
        if (ext) t.type = T_ALT;
        break;
      case 0x2a:
        t.type = T_STAR;
        break;
      case 0x2b:
        if (ext) t.type = T_PLUS;
        break;
      case 0x3f:
        if (ext) t.type = T_QUESTION;
        break;
      case 0x7b:
        if (ext) t.type = T_OPEN_DUP;
        break;
      case 0x7d:
        if (ext) t.type = T_CLOSE_DUP;
        break;
      case 0x28:
        if (ext) t.type = T_OPEN_SUB;
        break;
      case 0x29:
        if (ext) t.type = T_CLOSE_SUB;
        break;
      case 0x5b:
        t.type = T_BRACKET;
        break;
      case 0x2e:
        t.type = T_PERIOD;
        break;
      case 0x5e:
        if (!ext && !caretHere && at !== 0) break;
        t.type = T_ANCHOR;
        t.arg = A_LINE_FIRST;
        break;
      case 0x24:
        if (!ext && at + 1 !== pat.length) {
          const next = this.peek(at + 1, false);
          if (next.type !== T_ALT && next.type !== T_CLOSE_SUB) break;
        }
        t.type = T_ANCHOR;
        t.arg = A_LINE_LAST;
        break;
    }
    return t;
  }

  private fetch(caretHere = false): void {
    this.tok = this.peek(this.pos, caretHere);
    this.pos += this.tok.len;
  }

  parse(): Tree {
    this.fetch(true);
    const tree = this.parseRegExp(0);
    const end: Tree = { k: "end" };
    return tree ? { k: "cat", l: tree, r: end } : end;
  }

  private parseRegExp(nest: number): Tree | null {
    let tree = this.parseBranch(nest);
    while (this.tok.type === T_ALT) {
      this.fetch(true);
      let branch: Tree | null = null;
      const t = this.tok.type;
      if (t !== T_ALT && t !== T_END && (nest === 0 || t !== T_CLOSE_SUB)) {
        branch = this.parseBranch(nest);
      }
      this.count();
      tree = { k: "alt", l: tree, r: branch };
    }
    return tree;
  }

  private parseBranch(nest: number): Tree | null {
    let tree = this.parseExpression(nest);
    while (
      this.tok.type !== T_ALT &&
      this.tok.type !== T_END &&
      (nest === 0 || this.tok.type !== T_CLOSE_SUB)
    ) {
      const exp = this.parseExpression(nest);
      if (tree && exp) tree = { k: "cat", l: tree, r: exp };
      else if (!tree) tree = exp;
    }
    return tree;
  }

  private charSet(c: number): Uint8Array {
    const set = new Uint8Array(256);
    set[c] = 1;
    return set;
  }

  private parseExpression(nest: number): Tree | null {
    const tok = this.tok;
    let tree: Tree | null;
    switch (tok.type) {
      case T_CHAR:
        this.count();
        tree = { k: "set", set: this.charSet(tok.c) };
        break;
      case T_OPEN_SUB:
        tree = this.parseSubExp(nest + 1);
        break;
      case T_BRACKET:
        tree = this.parseBracket();
        break;
      case T_BACKREF:
        if (!(this.completed & (1 << tok.arg))) this.fail("REG_ESUBREG", "Invalid back reference");
        this.nbackref++;
        this.count();
        tree = { k: "backref", n: tok.arg };
        break;
      case T_OPEN_DUP:
        // an interval with nothing to repeat: refused in both syntaxes
        return this.fail("REG_BADRPT", "Invalid preceding regular expression");
      case T_STAR:
      case T_PLUS:
      case T_QUESTION:
        // nothing to repeat: an error in extended syntax, the character itself in basic
        if (this.extended) this.fail("REG_BADRPT", "Invalid preceding regular expression");
        this.count();
        tree = { k: "set", set: this.charSet(tok.c) };
        break;
      case T_CLOSE_SUB:
        // an unmatched ")" is itself in extended syntax; "\\)" is an error in basic
        if (!this.extended) this.fail("REG_ERPAREN", "Unmatched ) or \\)");
        this.count();
        tree = { k: "set", set: this.charSet(tok.c) };
        break;
      case T_CLOSE_DUP:
        this.count();
        tree = { k: "set", set: this.charSet(tok.c) };
        break;
      case T_ANCHOR:
      case T_ANCHOR_WORD_DELIM:
      case T_ANCHOR_NOT_WORD_DELIM: {
        if (tok.type === T_ANCHOR) {
          this.count();
          tree = { k: "anchor", a: tok.arg };
        } else {
          this.count();
          this.count();
          this.count();
          const word = tok.type === T_ANCHOR_WORD_DELIM;
          tree = {
            k: "alt",
            l: { k: "anchor", a: word ? A_WORD_FIRST : A_INSIDE_WORD },
            r: { k: "anchor", a: word ? A_WORD_LAST : A_INSIDE_NOTWORD },
          };
        }
        // anchors take no repetition: "^*" is "^" and a "*" at the start of an expression
        this.fetch();
        return tree;
      }
      case T_PERIOD: {
        this.count();
        const set = new Uint8Array(256).fill(1);
        set[0] = 0;
        tree = { k: "set", set };
        break;
      }
      case T_WORD:
      case T_NOTWORD:
        this.count();
        tree = { k: "set", set: classSet(isWordByte, tok.type === T_NOTWORD) };
        break;
      case T_SPACE:
      case T_NOTSPACE:
        this.count();
        tree = { k: "set", set: classSet(CLASS_TESTS.space, tok.type === T_NOTSPACE) };
        break;
      case T_ALT:
      case T_END:
        return null;
      case T_BACKSLASH:
        return this.fail("REG_EESCAPE", "Trailing backslash");
      default:
        return null;
    }
    this.fetch();
    while (
      this.tok.type === T_STAR ||
      this.tok.type === T_PLUS ||
      this.tok.type === T_QUESTION ||
      this.tok.type === T_OPEN_DUP
    ) {
      tree = this.parseDupOp(tree);
      // in basic syntax, consecutive repetitions are not allowed
      if (!this.extended && (this.tok.type === T_STAR || this.tok.type === T_OPEN_DUP)) {
        this.fail("REG_BADRPT", "Invalid preceding regular expression");
      }
    }
    return tree;
  }

  private parseSubExp(nest: number): Tree {
    const idx = this.nsub++;
    this.fetch(true);
    let body: Tree | null = null;
    if (this.tok.type !== T_CLOSE_SUB) {
      body = this.parseRegExp(nest);
      if (this.tok.type !== T_CLOSE_SUB) this.fail("REG_EPAREN", "Unmatched ( or \\(");
    }
    if (idx <= 8) this.completed |= 1 << idx;
    this.count();
    this.count();
    return { k: "sub", idx, body, opt: false };
  }

  /** `fetch_number`: -1 none, -2 invalid */
  private fetchNumber(): number {
    let num = -1;
    for (;;) {
      this.fetch();
      const c = this.tok.c;
      if (this.tok.type === T_END) return -2;
      if (this.tok.type === T_CLOSE_DUP || c === 0x2c) break;
      num =
        this.tok.type !== T_CHAR || c < 0x30 || c > 0x39 || num === -2
          ? -2
          : num === -1
            ? c - 0x30
            : Math.min(RE_DUP_MAX + 1, num * 10 + c - 0x30);
    }
    return num;
  }

  private parseDupOp(elemIn: Tree | null): Tree | null {
    let elem = elemIn;
    let start: number;
    let end: number;
    if (this.tok.type === T_OPEN_DUP) {
      end = 0;
      start = this.fetchNumber();
      if (start === -1) {
        if (this.tok.type === T_CHAR && this.tok.c === 0x2c) start = 0;
        else this.fail("REG_BADBR", "Invalid content of \\{\\}");
      }
      if (start !== -2) {
        end =
          this.tok.type === T_CLOSE_DUP
            ? start
            : this.tok.type === T_CHAR && this.tok.c === 0x2c
              ? this.fetchNumber()
              : -2;
      }
      if (start === -2 || end === -2) {
        if (this.tok.type === T_END) this.fail("REG_EBRACE", "Unmatched \\{");
        this.fail("REG_BADBR", "Invalid content of \\{\\}");
      }
      if ((end !== -1 && start > end) || this.tok.type !== T_CLOSE_DUP) {
        this.fail("REG_BADBR", "Invalid content of \\{\\}");
      }
      if ((end === -1 ? start : end) > RE_DUP_MAX) {
        this.fail("REG_ESIZE", "Regular expression too big");
      }
    } else {
      start = this.tok.type === T_PLUS ? 1 : 0;
      end = this.tok.type === T_QUESTION ? 1 : -1;
    }
    this.fetch();
    if (!elem) return null;
    if (start === 0 && end === 0) return null;
    let tree: Tree;
    let oldTree: Tree | null = null;
    if (start > 0) {
      tree = elem;
      for (let i = 2; i <= start; i++) {
        elem = dupTree(elem) as Tree;
        this.countTree(elem);
        tree = { k: "cat", l: tree, r: elem };
      }
      if (start === end) return tree;
      elem = dupTree(elem) as Tree;
      this.countTree(elem);
      oldTree = tree;
    }
    if (elem.k === "sub") markOpt(elem, elem.idx);
    this.count();
    tree = end === -1 ? { k: "star", body: elem } : { k: "alt", l: elem, r: null };
    for (let i = start + 2; i <= end; i++) {
      elem = dupTree(elem) as Tree;
      this.countTree(elem);
      tree = { k: "cat", l: tree, r: elem };
      this.count();
      tree = { k: "alt", l: tree, r: null };
    }
    return oldTree ? { k: "cat", l: oldTree, r: tree } : tree;
  }

  private countTree(t: Tree | null): void {
    if (!t) return;
    switch (t.k) {
      case "sub":
        this.count();
        this.count();
        this.countTree(t.body);
        return;
      case "cat":
        this.countTree(t.l);
        this.countTree(t.r);
        return;
      case "alt":
        this.count();
        this.countTree(t.l);
        this.countTree(t.r);
        return;
      case "star":
        this.count();
        this.countTree(t.body);
        return;
      default:
        this.count();
    }
  }

  /** `peek_token_bracket` */
  private peekBracket(at: number): Token {
    const pat = this.pat;
    if (at >= pat.length) return { type: T_END, c: 0, len: 0, arg: 0 };
    const c = this.byte(at);
    if (c === 0x5b) {
      const c2 = at + 1 < pat.length ? this.byte(at + 1) : 0;
      if (c2 === 0x2e) return { type: B_COLL, c: c2, len: 2, arg: 0 };
      if (c2 === 0x3d) return { type: B_EQUIV, c: c2, len: 2, arg: 0 };
      if (c2 === 0x3a) return { type: B_CLASS, c: c2, len: 2, arg: 0 };
      return { type: B_CHAR, c, len: 1, arg: 0 };
    }
    if (c === 0x2d) return { type: B_RANGE, c, len: 1, arg: 0 };
    if (c === 0x5d) return { type: B_CLOSE, c, len: 1, arg: 0 };
    if (c === 0x5e) return { type: B_NON_MATCH, c, len: 1, arg: 0 };
    return { type: B_CHAR, c, len: 1, arg: 0 };
  }

  /** `parse_bracket_element`: the element at `this.pos` (its token `tok`) */
  private bracketElement(tok: Token, acceptHyphen: boolean): BracketElem {
    this.pos += tok.len;
    if (tok.type === B_COLL || tok.type === B_EQUIV || tok.type === B_CLASS) {
      return this.bracketSymbol(tok);
    }
    if (tok.type === B_RANGE && !acceptHyphen) {
      const next = this.peekBracket(this.pos);
      if (next.type !== B_CLOSE) this.fail("REG_ERANGE", "Invalid range end");
    }
    return { kind: "char", c: tok.c, name: "" };
  }

  /** `parse_bracket_symbol`: `[:name:]`, `[.c.]`, `[=c=]` */
  private bracketSymbol(tok: Token): BracketElem {
    const pat = this.pat;
    const delim = tok.c;
    let name = "";
    if (this.pos >= pat.length) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
    for (let i = 0; ; i++) {
      if (i >= 32) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
      const ch = tok.type === B_CLASS ? pat[this.pos] : this.byte(this.pos);
      this.pos++;
      if (this.pos >= pat.length) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
      if (ch === delim && pat[this.pos] === 0x5d) break;
      name += String.fromCharCode(ch);
    }
    this.pos++;
    const kind = tok.type === B_COLL ? "coll" : tok.type === B_EQUIV ? "equiv" : "class";
    return { kind, c: name.length === 1 ? name.charCodeAt(0) : -1, name };
  }

  private parseBracket(): Tree {
    const set = new Uint8Array(256);
    let tok = this.peekBracket(this.pos);
    if (tok.type === T_END) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
    let nonMatch = false;
    if (tok.type === B_NON_MATCH) {
      nonMatch = true;
      this.pos += tok.len;
      tok = this.peekBracket(this.pos);
      if (tok.type === T_END) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
    }
    if (tok.type === B_CLOSE) tok = { ...tok, type: B_CHAR };
    let first = true;
    for (;;) {
      const startElem = this.bracketElement(tok, first);
      first = false;
      tok = this.peekBracket(this.pos);
      let range = false;
      let tok2: Token | undefined;
      if (startElem.kind !== "class" && startElem.kind !== "equiv") {
        if (tok.type === T_END) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
        if (tok.type === B_RANGE) {
          this.pos += tok.len;
          tok2 = this.peekBracket(this.pos);
          if (tok2.type === T_END) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
          if (tok2.type === B_CLOSE) {
            this.pos -= tok.len;
            tok = { ...tok, type: B_CHAR };
          } else range = true;
        }
      }
      if (range && tok2) {
        const endElem = this.bracketElement(tok2, true);
        tok = this.peekBracket(this.pos);
        this.addRange(set, startElem, endElem);
      } else {
        this.addElem(set, startElem);
      }
      if (tok.type === T_END) this.fail("REG_EBRACK", "Unmatched [, [^, [:, [., or [=");
      if (tok.type === B_CLOSE) break;
    }
    this.pos += tok.len;
    if (nonMatch) for (let c = 0; c < 256; c++) set[c] ^= 1;
    this.count();
    return { k: "set", set };
  }

  private elemByte(e: BracketElem): number {
    if (e.kind === "char") return e.c;
    if (e.kind === "coll") {
      if (e.name.length !== 1) this.fail("REG_ECOLLATE", "Invalid collation character");
      return e.c;
    }
    return this.fail("REG_ERANGE", "Invalid range end");
  }

  private addRange(set: Uint8Array, a: BracketElem, b: BracketElem): void {
    if (a.kind === "class" || a.kind === "equiv" || b.kind === "class" || b.kind === "equiv") {
      this.fail("REG_ERANGE", "Invalid range end");
    }
    const lo = this.elemByte(a);
    const hi = this.elemByte(b);
    if (lo > hi) this.fail("REG_ERANGE", "Invalid range end");
    for (let c = lo; c <= hi; c++) set[c] = 1;
  }

  private addElem(set: Uint8Array, e: BracketElem): void {
    switch (e.kind) {
      case "char":
        set[e.c] = 1;
        return;
      case "coll":
      case "equiv":
        if (e.name.length !== 1) this.fail("REG_ECOLLATE", "Invalid collation character");
        set[e.c] = 1;
        return;
      case "class": {
        let name = e.name;
        if (this.icase && (name === "upper" || name === "lower")) name = "alpha";
        const test = CLASS_TESTS[name];
        if (!test) this.fail("REG_ECTYPE", "Invalid character class name");
        for (let c = 0; c < 256; c++) if (test(c)) set[c] = 1;
        return;
      }
    }
  }
}

const B_CHAR: number = 100;
const B_RANGE: number = 101;
const B_CLOSE: number = 102;
const B_NON_MATCH: number = 103;
const B_COLL: number = 104;
const B_EQUIV: number = 105;
const B_CLASS: number = 106;

interface BracketElem {
  kind: "char" | "coll" | "equiv" | "class";
  c: number;
  name: string;
}

// --- NFA (glibc's re_dfa_t nodes) -------------------------------------------------------

const N_SET: number = 0;
const N_END: number = 1;
const N_BACKREF: number = 2;
// epsilon nodes from here on
const N_ALT: number = 3;
const N_OPEN: number = 4;
const N_CLOSE: number = 5;
const N_ANCHOR: number = 6;

interface Nfa {
  type: Uint8Array;
  /** Next node (sets, back-references, single-destination epsilon nodes) */
  next: Int32Array;
  /** Destinations of an alternation or loop, in glibc's order (e2 -1: single) */
  e1: Int32Array;
  e2: Int32Array;
  /** Group of open/close and back-reference nodes, kind of anchors */
  arg: Int32Array;
  /** `opt_subexp` of open/close nodes */
  opt: Uint8Array;
  sets: (Uint8Array | undefined)[];
  init: number;
  endNode: number;
  /** Epsilon predecessors of each node (for the reachability of the match end) */
  preds: Int32Array[];
}

/** glibc's `optimize_subexps` and `lower_subexps`: groups as open/close node pairs */
function lowerTree(t: Tree | null, subexpMap: number[]): Tree | null {
  if (!t) return null;
  switch (t.k) {
    case "sub": {
      let body = t.body;
      // "((x))": the inner group is the outer one
      while (body && body.k === "sub") {
        subexpMap[body.idx] = subexpMap[t.idx];
        body = body.body;
      }
      const lowered = lowerTree(body, subexpMap);
      const open: Tree = { k: "open", idx: t.idx, opt: t.opt };
      const close: Tree = { k: "close", idx: t.idx, opt: t.opt };
      return { k: "cat", l: open, r: lowered ? { k: "cat", l: lowered, r: close } : close };
    }
    case "cat":
      return {
        k: "cat",
        l: lowerTree(t.l, subexpMap) as Tree,
        r: lowerTree(t.r, subexpMap) as Tree,
      };
    case "alt":
      return { k: "alt", l: lowerTree(t.l, subexpMap), r: lowerTree(t.r, subexpMap) };
    case "star":
      return { k: "star", body: lowerTree(t.body, subexpMap) as Tree };
    default:
      return t;
  }
}

interface Built {
  tree: Tree;
  idx: number;
  first: Built | null;
  next: Built | null;
  l: Built | null;
  r: Built | null;
}

function buildNfa(root: Tree): Nfa {
  // calc_first (postorder): node indices; a concatenation is its left side's first node
  const all: Built[] = [];
  const wrap = (t: Tree | null): Built | null => {
    if (!t) return null;
    const b: Built = { tree: t, idx: -1, first: null, next: null, l: null, r: null };
    if (t.k === "cat" || t.k === "alt") {
      b.l = wrap(t.l);
      b.r = wrap(t.r);
    } else if (t.k === "star") {
      b.l = wrap(t.body);
    }
    if (t.k === "cat") {
      b.first = (b.l as Built).first;
      b.idx = (b.l as Built).idx;
    } else {
      b.first = b;
      b.idx = all.length;
      all.push(b);
    }
    return b;
  };
  const top = wrap(root) as Built;
  // calc_next (preorder)
  const calcNext = (b: Built | null) => {
    if (!b) return;
    const k = b.tree.k;
    if (k === "star") {
      (b.l as Built).next = b;
    } else if (k === "cat") {
      (b.l as Built).next = (b.r as Built).first;
      (b.r as Built).next = b.next;
    } else {
      if (b.l) b.l.next = b.next;
      if (b.r) b.r.next = b.next;
    }
    calcNext(b.l);
    calcNext(b.r);
  };
  calcNext(top);
  const n = all.length;
  const nfa: Nfa = {
    type: new Uint8Array(n),
    next: new Int32Array(n).fill(-1),
    e1: new Int32Array(n).fill(-1),
    e2: new Int32Array(n).fill(-1),
    arg: new Int32Array(n),
    opt: new Uint8Array(n),
    sets: new Array(n),
    init: (top.first as Built).idx,
    endNode: -1,
    preds: [],
  };
  const idxOf = (b: Built | null): number => (b ? (b.first as Built).idx : -1);
  for (const b of all) {
    const i = b.idx;
    const t = b.tree;
    const next = b.next ? (b.next.first as Built).idx : -1;
    switch (t.k) {
      case "set":
        nfa.type[i] = N_SET;
        nfa.sets[i] = t.set;
        nfa.next[i] = next;
        break;
      case "end":
        nfa.type[i] = N_END;
        nfa.endNode = i;
        break;
      case "backref":
        nfa.type[i] = N_BACKREF;
        nfa.arg[i] = t.n + 1;
        nfa.next[i] = next;
        break;
      case "alt":
      case "star": {
        nfa.type[i] = N_ALT;
        const left = b.l ? idxOf(b.l) : next;
        const right = b.r ? idxOf(b.r) : next;
        // re_node_set_init_2: sorted by node index, one element when equal
        if (left === right) nfa.e1[i] = left;
        else {
          nfa.e1[i] = Math.min(left, right);
          nfa.e2[i] = Math.max(left, right);
        }
        break;
      }
      case "open":
      case "close":
        nfa.type[i] = t.k === "open" ? N_OPEN : N_CLOSE;
        nfa.arg[i] = t.idx + 1;
        nfa.opt[i] = t.opt ? 1 : 0;
        nfa.next[i] = next;
        break;
      case "anchor":
        nfa.type[i] = N_ANCHOR;
        nfa.arg[i] = t.a;
        nfa.next[i] = next;
        break;
      default:
        throw new Error(`unexpected node ${t.k}`);
    }
  }
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const ty = nfa.type[i];
    if (ty === N_ALT) {
      preds[nfa.e1[i]].push(i);
      if (nfa.e2[i] >= 0) preds[nfa.e2[i]].push(i);
    } else if (ty >= N_ALT) {
      preds[nfa.next[i]].push(i);
    }
  }
  nfa.preds = preds.map((p) => Int32Array.from(p));
  return nfa;
}

// --- matching ---------------------------------------------------------------------------

class Matcher implements PosixRegex {
  readonly groupCount: number;
  private readonly nfa: Nfa;
  private readonly subexpMap: number[];
  private readonly hasBackref: boolean;
  private readonly icase: boolean;
  private readonly hasPlural: boolean;
  private mark: Int32Array;
  private gen = 0;

  constructor(pattern: Uint8Array, options: PosixRegexOptions) {
    const parser = new Parser(pattern, options.extended ?? false, options.icase ?? false);
    const tree = parser.parse();
    this.groupCount = parser.nsub;
    this.subexpMap = Array.from({ length: parser.nsub }, (_, i) => i);
    const lowered = lowerTree(tree, this.subexpMap) as Tree;
    this.nfa = buildNfa(lowered);
    this.hasBackref = parser.nbackref > 0;
    this.icase = options.icase ?? false;
    this.hasPlural = this.nfa.type.some((t) => t === N_ALT);
    this.mark = new Int32Array(this.nfa.type.length).fill(-1);
  }

  test(subject: Uint8Array, end = subject.length): boolean {
    return this.exec(subject, end, 1) !== undefined;
  }

  exec(subjectIn: Uint8Array, end = subjectIn.length, nmatchIn?: number): PosixMatch | undefined {
    let subject = subjectIn.subarray(0, end);
    if (this.icase) {
      const folded = new Uint8Array(subject.length);
      for (let i = 0; i < subject.length; i++) folded[i] = toUpper(subject[i]);
      subject = folded;
    }
    const nmatch = Math.min(nmatchIn ?? this.groupCount + 1, this.groupCount + 1);
    if (this.hasBackref) return this.execBacktrack(subject, nmatch);
    const found = this.overall(subject);
    if (!found) return undefined;
    const [start, stop] = found;
    let regs: Int32Array | undefined;
    if (nmatch > 1) {
      regs = this.setRegs(subject, start, stop, nmatch);
    }
    return this.result(start, stop, regs, nmatch);
  }

  private result(
    start: number,
    stop: number,
    regs: Int32Array | undefined,
    nmatch: number,
  ): PosixMatch {
    const groups: ([number, number] | undefined)[] = [];
    for (let g = 1; g < nmatch; g++) {
      const r = this.subexpMap[g - 1] + 1;
      const so = regs ? regs[2 * r] : -1;
      const eo = regs ? regs[2 * r + 1] : -1;
      groups.push(so >= 0 && eo >= 0 ? [so, eo] : undefined);
    }
    return { start, end: stop, groups };
  }

  private cond(kind: number, s: Uint8Array, idx: number): boolean {
    switch (kind) {
      case A_LINE_FIRST:
        return idx === 0;
      case A_LINE_LAST:
        return idx === s.length;
    }
    const prev = idx > 0 && isWordByte(s[idx - 1]);
    const next = idx < s.length && isWordByte(s[idx]);
    switch (kind) {
      case A_WORD_FIRST:
        return !prev && next;
      case A_WORD_LAST:
        return prev && !next;
      case A_INSIDE_WORD:
        return prev && next;
      default:
        return !prev && !next;
    }
  }

  /** Leftmost-longest `[start, end)` by simulating the NFA on all starts at once */
  private overall(s: Uint8Array): [number, number] | undefined {
    const nfa = this.nfa;
    const { type, next, e1, e2, arg, sets } = nfa;
    const n = type.length;
    let cNodes = new Int32Array(n);
    let cStarts = new Int32Array(n);
    let cCount = 0;
    let nNodes = new Int32Array(n);
    let nStarts = new Int32Array(n);
    let nCount = 0;
    const stack = new Int32Array(n * 2 + 2);
    const mark = this.mark;
    let bestStart = -1;
    let bestEnd = -1;

    // adds the closure of `node` at `idx` to the next list, threads keeping their start
    const add = (node: number, idx: number, start: number, gen: number) => {
      let sp = 0;
      stack[sp++] = node;
      while (sp > 0) {
        const x = stack[--sp];
        if (mark[x] === gen) continue;
        mark[x] = gen;
        const t = type[x];
        if (t === N_ALT) {
          if (e2[x] >= 0) stack[sp++] = e2[x];
          stack[sp++] = e1[x];
        } else if (t === N_OPEN || t === N_CLOSE) {
          stack[sp++] = next[x];
        } else if (t === N_ANCHOR) {
          if (this.cond(arg[x], s, idx)) stack[sp++] = next[x];
        } else {
          nNodes[nCount] = x;
          nStarts[nCount] = start;
          nCount++;
        }
      }
    };

    const len = s.length;
    let gen = ++this.gen;
    for (let idx = 0; ; idx++) {
      // a new thread starting here (after all the earlier-started ones)
      if (bestStart < 0) add(nfa.init, idx, idx, gen);
      // the lists swap: the next list (with the seed) is current
      [cNodes, nNodes] = [nNodes, cNodes];
      [cStarts, nStarts] = [nStarts, cStarts];
      cCount = nCount;
      nCount = 0;
      for (let i = 0; i < cCount; i++) {
        if (type[cNodes[i]] === N_END) {
          const st = cStarts[i];
          if (bestStart < 0 || st < bestStart || (st === bestStart && idx > bestEnd)) {
            bestStart = st;
            bestEnd = idx;
          }
        }
      }
      if (idx >= len) break;
      gen = ++this.gen;
      const c = s[idx];
      for (let i = 0; i < cCount; i++) {
        const x = cNodes[i];
        const st = cStarts[i];
        if (bestStart >= 0 && st > bestStart) continue;
        if (type[x] === N_SET && (sets[x] as Uint8Array)[c]) add(next[x], idx + 1, st, gen);
      }
      if (nCount === 0 && bestStart >= 0) break;
    }
    this.gen = gen + 1;
    if (this.gen > 0x3fffffff) {
      this.mark.fill(-1);
      this.gen = 0;
    }
    return bestStart >= 0 ? [bestStart, bestEnd] : undefined;
  }

  /**
   * glibc's `set_regs` without back-references: from `start`, at each choice take the first
   * destination from which `stop` is reachable (`prune_impossible_nodes` gives glibc the
   * same set), leaving a loop entered without consuming.
   */
  private setRegs(s: Uint8Array, start: number, stop: number, nmatch: number): Int32Array {
    const nfa = this.nfa;
    const { type, next, e1, e2, arg, opt, sets } = nfa;
    const n = type.length;
    const regs = new Int32Array(2 * nmatch).fill(-1);
    const prev = new Int32Array(2 * nmatch).fill(-1);
    regs[0] = start;
    regs[1] = stop;
    prev.set(regs);
    // viable[((idx - start) * n + node) * 2 + anchored]: the match end is reachable from node
    // at idx. glibc gives the nodes behind an anchor (up to the next character) copies of their
    // own, an end node among them: "anchored" is whether the walk passed an anchor since the
    // last character, and the end reached must be the halt node glibc picked, the plain end
    // node when the start reaches it unanchored, else a copy behind an anchor.
    const span = stop - start + 1;
    let viable: Uint8Array | undefined;
    if (this.hasPlural) {
      viable = this.viability(s, start, stop, 0);
      if (!viable[nfa.init * 2]) viable = this.viability(s, start, stop, 1);
    }
    const isViable = (x: number, idx: number, anchored: number) =>
      viable ? viable[((idx - start) * n + x) * 2 + anchored] === 1 : true;
    const epsVia = new Int32Array(n).fill(-1);
    let epsGen = 0;
    let node = nfa.init;
    let idx = start;
    let anchored = 0;
    let guard = 0;
    const limit = (span + 1) * (n + 1) * 4;
    for (;;) {
      if (++guard > limit) return regs;
      // update_regs
      const t = type[node];
      if (t === N_OPEN) {
        const r = arg[node];
        if (r < nmatch) {
          regs[2 * r] = idx;
          regs[2 * r + 1] = -1;
        }
      } else if (t === N_CLOSE) {
        const r = arg[node];
        if (r < nmatch) {
          if (regs[2 * r] < idx) {
            regs[2 * r + 1] = idx;
            prev.set(regs);
          } else if (opt[node] && prev[2 * r] !== -1) {
            regs.set(prev);
          } else {
            regs[2 * r + 1] = idx;
          }
        }
      }
      if (idx === stop && node === nfa.endNode) return regs;
      // proceed_next_node
      if (t >= N_ALT) {
        epsVia[node] = epsGen;
        let dest = -1;
        if (t === N_ALT) {
          const a = e1[node];
          const b = e2[node];
          const aOk = isViable(a, idx, anchored);
          const bOk = b >= 0 && isViable(b, idx, anchored);
          if (aOk && bOk) dest = epsVia[a] === epsGen ? b : a;
          else if (aOk) dest = a;
          else if (bOk) dest = b;
        } else {
          if (t === N_ANCHOR) anchored = 1;
          const a = next[node];
          if (isViable(a, idx, anchored)) dest = a;
        }
        if (dest < 0) return regs;
        node = dest;
      } else if (t === N_SET) {
        if (idx >= s.length || !(sets[node] as Uint8Array)[s[idx]]) return regs;
        idx++;
        epsGen++;
        anchored = 0;
        node = next[node];
      } else {
        return regs;
      }
    }
  }

  /** The viability table of {@link setRegs}, the halt node behind an anchor or not */
  private viability(s: Uint8Array, start: number, stop: number, haltAnchored: number): Uint8Array {
    const { type, next, arg, sets, preds, endNode } = this.nfa;
    const n = type.length;
    const viable = new Uint8Array((stop - start + 1) * n * 2);
    const queue = new Int32Array(n * 2);
    for (let idx = stop; idx >= start; idx--) {
      const base = (idx - start) * n * 2;
      let qh = 0;
      let qt = 0;
      const mark = (x: number, f: number) => {
        if (viable[base + x * 2 + f]) return;
        viable[base + x * 2 + f] = 1;
        queue[qt++] = x * 2 + f;
      };
      if (idx === stop) mark(endNode, haltAnchored);
      if (idx < stop) {
        const c = s[idx];
        const nextBase = base + n * 2;
        for (let x = 0; x < n; x++) {
          if (type[x] === N_SET && (sets[x] as Uint8Array)[c] && viable[nextBase + next[x] * 2]) {
            mark(x, 0);
            mark(x, 1);
          }
        }
      }
      while (qh < qt) {
        const item = queue[qh++];
        const y = item >> 1;
        const f = item & 1;
        for (const p of preds[y]) {
          if (type[p] === N_ANCHOR) {
            // past an anchor the walk is anchored, whatever it was before
            if (f === 1 && this.cond(arg[p], s, idx)) {
              mark(p, 0);
              mark(p, 1);
            }
          } else {
            mark(p, f);
          }
        }
      }
    }
    return viable;
  }

  /** Patterns with back-references: backtracking, in glibc's order of choices */
  private execBacktrack(s: Uint8Array, nmatch: number): PosixMatch | undefined {
    const nregs = this.groupCount + 1;
    for (let start = 0; start <= s.length; start++) {
      const found = this.backtrackFrom(s, start, nregs);
      if (found) return this.result(start, found.end, found.regs, nmatch);
    }
    return undefined;
  }

  private backtrackFrom(
    s: Uint8Array,
    start: number,
    nregs: number,
  ): { end: number; regs: Int32Array } | undefined {
    const nfa = this.nfa;
    const { type, next, e1, e2, arg, opt, sets } = nfa;
    interface Frame {
      node: number;
      idx: number;
      regs: Int32Array;
      prev: Int32Array;
      eps: Set<number>;
    }
    let bestEnd = -1;
    let bestRegs: Int32Array | undefined;
    const init = new Int32Array(2 * nregs).fill(-1);
    const stack: Frame[] = [
      { node: nfa.init, idx: start, regs: init, prev: init.slice(), eps: new Set() },
    ];
    let budget = 2_000_000;
    while (stack.length > 0) {
      if (--budget < 0) break;
      const f = stack.pop() as Frame;
      let { node, idx } = f;
      const { regs, prev } = f;
      let eps = f.eps;
      for (;;) {
        if (--budget < 0) break;
        const t = type[node];
        if (t === N_OPEN) {
          const r = arg[node];
          regs[2 * r] = idx;
          regs[2 * r + 1] = -1;
        } else if (t === N_CLOSE) {
          const r = arg[node];
          if (regs[2 * r] < idx) {
            regs[2 * r + 1] = idx;
            prev.set(regs);
          } else if (opt[node] && prev[2 * r] !== -1) {
            regs.set(prev);
          } else {
            regs[2 * r + 1] = idx;
          }
        }
        if (t === N_END) {
          let closed = true;
          for (let r = 1; r < nregs; r++) {
            if (regs[2 * r] > -1 && regs[2 * r + 1] === -1) closed = false;
          }
          if (closed && idx > bestEnd) {
            bestEnd = idx;
            bestRegs = regs.slice();
          }
          break;
        }
        if (t === N_ALT) {
          eps.add(node);
          const a = e1[node];
          const b = e2[node];
          if (b < 0) {
            node = a;
            continue;
          }
          if (eps.has(a)) {
            node = b;
            continue;
          }
          stack.push({ node: b, idx, regs: regs.slice(), prev: prev.slice(), eps: new Set(eps) });
          node = a;
          continue;
        }
        if (t === N_OPEN || t === N_CLOSE) {
          eps.add(node);
          node = next[node];
          continue;
        }
        if (t === N_ANCHOR) {
          eps.add(node);
          if (!this.cond(arg[node], s, idx)) break;
          node = next[node];
          continue;
        }
        if (t === N_BACKREF) {
          const r = arg[node];
          const so = regs[2 * r];
          const eo = regs[2 * r + 1];
          if (so < 0 || eo < 0) break;
          const len = eo - so;
          if (len === 0) {
            eps.add(node);
            node = next[node];
            continue;
          }
          if (idx + len > s.length) break;
          let same = true;
          for (let k = 0; k < len; k++) {
            if (s[so + k] !== s[idx + k]) {
              same = false;
              break;
            }
          }
          if (!same) break;
          idx += len;
          eps = new Set();
          node = next[node];
          continue;
        }
        // a set
        if (idx >= s.length || !(sets[node] as Uint8Array)[s[idx]]) break;
        idx++;
        eps = new Set();
        node = next[node];
      }
    }
    if (bestEnd < 0 || !bestRegs) return undefined;
    // the first path (in glibc's order) that ends at the longest end places the groups
    bestRegs[0] = start;
    bestRegs[1] = bestEnd;
    return { end: bestEnd, regs: bestRegs };
  }
}

/**
 * Compiles a POSIX regular expression as glibc's `regcomp` does in the C locale; throws
 * {@link PosixRegexError} for a pattern glibc rejects. A string pattern is taken as UTF-8.
 */
export function compilePosixRegex(
  pattern: string | Uint8Array,
  options: PosixRegexOptions = {},
): PosixRegex {
  const bytes = typeof pattern === "string" ? new TextEncoder().encode(pattern) : pattern;
  return new Matcher(bytes, options);
}
