/**
 * Reading `.gitattributes` lines and matching their patterns, as git's `attr.c` does
 * (`parse_attr_line`, `path_matches`).
 *
 * A line is a pattern (gitignore syntax, but a leading `!` is refused) or a macro definition
 * (`[attr]name ...`), followed by attribute states: `name` (set), `-name` (unset), `!name`
 * (back to unspecified) or `name=value`.
 */

import {
  decodeGitPath,
  decodeGitPatternFile,
  encodeGitPath,
  foldAsciiCase,
  hasEscapedBytes,
} from "@statewalker/vcs-utils/encoding";
import { sameBytes, wildmatch, wildmatchBytes } from "../ignore/git-wildmatch.js";

/**
 * The state an attributes line gives an attribute: `true` (set), `false` (unset), `null`
 * (`!name`: back to unspecified) or a string value.
 */
export type AttributeSetting = true | false | null | string;

/** One attribute state of a line. */
export interface AttributeState {
  name: string;
  setting: AttributeSetting;
}

/** A pattern as git's `parse_path_pattern` reads it. */
export interface AttributePattern {
  /** The pattern, without the trailing `/` */
  pattern: string;
  /** Length of its leading part without wildcards (git's `nowildcardlen`) */
  nowildcardLen: number;
  /** No `/` in it: matched against the basename (`PATTERN_FLAG_NODIR`) */
  nodir: boolean;
  /** Ends with `/`: matches directories only (`PATTERN_FLAG_MUSTBEDIR`) */
  mustBeDir: boolean;
  /** `*literal` (`PATTERN_FLAG_ENDSWITH`) */
  endsWith: boolean;
}

/** One rule of an attributes file: a pattern or a macro with its states. */
export type AttributeRule =
  | { kind: "pattern"; pattern: AttributePattern; states: AttributeState[] }
  | { kind: "macro"; name: string; states: AttributeState[] };

/** How an attributes file is read. */
export interface ParseAttributesOptions {
  /** Where the lines come from, for messages (a path, or `[builtin]`) */
  source?: string;
  /**
   * Macro definitions are allowed (the built-in, system, global, root `.gitattributes` and
   * `info/attributes` files; not a subdirectory's `.gitattributes`)
   */
  macrosAllowed?: boolean;
  /** Receives git's warnings about the lines it ignores */
  onWarning?: (message: string) => void;
}

/** git's `ATTR_MAX_LINE_LENGTH` */
export const ATTR_MAX_LINE_LENGTH = 2048;
/** git's `ATTR_MAX_FILE_SIZE` */
export const ATTR_MAX_FILE_SIZE = 100 * 1024 * 1024;

const MACRO_PREFIX = "[attr]";
const isBlank = (c: string | undefined) => c === " " || c === "\t" || c === "\r" || c === "\n";

/** git's `attr_name_valid`: `[-A-Za-z0-9_.]`, not starting with `-`. */
export function isValidAttributeName(name: string): boolean {
  if (name.length === 0 || name[0] === "-") return false;
  return /^[-A-Za-z0-9_.]+$/.test(name);
}

const isReserved = (name: string) => name.startsWith("builtin_");

function skipBlank(s: string, i: number): number {
  while (i < s.length && isBlank(s[i])) i++;
  return i;
}

function tokenEnd(s: string, i: number): number {
  while (i < s.length && !isBlank(s[i])) i++;
  return i;
}

/**
 * git's `unquote_c_style` on a string starting with `"`: the unquoted text and the index
 * after the closing quote, or undefined when it is not a valid C-quoted string.
 */
function unquoteC(s: string, start: number): { value: string; end: number } | undefined {
  const bytes: number[] = [];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      // octal escapes of a name that is no UTF-8 stay its bytes (`decodeGitPath`)
      return { value: decodeGitPath(new Uint8Array(bytes)), end: i + 1 };
    }
    if (c === "\\") {
      i++;
      const e = s[i];
      if (e === undefined) return undefined;
      const simple: Record<string, number> = {
        a: 7,
        b: 8,
        f: 12,
        n: 10,
        r: 13,
        t: 9,
        v: 11,
        "\\": 0x5c,
        '"': 0x22,
      };
      if (e in simple) {
        bytes.push(simple[e]);
        i++;
        continue;
      }
      if (e >= "0" && e <= "3") {
        const oct = s.slice(i, i + 3);
        if (!/^[0-3][0-7][0-7]$/.test(oct)) return undefined;
        bytes.push(Number.parseInt(oct, 8));
        i += 3;
        continue;
      }
      return undefined;
    }
    // a whole code point: an astral character is two UTF-16 units
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    bytes.push(...encodeGitPath(ch));
    i += ch.length;
  }
  return undefined;
}

const isGlobSpecial = (c: string) => c === "*" || c === "?" || c === "[" || c === "\\";

/** git's `simple_length`. */
function simpleLength(s: string): number {
  let i = 0;
  while (i < s.length && !isGlobSpecial(s[i])) i++;
  return i;
}

