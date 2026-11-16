/**
 * Git ignore rule implementation.
 *
 * Based on JGit's FastIgnoreRule and internal matchers.
 * Supports full gitignore syntax including:
 * - Wildcards: *, ?, **
 * - Character classes: [a-z], [!abc], [[:alnum:]]
 * - Negation: !pattern
 * - Directory-only: pattern/
 * - Anchored patterns: /pattern
 */

import { wildmatch } from "./git-wildmatch.js";
import type { IgnoreRule } from "./ignore-manager.js";

const PATH_SEPARATOR = "/";

/**
 * Matcher interface for pattern matching.
 */
interface IMatcher {
  matches(path: string, startIncl: number, endExcl: number): boolean;
  matchesPath(path: string, isDirectory: boolean, pathMatch: boolean): boolean;
}

/**
 * Matcher that never matches (for empty/invalid patterns).
 */
const NO_MATCH: IMatcher = {
  matches: () => false,
  matchesPath: () => false,
};

/**
 * Create an ignore rule from a pattern string.
 */
export function createIgnoreRule(pattern: string): IgnoreRule {
  return new GitIgnoreRule(pattern);
}

class GitIgnoreRule implements IgnoreRule {
  readonly pattern: string;
  readonly isNegated: boolean;
  readonly dirOnly: boolean;
  readonly isEmpty: boolean;
  private matcher: IMatcher;
  private readonly git: GitPattern | undefined;

  constructor(originalPattern: string) {
    if (originalPattern == null) {
      throw new Error("Pattern must not be null!");
    }

    this.pattern = originalPattern;
    this.git = parseGitPattern(originalPattern);
    const legacy = parseLegacy(originalPattern);
    this.isNegated = originalPattern.startsWith("!");
    this.dirOnly = legacy.dirOnly;
    this.matcher = legacy.matcher;
    // empty as git reads it: a comment, or nothing left once `!` and a trailing `/` go
    this.isEmpty = !this.git || this.git.pattern.length === 0;
  }

  isMatch(path: string, isDirectory: boolean): boolean {
    return this.isMatchWithMode(path, isDirectory, false);
  }

  isMatchWithMode(path: string, isDirectory: boolean, pathMatch: boolean): boolean {
    if (path == null || path.length === 0) {
      return false;
    }
    return this.matcher.matchesPath(path, isDirectory, pathMatch);
  }

  matchesPath(path: string, isDirectory: boolean): boolean {
    if (!this.git || !path) return false;
    return matchGitPattern(this.git, path.replace(/^\/+/, ""), isDirectory);
  }
}

/** JGit's parsing of a pattern (for `isMatch` / `isMatchWithMode`); never throws. */
function parseLegacy(originalPattern: string): { dirOnly: boolean; matcher: IMatcher } {
  let pattern = originalPattern;
  if (pattern.length === 0) return { dirOnly: false, matcher: NO_MATCH };
  if (pattern.charAt(0) === "!") {
    pattern = pattern.substring(1);
    if (pattern.length === 0) return { dirOnly: false, matcher: NO_MATCH };
  }
  if (pattern.charAt(0) === "#") return { dirOnly: false, matcher: NO_MATCH };
  if (pattern.charAt(0) === "\\" && pattern.length > 1) {
    const next = pattern.charAt(1);
    if (next === "!" || next === "#") pattern = pattern.substring(1);
  }
  const dirOnly = isDirectoryPattern(pattern);
  if (dirOnly) {
    pattern = stripTrailingWhitespace(pattern);
    pattern = stripTrailing(pattern, PATH_SEPARATOR);
    if (pattern.length === 0) return { dirOnly, matcher: NO_MATCH };
  }
  try {
    return { dirOnly, matcher: createPathMatcher(pattern, dirOnly) };
  } catch {
    return { dirOnly, matcher: NO_MATCH };
  }
}

// ============ git's pattern matching (dir.c) ============

