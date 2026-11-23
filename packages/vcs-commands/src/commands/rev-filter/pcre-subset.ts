/**
 * `-P` (`--perl-regexp`, `grep.patternType=perl`) patterns: a subset of PCRE2 translated to
 * a JavaScript `RegExp` whose matches are PCRE2's, run as git runs PCRE2 in the C locale
 * (no `PCRE2_UTF`: one character per byte, ASCII classes and case folding).
 *
 * @example
 * ```ts
 * const re = compilePcreSubset("fi(?=x)", { ignoreCase: false });
 * re.test(new TextEncoder().encode("fix")); // true
 * ```
 *
 * PCRE2 and JavaScript are both backtracking Perl-style engines and agree on most syntax;
 * what they do differently is translated (`.` stops only at `\n`, `\Q...\E`, `(?P<name>`,
 * `\A`/`\z`, POSIX classes, a leading `(?i)`), and what has no JavaScript equivalent with
 * the same meaning (possessive quantifiers, atomic groups, recursion, conditionals, `\K`,
 * `\G`, Unicode properties, verbs, inline options other than a leading `(?i)`, octal escapes)
 * is refused with {@link PcreUnsupportedError} rather than run as something else. Subject
 * bytes 0x80-0xFF are matched as private-use characters, so JavaScript folds the case of
 * ASCII letters only and `\s`, `\w`, `\d` and `\b` stay ASCII, as PCRE2 without UTF.
 *
 * @module
 */

/** A `-P` pattern using PCRE2 syntax this matcher does not run (refused, never approximated) */
export class PcreUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PcreUnsupportedError";
  }
}

/** A `-P` pattern that is not valid (JavaScript's description of the error) */
export class PcreSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PcreSyntaxError";
  }
}

/** A compiled `-P` pattern */
export interface PcreMatcher {
  /** Whether the bytes (one line, no newline) match */
  test(subject: Uint8Array): boolean;
}

/** The character a byte is matched as: ASCII as itself, 0x80-0xFF as U+E080-U+E0FF */
export function byteChar(b: number): string {
  return String.fromCharCode(b < 0x80 ? b : 0xe000 + b);
}

/** The subject bytes as the string the translated `RegExp` runs on */
export function bytesToSubject(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + CHUNK));
    const codes = new Array<number>(part.length);
    for (let k = 0; k < part.length; k++) {
      const b = part[k] as number;
      codes[k] = b < 0x80 ? b : 0xe000 + b;
    }
    s += String.fromCharCode(...codes);
  }
  return s;
}

/** A character of the translated pattern as a `RegExp` source escape */
function escapeChar(code: number): string {
  if (code >= 0x80) return `\\u${(0xe000 + code).toString(16).toUpperCase()}`;
  const c = String.fromCharCode(code);
  if (/[A-Za-z0-9_]/.test(c)) return c;
  if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
  return `\\${c}`;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  ascii: "\\x00-\\x7f",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\t\\n\\x0b\\f\\r ",
  upper: "A-Z",
  word: "A-Za-z0-9_",
  xdigit: "0-9A-Fa-f",
};

/**
 * Translates a PCRE2 pattern (UTF-8 bytes, as git passes it) to a JavaScript `RegExp`;
 * throws {@link PcreUnsupportedError} or {@link PcreSyntaxError}.
 */