/** git's `parse_path_pattern`; `negative` when it starts with `!`. */
export function parseAttributePattern(text: string): AttributePattern & { negative: boolean } {
  let p = text;
  let negative = false;
  if (p.startsWith("!")) {
    negative = true;
    p = p.slice(1);
  }
  let len = p.length;
  let mustBeDir = false;
  if (len && p[len - 1] === "/") {
    len--;
    mustBeDir = true;
  }
  const pattern = p.slice(0, len);
  const nodir = !pattern.includes("/");
  const nowildcardLen = Math.min(simpleLength(p), len);
  const endsWith = p.startsWith("*") && simpleLength(p.slice(1)) === p.length - 1;
  return { pattern, nowildcardLen, nodir, mustBeDir, endsWith, negative };
}

/**
 * git's `parse_attr` over the states of a line; undefined (with a message) when a name is
 * not valid, which drops the whole line, as in git.
 */
function parseStates(
  states: string,
  where: string,
  onWarning?: (message: string) => void,
): AttributeState[] | undefined {
  const out: AttributeState[] = [];
  let cp = skipBlank(states, 0);
  while (cp < states.length) {
    const ep = tokenEnd(states, cp);
    const token = states.slice(cp, ep);
    const eq = token.indexOf("=");
    let nameStart = 0;
    let nameEnd = eq >= 0 ? eq : token.length;
    let setting: AttributeSetting;
    if (token[0] === "-" || token[0] === "!") {
      setting = token[0] === "-" ? false : null;
      nameStart = 1;
    } else if (eq < 0) {
      setting = true;
    } else {
      setting = token.slice(eq + 1);
    }
    if (nameEnd < nameStart) nameEnd = nameStart;
    const name = token.slice(nameStart, nameEnd);
    if (!isValidAttributeName(name) || isReserved(name)) {
      onWarning?.(`${name} is not a valid attribute name: ${where}`);
      return undefined;
    }
    out.push({ name, setting });
    cp = skipBlank(states, ep);
  }
  return out;
}

/**
 * Reads one line of an attributes file as git's `parse_attr_line`: undefined for a blank
 * line, a comment, or a line git ignores (with the warning git prints).
 *
 * @example
 * ```typescript
 * parseAttributesLine("*.txt text eol=crlf");
 * // { kind: "pattern", pattern: {...}, states: [{name: "text", setting: true}, {name: "eol", setting: "crlf"}] }
 * ```
 */
export function parseAttributesLine(
  line: string,
  lineno: number,
  options: ParseAttributesOptions = {},
): AttributeRule | undefined {
  const { onWarning } = options;
  const src = options.source ?? "";
  const where = `${src}:${lineno}`;
  const cp = skipBlank(line, 0);
  if (cp >= line.length || line[cp] === "#") return undefined;
  if (new TextEncoder().encode(line).length >= ATTR_MAX_LINE_LENGTH) {
    onWarning?.(`ignoring overly long attributes line ${lineno}`);
    return undefined;
  }
  let name: string;
  let statesStart: number;
  const quoted = line[cp] === '"' ? unquoteC(line, cp) : undefined;
  if (quoted) {
    name = quoted.value;
    statesStart = quoted.end;
  } else {
    const end = tokenEnd(line, cp);
    name = line.slice(cp, end);
    statesStart = end;
  }

  if (name.length > MACRO_PREFIX.length && name.startsWith(MACRO_PREFIX)) {
    if (!options.macrosAllowed) {
      onWarning?.(`${line.slice(cp)} not allowed: ${where}`);
      return undefined;
    }
    // the macro's name: after the prefix (and any blanks), up to the next blank
    let start = cp + MACRO_PREFIX.length;
    start = skipBlank(line, start);
    const end = tokenEnd(line, start);
    const macro = line.slice(start, end);
    if (!isValidAttributeName(macro) || isReserved(macro)) {
      onWarning?.(`${macro} is not a valid attribute name: ${where}`);
      return undefined;
    }
    const states = parseStates(line.slice(statesStart), where, onWarning);
    if (!states) return undefined;
    return { kind: "macro", name: macro, states };
  }

  const states = parseStates(line.slice(statesStart), where, onWarning);
  if (!states) return undefined;
  const { negative, ...pattern } = parseAttributePattern(name);
  if (negative) {
    onWarning?.(
      "Negative patterns are ignored in git attributes\nUse '\\!' for literal leading exclamation.",
    );
    return undefined;
  }
  return { kind: "pattern", pattern, states };
}

/**
 * Reads an attributes file (`.gitattributes`, `info/attributes`, ...) as git does: a UTF-8
 * BOM at the start is skipped, lines split at LF, each read by {@link parseAttributesLine}.
 */