/** A `.gitignore` line as git's `parse_path_pattern` reads it. */
interface GitPattern {
  /** The pattern, without `!` and the trailing `/` */
  pattern: string;
  /** The length of its leading literal part (git's `nowildcardlen`) */
  nowildcardLen: number;
  /** No slash in it: matched against the last component (`PATTERN_FLAG_NODIR`) */
  nodir: boolean;
  /** Ends with `/`: only a directory (`PATTERN_FLAG_MUSTBEDIR`) */
  mustBeDir: boolean;
  /** `*literal` (`PATTERN_FLAG_ENDSWITH`) */
  endsWith: boolean;
}

const isGlobSpecialChar = (c: string) => c === "*" || c === "?" || c === "[" || c === "\\";
const simpleLength = (s: string) => {
  let i = 0;
  while (i < s.length && !isGlobSpecialChar(s[i])) i++;
  return i;
};

/**
 * git's `trim_trailing_spaces`: trailing spaces go unless escaped with a backslash.
 *
 * @example
 * ```typescript
 * trimTrailingSpaces("a  "); // "a"
 * trimTrailingSpaces("a\\ "); // "a\\ "
 * ```
 */
export function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") {
      if (lastSpace < 0) lastSpace = i;
    } else if (c === "\\") {
      i++;
      if (i >= line.length) return line;
      lastSpace = -1;
    } else lastSpace = -1;
  }
  return lastSpace >= 0 ? line.slice(0, lastSpace) : line;
}

/** git's `parse_path_pattern`; undefined for a comment. */
function parseGitPattern(line: string): GitPattern | undefined {
  if (line.length === 0 || line.startsWith("#")) return undefined;
  let p = line;
  if (p.startsWith("!")) p = p.slice(1);
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
  return { pattern, nowildcardLen, nodir, mustBeDir, endsWith };
}

/** git's `match_basename` and `match_pathname` (base: the ignore file's directory). */
function matchGitPattern(g: GitPattern, path: string, isDirectory: boolean): boolean {
  if (g.mustBeDir && !isDirectory) return false;
  const { pattern } = g;
  const patternlen = pattern.length;
  if (g.nodir) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (g.nowildcardLen === patternlen) return patternlen > 0 && pattern === basename;
    if (g.endsWith) {
      const tail = pattern.slice(1);
      return tail.length <= basename.length && basename.endsWith(tail);
    }
    return wildmatch(pattern, basename);
  }
  let pat = pattern;
  let prefix = g.nowildcardLen;
  if (pat.startsWith("/")) {
    pat = pat.slice(1);
    prefix--;
  }
  let name = path;
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (pat.slice(0, prefix) !== name.slice(0, prefix)) return false;
    pat = pat.slice(prefix);
    name = name.slice(prefix);
    if (!pat.length && !name.length) return true;
  }
  return wildmatch(pat, name, { pathname: true });
}

// ============ Pattern State Detection ============

type PatternState = "LEADING_ASTERISK_ONLY" | "TRAILING_ASTERISK_ONLY" | "COMPLEX" | "NONE";

function checkWildCards(pattern: string): PatternState {
  if (isComplexWildcard(pattern)) {
    return "COMPLEX";
  }
  const startIdx = pattern.indexOf("*");
  if (startIdx < 0) {
    return "NONE";
  }
  if (startIdx === pattern.length - 1) {
    return "TRAILING_ASTERISK_ONLY";
  }
  if (pattern.lastIndexOf("*") === 0) {
    return "LEADING_ASTERISK_ONLY";
  }
  return "COMPLEX";
}

function isComplexWildcard(pattern: string): boolean {
  if (pattern.indexOf("[") !== -1) {
    return true;
  }
  if (pattern.indexOf("?") !== -1) {
    return true;
  }
  const backSlash = pattern.indexOf("\\");
  if (backSlash >= 0) {
    const nextIdx = backSlash + 1;
    if (pattern.length === nextIdx) {
      return false;
    }
    const nextChar = pattern.charAt(nextIdx);
    if (nextChar === "?" || nextChar === "*" || nextChar === "[") {
      return true;
    }
  }
  return false;
}

function isWildCard(pattern: string): boolean {
  return pattern.indexOf("*") !== -1 || isComplexWildcard(pattern);
}

// ============ String Helpers ============