export function compilePcreSubset(
  pattern: string | Uint8Array,
  options: { ignoreCase?: boolean } = {},
): PcreMatcher {
  const p = typeof pattern === "string" ? new TextEncoder().encode(pattern) : pattern;
  let i = 0;
  let out = "";
  let groups = 0;
  const names = new Set<string>();
  const backrefs: number[] = [];
  const namedRefs: string[] = [];
  let ignoreCase = !!options.ignoreCase;
  const unsupported = (what: string): never => {
    throw new PcreUnsupportedError(`unsupported in -P patterns: ${what}`);
  };
  const ch = (k: number) => (k < p.length ? String.fromCharCode(p[k] as number) : "");
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isHex = (c: string) => /^[0-9A-Fa-f]$/.test(c);
  /** A group name at `i` up to `end`; advances past `end` */
  const readName = (end: string): string => {
    let name = "";
    while (i < p.length && ch(i) !== end) name += ch(i++);
    if (ch(i) !== end || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new PcreSyntaxError("invalid group name");
    }
    i++;
    return name;
  };
  // a leading (?i) sets the option for the whole pattern
  if (ch(0) === "(" && ch(1) === "?" && ch(2) === "i" && ch(3) === ")") {
    ignoreCase = true;
    i = 4;
  }

  /** An escape at `i` (just after the backslash): source text; `inClass` inside `[...]` */
  const readEscape = (inClass: boolean): string => {
    if (i >= p.length) throw new PcreSyntaxError("\\ at end of pattern");
    const c = ch(i++);
    switch (c) {
      case "d":
      case "D":
      case "w":
      case "W":
      case "s":
      case "S":
        return `\\${c}`;
      case "b":
      case "B":
        if (inClass) {
          if (c === "b") return "\\x08";
          return unsupported("\\B in a character class");
        }
        return `\\${c}`;
      case "n":
        return "\\n";
      case "t":
        return "\\t";
      case "r":
        return "\\r";
      case "f":
        return "\\f";
      case "e":
        return "\\x1b";
      case "a":
        return "\\x07";
      case "0": {
        if (isDigit(ch(i))) return unsupported("octal escapes");
        return "\\x00";
      }
      case "x": {
        let hex = "";
        if (ch(i) === "{") {
          i++;
          while (i < p.length && ch(i) !== "}") hex += ch(i++);
          if (ch(i) !== "}" || !/^[0-9A-Fa-f]+$/.test(hex))
            throw new PcreSyntaxError("bad \\x{...}");
          i++;
        } else {
          while (hex.length < 2 && isHex(ch(i))) hex += ch(i++);
        }
        const code = hex ? Number.parseInt(hex, 16) : 0;
        if (code > 0xff) return unsupported("characters above \\xff");
        return escapeChar(code);
      }
      case "A":
      case "z":
      case "Z":
        if (inClass) return unsupported(`\\${c} in a character class`);
        return c === "A" ? "^" : "$";
      case "k": {
        if (inClass) return unsupported("\\k in a character class");
        const open = ch(i);
        const close = open === "<" ? ">" : open === "{" ? "}" : open === "'" ? "'" : "";
        if (!close) throw new PcreSyntaxError("\\k is not followed by a name");
        i++;
        const name = readName(close);
        namedRefs.push(name);
        return `\\k<${name}>`;
      }
      case "g": {
        if (inClass) return unsupported("\\g in a character class");
        let num = "";
        if (ch(i) === "{") {
          i++;
          while (i < p.length && ch(i) !== "}") num += ch(i++);
          i++;
        } else {
          while (isDigit(ch(i))) num += ch(i++);
        }
        if (!/^[1-9][0-9]*$/.test(num)) return unsupported(`\\g${num}`);
        backrefs.push(Number(num));
        return `(?:\\${num})`;
      }
      case "Q": {
        let lit = "";
        while (i < p.length && !(ch(i) === "\\" && ch(i + 1) === "E")) {
          lit += escapeChar(p[i] as number);
          i++;
        }
        if (i < p.length) i += 2;
        return inClass ? lit : `(?:${lit})`;
      }
      case "E":
        return "";
      default: {
        if (c >= "1" && c <= "9") {
          if (inClass) return unsupported("octal escapes");
          if (isDigit(ch(i))) return unsupported("back-references above \\9");
          backrefs.push(Number(c));
          return `(?:\\${c})`;
        }
        if (/[A-Za-z]/.test(c)) return unsupported(`\\${c}`);
        // any other escaped character is itself
        return escapeChar(p[i - 1] as number);
      }
    }
  };

  /** A character class at `i` (just after `[`) */
  const charClass = (): string => {
    let src = "[";
    if (ch(i) === "^") {
      src += "^";
      i++;
    }
    let first = true;
    for (;;) {
      if (i >= p.length) throw new PcreSyntaxError("missing terminating ] for character class");
      const c = ch(i);
      if (c === "]" && !first) {
        i++;
        break;
      }
      first = false;
      if (c === "[" && ch(i + 1) === ":") {
        const end = indexOfBytes(p, ":]", i + 2);
        if (end < 0) {
          src += "\\[";
          i++;
          continue;
        }
        const name = new TextDecoder().decode(p.subarray(i + 2, end));
        const set = POSIX_CLASSES[name];
        if (!set) return unsupported(`[:${name}:]`);
        src += set;
        i = end + 2;
        continue;
      }
      if (c === "[" && (ch(i + 1) === "." || ch(i + 1) === "=")) {
        return unsupported(`[${ch(i + 1)} in a character class`);
      }
      if (c === "\\") {
        i++;
        src += readEscape(true);
        continue;
      }
      if (c === "-") {
        src += "-";
        i++;
        continue;
      }
      src += escapeChar(p[i] as number);
      i++;
    }
    return `${src}]`;
  };

  /** A `{n}`, `{n,}` or `{n,m}` quantifier at `i`, or undefined (then `{` is a literal) */
  const braceQuantifier = (): string | undefined => {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(new TextDecoder("latin1").decode(p.subarray(i, i + 24)));
    if (!m) {
      if (/^\{\s*,\s*\d+\s*\}/.test(new TextDecoder("latin1").decode(p.subarray(i, i + 24)))) {
        return unsupported("{,m} quantifiers");
      }
      return undefined;
    }
    i += m[0].length;
    return m[0];
  };

  let atomEnd = false;
  const quantifierFollows = () => {
    const c = ch(i);
    if (c === "?") {
      out += "?";
      i++;
    } else if (c === "+") {
      unsupported("possessive quantifiers");
    }
  };

  while (i < p.length) {
    const c = ch(i);
    switch (c) {
      case "\\":
        i++;
        out += readEscape(false);
        atomEnd = true;
        break;
      case "[":
        i++;
        out += charClass();
        atomEnd = true;
        break;
      case ".":
        i++;
        out += "[^\\n]";
        atomEnd = true;
        break;
      case "(": {
        i++;
        if (ch(i) === "*") unsupported("(*VERB) and option settings");
        if (ch(i) !== "?") {
          groups++;
          out += "(";
          atomEnd = false;
          break;
        }
        const k = ch(i + 1);
        if (k === ":" || k === "=" || k === "!") {
          out += `(?${k}`;
          i += 2;
        } else if (k === "<" && (ch(i + 2) === "=" || ch(i + 2) === "!")) {
          out += `(?<${ch(i + 2)}`;
          i += 3;
        } else if (k === "<" || k === "'" || (k === "P" && ch(i + 2) === "<")) {
          i += k === "P" ? 3 : 2;
          const name = readName(k === "'" ? "'" : ">");
          if (names.has(name))
            throw new PcreSyntaxError("two named subpatterns have the same name");
          names.add(name);
          groups++;
          out += `(?<${name}>`;
        } else if (k === "P" && ch(i + 2) === "=") {
          i += 3;
          const name = readName(")");
          namedRefs.push(name);
          out += `\\k<${name}>`;
          atomEnd = true;
          break;
        } else if (k === "#") {
          const end = p.indexOf(0x29, i);
          if (end < 0) throw new PcreSyntaxError("missing ) after (?# comment");
          i = end + 1;
          break;
        } else {
          unsupported(`(?${k}`);
        }
        atomEnd = false;
        break;
      }
      case ")":
        i++;
        out += ")";
        atomEnd = true;
        break;
      case "|":
      case "^":
      case "$":
        i++;
        out += c;
        atomEnd = c === "$";
        break;
      case "*":
      case "+":
      case "?":
        i++;
        out += c;
        quantifierFollows();
        atomEnd = false;
        break;
      case "{": {
        const q = atomEnd ? braceQuantifier() : undefined;
        if (q) {
          out += q;
          quantifierFollows();
          atomEnd = false;
        } else {
          out += "\\{";
          i++;
          atomEnd = true;
        }
        break;
      }
      default:
        out += escapeChar(p[i] as number);
        i++;
        atomEnd = true;
    }
  }
  for (const n of backrefs) {
    if (n > groups) throw new PcreSyntaxError("reference to non-existent subpattern");
  }
  for (const name of namedRefs) {
    if (!names.has(name)) throw new PcreSyntaxError("reference to non-existent subpattern");
  }
  let re: RegExp;
  try {
    re = new RegExp(out, ignoreCase ? "i" : "");
  } catch (e) {
    throw new PcreSyntaxError((e as Error).message);
  }
  return {
    test: (subject: Uint8Array) => {
      re.lastIndex = 0;
      return re.test(bytesToSubject(subject));
    },
  };
}

function indexOfBytes(hay: Uint8Array, needle: string, from: number): number {
  outer: for (let k = from; k + needle.length <= hay.length; k++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[k + j] !== needle.charCodeAt(j)) continue outer;
    }
    return k;
  }
  return -1;
}
