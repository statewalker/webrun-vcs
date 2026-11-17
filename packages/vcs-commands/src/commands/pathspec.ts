/**
 * git's pathspecs: parsing (pathspec.c), matching a path (dir.c `match_pathspec_item`, for the
 * worktree scans) and matching tree entries (tree-walk.c `tree_entry_interesting`, for the
 * pruned tree diffs of `git log -- <pathspec>`).
 */

import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";
import { wildmatch, wildmatchBytes } from "@statewalker/vcs-working-tree";

export const MATCHED_RECURSIVELY = 1;
export const MATCHED_RECURSIVELY_LEADING_PATHSPEC = 2;
export const MATCHED_FNMATCH = 3;
export const MATCHED_EXACTLY = 4;
export const DO_MATCH_DIRECTORY = 1;
export const DO_MATCH_LEADING_PATHSPEC = 2;
export const DO_MATCH_EXCLUDE = 4;

/** One pathspec element as git's `init_pathspec_item` parses it. */
export interface PathspecItem {
  /** The path from the top of the worktree (normalised), without its magic */
  match: string;
  /** The length of its leading literal part (git's `nowildcard_len`) */
  nowildcardLen: number;
  /** `*` followed by no other wildcard after the literal prefix (git's ONESTAR) */
  oneStar: boolean;
  /** `:(exclude)` / `:!` / `:^`: a path it matches is left out */
  exclude: boolean;
  /** `:(glob)`: wildmatch with WM_PATHNAME (`*` stops at `/`, `**` spans directories) */
  glob: boolean;
  /** `:(icase)`: case-insensitive */
  icase: boolean;
  /** `match` holds the path's bytes, one character each (see {@link treePathspec}) */
  bytes?: boolean;
}

/** git's characters that may introduce short pathspec magic (`GIT_PATHSPEC_MAGIC`). */
const SHORT_MAGIC_CHARS = new Set([..."!\"#%&',-;<=>@_`~^/"]);

/**
 * The pathspec elements as git's `parse_pathspec` reads them from the top of the worktree:
 * short magic (`:/` top, `:!` and `:^` exclude) and long magic (`:(top,literal,glob,icase,
 * exclude)`), the path normalised as `prefix_path` does (`.`, `..`, repeated slashes; above
 * the top refused), and an implicit `.` when every element excludes.
 */
export function parsePathspec(paths: string[]): PathspecItem[] {
  const items = paths.map(parsePathspecItem);
  if (items.length > 0 && items.every((i) => i.exclude)) {
    items.push(parsePathspecItem("."));
  }
  return items;
}

export function parsePathspecItem(elem: string): PathspecItem {
  if (elem === "") {
    // git's parse_pathspec
    throw new Error(
      "empty string is not a valid pathspec. please use . instead if you meant to match all paths",
    );
  }
  let exclude = false;
  let literal = false;
  let glob = false;
  let icase = false;
  let rest = elem;
  if (elem.startsWith(":(")) {
    const end = elem.indexOf(")");
    if (end < 0) throw new Error(`Missing ')' at the end of pathspec magic in '${elem}'`);
    for (const raw of elem.slice(2, end).split(",")) {
      const name = raw.trim();
      if (name === "" || name === "top") continue;
      if (name === "literal") literal = true;
      else if (name === "glob") glob = true;
      else if (name === "icase") icase = true;
      else if (name === "exclude") exclude = true;
      else if (name.startsWith("attr:") || name === "attr") {
        throw new Error(`Unsupported pathspec magic 'attr' in '${elem}'`);
      } else throw new Error(`Invalid pathspec magic '${name}' in '${elem}'`);
    }
    rest = elem.slice(end + 1);
  } else if (elem.startsWith(":")) {
    let pos = 1;
    for (; pos < elem.length && elem[pos] !== ":"; pos++) {
      const ch = elem[pos];
      if (ch === "!" || ch === "^") exclude = true;
      else if (ch === "/") {
        // top: the paths are from the top already
      } else if (!SHORT_MAGIC_CHARS.has(ch)) break;
      else throw new Error(`Unimplemented pathspec magic '${ch}' in '${elem}'`);
    }
    if (elem[pos] === ":") pos++;
    rest = elem.slice(pos);
  }
  if (literal && glob) throw new Error("'literal' and 'glob' are incompatible");
  const match = normalizePathspecPath(rest, elem);
  let nowildcardLen = match.length;
  if (!literal) {
    nowildcardLen = 0;
    while (nowildcardLen < match.length && !isGlobSpecial(match[nowildcardLen])) nowildcardLen++;
  }
  const after = match.slice(nowildcardLen + 1);
  const oneStar =
    !glob &&
    nowildcardLen < match.length &&
    match[nowildcardLen] === "*" &&
    ![...after].some((c) => isGlobSpecial(c));
  return { match, nowildcardLen, oneStar, exclude, glob, icase };
}