function stripTrailing(pattern: string, c: string): string {
  for (let i = pattern.length - 1; i >= 0; i--) {
    if (pattern.charAt(i) !== c) {
      return i === pattern.length - 1 ? pattern : pattern.substring(0, i + 1);
    }
  }
  return "";
}

function stripTrailingWhitespace(pattern: string): string {
  for (let i = pattern.length - 1; i >= 0; i--) {
    const c = pattern.charAt(i);
    if (!/\s/.test(c)) {
      return i === pattern.length - 1 ? pattern : pattern.substring(0, i + 1);
    }
  }
  return "";
}

function isDirectoryPattern(pattern: string): boolean {
  for (let i = pattern.length - 1; i >= 0; i--) {
    const c = pattern.charAt(i);
    if (!/\s/.test(c)) {
      return c === PATH_SEPARATOR;
    }
  }
  return false;
}

function countSlashes(s: string, ignoreFirstLast: boolean): number {
  let start = 0;
  let count = 0;
  const length = s.length;
  while (start < length) {
    start = s.indexOf(PATH_SEPARATOR, start);
    if (start === -1) {
      break;
    }
    if (!ignoreFirstLast || (start !== 0 && start !== length - 1)) {
      count++;
    }
    start++;
  }
  return count;
}

function splitPath(pattern: string): string[] {
  const count = countSlashes(pattern, true);
  if (count < 1) {
    throw new Error(`Pattern must have at least two segments: ${pattern}`);
  }

  const segments: string[] = [];
  let right = 0;
  while (true) {
    const left = right;
    right = pattern.indexOf(PATH_SEPARATOR, right);
    if (right === -1) {
      if (left < pattern.length) {
        segments.push(pattern.substring(left));
      }
      break;
    }
    if (right - left > 0) {
      if (left === 1) {
        // Leading slash should remain by the first pattern
        segments.push(pattern.substring(left - 1, right));
      } else if (right === pattern.length - 1) {
        // Trailing slash should remain too
        segments.push(pattern.substring(left, right + 1));
      } else {
        segments.push(pattern.substring(left, right));
      }
    }
    right++;
  }
  return segments;
}

// ============ Pattern Trimming ============

function trimPattern(pattern: string): string {
  while (pattern.length > 0 && pattern.charAt(pattern.length - 1) === " ") {
    if (pattern.length > 1 && pattern.charAt(pattern.length - 2) === "\\") {
      // Last space was escaped by backslash
      pattern = `${pattern.substring(0, pattern.length - 2)} `;
      return pattern;
    }
    pattern = pattern.substring(0, pattern.length - 1);
  }
  return pattern;
}

// ============ Glob to Regex Conversion ============

const POSIX_CHAR_CLASSES: Record<string, string> = {
  alnum: "\\p{L}\\p{N}",
  alpha: "\\p{L}",
  blank: " \\t",
  cntrl: "\\p{Cc}",
  digit: "\\d",
  graph: "\\S",
  lower: "\\p{Ll}",
  print: "\\P{Cc}",
  punct: "\\p{P}",
  space: "\\s",
  upper: "\\p{Lu}",
  xdigit: "[0-9A-Fa-f]",
  word: "\\w",
};