export function parseAttributes(
  content: string | Uint8Array,
  options: ParseAttributesOptions = {},
): AttributeRule[] {
  if (typeof content !== "string" && content.length >= ATTR_MAX_FILE_SIZE) {
    options.onWarning?.(`ignoring overly large gitattributes file '${options.source ?? ""}'`);
    return [];
  }
  // one BOM is skipped, as git does: by the byte decoder, or here for text handed in
  let text = typeof content === "string" ? content : decodeGitPatternFile(content);
  if (typeof content === "string" && text.startsWith("﻿")) text = text.slice(1);
  const rules: AttributeRule[] = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, i) => {
    const rule = parseAttributesLine(line, i + 1, options);
    if (rule) rules.push(rule);
  });
  return rules;
}

/**
 * Compares `a` and `b`, folding ASCII case when asked (`fspathncmp`: git folds ASCII only,
 * so `É` and `é` stay different).
 */
function sameChars(a: string, b: string, ignoreCase: boolean): boolean {
  return ignoreCase ? foldAsciiCase(a) === foldAsciiCase(b) : a === b;
}

/**
 * Whether `path` matches the pattern of an attributes file in directory `base` ("" for the
 * root, and for the files outside the tree), as git's `path_matches`: a pattern without `/`
 * against the basename, others against the path relative to `base` (`WM_PATHNAME`).
 */
export function attributePatternMatches(
  pat: AttributePattern,
  path: string,
  base: string,
  options: { isDirectory?: boolean; ignoreCase?: boolean } = {},
): boolean {
  const ignoreCase = options.ignoreCase === true;
  if (pat.mustBeDir && !options.isDirectory) return false;
  // a pattern holding escaped bytes (half of a UTF-8 sequence) compares as bytes, as in git;
  // one of UTF-8 text has whole characters in its literal part, where strings agree
  if (hasEscapedBytes(pat.pattern)) return matchesBytes(pat, path, base, ignoreCase);
  const { pattern } = pat;
  const patternlen = pattern.length;
  if (pat.nodir) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (pat.nowildcardLen === patternlen) {
      return patternlen === basename.length && sameChars(pattern, basename, ignoreCase);
    }
    if (pat.endsWith) {
      const tail = pattern.slice(1);
      return (
        tail.length <= basename.length &&
        sameChars(tail, basename.slice(basename.length - tail.length), ignoreCase)
      );
    }
    return wildmatch(pattern, basename, { casefold: ignoreCase });
  }
  // match_pathname
  let pat2 = pattern;
  let prefix = pat.nowildcardLen;
  if (pat2.startsWith("/")) {
    pat2 = pat2.slice(1);
    prefix--;
  }
  const baselen = base.length;
  if (
    path.length < baselen + 1 ||
    (baselen && path[baselen] !== "/") ||
    !sameChars(path.slice(0, baselen), base, ignoreCase)
  ) {
    return false;
  }
  let name = baselen ? path.slice(baselen + 1) : path;
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (!sameChars(pat2.slice(0, prefix), name.slice(0, prefix), ignoreCase)) return false;
    if (pat2.length === prefix && name.length === prefix) return true;
    // keep one character of the prefix, so the match sees where a component starts
    prefix--;
    pat2 = pat2.slice(prefix);
    name = name.slice(prefix);
  }
  return wildmatch(pat2, name, { pathname: true, casefold: ignoreCase });
}

/** {@link attributePatternMatches} of a pattern holding escaped bytes: byte by byte. */
function matchesBytes(
  pat: AttributePattern,
  path: string,
  base: string,
  ignoreCase: boolean,
): boolean {
  const pattern = encodeGitPath(pat.pattern);
  const patternlen = pattern.length;
  const literal = encodeGitPath(pat.pattern.slice(0, pat.nowildcardLen)).length;
  if (pat.nodir) {
    const basename = encodeGitPath(path.slice(path.lastIndexOf("/") + 1));
    if (literal === patternlen) {
      return (
        patternlen === basename.length && sameBytes(pattern, 0, basename, 0, patternlen, ignoreCase)
      );
    }
    if (pat.endsWith) {
      const tail = patternlen - 1;
      return (
        tail <= basename.length &&
        sameBytes(pattern, 1, basename, basename.length - tail, tail, ignoreCase)
      );
    }
    return wildmatchBytes(pattern, basename, { casefold: ignoreCase });
  }
  let start = 0;
  let prefix = literal;
  if (pattern[0] === 0x2f) {
    start = 1;
    prefix--;
  }
  const baselen = base.length;
  if (
    path.length < baselen + 1 ||
    (baselen && path[baselen] !== "/") ||
    !sameChars(path.slice(0, baselen), base, ignoreCase)
  ) {
    return false;
  }
  const name = encodeGitPath(baselen ? path.slice(baselen + 1) : path);
  let nameStart = 0;
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (!sameBytes(pattern, start, name, 0, prefix, ignoreCase)) return false;
    if (patternlen - start === prefix && name.length === prefix) return true;
    // keep one byte of the prefix, so the match sees where a component starts
    prefix--;
    start += prefix;
    nameStart = prefix;
  }
  return wildmatchBytes(pattern.subarray(start), name.subarray(nameStart), {
    pathname: true,
    casefold: ignoreCase,
  });
}
