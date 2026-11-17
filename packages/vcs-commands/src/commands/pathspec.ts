/**
 * git's pathspecs: parsing (pathspec.c), matching a path (dir.c `match_pathspec_item`, for the
 * worktree scans) and matching tree entries (tree-walk.c `tree_entry_interesting`, for the
 * pruned tree diffs of `git log -- <pathspec>`).
 */

import { decodeGitPath, encodeGitPath, foldAsciiCase } from "@statewalker/vcs-utils/encoding";
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
  /**
   * `match` holds the path's bytes, one character each (see {@link treePathspec}); its
   * lengths count bytes, and names are matched as their bytes ({@link pathspecName})
   */
  bytes?: boolean;
  /**
   * `:(prefix:N)`: the first N bytes of the path are a literal prefix (git's `item->prefix`,
   * set when a pathspec is handed to another command); `match` is then taken as written,
   * not normalised, and held as bytes (`bytes`), so N may end inside a character as in git.
   */
  prefix?: number;
  /** `:(attr:...)`: the attributes a matching path must have (only where a caller allows it) */
  attr?: AttrMatch[];
}

/** One requirement of `:(attr:<spec>)` (git's `struct attr_match`). */
export interface AttrMatch {
  name: string;
  /** `name`: set; `-name`: unset; `!name`: unspecified; `name=value`: that value */
  mode: "set" | "unset" | "unspecified" | "value";
  value?: string;
}

/** What {@link parsePathspecItem} accepts besides git's plain magic. */
export interface PathspecParseOptions {
  /**
   * Accept `:(attr:...)` (git's PATHSPEC_ATTR, for commands that match attributes); without
   * it the magic is refused as unsupported.
   */
  attr?: boolean;
}

/** git's `strcspn_escaped`: characters from `from` up to one of `stop`, backslash escapes skipped. */
function strcspnEscaped(s: string, from: number, stop: string): number {
  let i = from;
  for (; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (stop.includes(s[i] as string)) break;
  }
  return i - from;
}

/** git's `attr_name_valid`: [-._0-9A-Za-z], not starting with "-". */
const validAttrName = (name: string) => /^[A-Za-z0-9._][-A-Za-z0-9._]*$/.test(name);

/** git's `parse_pathspec_attr_match` of the body of `attr:` (one element's). */
function parseAttrSpec(body: string, elem: string): AttrMatch[] {
  if (body === "") throw new Error("attr spec must not be empty");
  const out: AttrMatch[] = [];
  for (const word of body.split(" ")) {
    if (word === "") continue;
    let match: AttrMatch;
    if (word.startsWith("!")) match = { name: word.slice(1), mode: "unspecified" };
    else if (word.startsWith("-")) match = { name: word.slice(1), mode: "unset" };
    else {
      const eq = word.indexOf("=");
      if (eq < 0) match = { name: word, mode: "set" };
      else
        match = {
          name: word.slice(0, eq),
          mode: "value",
          value: unescapeAttrValue(word.slice(eq + 1)),
        };
    }
    if (!validAttrName(match.name)) throw new Error(`invalid attribute name ${match.name}`);
    out.push(match);
  }
  if (out.length === 0) throw new Error(`attr spec must not be empty in '${elem}'`);
  return out;
}

/** git's `attr_value_unescape`: backslashes removed; only [A-Za-z0-9,-_] may be matched. */
function unescapeAttrValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    let ch = value[i] as string;
    if (ch === "\\") {
      if (i + 1 >= value.length)
        throw new Error("Escape character '\\' not allowed as last character in attr value");
      ch = value[++i] as string;
    }
    if (!/[A-Za-z0-9,\-_]/.test(ch)) throw new Error(`cannot use '${ch}' for value matching`);
    out += ch;
  }
  return out;
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
  const items = paths.map((p) => parsePathspecItem(p));
  if (items.length > 0 && items.every((i) => i.exclude)) {
    items.push(parsePathspecItem("."));
  }
  return items;
}