function convertGlobToRegex(pattern: string): RegExp {
  let sb = "";
  let inBrackets = 0;
  let seenEscape = false;
  let ignoreLastBracket = false;
  let inCharClass = false;
  let charClass = "";

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);

    switch (c) {
      case "*":
        if (seenEscape || inBrackets > 0) {
          sb += c;
        } else {
          sb += `.${c}`;
        }
        break;

      case "(":
      case ")":
      case "{":
      case "}":
      case "+":
      case "$":
      case "^":
      case "|":
        if (seenEscape || inBrackets > 0) {
          sb += c;
        } else {
          sb += `\\${c}`;
        }
        break;

      case ".":
        if (seenEscape) {
          sb += c;
        } else {
          sb += "\\.";
        }
        break;

      case "?":
        if (seenEscape || inBrackets > 0) {
          sb += c;
        } else {
          sb += ".";
        }
        break;

      case ":":
        if (inBrackets > 0) {
          if (sb.charAt(sb.length - 1) === "[" && /[a-z]/i.test(pattern.charAt(i + 1) || "")) {
            inCharClass = true;
          }
        }
        sb += ":";
        break;

      case "-":
        if (inBrackets > 0) {
          if (pattern.charAt(i + 1) === "]") {
            sb += "\\-";
          } else {
            sb += c;
          }
        } else {
          sb += "-";
        }
        break;

      case "\\":
        if (inBrackets > 0) {
          const lookAhead = pattern.charAt(i + 1);
          if (lookAhead === "]" || lookAhead === "[") {
            ignoreLastBracket = true;
          }
        } else {
          const lookAhead = pattern.charAt(i + 1);
          if (
            lookAhead !== "\\" &&
            lookAhead !== "[" &&
            lookAhead !== "?" &&
            lookAhead !== "*" &&
            lookAhead !== " "
          ) {
            break;
          }
        }
        sb += c;
        break;

      case "[":
        if (inBrackets > 0) {
          if (!seenEscape) {
            sb += "\\";
          }
          sb += "[";
          ignoreLastBracket = true;
        } else {
          if (!seenEscape) {
            inBrackets++;
            ignoreLastBracket = false;
          }
          sb += "[";
        }
        break;

      case "]":
        if (seenEscape) {
          sb += "]";
          ignoreLastBracket = true;
          break;
        }
        if (inBrackets <= 0) {
          sb += "\\]";
          ignoreLastBracket = true;
          break;
        }
        {
          const lookBehind = sb.charAt(sb.length - 1);
          if ((lookBehind === "[" && !ignoreLastBracket) || lookBehind === "^") {
            sb += "\\]";
            ignoreLastBracket = true;
          } else {
            ignoreLastBracket = false;
            if (!inCharClass) {
              inBrackets--;
              sb += "]";
            } else {
              inCharClass = false;
              // Check for POSIX character class
              const posixClass = POSIX_CHAR_CLASSES[charClass];
              if (posixClass) {
                // Remove last [:
                sb = sb.substring(0, sb.length - 2) + posixClass;
              }
              charClass = "";
            }
          }
        }
        break;

      case "!":
        if (inBrackets > 0) {
          if (sb.charAt(sb.length - 1) === "[") {
            sb += "^";
          } else {
            sb += c;
          }
        } else {
          sb += c;
        }
        break;

      default:
        if (inCharClass) {
          charClass += c;
        } else {
          sb += c;
        }
        break;
    }

    seenEscape = c === "\\";
  }

  if (inBrackets > 0) {
    throw new Error(`Not closed bracket in pattern: ${pattern}`);
  }

  // Anchor the regex to match the entire string
  // Use 'us' flags: u=unicode, s=dotAll (allows . to match newlines/CR)
  return new RegExp(`^${sb}$`, "us");
}

function deleteBackslash(s: string): string {
  if (s.indexOf("\\") < 0) {
    return s;
  }
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "\\") {
      if (i + 1 === s.length) {
        continue;
      }
      const next = s.charAt(i + 1);
      if (next === "\\") {
        result += ch;
        i++;
        continue;
      }
      if (next === "?" || next === "*" || next === "[") {
        continue;
      }
    }
    result += ch;
  }
  return result;
}

// ============ Matchers ============

class NameMatcher implements IMatcher {
  protected readonly pattern: string;
  protected readonly dirOnly: boolean;
  private readonly subPattern: string;
  private readonly beginning: boolean;
  private readonly nameOnly: boolean;

  constructor(pattern: string, dirOnly: boolean, nameOnly: boolean) {
    this.dirOnly = dirOnly;
    // nameOnly is false if pattern has a slash or starts with /
    this.beginning = pattern.charAt(0) === PATH_SEPARATOR;
    this.subPattern = deleteBackslash(this.beginning ? pattern.substring(1) : pattern);
    // For anchored patterns (/a), we don't use nameOnly matching
    this.nameOnly = nameOnly && !this.beginning;
    this.pattern = pattern;
  }

