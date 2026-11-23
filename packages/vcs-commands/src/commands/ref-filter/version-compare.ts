/**
 * git's versioncmp.c: the order `--sort=version:refname` (`v:`) and `tag.sort=version:...`
 * give names, digits compared as numbers, with `versionsort.suffix` pre-release suffixes
 * sorted before the release they precede.
 *
 * @example
 * ```typescript
 * versionCompare("foo1.6", "foo1.10"); // < 0
 * versionCompare("v1.0-rc1", "v1.0", ["-rc"]); // < 0: "-rc" sorts before the release
 * ```
 *
 * @module
 */

import { encodeGitPath } from "@statewalker/vcs-utils";

const S_N = 0x0;
const S_I = 0x3;
const S_F = 0x6;
const S_Z = 0x9;
const CMP = 2;
const LEN = 3;

// state    x    d    0
const NEXT_STATE = [
  /* S_N */ S_N,
  S_I,
  S_Z,
  /* S_I */ S_N,
  S_I,
  S_I,
  /* S_F */ S_N,
  S_F,
  S_F,
  /* S_Z */ S_N,
  S_F,
  S_Z,
];

// state   x/x  x/d  x/0  d/x  d/d  d/0  0/x  0/d  0/0
const RESULT_TYPE = [
  /* S_N */ CMP,
  CMP,
  CMP,
  CMP,
  LEN,
  CMP,
  CMP,
  CMP,
  CMP,
  /* S_I */ CMP,
  -1,
  -1,
  +1,
  LEN,
  LEN,
  +1,
  LEN,
  LEN,
  /* S_F */ CMP,
  CMP,
  CMP,
  CMP,
  CMP,
  CMP,
  CMP,
  CMP,
  CMP,
  /* S_Z */ CMP,
  +1,
  +1,
  -1,
  CMP,
  CMP,
  -1,
  CMP,
  CMP,
];

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const cls = (c: number) => (c === 0x30 ? 1 : 0) + (isDigit(c) ? 1 : 0);

function startsWithAt(s: Uint8Array, at: number, suffix: Uint8Array): boolean {
  if (at < 0 || at + suffix.length > s.length) return false;
  for (let i = 0; i < suffix.length; i++) if (s[at + i] !== suffix[i]) return false;
  return true;
}

interface SuffixMatch {
  confPos: number;
  start: number;
  len: number;
}

function findBetterMatchingSuffix(
  name: Uint8Array,
  suffix: Uint8Array,
  start: number,
  confPos: number,
  match: SuffixMatch,
): void {
  // a better match either starts earlier or starts at the same offset but is longer
  const end = match.len < suffix.length ? match.start : match.start - 1;
  for (let i = start; i <= end; i++) {
    if (startsWithAt(name, i, suffix)) {
      match.confPos = confPos;
      match.start = i;
      match.len = suffix.length;
      break;
    }
  }
}

function swapPrereleases(
  s1: Uint8Array,
  s2: Uint8Array,
  off: number,
  suffixes: readonly Uint8Array[],
): number | undefined {
  const m1: SuffixMatch = { confPos: -1, start: off, len: -1 };
  const m2: SuffixMatch = { confPos: -1, start: off, len: -1 };
  suffixes.forEach((suffix, i) => {
    const start = suffix.length < off ? off - suffix.length : 0;
    findBetterMatchingSuffix(s1, suffix, start, i, m1);
    findBetterMatchingSuffix(s2, suffix, start, i, m2);
  });
  if (m1.confPos === -1 && m2.confPos === -1) return undefined;
  // the same suffix in both ("-rc" in "v1.0-rcX" and "v1.0-rcY"): X and Y decide
  if (m1.confPos === m2.confPos) return undefined;
  if (m1.confPos >= 0 && m2.confPos >= 0) return m1.confPos - m2.confPos;
  return m1.confPos >= 0 ? -1 : 1;
}

/**
 * versioncmp.c's versioncmp: negative, zero or positive as `a` sorts before, with or after
 * `b`. `suffixes` are `versionsort.suffix` (or the older `versionsort.prereleaseSuffix`) in
 * configuration order.
 */
export function versionCompare(a: string, b: string, suffixes: readonly string[] = []): number {
  if (a === b) return 0;
  const s1 = encodeGitPath(a);
  const s2 = encodeGitPath(b);
  // C strings: a NUL past the end
  const at = (s: Uint8Array, i: number) => (i < s.length ? (s[i] as number) : 0);
  let i = 0;
  let c1 = at(s1, i);
  let c2 = at(s2, i);
  i++;
  let state = S_N + cls(c1);
  let diff = c1 - c2;
  while (diff === 0) {
    if (c1 === 0) return diff;
    state = NEXT_STATE[state] as number;
    c1 = at(s1, i);
    c2 = at(s2, i);
    i++;
    state += cls(c1);
    diff = c1 - c2;
  }
  if (suffixes.length > 0) {
    const swapped = swapPrereleases(s1, s2, i - 1, suffixes.map(encodeGitPath));
    if (swapped !== undefined) return swapped;
  }
  const result = RESULT_TYPE[state * 3 + cls(c2)] as number;
  switch (result) {
    case CMP:
      return diff;
    case LEN: {
      let p1 = i;
      let p2 = i;
      while (isDigit(at(s1, p1++))) if (!isDigit(at(s2, p2++))) return 1;
      return isDigit(at(s2, p2)) ? -1 : diff;
    }
    default:
      return result;
  }
}