const isGlobSpecial = (c: string) => c === "*" || c === "?" || c === "[" || c === "\\";

/** git's `normalize_path_copy` of a path from the top (trailing slash kept; "." is ""). */
function normalizePathspecPath(path: string, elem: string): string {
  const trailing = path.endsWith("/") && path.replace(/\/+$/, "") !== "";
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new Error(`'${elem}' is outside repository`);
      out.pop();
    } else out.push(part);
  }
  const joined = out.join("/");
  return joined && trailing ? `${joined}/` : joined;
}

/**
 * git's `ps_strncmp` / `ps_strcmp`: equal, case-insensitively for `:(icase)` (`strncasecmp`:
 * ASCII letters only, as git folds them).
 */
export const psEqual = (item: PathspecItem, a: string, b: string) =>
  item.icase ? foldAsciiCase(a) === foldAsciiCase(b) : a === b;

/** git's `git_fnmatch` of an element against a name. */
function pathspecFnmatch(item: PathspecItem, name: string): boolean {
  return gitFnmatch(item, item.match, name, item.nowildcardLen);
}

/**
 * git's `git_fnmatch`: whether `string` matches `pattern` (an element's pattern, or its tail),
 * the first `prefix` characters compared literally.
 */
function gitFnmatch(item: PathspecItem, pattern: string, string: string, prefix: number): boolean {
  if (prefix > 0) {
    if (!psEqual(item, string.slice(0, prefix), pattern.slice(0, prefix))) return false;
    pattern = pattern.slice(prefix);
    string = string.slice(prefix);
  }
  if (item.oneStar) {
    const tail = pattern.slice(1);
    return (
      string.length >= tail.length && psEqual(item, string.slice(string.length - tail.length), tail)
    );
  }
  if (item.bytes) {
    return wildmatchBytes(latin1Bytes(pattern), latin1Bytes(string), {
      pathname: item.glob,
      casefold: item.icase,
    });
  }
  return wildmatch(pattern, string, { pathname: item.glob, casefold: item.icase });
}

/** git's `match_pathspec_item`. */
function matchPathspecItem(item: PathspecItem, name: string, flags: number): number {
  const { match } = item;
  const matchlen = match.length;
  const namelen = name.length;
  if (matchlen === 0) return MATCHED_RECURSIVELY;
  if (matchlen <= namelen && psEqual(item, name.slice(0, matchlen), match)) {
    if (matchlen === namelen) return MATCHED_EXACTLY;
    if (match[matchlen - 1] === "/" || name[matchlen] === "/") return MATCHED_RECURSIVELY;
  } else if (
    flags & DO_MATCH_DIRECTORY &&
    match[matchlen - 1] === "/" &&
    namelen === matchlen - 1 &&
    psEqual(item, match.slice(0, namelen), name)
  ) {
    return MATCHED_EXACTLY;
  }
  if (item.nowildcardLen < matchlen && pathspecFnmatch(item, name)) return MATCHED_FNMATCH;
  if (flags & DO_MATCH_LEADING_PATHSPEC && !(flags & DO_MATCH_EXCLUDE)) {
    const offset = name.endsWith("/") ? 1 : 0;
    if (
      namelen < matchlen &&
      match[namelen - offset] === "/" &&
      psEqual(item, match.slice(0, namelen), name)
    ) {
      return MATCHED_RECURSIVELY_LEADING_PATHSPEC;
    }
    const n = item.nowildcardLen;
    if (n < matchlen && !psEqual(item, name.slice(0, n), match.slice(0, n))) return 0;
    if (n === matchlen) return 0;
    return MATCHED_RECURSIVELY_LEADING_PATHSPEC;
  }
  return 0;
}

/** git's `match_pathspec_with_flags`: the best positive match, unless an exclude matches. */
export function matchPathspec(items: PathspecItem[], name: string, flags: number): number {
  if (items.length === 0) return MATCHED_RECURSIVELY;
  let positive = 0;
  for (const item of items) {
    if (!item.exclude) positive = Math.max(positive, matchPathspecItem(item, name, flags));
  }
  if (!positive || !items.some((i) => i.exclude)) return positive;
  for (const item of items) {
    if (item.exclude && matchPathspecItem(item, name, flags | DO_MATCH_EXCLUDE)) return 0;
  }
  return positive;
}