  matches(path: string, startIncl: number, endExcl: number): boolean {
    const toMatch = path.substring(startIncl, endExcl);
    return this.subPattern === toMatch;
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    if (this.nameOnly) {
      return this.matchNameOnly(path, assumeDirectory, pathMatch);
    }
    return this.matchSegment(path, assumeDirectory, pathMatch);
  }

  private matchNameOnly(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // Normalize path
    let p = path;
    if (p.startsWith(PATH_SEPARATOR)) {
      p = p.substring(1);
    }

    const name = this.subPattern;
    const segments = p.split(PATH_SEPARATOR).filter((s) => s.length > 0);

    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === name) {
        // Found matching segment
        const isLastSegment = i === segments.length - 1;

        if (this.dirOnly) {
          // For directory patterns, must be a directory (has children or assumeDirectory at end)
          if (isLastSegment) {
            // pathMatch requires exact path match - only match if this is the only segment
            if (pathMatch) {
              return assumeDirectory;
            }
            return assumeDirectory;
          }

          // For pathMatch=true, a/ should not match a/b (has children)
          // pathMatch means match the exact path, not content under it
          if (pathMatch) {
            return false;
          }

          return true; // Has children, so it's a directory
        }

        // pathMatch: the pattern names the path itself (its last component), as git
        // matches it; directories above are the caller's to check
        if (pathMatch) return isLastSegment;
        return true;
      }
    }
    return false;
  }

  private matchSegment(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // Normalize path
    let p = path;
    if (p.startsWith(PATH_SEPARATOR)) {
      p = p.substring(1);
    }

    // For anchored patterns, only match at root
    if (this.beginning) {
      const segments = p.split(PATH_SEPARATOR).filter((s) => s.length > 0);
      if (segments.length === 0) {
        return false;
      }

      // Must match first segment
      if (segments[0] !== this.subPattern) {
        return false;
      }

      // For directory patterns
      if (this.dirOnly) {
        if (segments.length === 1) {
          // Single segment - must be directory
          if (pathMatch) {
            return assumeDirectory;
          }
          return assumeDirectory;
        }
        // Has more segments, so it's definitely a directory (pathMatch: not the path itself)
        return !pathMatch;
      }

      // Regular match at root (pathMatch: the path itself, a single component)
      return !pathMatch || segments.length === 1;
    }

    // Non-anchored simple pattern - shouldn't reach here for nameOnly=false
    // but handle it for safety
    if (p === this.subPattern) {
      return !this.dirOnly || assumeDirectory;
    }

    const prefix = this.subPattern + PATH_SEPARATOR;
    if (pathMatch) {
      return p === prefix && (!this.dirOnly || assumeDirectory);
    }
    return p.startsWith(prefix);
  }
}

class WildCardMatcher implements IMatcher {
  protected readonly pattern: string;
  protected readonly dirOnly: boolean;
  private readonly regex: RegExp;
  private readonly beginning: boolean;
  private readonly subPattern: string;

  constructor(pattern: string, dirOnly: boolean) {
    this.pattern = pattern;
    this.dirOnly = dirOnly;
    this.beginning = pattern.charAt(0) === PATH_SEPARATOR;
    this.subPattern = this.beginning ? pattern.substring(1) : pattern;
    this.regex = convertGlobToRegex(deleteBackslash(this.subPattern));
  }

  matches(path: string, startIncl: number, endExcl: number): boolean {
    const toMatch = path.substring(startIncl, endExcl);
    return this.regex.test(toMatch);
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // Normalize path (remove leading /)
    let p = path;
    if (p.startsWith(PATH_SEPARATOR)) {
      p = p.substring(1);
    }

    const segments = p.split(PATH_SEPARATOR).filter((s) => s.length > 0);
    if (segments.length === 0) {
      return false;
    }

    // git matches a pattern against the path itself: a name-only pattern against its last
    // component, an anchored one-component pattern against a path of one component, a
    // directory-only pattern only against a directory. Directories above the path are the
    // caller's to check (a path inside an excluded directory is excluded; a negated
    // directory pattern re-includes the directory, never the files below it).
    if (pathMatch) {
      if (this.beginning && segments.length !== 1) return false;
      const last = segments[segments.length - 1];
      if (!this.regex.test(last)) return false;
      return !this.dirOnly || assumeDirectory;
    }

    // If anchored (starts with /), only match first segment
    if (this.beginning) {
      if (!this.regex.test(segments[0])) {
        return false;
      }
      if (this.dirOnly) {
        return assumeDirectory || segments.length > 1;
      }
      return true;
    }

    // Match against any segment
    for (let i = 0; i < segments.length; i++) {
      if (this.regex.test(segments[i])) {
        if (this.dirOnly) {
          return assumeDirectory || i < segments.length - 1;
        }
        return true;
      }
    }
    return false;
  }
}

