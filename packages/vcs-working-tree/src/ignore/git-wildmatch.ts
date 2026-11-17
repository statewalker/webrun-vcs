/**
 * git's wildmatch (`wildmatch.c`), byte for byte: the glob git matches ignore rules and
 * pathspecs with. `*` matches anything but `/` with `pathname` (and anything without it), a
 * `**` between slashes (or at either end) matches any number of directories, `?` one
 * character, `[...]` a class (`!` or `^` negates, ranges, `[:alpha:]` and the other POSIX
 * classes), and a backslash makes the next character literal.
 */

import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

const MATCH = 0;
const NOMATCH = 1;
const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;

const isGlobSpecial = (c: number) =>
  c === 0x2a /* * */ || c === 0x3f /* ? */ || c === 0x5b /* [ */ || c === 0x5c; /* \ */

const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => isUpper(c) || isLower(c);
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isPrint = (c: number) => c >= 0x20 && c < 0x7f;
const isGraph = (c: number) => c > 0x20 && c < 0x7f;
const isCntrl = (c: number) => c < 0x20 || c === 0x7f;
const isPunct = (c: number) => isGraph(c) && !isAlpha(c) && !isDigit(c);
const isXdigit = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const lower = (c: number) => (isUpper(c) ? c + 32 : c);

const CLASSES: Record<string, (c: number) => boolean> = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: isCntrl,
  digit: isDigit,
  graph: isGraph,
  lower: isLower,
  print: isPrint,
  punct: isPunct,
  space: isSpace,
  upper: isUpper,
  xdigit: isXdigit,
};

/** Options of {@link wildmatch}. */
export interface WildmatchOptions {
  /** `*` and `?` never match `/` (`WM_PATHNAME`) */
  pathname?: boolean;
  /** Case-insensitive (`WM_CASEFOLD`) */
  casefold?: boolean;
}

/**
 * Whether `text` matches the glob `pattern` as git's `wildmatch` decides.
 *
 * @example
 * ```typescript
 * wildmatch("a/**\/b", "a/x/y/b", { pathname: true }); // true
 * wildmatch("\\*.txt", "x.txt"); // false: only the literal "*.txt"
 * ```
 */
export function wildmatch(pattern: string, text: string, options: WildmatchOptions = {}): boolean {
  // a path is its bytes: a name that is no UTF-8 matches byte by byte, as in git
  return wildmatchBytes(encodeGitPath(pattern), encodeGitPath(text), options);
}

/** {@link wildmatch} of a pattern and a text given as their bytes (`encodeGitPath`). */
export function wildmatchBytes(
  pattern: Uint8Array,
  text: Uint8Array,
  options: WildmatchOptions = {},
): boolean {
  return (
    dowild(pattern, 0, text, 0, options.pathname === true, options.casefold === true) === MATCH
  );
}

/**
 * Whether `a` from `aStart` and `b` from `bStart` hold the same `n` bytes, ASCII case folded
 * with `casefold` (git's `fspathncmp` of a pattern's literal part and a path: bytes, so half
 * of a UTF-8 sequence compares as the byte it is).
 */
export function sameBytes(
  a: Uint8Array,
  aStart: number,
  b: Uint8Array,
  bStart: number,
  n: number,
  casefold = false,
): boolean {
  if (aStart + n > a.length || bStart + n > b.length) return false;
  for (let i = 0; i < n; i++) {
    let x = a[aStart + i];
    let y = b[bStart + i];
    if (casefold) {
      x = lower(x);
      y = lower(y);
    }
    if (x !== y) return false;
  }
  return true;
}