// ============ tree entries (tree-walk.c tree_entry_interesting) ============

/** `tree_entry_interesting`: no later entry of this tree can match */
export const ALL_ENTRIES_NOT_INTERESTING = -1;
/** `tree_entry_interesting`: this entry does not match */
export const ENTRY_NOT_INTERESTING = 0;
/** `tree_entry_interesting`: this entry matches (a directory: some of it may) */
export const ENTRY_INTERESTING = 1;
/** `tree_entry_interesting`: this entry and everything below it matches */
export const ALL_ENTRIES_INTERESTING = 2;

/**
 * A pathspec prepared for tree entries: its elements with their paths as bytes (one
 * character per byte, as tree entry names are read), so names compare as git's `strncmp`.
 */
export interface TreePathspec {
  items: PathspecItem[];
  /** Some element has a wildcard (git's `has_wildcard`) */
  hasWildcard: boolean;
  /** Some element excludes (`PATHSPEC_EXCLUDE` in the pathspec's magic) */
  hasExclude: boolean;
}

/** The elements as `tree_entry_interesting` matches them. */
export function treePathspec(items: PathspecItem[]): TreePathspec {
  const byteItems = items.map((item) => ({
    ...item,
    match: utf8Latin1(item.match),
    nowildcardLen: utf8Latin1(item.match.slice(0, item.nowildcardLen)).length,
    bytes: true,
  }));
  return {
    items: byteItems,
    hasWildcard: byteItems.some((i) => i.nowildcardLen < i.match.length),
    hasExclude: byteItems.some((i) => i.exclude),
  };
}

const UTF8 = new TextEncoder();

/** A string's UTF-8 bytes, one character each. */
export function utf8Latin1(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast path
  if (/^[\x00-\x7f]*$/.test(s)) return s;
  return latin1String(UTF8.encode(s));
}