class LeadingAsteriskMatcher implements IMatcher {
  protected readonly dirOnly: boolean;
  private readonly suffix: string;
  private readonly beginning: boolean;

  constructor(pattern: string, dirOnly: boolean) {
    this.dirOnly = dirOnly;
    this.beginning = pattern.charAt(0) === PATH_SEPARATOR;
    // Remove leading / and * and any escape chars
    const p = this.beginning ? pattern.substring(1) : pattern;
    this.suffix = deleteBackslash(p.substring(1));
  }

  matches(path: string, startIncl: number, endExcl: number): boolean {
    const toMatch = path.substring(startIncl, endExcl);
    return toMatch.endsWith(this.suffix);
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // Normalize path (remove leading /)
    let p = path;
    if (p.startsWith(PATH_SEPARATOR)) {
      p = p.substring(1);
    }

    const segments = p.split(PATH_SEPARATOR).filter((s) => s.length > 0);
    if (segments.length === 0) {
      return false;
    }

    // git matches a pattern against the path itself: a name-only pattern against its last
    // component, an anchored one-component pattern against a path of one component, a
    // directory-only pattern only against a directory. Directories above the path are the
    // caller's to check (a path inside an excluded directory is excluded; a negated
    // directory pattern re-includes the directory, never the files below it).
    if (pathMatch) {
      if (this.beginning && segments.length !== 1) return false;
      const last = segments[segments.length - 1];
      if (!last.endsWith(this.suffix)) return false;
      return !this.dirOnly || assumeDirectory;
    }

    // If anchored (starts with /), only match first segment
    if (this.beginning) {
      if (!segments[0].endsWith(this.suffix)) {
        return false;
      }
      if (this.dirOnly) {
        return assumeDirectory || segments.length > 1;
      }
      return true;
    }

    // Match against any segment
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].endsWith(this.suffix)) {
        if (this.dirOnly) {
          return assumeDirectory || i < segments.length - 1;
        }
        return true;
      }
    }
    return false;
  }
}

class TrailingAsteriskMatcher implements IMatcher {
  protected readonly dirOnly: boolean;
  private readonly prefix: string;
  private readonly beginning: boolean;

  constructor(pattern: string, dirOnly: boolean) {
    this.dirOnly = dirOnly;
    this.beginning = pattern.charAt(0) === PATH_SEPARATOR;
    // Remove leading / if present, then remove trailing *
    const p = this.beginning ? pattern.substring(1) : pattern;
    this.prefix = deleteBackslash(p.substring(0, p.length - 1));
  }

  matches(path: string, startIncl: number, endExcl: number): boolean {
    const toMatch = path.substring(startIncl, endExcl);
    return toMatch.startsWith(this.prefix);
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // Normalize path (remove leading /)
    let p = path;
    if (p.startsWith(PATH_SEPARATOR)) {
      p = p.substring(1);
    }

    const segments = p.split(PATH_SEPARATOR).filter((s) => s.length > 0);
    if (segments.length === 0) {
      return false;
    }

    // git matches a pattern against the path itself: a name-only pattern against its last
    // component, an anchored one-component pattern against a path of one component, a
    // directory-only pattern only against a directory. Directories above the path are the
    // caller's to check (a path inside an excluded directory is excluded; a negated
    // directory pattern re-includes the directory, never the files below it).
    if (pathMatch) {
      if (this.beginning && segments.length !== 1) return false;
      const last = segments[segments.length - 1];
      if (!last.startsWith(this.prefix)) return false;
      return !this.dirOnly || assumeDirectory;
    }

    // If anchored (starts with /), only match first segment
    if (this.beginning) {
      if (!segments[0].startsWith(this.prefix)) {
        return false;
      }
      if (this.dirOnly) {
        return assumeDirectory || segments.length > 1;
      }
      return true;
    }

    // Match against any segment
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].startsWith(this.prefix)) {
        if (this.dirOnly) {
          return assumeDirectory || i < segments.length - 1;
        }
        return true;
      }
    }
    return false;
  }
}