function dowild(
  p: Uint8Array,
  pi: number,
  t: Uint8Array,
  ti: number,
  pathname: boolean,
  casefold: boolean,
): number {
  const at = (a: Uint8Array, i: number) => (i < a.length ? a[i] : 0);
  for (; pi < p.length; ti++, pi++) {
    let pCh = p[pi];
    let tCh = at(t, ti);
    if (tCh === 0 && pCh !== 0x2a) return ABORT_ALL;
    if (casefold) {
      tCh = lower(tCh);
      pCh = lower(pCh);
    }
    switch (pCh) {
      case 0x5c: {
        // backslash: the next character literally
        pi++;
        // not folded, as in git's wildmatch.c (it folds the pattern character before the
        // switch, then reads the escaped one raw): under casefold `\\A` matches nothing
        pCh = at(p, pi);
        if (tCh !== pCh) return NOMATCH;
        continue;
      }
      case 0x3f:
        if (pathname && tCh === 0x2f) return NOMATCH;
        continue;
      case 0x2a: {
        let matchSlash: boolean;
        pi++;
        if (at(p, pi) === 0x2a) {
          // the char before the first star
          const prev = pi - 2;
          while (at(p, ++pi) === 0x2a) {}
          if (!pathname) matchSlash = true;
          else if (
            (prev < 0 || p[prev] === 0x2f) &&
            (pi >= p.length || p[pi] === 0x2f || (p[pi] === 0x5c && at(p, pi + 1) === 0x2f))
          ) {
            if (at(p, pi) === 0x2f && dowild(p, pi + 1, t, ti, pathname, casefold) === MATCH) {
              return MATCH;
            }
            matchSlash = true;
          } else matchSlash = false;
        } else matchSlash = !pathname;
        if (pi >= p.length) {
          // a trailing "**" matches everything, a trailing "*" what has no more slash
          if (!matchSlash && t.indexOf(0x2f, ti) >= 0) return ABORT_TO_STARSTAR;
          return MATCH;
        }
        if (!matchSlash && p[pi] === 0x2f) {
          // one star then a slash: the rest of this directory name
          const slash = t.indexOf(0x2f, ti);
          if (slash < 0) return ABORT_ALL;
          ti = slash;
          // the slash is consumed by the loop
          break;
        }
        for (;;) {
          if (tCh === 0) break;
          if (!isGlobSpecial(p[pi])) {
            let lit = p[pi];
            if (casefold) lit = lower(lit);
            for (;;) {
              tCh = at(t, ti);
              if (tCh === 0 || (!matchSlash && tCh === 0x2f)) break;
              if (casefold) tCh = lower(tCh);
              if (tCh === lit) break;
              ti++;
            }
            if (tCh !== lit) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
          }
          const matched = dowild(p, pi, t, ti, pathname, casefold);
          if (matched !== NOMATCH) {
            if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tCh === 0x2f) return ABORT_TO_STARSTAR;
          tCh = at(t, ++ti);
          if (casefold) tCh = lower(tCh);
        }
        return ABORT_ALL;
      }
      case 0x5b: {
        pi++;
        pCh = at(p, pi);
        if (pCh === 0x5e /* ^ */) pCh = 0x21;
        const negated = pCh === 0x21;
        if (negated) {
          pi++;
          pCh = at(p, pi);
        }
        let prevCh = 0;
        let matched = false;
        do {
          if (!pCh) return ABORT_ALL;
          if (pCh === 0x5c) {
            pi++;
            pCh = at(p, pi);
            if (!pCh) return ABORT_ALL;
            if (tCh === pCh) matched = true;
          } else if (pCh === 0x2d && prevCh && at(p, pi + 1) && at(p, pi + 1) !== 0x5d) {
            pi++;
            pCh = at(p, pi);
            if (pCh === 0x5c) {
              pi++;
              pCh = at(p, pi);
              if (!pCh) return ABORT_ALL;
            }
            if (tCh <= pCh && tCh >= prevCh) matched = true;
            else if (casefold && isLower(tCh)) {
              const upper = tCh - 32;
              if (upper <= pCh && upper >= prevCh) matched = true;
            }
            pCh = 0;
          } else if (pCh === 0x5b && at(p, pi + 1) === 0x3a /* : */) {
            pi += 2;
            const s = pi;
            while (at(p, pi) && at(p, pi) !== 0x5d) pi++;
            pCh = at(p, pi);
            if (!pCh) return ABORT_ALL;
            const len = pi - s - 1;
            if (len < 0 || p[pi - 1] !== 0x3a) {
              // no ":]": a plain "[" in the set
              pi = s - 2;
              pCh = 0x5b;
              if (tCh === pCh) matched = true;
            } else {
              const name = new TextDecoder().decode(p.subarray(s, s + len));
              const test = CLASSES[name];
              if (!test) return ABORT_ALL;
              if (test(tCh)) matched = true;
              else if (casefold && name === "upper" && isLower(tCh)) matched = true;
              pCh = 0;
            }
          } else if (tCh === pCh) matched = true;
          prevCh = pCh;
          pi++;
          pCh = at(p, pi);
        } while (pCh !== 0x5d);
        if (matched === negated || (pathname && tCh === 0x2f)) return NOMATCH;
        continue;
      }
      default:
        if (tCh !== pCh) return NOMATCH;
        continue;
    }
  }
  return ti < t.length ? NOMATCH : MATCH;
}