/** Bytes as a string of one character per byte. */
export function latin1String(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const isDirMode = (mode: number) => (mode & 0o170000) === 0o040000;
const isGitlinkMode = (mode: number) => (mode & 0o170000) === 0o160000;

/** C's `strncmp` of two strings over at most `n` characters (a sign). */
function strncmp(a: string, b: string, n: number): number {
  for (let i = 0; i < n; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    if (ca !== cb) return ca - cb;
    if (ca === 0) return 0;
  }
  return 0;
}

/** git's `ps_strncmp`: `strncasecmp` for `:(icase)` (ASCII letters folded). */
function psStrncmp(item: PathspecItem, a: string, b: string, n: number): number {
  if (!item.icase) return strncmp(a, b, n);
  return strncmp(foldAsciiCase(a.slice(0, n)), foldAsciiCase(b.slice(0, n)), n);
}

/** git's `basecmp` (the elements are from the top: no prefix). */
const basecmp = (item: PathspecItem, base: string, match: string, len: number) =>
  psStrncmp(item, base, match, len);

/** git's `match_entry`: the element (its part below the base) names the entry or lies below it. */
function matchEntry(
  item: PathspecItem,
  path: string,
  mode: number,
  match: string,
  never: { value: number },
): boolean {
  const pathlen = path.length;
  const matchlen = match.length;
  let m: number | undefined;
  if (item.icase) {
    never.value = ENTRY_NOT_INTERESTING;
  } else if (never.value !== ENTRY_NOT_INTERESTING) {
    m = strncmp(match, path, matchlen < pathlen ? matchlen : pathlen);
    if (m < 0) return false;
    never.value = ENTRY_NOT_INTERESTING;
  }
  if (pathlen > matchlen) return false;
  if (matchlen > pathlen) {
    if (match[pathlen] !== "/") return false;
    if (!isDirMode(mode) && (!isGitlinkMode(mode) || matchlen > pathlen + 1)) return false;
  }
  if (m === undefined) m = psStrncmp(item, match, path, pathlen);
  return m === 0;
}

/** git's `match_dir_prefix`: the base lies at or below the element. */
function matchDirPrefix(
  item: PathspecItem,
  base: string,
  match: string,
  matchlen: number,
): boolean {
  if (basecmp(item, base, match, matchlen)) return false;
  return matchlen === 0 || base[matchlen] === "/" || match[matchlen - 1] === "/";
}

/** git's `match_wildcard_base`: the base agrees with the element's literal part. */
function matchWildcardBase(item: PathspecItem, base: string): boolean {
  const matchlen = item.nowildcardLen;
  const baselen = base.length;
  if (baselen) {
    if (baselen >= matchlen) return !basecmp(item, base, item.match, matchlen);
    if (basecmp(item, base, item.match, baselen)) return false;
  }
  return true;
}

/** git's `do_match` (recursive, no depth limit, no attributes) over one kind of element. */
function doMatch(ps: TreePathspec, path: string, mode: number, base: string, exclude: boolean) {
  const never = { value: ps.hasWildcard ? ENTRY_NOT_INTERESTING : ALL_ENTRIES_NOT_INTERESTING };
  const baselen = base.length;
  const isDir = isDirMode(mode);
  for (let i = ps.items.length - 1; i >= 0; i--) {
    const item = ps.items[i] as PathspecItem;
    if (item.exclude !== exclude) continue;
    const match = item.match;
    const matchlen = match.length;
    if (baselen >= matchlen) {
      if (matchDirPrefix(item, base, match, matchlen)) return ALL_ENTRIES_INTERESTING;
    } else if (baselen === 0 || !basecmp(item, base, match, baselen)) {
      if (matchEntry(item, path, mode, match.slice(baselen), never)) return ENTRY_INTERESTING;
      if (item.nowildcardLen < matchlen) {
        if (gitFnmatch(item, match.slice(baselen), path, item.nowildcardLen - baselen)) {
          return ENTRY_INTERESTING;
        }
        // all directories match: their files are matched later
        if (isDir) return ENTRY_INTERESTING;
      }
      continue;
    }
    // match_wildcards
    if (item.nowildcardLen === matchlen) continue;
    if (item.nowildcardLen && !matchWildcardBase(item, base)) continue;
    if (gitFnmatch(item, match, base + path, item.nowildcardLen)) return ENTRY_INTERESTING;
    if (isDir) return ENTRY_INTERESTING;
  }
  return never.value;
}

/**
 * git's `tree_entry_interesting`: whether the entry `path` (a name, as bytes) of mode `mode`
 * under `base` ("" or a directory path ending in "/") is in the pathspec.
 */
export function treeEntryInteresting(
  ps: TreePathspec,
  path: string,
  mode: number,
  base: string,
): number {
  const positive = doMatch(ps, path, mode, base, false);
  if (!ps.hasExclude || positive <= ENTRY_NOT_INTERESTING) return positive;
  const negative = doMatch(ps, path, mode, base, true);
  if (positive === ALL_ENTRIES_INTERESTING && negative === ENTRY_NOT_INTERESTING) {
    return ENTRY_INTERESTING;
  }
  if (negative <= ENTRY_NOT_INTERESTING) return positive;
  if (isDirMode(mode) && positive >= ENTRY_INTERESTING && negative === ENTRY_INTERESTING) {
    return ENTRY_INTERESTING;
  }
  if (
    (positive === ENTRY_INTERESTING && negative >= ENTRY_INTERESTING) ||
    (positive === ALL_ENTRIES_INTERESTING && negative === ENTRY_INTERESTING)
  ) {
    return ENTRY_NOT_INTERESTING;
  }
  return ALL_ENTRIES_NOT_INTERESTING;
}

/**
 * The path a pathspec element gives the changed-path Bloom filters (git's
 * convert_pathspec_to_bloom_keyvec): its literal part up to the last "/" before a wildcard,
 * without a trailing "/"; undefined when that is empty (no filter can be used then).
 */
export function bloomPathOf(item: PathspecItem): string | undefined {
  const match = item.bytes ? item.match : utf8Latin1(item.match);
  let len = item.bytes
    ? item.nowildcardLen
    : utf8Latin1(item.match.slice(0, item.nowildcardLen)).length;
  if (len !== match.length) {
    while (len > 0 && match[len - 1] !== "/") len--;
  }
  if (len > 0 && match[len - 1] === "/") len--;
  return len > 0 ? match.slice(0, len) : undefined;
}

/**
 * git's `forbid_bloom_filters`: magic other than top, literal and glob (exclude, icase)
 * keeps the filters out of the walk.
 */
export const pathspecForbidsBloom = (items: PathspecItem[]) =>
  items.some((i) => i.exclude || i.icase);