/**
 * Matches ** (double star) which matches any path segments.
 */
class WildMatcher implements IMatcher {
  readonly dirOnly: boolean;

  constructor(dirOnly: boolean) {
    this.dirOnly = dirOnly;
  }

  matches(_path: string, _startIncl: number, _endExcl: number): boolean {
    return true;
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    // For directory-only patterns (like **/), need to check if target is directory
    if (this.dirOnly) {
      // If assumeDirectory is true, or path contains more segments, it's a match
      // But for single file paths, we need assumeDirectory
      const segments = path.split(PATH_SEPARATOR).filter((s) => s.length > 0);
      if (segments.length === 0) {
        return false;
      }

      // In pathMatch mode, check last segment is directory
      if (pathMatch) {
        return assumeDirectory;
      }

      // In prefix mode, if there are multiple segments or assumeDirectory, match
      // A single segment file shouldn't match **/
      if (segments.length === 1 && !assumeDirectory) {
        return false;
      }

      return true;
    }
    return true;
  }
}

const WILD_NO_DIRECTORY = new WildMatcher(false);
const WILD_ONLY_DIRECTORY = new WildMatcher(true);

// ============ Path Matcher ============

function isSimplePathWithSegments(pattern: string): boolean {
  return !isWildCard(pattern) && pattern.indexOf("\\") < 0 && countSlashes(pattern, true) > 0;
}

function createNameMatcher(segment: string, dirOnly: boolean, lastSegment: boolean): IMatcher {
  // Check for ** pattern
  if (segment === "**" || segment === "/**") {
    return dirOnly && lastSegment ? WILD_ONLY_DIRECTORY : WILD_NO_DIRECTORY;
  }

  const state = checkWildCards(segment);
  switch (state) {
    case "LEADING_ASTERISK_ONLY":
      return new LeadingAsteriskMatcher(segment, dirOnly);
    case "TRAILING_ASTERISK_ONLY":
      return new TrailingAsteriskMatcher(segment, dirOnly);
    case "COMPLEX":
      return new WildCardMatcher(segment, dirOnly);
    default:
      return new NameMatcher(segment, dirOnly, true);
  }
}

/**
 * Create matchers from path segments.
 */
function createMatchers(segments: string[], dirOnly: boolean): IMatcher[] {
  const matchers: IMatcher[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const matcher = createNameMatcher(segment, dirOnly, i === segments.length - 1);

    if (i > 0) {
      const last = matchers[matchers.length - 1];
      if (last instanceof WildMatcher && matcher instanceof WildMatcher) {
        // Collapse wildmatchers: **/** is same as **
        matchers.pop();
      }
    }
    matchers.push(matcher);
  }
  return matchers;
}

/**
 * Path matcher that handles multi-segment patterns.
 */
class PathMatcherImpl implements IMatcher {
  private readonly pattern: string;
  private readonly dirOnly: boolean;
  private readonly matchers: IMatcher[] | null;
  private readonly beginning: boolean;

  constructor(pattern: string, dirOnly: boolean) {
    this.pattern = pattern;
    this.dirOnly = dirOnly;
    this.beginning = pattern.indexOf(PATH_SEPARATOR) === 0;

    if (isSimplePathWithSegments(pattern)) {
      this.matchers = null;
    } else {
      this.matchers = createMatchers(splitPath(pattern), dirOnly);
    }
  }

  matches(_path: string, _startIncl: number, _endExcl: number): boolean {
    throw new Error("Path matcher works only on entire paths");
  }

  matchesPath(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    if (this.matchers === null) {
      return this.simpleMatch(path, assumeDirectory, pathMatch);
    }
    return this.iterate(path, 0, path.length, assumeDirectory, pathMatch);
  }