export function parsePathspecItem(elem: string, options: PathspecParseOptions = {}): PathspecItem {
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
  let prefix = -1;
  let attr: AttrMatch[] | undefined;
  let rest = elem;
  if (elem.startsWith(":(")) {
    // git's parse_long_magic: words up to "," or ")", backslash escapes skipped (attr values)
    let pos = 2;
    while (pos < elem.length && elem[pos] !== ")") {
      const len = strcspnEscaped(elem, pos, ",)");
      const next = elem[pos + len] === "," ? pos + len + 1 : pos + len;
      const word = elem.slice(pos, pos + len);
      pos = next;
      if (word.startsWith("prefix:")) {
        prefix = parsePrefixMagic(word.slice(7));
        continue;
      }
      if (word.startsWith("attr:")) {
        if (!options.attr) throw new Error(`Unsupported pathspec magic 'attr' in '${elem}'`);
        if (attr) throw new Error("Only one 'attr:' specification is allowed.");
        attr = parseAttrSpec(word.slice(5), elem);
        continue;
      }
      const name = word.trim();
      if (name === "" || name === "top") continue;
      if (name === "literal") literal = true;
      else if (name === "glob") glob = true;
      else if (name === "icase") icase = true;
      else if (name === "exclude") exclude = true;
      else if (name === "attr") {
        // the magic without a spec: nothing to match
        if (!options.attr) throw new Error(`Unsupported pathspec magic 'attr' in '${elem}'`);
      } else throw new Error(`Invalid pathspec magic '${name}' in '${elem}'`);
    }
    if (elem[pos] !== ")") throw new Error(`Missing ')' at the end of pathspec magic in '${elem}'`);
    rest = elem.slice(pos + 1);
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
  // with prefix magic the path is taken as written (git's init_pathspec_item), and its
  // lengths are bytes: the prefix may end inside a character
  const match = prefix >= 0 ? byteString(rest) : normalizePathspecPath(rest, elem);
  if (prefix > match.length) throw new Error(`error initializing pathspec_item '${elem}'`);
  let nowildcardLen = match.length;
  if (!literal) {
    nowildcardLen = 0;
    while (nowildcardLen < match.length && !isGlobSpecial(match[nowildcardLen])) nowildcardLen++;
    if (nowildcardLen < prefix) nowildcardLen = prefix;
  }
  const after = match.slice(nowildcardLen + 1);
  const oneStar =
    !glob &&
    nowildcardLen < match.length &&
    match[nowildcardLen] === "*" &&
    ![...after].some((c) => isGlobSpecial(c));
  return {
    match,
    nowildcardLen,
    oneStar,
    exclude,
    glob,
    icase,
    ...(prefix >= 0 ? { prefix, bytes: true } : {}),
    ...(attr ? { attr } : {}),
  };
}

/**
 * git's `strtol(pos + 7, &endptr, 10)` of `prefix:<n>`, which must use up the word: leading
 * blanks and a sign allowed, no digits at all read as 0 (only for an empty number), the value
 * clamped to a `long` and kept as an `int`. A negative prefix is no prefix magic.
 */
function parsePrefixMagic(text: string): number {
  if (text === "") return 0;
  if (!/^[ \t\n\v\f\r]*[-+]?\d+$/.test(text))
    throw new Error("invalid parameter for pathspec magic 'prefix'");
  let n = BigInt(text.trim());
  const LONG_MAX = (1n << 63n) - 1n;
  if (n > LONG_MAX) n = LONG_MAX;
  else if (n < -LONG_MAX - 1n) n = -LONG_MAX - 1n;
  return Number(BigInt.asIntN(32, n));
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
  const options = { pathname: item.glob, casefold: item.icase };
  if (item.bytes) return wildmatchBytes(latin1Bytes(pattern), latin1Bytes(string), options);
  return wildmatch(pattern, string, options);
}

/**
 * A path as an element matches it: as it is, or as its bytes (one character each) for an
 * element held as bytes (`:(prefix:N)`).
 */
export const pathspecName = (item: PathspecItem, name: string) =>
  item.bytes ? byteString(name) : name;

/** git's `match_pathspec_item`. */
function matchPathspecItem(item: PathspecItem, path: string, flags: number): number {
  const { match } = item;
  const name = pathspecName(item, path);
  const matchlen = match.length;
  const namelen = name.length;
  // the prefix of `:(prefix:N)` (bytes) compares exactly, even under icase (dir.c)
  if (item.prefix && item.icase && name.slice(0, item.prefix) !== match.slice(0, item.prefix))
    return 0;
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
 * `treeEntryInteresting` cannot tell yet: an `:(attr)` element needs the attributes of the
 * path in `TreePathspec.attributes.pending`. Load them (`values`) and ask again.
 */
export const NEED_ATTRIBUTES = -3;
/** `doMatch`: the element does not match after all (its attributes differ); try the next */
const NEXT_ELEMENT = -4;

/** An attribute's value as the attributes resolver gives it (git's ATTR_TRUE/FALSE/UNSET or a string). */
export type PathspecAttributeValue = true | false | string | undefined;

/**
 * A pathspec element prepared for raw tree entries: its path as UTF-8 bytes, compared with the
 * bytes of entry names where they lie in the tree (no name is decoded).
 */
export interface TreePathspecElement {
  /** The path's bytes */
  match: Uint8Array;
  /** The length in bytes of its leading literal part */
  nowildcardLen: number;
  oneStar: boolean;
  exclude: boolean;
  glob: boolean;
  icase: boolean;
  /** The pattern after its literal part (what wildmatch matches after the prefix) */
  tail: Uint8Array;
  /** wildmatch's options for the element */
  wildmatch: { pathname: boolean; casefold: boolean };
  /** `:(attr:...)` requirements */
  attr: AttrMatch[] | undefined;
  /** `:(prefix:N)`: its first N bytes compare case-sensitively even under icase (0: none) */
  prefix: number;
}

/**
 * A pathspec prepared for tree entries: its elements with their paths as bytes, so names
 * compare as git's `strncmp` compares them.
 */
export interface TreePathspec {
  /** The elements, their paths one character per byte (for the Bloom keys) */
  items: PathspecItem[];
  /** The elements, their paths as bytes (for `treeEntryInteresting`) */
  elements: TreePathspecElement[];
  /** Some element has a wildcard (git's `has_wildcard`) */
  hasWildcard: boolean;
  /** Some element excludes (`PATHSPEC_EXCLUDE` in the pathspec's magic) */
  hasExclude: boolean;
  /**
   * With `:(attr)` elements: the attributes they name, the values read so far by path, and
   * the path `treeEntryInteresting` asks for when it returns `NEED_ATTRIBUTES`.
   */
  attributes?: {
    names: string[];
    values: Map<string, Map<string, PathspecAttributeValue>>;
    pending?: string;
  };
}

/** The elements as `tree_entry_interesting` matches them. */
export function treePathspec(items: PathspecItem[]): TreePathspec {
  const byteItems = items.map((item) =>
    item.bytes
      ? item
      : {
          ...item,
          match: byteString(item.match),
          nowildcardLen: byteString(item.match.slice(0, item.nowildcardLen)).length,
          bytes: true,
        },
  );
  const elements = items.map((item): TreePathspecElement => {
    const match = item.bytes ? latin1Bytes(item.match) : encodeGitPath(item.match);
    const nowildcardLen = item.bytes
      ? item.nowildcardLen
      : encodeGitPath(item.match.slice(0, item.nowildcardLen)).length;
    return {
      match,
      nowildcardLen,
      oneStar: item.oneStar,
      exclude: item.exclude,
      glob: item.glob,
      icase: item.icase,
      tail: match.subarray(nowildcardLen),
      wildmatch: { pathname: item.glob, casefold: item.icase },
      attr: item.attr,
      prefix: item.prefix && item.prefix > 0 ? item.prefix : 0,
    };
  });
  const names = [...new Set(items.flatMap((i) => (i.attr ?? []).map((a) => a.name)))];
  return {
    items: byteItems,
    elements,
    hasWildcard: elements.some((e) => e.nowildcardLen < e.match.length),
    hasExclude: elements.some((e) => e.exclude),
    ...(items.some((i) => i.attr) ? { attributes: { names, values: new Map() } } : {}),
  };
}

/**
 * git's `interesting:` label of `do_match`: an element with attributes matches a file only if
 * the file has them (`match_pathspec_attrs`); every directory is interesting then.
 */
function interesting(ps: TreePathspec, el: TreePathspecElement, mode: number, result: number) {
  if (!el.attr) return result;
  never = ENTRY_NOT_INTERESTING;
  if (isDirMode(mode)) return ENTRY_INTERESTING;
  // the path as the worktree names it: bytes that are no UTF-8 kept apart (surrogateescape)
  const path = decodeGitPath(baseBytes) + decodeGitPath(nameBytes.subarray(nameStart, nameEnd));
  const attributes = ps.attributes as NonNullable<TreePathspec["attributes"]>;
  const values = attributes.values.get(path);
  if (!values) {
    attributes.pending = path;
    return NEED_ATTRIBUTES;
  }
  for (const a of el.attr) {
    const v = values.get(a.name);
    const ok =
      v === true
        ? a.mode === "set"
        : v === false
          ? a.mode === "unset"
          : v === undefined
            ? a.mode === "unspecified"
            : a.mode === "value" && a.value === v;
    if (!ok) return NEXT_ELEMENT;
  }
  return ENTRY_INTERESTING;
}

/** A path's git bytes (`encodeGitPath`: escaped bytes as they were), one character each. */
export function byteString(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast path
  if (/^[\x00-\x7f]*$/.test(s)) return s;
  return latin1String(encodeGitPath(s));
}

/** A string of one character per byte as its bytes. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Bytes as a string of one character per byte. */
export function latin1String(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

const isDirMode = (mode: number) => (mode & 0o170000) === 0o040000;
const isGitlinkMode = (mode: number) => (mode & 0o170000) === 0o160000;
const lowerByte = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 32 : c);

/**
 * C's `strncmp` (or `strncasecmp` with `icase`: ASCII letters folded, as git's `ps_strncmp`)
 * of `a[aFrom, aEnd)` and `b[bFrom, bEnd)` over at most `n` bytes, each read as NUL past its
 * end: a sign.
 */
function strncmpBytes(
  a: Uint8Array,
  aFrom: number,
  aEnd: number,
  b: Uint8Array,
  bFrom: number,
  bEnd: number,
  n: number,
  icase: boolean,
): number {
  for (let i = 0; i < n; i++) {
    let ca = aFrom + i < aEnd ? (a[aFrom + i] as number) : 0;
    let cb = bFrom + i < bEnd ? (b[bFrom + i] as number) : 0;
    if (icase) {
      ca = lowerByte(ca);
      cb = lowerByte(cb);
    }
    if (ca !== cb) return ca - cb;
    if (ca === 0) return 0;
  }
  return 0;
}

/**
 * The name of the entry being matched (in its tree's bytes) and its base, set by
 * `treeEntryInteresting` for the functions below (matching is synchronous).
 */
let nameBytes: Uint8Array = new Uint8Array(0);
let nameStart = 0;
let nameEnd = 0;
let baseBytes: Uint8Array = new Uint8Array(0);
/** git's `never_interesting` of the `do_match` running */
let never = ENTRY_NOT_INTERESTING;
/** base + name, for the wildcard matches of whole paths (grown as needed) */
let joined = new Uint8Array(256);

/**
 * git's `match_entry`: the element (its part from `from` on, below the base) names the entry
 * or lies below it.
 */
function matchEntry(el: TreePathspecElement, from: number, mode: number): boolean {
  const match = el.match;
  const pathlen = nameEnd - nameStart;
  const matchlen = match.length - from;
  let m: number | undefined;
  if (el.icase) {
    never = ENTRY_NOT_INTERESTING;
  } else if (never !== ENTRY_NOT_INTERESTING) {
    m = strncmpBytes(
      match,
      from,
      match.length,
      nameBytes,
      nameStart,
      nameEnd,
      matchlen < pathlen ? matchlen : pathlen,
      false,
    );
    if (m < 0) return false;
    never = ENTRY_NOT_INTERESTING;
  }
  if (pathlen > matchlen) return false;
  if (matchlen > pathlen) {
    if (match[from + pathlen] !== 0x2f) return false;
    if (!isDirMode(mode) && (!isGitlinkMode(mode) || matchlen > pathlen + 1)) return false;
  }
  if (m === undefined)
    m = strncmpBytes(match, from, match.length, nameBytes, nameStart, nameEnd, pathlen, el.icase);
  return m === 0;
}

/**
 * git's `basecmp`: `strncmp`, or under icase the first `item->prefix` bytes exactly and the
 * rest case-insensitively.
 */
function basecmp(el: TreePathspecElement, len: number): number {
  const baseEnd = baseBytes.length;
  const matchEnd = el.match.length;
  if (el.icase && el.prefix > 0) {
    const n = len > el.prefix ? el.prefix : len;
    const r = strncmpBytes(baseBytes, 0, baseEnd, el.match, 0, matchEnd, n, false);
    if (r) return r;
    return strncmpBytes(baseBytes, n, baseEnd, el.match, n, matchEnd, len - n, true);
  }
  return strncmpBytes(baseBytes, 0, baseEnd, el.match, 0, matchEnd, len, el.icase);
}

/** git's `match_dir_prefix`: the base lies at or below the element. */
function matchDirPrefix(el: TreePathspecElement, matchlen: number): boolean {
  if (basecmp(el, matchlen)) return false;
  return (
    matchlen === 0 ||
    (matchlen < baseBytes.length && baseBytes[matchlen] === 0x2f) ||
    el.match[matchlen - 1] === 0x2f
  );
}

/** git's `match_wildcard_base`: the base agrees with the element's literal part. */
function matchWildcardBase(el: TreePathspecElement): boolean {
  const matchlen = el.nowildcardLen;
  const baselen = baseBytes.length;
  if (baselen) {
    if (baselen >= matchlen) return !basecmp(el, matchlen);
    if (basecmp(el, baselen)) return false;
  }
  return true;
}

/**
 * git's `git_fnmatch` of the element's pattern from `from` on and `text[tFrom, tEnd)`, the
 * first `prefix` bytes compared literally.
 */
function fnmatchBytes(
  el: TreePathspecElement,
  from: number,
  text: Uint8Array,
  tFrom: number,
  tEnd: number,
  prefix: number,
): boolean {
  const pattern = el.match;
  if (prefix > 0) {
    if (tEnd - tFrom < prefix) return false;
    for (let i = 0; i < prefix; i++) {
      let a = text[tFrom + i] as number;
      let b = pattern[from + i] as number;
      if (el.icase) {
        a = lowerByte(a);
        b = lowerByte(b);
      }
      if (a !== b) return false;
    }
    from += prefix;
    tFrom += prefix;
  }
  if (el.oneStar) {
    // the tail after the "*" ends the text
    const tail = pattern.length - from - 1;
    if (tEnd - tFrom < tail) return false;
    for (let i = 0; i < tail; i++) {
      let a = text[tEnd - tail + i] as number;
      let b = pattern[from + 1 + i] as number;
      if (el.icase) {
        a = lowerByte(a);
        b = lowerByte(b);
      }
      if (a !== b) return false;
    }
    return true;
  }
  // the pattern after the literal prefix is the element's tail (kept): only the text is a view
  const rest = from === el.nowildcardLen ? el.tail : pattern.subarray(from);
  return wildmatchBytes(rest, text.subarray(tFrom, tEnd), el.wildmatch);
}

/** git's `do_match` (recursive, no depth limit, no attributes) over one kind of element. */
function doMatch(ps: TreePathspec, mode: number, exclude: boolean): number {
  never = ps.hasWildcard ? ENTRY_NOT_INTERESTING : ALL_ENTRIES_NOT_INTERESTING;
  const baselen = baseBytes.length;
  const isDir = isDirMode(mode);
  const elements = ps.elements;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i] as TreePathspecElement;
    if (el.exclude !== exclude) continue;
    const matchlen = el.match.length;
    if (baselen >= matchlen) {
      if (matchDirPrefix(el, matchlen)) {
        const r = interesting(ps, el, mode, ALL_ENTRIES_INTERESTING);
        if (r !== NEXT_ELEMENT) return r;
        continue;
      }
    } else if (baselen === 0 || !basecmp(el, baselen)) {
      if (matchEntry(el, baselen, mode)) {
        const r = interesting(ps, el, mode, ENTRY_INTERESTING);
        if (r !== NEXT_ELEMENT) return r;
        continue;
      }
      if (el.nowildcardLen < matchlen) {
        if (fnmatchBytes(el, baselen, nameBytes, nameStart, nameEnd, el.nowildcardLen - baselen)) {
          const r = interesting(ps, el, mode, ENTRY_INTERESTING);
          if (r !== NEXT_ELEMENT) return r;
          continue;
        }
        // all directories match: their files are matched later
        if (isDir) return ENTRY_INTERESTING;
      }
      continue;
    }
    // match_wildcards: the whole path (base and name) against the whole element
    if (el.nowildcardLen === matchlen) continue;
    if (el.nowildcardLen && !matchWildcardBase(el)) continue;
    const pathLength = baselen + nameEnd - nameStart;
    if (joined.length < pathLength)
      joined = new Uint8Array(Math.max(pathLength, 2 * joined.length));
    joined.set(baseBytes);
    joined.set(nameBytes.subarray(nameStart, nameEnd), baselen);
    if (fnmatchBytes(el, 0, joined, 0, pathLength, el.nowildcardLen)) {
      const r = interesting(ps, el, mode, ENTRY_INTERESTING);
      if (r !== NEXT_ELEMENT) return r;
      continue;
    }
    if (isDir) return ENTRY_INTERESTING;
  }
  return never;
}

/**
 * git's `tree_entry_interesting`: whether the entry whose name is `tree[start, end)` (the raw
 * bytes of its tree), of mode `mode`, under `base` (empty, or the bytes of a directory path
 * ending in "/") is in the pathspec. Nothing is decoded or allocated for the common entries.
 */
export function treeEntryInteresting(
  ps: TreePathspec,
  tree: Uint8Array,
  start: number,
  end: number,
  mode: number,
  base: Uint8Array,
): number {
  nameBytes = tree;
  nameStart = start;
  nameEnd = end;
  baseBytes = base;
  const positive = doMatch(ps, mode, false);
  if (!ps.hasExclude || positive <= ENTRY_NOT_INTERESTING) return positive;
  const negative = doMatch(ps, mode, true);
  if (negative === NEED_ATTRIBUTES) return NEED_ATTRIBUTES;
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
  const match = item.bytes ? item.match : byteString(item.match);
  let len = item.bytes
    ? item.nowildcardLen
    : byteString(item.match.slice(0, item.nowildcardLen)).length;
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