  private simpleMatch(path: string, assumeDirectory: boolean, pathMatch: boolean): boolean {
    let p = path;
    const hasSlash = p.indexOf(PATH_SEPARATOR) === 0;
    if (this.beginning && !hasSlash) {
      p = PATH_SEPARATOR + p;
    }
    if (!this.beginning && hasSlash) {
      p = p.substring(1);
    }

    if (p === this.pattern) {
      return !this.dirOnly || assumeDirectory;
    }

    const prefix = this.pattern + PATH_SEPARATOR;
    if (pathMatch) {
      return p === prefix && (!this.dirOnly || assumeDirectory);
    }
    return p.startsWith(prefix);
  }

  private iterate(
    path: string,
    startIncl: number,
    endExcl: number,
    assumeDirectory: boolean,
    pathMatch: boolean,
  ): boolean {
    const matchers = this.matchers;
    if (!matchers) {
      return false;
    }
    let matcher = 0;
    let right = startIncl;
    let match = false;
    let lastWildmatch = -1;
    let wildmatchBacktrackPos = -1;

    while (true) {
      const left = right;
      right = path.indexOf(PATH_SEPARATOR, right);

      if (right === -1) {
        if (left < endExcl) {
          match = this.matchSegment(matcher, path, left, endExcl, assumeDirectory, pathMatch);
        } else {
          match = match && !(matchers[matcher] instanceof WildMatcher);
        }

        if (match) {
          if (matcher < matchers.length - 1 && matchers[matcher] instanceof WildMatcher) {
            matcher++;
            match = this.matchSegment(matcher, path, left, endExcl, assumeDirectory, pathMatch);
          } else if (this.dirOnly && !assumeDirectory) {
            return false;
          }
        }
        return match && matcher + 1 === matchers.length;
      }

      if (wildmatchBacktrackPos < 0) {
        wildmatchBacktrackPos = right;
      }

      if (right - left > 0) {
        match = this.matchSegment(matcher, path, left, right, assumeDirectory, pathMatch);
      } else {
        right++;
        continue;
      }

      if (match) {
        const wasWild = matchers[matcher] instanceof WildMatcher;
        if (wasWild) {
          lastWildmatch = matcher;
          wildmatchBacktrackPos = -1;
          right = left - 1;
        }
        matcher++;

        if (matcher === matchers.length) {
          if (!pathMatch) {
            return true;
          }
          if (right === endExcl - 1) {
            return !this.dirOnly || assumeDirectory;
          }
          if (wasWild) {
            return true;
          }
          if (lastWildmatch >= 0) {
            matcher = lastWildmatch + 1;
            right = wildmatchBacktrackPos;
            wildmatchBacktrackPos = -1;
          } else {
            return false;
          }
        }
      } else if (lastWildmatch !== -1) {
        matcher = lastWildmatch + 1;
        right = wildmatchBacktrackPos;
        wildmatchBacktrackPos = -1;
      } else {
        return false;
      }
      right++;
    }
  }

  private matchSegment(
    matcherIdx: number,
    path: string,
    startIncl: number,
    endExcl: number,
    assumeDirectory: boolean,
    pathMatch: boolean,
  ): boolean {
    const m = this.matchers?.[matcherIdx];
    if (!m) {
      return false;
    }
    const matches = m.matches(path, startIncl, endExcl);

    if (
      !matches ||
      !pathMatch ||
      !this.matchers ||
      matcherIdx < this.matchers.length - 1 ||
      !(m instanceof WildMatcher)
    ) {
      return matches;
    }

    return assumeDirectory || !m.dirOnly;
  }
}

/**
 * Create a path matcher from a pattern.
 */
function createPathMatcher(pattern: string, dirOnly: boolean): IMatcher {
  pattern = trimPattern(pattern);

  // Check if pattern has multiple segments
  const slashIdx = pattern.indexOf(PATH_SEPARATOR, 1);
  if (slashIdx > 0 && slashIdx < pattern.length - 1) {
    return new PathMatcherImpl(pattern, dirOnly);
  }

  return createNameMatcher(pattern, dirOnly, true);
}
