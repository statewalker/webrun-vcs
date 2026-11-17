/**
 * The object checks of git's `fsck.c` (`fsck_tree`, `fsck_commit`, `fsck_tag`, `fsck_blob`),
 * ported byte for byte: the same conditions, in the same order, with the same message ids and
 * texts, and the same early returns (a commit or tag check stops at the first error that is
 * reported as an error; warnings and ignored messages let it go on).
 *
 * The parsers git uses to load objects for its object graph (`parse_commit_buffer`,
 * `parse_tag_buffer`, the tree walker of `tree-walk.c`) are here too: they accept and refuse
 * other inputs than the checks do, and fsck reports both.
 */

import {
  isDotGitComponent,
  isGitWorktreeFile,
  isNtfsGitWorktreeFile,
  isValidRefName,
} from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import type { FsckMessageTypes, FsckMsgId } from "./fsck-msg-ids.js";

/**
 * Reports one message for the object being checked; returns 1 when it was reported as an
 * error, 0 for a warning or an ignored message (git's `report`).
 */
export type FsckReport = (msgId: FsckMsgId, message: string) => number;

const NL = 0x0a;
const SP = 0x20;
const LT = 0x3c;
const GT = 0x3e;
const ZERO = 0x30;
const SLASH = 0x2f;
const NUL = 0;
const HEX = 40;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;

const dec = new TextDecoder();
const decKeepBom = new TextDecoder("utf-8", { ignoreBOM: true });
const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
const isHexDigit = (c: number | undefined) =>
  c !== undefined &&
  ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46));

/** Whether `buf` holds `prefix` at `at`. */
function startsWith(buf: Uint8Array, at: number, prefix: string): boolean {
  if (at + prefix.length > buf.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[at + i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/** git's `parse_oid_hex`: 40 hex digits (either case) at `at`; the end, or -1. */
function parseOidHex(buf: Uint8Array, at: number): number {
  for (let i = 0; i < HEX; i++) if (!isHexDigit(buf[at + i])) return -1;
  return at + HEX;
}

function indexOf(buf: Uint8Array, byte: number, from: number, end = buf.length): number {
  for (let i = from; i < end; i++) if (buf[i] === byte) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Commits and tags

/**
 * git's `verify_headers`: the headers end with "\n\n" or a final newline, and hold no NUL.
 * Returns the report's value (nonzero stops the check, whatever the severity).
 */
function verifyHeaders(buf: Uint8Array, report: FsckReport): { stop: boolean; value: number } {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NUL) {
      return {
        stop: true,
        value: report("nulInHeader", `unterminated header: NUL at offset ${i}`),
      };
    }
    if (buf[i] === NL && i + 1 < buf.length && buf[i + 1] === NL) return { stop: false, value: 0 };
  }
  if (buf.length > 0 && buf[buf.length - 1] === NL) return { stop: false, value: 0 };
  return { stop: true, value: report("unterminatedHeader", "unterminated header") };
}

/** 2^63: git's `date_overflows` for a 64-bit time_t. */
const TIME_LIMIT = 2n ** 63n;

/**
 * git's `fsck_ident`: an author, committer or tagger line from `p` (just after the keyword) to
 * its newline. Returns the report's value and where the next line starts.
 */
function fsckIdent(
  buf: Uint8Array,
  start: number,
  report: FsckReport,
): { value: number; next: number } {
  const end = buf.length;
  const nl = indexOf(buf, NL, start);
  const next = nl < 0 ? end : nl + 1;
  let p = start;
  const r = (id: FsckMsgId, text: string) => ({ value: report(id, text), next });
  if (buf[p] === LT) {
    return r(
      "missingNameBeforeEmail",
      "invalid author/committer line - missing space before email",
    );
  }
  for (;;) {
    if (p >= end || buf[p] === NL)
      return r("missingEmail", "invalid author/committer line - missing email");
    if (buf[p] === GT) return r("badName", "invalid author/committer line - bad name");
    if (buf[p] === LT) break;
    p++;
  }
  if (buf[p - 1] !== SP) {
    return r(
      "missingSpaceBeforeEmail",
      "invalid author/committer line - missing space before email",
    );
  }
  p++;
  for (;;) {
    if (p >= end || buf[p] === LT || buf[p] === NL) {
      return r("badEmail", "invalid author/committer line - bad email");
    }
    if (buf[p] === GT) break;
    p++;
  }
  p++;
  if (buf[p] !== SP) {
    return r("missingSpaceBeforeDate", "invalid author/committer line - missing space before date");
  }
  p++;
  while (buf[p] === SP || buf[p] === 0x09) p++;
  if (!isDigit(buf[p])) return r("badDate", "invalid author/committer line - bad date");
  if (buf[p] === ZERO && buf[p + 1] !== SP) {
    return r("zeroPaddedDate", "invalid author/committer line - zero-padded date");
  }
  let digits = "";
  while (p < end && isDigit(buf[p])) digits += String.fromCharCode(buf[p++] as number);
  if (digits.length > 23 || BigInt(digits) >= TIME_LIMIT) {
    return r("badDateOverflow", "invalid author/committer line - date causes integer overflow");
  }
  if (buf[p] !== SP) return r("badDate", "invalid author/committer line - bad date");
  p++;
  const sign = buf[p];
  if (
    (sign !== 0x2b && sign !== 0x2d) ||
    !isDigit(buf[p + 1]) ||
    !isDigit(buf[p + 2]) ||
    !isDigit(buf[p + 3]) ||
    !isDigit(buf[p + 4]) ||
    buf[p + 5] !== NL
  ) {
    return r("badTimezone", "invalid author/committer line - bad time zone");
  }
  return { value: 0, next };
}

/** git's `fsck_commit`. Returns nonzero when an error was reported (or a fatal check stopped it). */
export function fsckCommit(buf: Uint8Array, report: FsckReport): number {
  const headers = verifyHeaders(buf, report);
  if (headers.stop) return headers.value || -1;
  const end = buf.length;
  let p = 0;
  if (p >= end || !startsWith(buf, p, "tree ")) {
    return report("missingTree", "invalid format - expected 'tree' line");
  }
  p += 5;
  let q = parseOidHex(buf, p);
  if (q < 0 || buf[q] !== NL) {
    const err = report("badTreeSha1", "invalid 'tree' line format - bad sha1");
    if (err) return err;
    q = q < 0 ? indexOf(buf, NL, p) : indexOf(buf, NL, q);
    if (q < 0) q = end;
  }
  p = q + 1;
  while (p < end && startsWith(buf, p, "parent ")) {
    p += 7;
    q = parseOidHex(buf, p);
    if (q < 0 || buf[q] !== NL) {
      const err = report("badParentSha1", "invalid 'parent' line format - bad sha1");
      if (err) return err;
      q = q < 0 ? indexOf(buf, NL, p) : indexOf(buf, NL, q);
      if (q < 0) q = end;
    }
    p = q + 1;
  }
  let authors = 0;
  let err = 0;
  while (p < end && startsWith(buf, p, "author ")) {
    authors++;
    const ident = fsckIdent(buf, p + 7, report);
    if (ident.value) return ident.value;
    p = ident.next;
  }
  if (authors < 1) err = report("missingAuthor", "invalid format - expected 'author' line");
  else if (authors > 1) err = report("multipleAuthors", "invalid format - multiple 'author' lines");
  if (err) return err;
  if (p >= end || !startsWith(buf, p, "committer ")) {
    return report("missingCommitter", "invalid format - expected 'committer' line");
  }
  const committer = fsckIdent(buf, p + 10, report);
  if (committer.value) return committer.value;
  if (buf.includes(NUL)) {
    const nul = report("nulInCommit", "NUL byte in the commit object body");
    if (nul) return nul;
  }
  return 0;
}

const TYPE_NAMES = ["commit", "tree", "blob", "tag"];

/**
 * git's `fsck_tag_standalone`. Returns nonzero when an error was reported. With `gpgsig` (git
 * 2.45+, the default) a `gpgsig` or `gpgsig-sha256` header after the tagger is skipped; git
 * 2.43 counts it as an extra header (`extraHeaderEntry`, ignored unless configured).
 */
export function fsckTag(
  buf: Uint8Array,
  report: FsckReport,
  options: { gpgsig?: boolean } = {},
): number {
  const headers = verifyHeaders(buf, report);
  if (headers.stop) return headers.value || -1;
  const end = buf.length;
  let p = 0;
  if (p >= end || !startsWith(buf, p, "object ")) {
    return report("missingObject", "invalid format - expected 'object' line");
  }
  p += 7;
  let q = parseOidHex(buf, p);
  if (q < 0 || buf[q] !== NL) {
    const ret = report("badObjectSha1", "invalid 'object' line format - bad sha1");
    if (ret) return ret;
    q = q < 0 ? indexOf(buf, NL, p) : indexOf(buf, NL, q);
    if (q < 0) q = end;
  }
  p = q + 1;
  if (p >= end || !startsWith(buf, p, "type ")) {
    return report("missingTypeEntry", "invalid format - expected 'type' line");
  }
  p += 5;
  let eol = indexOf(buf, NL, p);
  if (eol < 0) return report("missingType", "invalid format - unexpected end after 'type' line");
  const type = dec.decode(buf.subarray(p, eol));
  if (!TYPE_NAMES.includes(type)) {
    const ret = report("badType", "invalid 'type' value");
    if (ret) return ret;
  }
  p = eol + 1;
  if (p >= end || !startsWith(buf, p, "tag ")) {
    return report("missingTagEntry", "invalid format - expected 'tag' line");
  }
  p += 4;
  eol = indexOf(buf, NL, p);
  if (eol < 0) return report("missingTag", "invalid format - unexpected end after 'type' line");
  const name = dec.decode(buf.subarray(p, eol));
  if (!isValidRefName(`refs/tags/${name}`)) {
    const ret = report("badTagName", `invalid 'tag' name: ${name}`);
    if (ret) return ret;
  }
  p = eol + 1;
  let ret = 0;
  if (p >= end || !startsWith(buf, p, "tagger ")) {
    ret = report("missingTaggerEntry", "invalid format - expected 'tagger' line");
    if (ret) return ret;
  } else {
    const ident = fsckIdent(buf, p + 7, report);
    ret = ident.value;
    p = ident.next;
  }
  const gpg =
    options.gpgsig === false
      ? 0
      : startsWith(buf, p, "gpgsig ")
        ? 7
        : startsWith(buf, p, "gpgsig-sha256 ")
          ? 14
          : 0;
  if (p < end && gpg) {
    p += gpg;
    eol = indexOf(buf, NL, p);
    if (eol < 0) {
      return report(
        "badGpgsig",
        "invalid format - unexpected end after 'gpgsig' or 'gpgsig-sha256' line",
      );
    }
    p = eol + 1;
    while (p < end && buf[p] === SP) {
      eol = indexOf(buf, NL, p);
      if (eol < 0) {
        return report(
          "badHeaderContinuation",
          "invalid format - unexpected end in 'gpgsig' or 'gpgsig-sha256' continuation line",
        );
      }
      p = eol + 1;
    }
  }
  if (p < end && buf[p] !== NL) {
    ret = report("extraHeaderEntry", "invalid format - extra header(s) after 'tagger'");
    if (ret) return ret;
  }
  return ret;
}

// ---------------------------------------------------------------------------------------------
// Trees

/** One tree entry as git's tree walker decodes it. */
export interface RawTreeEntry {
  /** The mode as written (`TREE_DESC_RAW_MODES`), in 16 bits as git keeps it. */
  mode: number;
  /** The name's bytes. */
  name: Uint8Array;
  /** Offset of the entry's 20 id bytes in the tree (`treeEntryId` gives the hex). */
  idAt: number;
  /** Offset of the entry's mode text in the tree. */
  at: number;
}

/** The id of a tree entry, as hex. */
export function treeEntryId(buf: Uint8Array, entry: RawTreeEntry): string {
  return bytesToHex(buf.subarray(entry.idAt, entry.idAt + 20));
}

/**
 * A name none of fsck's special-name checks can match (`.`, `..`, `.git`, `.gitmodules` and the
 * like under their HFS+ and NTFS spellings): it does not start with a dot and holds no `~`, no
 * backslash and no non-ASCII byte.
 */
function isPlainName(name: Uint8Array): boolean {
  if (name[0] === 0x2e) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i] as number;
    if (c === 0x7e || c === 0x5c || c >= 0x80) return false;
  }
  return true;
}

/** Whether the 20 id bytes at `at` are all zero (the null id). */
function isNullIdAt(buf: Uint8Array, at: number): boolean {
  for (let i = at; i < at + 20; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Decodes the entry at `at` as git's `decode_tree_entry`: returns it, or the error git prints
 * (`too-short tree object`, `malformed mode in tree entry`, `empty filename in tree entry`).
 */
function decodeTreeEntry(buf: Uint8Array, at: number): RawTreeEntry | string {
  const size = buf.length - at;
  if (size < 23 || buf[at + size - 21] !== NUL) return "too-short tree object";
  if (buf[at] === SP) return "malformed mode in tree entry";
  let p = at;
  let mode = 0;
  for (;;) {
    const c = buf[p++];
    if (c === SP) break;
    if (c === undefined || c < 0x30 || c > 0x37) return "malformed mode in tree entry";
    // git reads the mode into an unsigned int and keeps it in an unsigned short: the low 16
    // bits (1100644 is 100644)
    mode = (mode * 8 + (c - 0x30)) & 0xffff;
  }
  if (buf[p] === NUL) return "empty filename in tree entry";
  const nul = indexOf(buf, NUL, p);
  const name = buf.subarray(p, nul);
  return { mode, name, idAt: nul + 1, at };
}

/** A tree walk: the entries decoded before an error, and that error (git's message). */
export interface TreeWalk {
  entries: RawTreeEntry[];
  /** The first entry could not be decoded (`init_tree_desc_gently` failed). */
  initError?: string;
  /** A later entry could not be decoded: the walk stopped before it. */
  error?: string;
}

/**
 * Walks a tree as `tree_entry_gently` does: entries until one cannot be decoded. git stops a
 * walk with `die("too-short tree file")` when an entry runs past the end; that is reported as a
 * decoding error here.
 */
export function walkTree(buf: Uint8Array): TreeWalk {
  const entries: RawTreeEntry[] = [];
  if (buf.length === 0) return { entries };
  let at = 0;
  let entry = decodeTreeEntry(buf, at);
  if (typeof entry === "string") return { entries, initError: entry };
  for (;;) {
    const next = entry.idAt + 20;
    if (next > buf.length) return { entries, error: "too-short tree file" };
    at = next;
    if (at >= buf.length) {
      entries.push(entry);
      return { entries };
    }
    const decoded = decodeTreeEntry(buf, at);
    if (typeof decoded === "string") return { entries, error: decoded };
    entries.push(entry);
    entry = decoded;
  }
}

/** git's `canon_mode`: the mode a walk sees. */
export function canonMode(mode: number): number {
  switch (mode & S_IFMT) {
    case S_IFREG:
      return S_IFREG | (mode & 0o100 ? 0o755 : 0o644);
    case S_IFLNK:
      return S_IFLNK;
    case S_IFDIR:
      return S_IFDIR;
    default:
      return S_IFGITLINK;
  }
}

const isDir = (mode: number) => (mode & S_IFMT) === S_IFDIR;
const isLink = (mode: number) => (mode & S_IFMT) === S_IFLNK;
const isLessThanSlash = (c: number) => c > 0 && c < SLASH;

/** Whether `name` begins with `prefix`. */
function hasPrefix(name: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > name.length) return false;
  for (let i = 0; i < prefix.length; i++) if (name[i] !== prefix[i]) return false;
  return true;
}

const TREE_UNORDERED = -1;
const TREE_HAS_DUPS = -2;

/** git's `verify_ordered`, with its stack of file names a later directory may duplicate. */
function verifyOrdered(
  mode1: number,
  name1: Uint8Array,
  mode2: number,
  name2: Uint8Array,
  candidates: Uint8Array[],
): number {
  const len = Math.min(name1.length, name2.length);
  for (let i = 0; i < len; i++) {
    if (name1[i] !== name2[i])
      return (name1[i] as number) < (name2[i] as number) ? 0 : TREE_UNORDERED;
  }
  let c1 = name1[len] ?? 0;
  let c2 = name2[len] ?? 0;
  if (!c1 && !c2) return TREE_HAS_DUPS;
  if (!c1 && isDir(mode1)) c1 = SLASH;
  if (!c2 && isDir(mode2)) c2 = SLASH;
  if (!c1 && isLessThanSlash(c2)) {
    candidates.push(name1);
  } else if (c2 === SLASH && isLessThanSlash(c1)) {
    for (;;) {
      const fName = candidates.pop();
      if (!fName) break;
      if (!hasPrefix(name2, fName)) continue;
      const p = name2[fName.length];
      if (p === undefined) return TREE_HAS_DUPS;
      if (isLessThanSlash(p)) {
        candidates.push(fName);
        break;
      }
    }
  }
  return c1 < c2 ? 0 : TREE_UNORDERED;
}

/** What a tree check found that later checks need: the `.gitmodules` and `.gitattributes` blobs. */
export interface TreeFindings {
  gitmodules: string[];
  gitattributes: string[];
}

/**
 * git's `fsck_tree`. `onDecodeError` receives the tree walker's own error message (git prints
 * it with `error()` before reporting `badTree`).
 */
export function fsckTree(
  buf: Uint8Array,
  types: FsckMessageTypes,
  report: FsckReport,
  onDecodeError: (message: string) => void,
  found: TreeFindings,
): number {
  let retval = 0;
  let hasNullSha1 = false;
  let hasFullPath = false;
  let hasEmptyName = false;
  let hasDot = false;
  let hasDotdot = false;
  let hasDotgit = false;
  let hasZeroPad = false;
  let hasBadModes = false;
  let hasDupEntries = false;
  let notProperlySorted = false;
  let hasLargeName = false;
  const candidates: Uint8Array[] = [];

  if (buf.length === 0) return 0;
  let entry = decodeTreeEntry(buf, 0);
  if (typeof entry === "string") {
    onDecodeError(entry);
    return report("badTree", "cannot be parsed as a tree");
  }
  let oMode = 0;
  let oName: Uint8Array | undefined;
  for (;;) {
    const { mode, name } = entry;
    hasNullSha1 ||= isNullIdAt(buf, entry.idAt);
    hasFullPath ||= name.includes(SLASH);
    hasEmptyName ||= name.length === 0;
    hasZeroPad ||= buf[entry.at] === ZERO;
    hasLargeName ||= name.length > types.maxTreeEntryLength;
    // the name checks below can match only a name that starts with a dot, or holds a `~`, a
    // backslash or a non-ASCII byte: most names skip them
    if (!isPlainName(name)) {
      const text = dec.decode(name);
      hasDot ||= text === ".";
      hasDotdot ||= text === "..";
      hasDotgit ||= isDotGitComponent(text);
      if (isGitWorktreeFile(text, "gitmodules")) {
        if (!isLink(mode)) found.gitmodules.push(treeEntryId(buf, entry));
        else retval += report("gitmodulesSymlink", ".gitmodules is a symbolic link");
      }
      if (isGitWorktreeFile(text, "gitattributes")) {
        if (!isLink(mode)) found.gitattributes.push(treeEntryId(buf, entry));
        else retval += report("gitattributesSymlink", ".gitattributes is a symlink");
      }
      if (isLink(mode)) {
        if (isGitWorktreeFile(text, "gitignore")) {
          retval += report("gitignoreSymlink", ".gitignore is a symlink");
        }
        if (isGitWorktreeFile(text, "mailmap")) {
          retval += report("mailmapSymlink", ".mailmap is a symlink");
        }
      }
      if (text.includes("\\")) {
        // git checks only is_ntfs_dotgitmodules there (no HFS+ spelling)
        for (const part of text.split("\\").slice(1)) {
          if (isNtfsGitWorktreeFile(part, "gitmodules")) {
            if (!isLink(mode)) found.gitmodules.push(treeEntryId(buf, entry));
            else retval += report("gitmodulesSymlink", ".gitmodules is a symbolic link");
          }
        }
      }
    }

    // update_tree_entry_gently
    const next = entry.idAt + 20;
    let decodeError: string | undefined;
    let nextEntry: RawTreeEntry | undefined;
    if (next > buf.length) decodeError = "too-short tree file";
    else if (next < buf.length) {
      const decoded = decodeTreeEntry(buf, next);
      if (typeof decoded === "string") decodeError = decoded;
      else nextEntry = decoded;
    }
    if (decodeError) {
      onDecodeError(decodeError);
      retval += report("badTree", "cannot be parsed as a tree");
      break;
    }

    switch (mode) {
      case S_IFREG | 0o755:
      case S_IFREG | 0o644:
      case S_IFLNK:
      case S_IFDIR:
      case S_IFGITLINK:
        break;
      case S_IFREG | 0o664:
        if (!types.strict) break;
        hasBadModes = true;
        break;
      default:
        hasBadModes = true;
    }

    if (oName) {
      const order = verifyOrdered(oMode, oName, mode, name, candidates);
      if (order === TREE_UNORDERED) notProperlySorted = true;
      else if (order === TREE_HAS_DUPS) hasDupEntries = true;
    }
    oMode = mode;
    oName = name;
    if (!nextEntry) break;
    entry = nextEntry;
  }

  if (hasNullSha1) retval += report("nullSha1", "contains entries pointing to null sha1");
  if (hasFullPath) retval += report("fullPathname", "contains full pathnames");
  if (hasEmptyName) retval += report("emptyName", "contains empty pathname");
  if (hasDot) retval += report("hasDot", "contains '.'");
  if (hasDotdot) retval += report("hasDotdot", "contains '..'");
  if (hasDotgit) retval += report("hasDotgit", "contains '.git'");
  if (hasZeroPad) retval += report("zeroPaddedFilemode", "contains zero-padded file modes");
  if (hasBadModes) retval += report("badFilemode", "contains bad file modes");
  if (hasDupEntries) retval += report("duplicateEntries", "contains duplicate file entries");
  if (notProperlySorted) retval += report("treeNotSorted", "not properly sorted");
  if (hasLargeName) retval += report("largePathname", "contains excessively large pathname");
  return retval;
}

// ---------------------------------------------------------------------------------------------
// Blobs: .gitmodules and .gitattributes

/** git's ATTR_MAX_FILE_SIZE (100 MiB) and ATTR_MAX_LINE_LENGTH (2048). */
const ATTR_MAX_FILE_SIZE = 100 * 1024 * 1024;
const ATTR_MAX_LINE_LENGTH = 2048;

/**
 * git's `fsck_blob` for a blob named `.gitmodules` (`gitmodules`) or `.gitattributes`
 * (`gitattributes`) by some tree. `buf` is undefined for a blob too large to load.
 */
export function fsckBlob(
  buf: Uint8Array | undefined,
  size: number,
  kinds: { gitmodules: boolean; gitattributes: boolean },
  report: FsckReport,
): number {
  let ret = 0;
  if (kinds.gitmodules) {
    if (!buf) return report("gitmodulesLarge", ".gitmodules too large to parse");
    // git's config parser skips a UTF-8 BOM only in files, not in a blob: kept, it is refused
    const entries = parseGitmodulesConfig(decKeepBom.decode(buf));
    if (!entries) {
      ret |= report("gitmodulesParse", "could not parse gitmodules blob");
    } else {
      let r = 0;
      for (const { name, key, value } of entries) {
        if (!checkSubmoduleName(name)) {
          r |= report("gitmodulesName", `disallowed submodule name: ${name}`);
        }
        if (key === "url" && value !== undefined && !checkSubmoduleUrl(value)) {
          r |= report("gitmodulesUrl", `disallowed submodule url: ${value}`);
        }
        if (key === "path" && value !== undefined && value.startsWith("-")) {
          r |= report("gitmodulesPath", `disallowed submodule path: ${value}`);
        }
        if (key === "update" && value !== undefined && value.startsWith("!")) {
          r |= report("gitmodulesUpdate", `disallowed submodule update setting: ${value}`);
        }
      }
      ret |= r;
    }
  }
  if (kinds.gitattributes) {
    if (!buf || size > ATTR_MAX_FILE_SIZE) {
      return report("gitattributesLarge", ".gitattributes too large to parse");
    }
    let p = 0;
    // git scans up to the first NUL (a C string)
    const end = (() => {
      const nul = indexOf(buf, NUL, 0);
      return nul < 0 ? buf.length : nul;
    })();
    while (p < end) {
      let eol = indexOf(buf, NL, p, end);
      if (eol < 0) eol = end;
      if (eol - p >= ATTR_MAX_LINE_LENGTH) {
        ret |= report("gitattributesLineLength", ".gitattributes has too long lines to parse");
        break;
      }
      p = eol < end ? eol + 1 : eol;
    }
  }
  return ret;
}

/** git's `check_submodule_name`: not empty, no `..` path component (either separator). */
export function checkSubmoduleName(name: string): boolean {
  if (name === "") return false;
  const isSep = (c: string | undefined) => c === "/" || c === "\\";
  for (let i = -1; i < name.length; i++) {
    if (i >= 0 && !isSep(name[i])) continue;
    if (
      name[i + 1] === "." &&
      name[i + 2] === "." &&
      (i + 3 >= name.length || isSep(name[i + 3]))
    ) {
      return false;
    }
  }
  return true;
}

function urlDecode(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** git's `check_submodule_url`. */
export function checkSubmoduleUrl(url: string): boolean {
  if (url.startsWith("-")) return false;
  const dotSlash = (u: string) => /^\.[/\\]/.test(u);
  const dotDotSlash = (u: string) => /^\.\.[/\\]/.test(u);
  if (dotSlash(url) || dotDotSlash(url) || url.startsWith("git://")) {
    if (urlDecode(url).includes("\n")) return false;
    let rest = url;
    let dotdots = 0;
    for (;;) {
      if (dotDotSlash(rest)) {
        dotdots++;
        rest = rest.slice(3);
      } else if (dotSlash(rest)) {
        rest = rest.slice(2);
      } else break;
    }
    if (dotdots > 0 && (rest.startsWith(":") || rest.startsWith("/"))) return false;
    return true;
  }
  const curl =
    /^(?:https?|ftps?)::(.*)$/s.exec(url)?.[1] ??
    (/^(?:https?|ftps?):\/\//.test(url) ? url : undefined);
  if (curl !== undefined) {
    // credential_from_url_gently: scheme://[user[:pass]@]host[/path]; a host is required and
    // no part may carry a newline once decoded
    const match = /^([^:/]+):\/\/([^/]*)(.*)$/s.exec(curl);
    if (!match) return false;
    const authority = match[2] as string;
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    if (host === "") return false;
    if (urlDecode(curl).includes("\n")) return false;
  }
  return true;
}

/** One `submodule.<name>.<key>` setting of a `.gitmodules` blob. */
interface GitmodulesSetting {
  name: string;
  key: string;
  value: string | undefined;
}

/**
 * The `submodule.<name>.<key>` settings of a `.gitmodules` text, or undefined when git's
 * config parser would refuse it.
 */
export function parseGitmodulesConfig(text: string): GitmodulesSetting[] | undefined {
  const out: GitmodulesSetting[] = [];
  let section = "";
  let subsection: string | undefined;
  let i = 0;
  const n = text.length;
  const skipBlank = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  while (i < n) {
    skipBlank();
    const c = text[i];
    if (c === undefined) break;
    if (c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || c === ";") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "[") {
      i++;
      let name = "";
      while (i < n && /[A-Za-z0-9.-]/.test(text[i] as string)) name += text[i++];
      subsection = undefined;
      if (text[i] === " " || text[i] === "\t") {
        skipBlank();
        if (text[i] !== '"') return undefined;
        i++;
        let sub = "";
        for (;;) {
          const ch = text[i++];
          if (ch === undefined || ch === "\n") return undefined;
          if (ch === '"') break;
          if (ch === "\\") {
            const esc = text[i++];
            if (esc === undefined || esc === "\n") return undefined;
            sub += esc;
          } else sub += ch;
        }
        subsection = sub;
      }
      if (text[i] !== "]") return undefined;
      i++;
      section = name.toLowerCase();
      if (subsection === undefined && section.includes(".")) {
        const dot = name.indexOf(".");
        subsection = name.slice(dot + 1);
        section = name.slice(0, dot).toLowerCase();
      }
      continue;
    }
    if (!/[A-Za-z]/.test(c)) return undefined;
    let key = "";
    while (i < n && /[A-Za-z0-9-]/.test(text[i] as string)) key += text[i++];
    skipBlank();
    let value: string | undefined;
    if (text[i] === "=") {
      i++;
      skipBlank();
      let v = "";
      let quoted = false;
      let pendingSpace = "";
      for (;;) {
        const ch = text[i];
        if (ch === undefined) break;
        if (ch === "\n" && !quoted) break;
        if (ch === "\n") return undefined;
        i++;
        if (!quoted && (ch === "#" || ch === ";")) {
          while (i < n && text[i] !== "\n") i++;
          break;
        }
        if (!quoted && (ch === " " || ch === "\t")) {
          pendingSpace += ch;
          continue;
        }
        if (ch === "\r" && text[i] === "\n") continue;
        v += pendingSpace;
        pendingSpace = "";
        if (ch === '"') {
          quoted = !quoted;
          continue;
        }
        if (ch === "\\") {
          const esc = text[i++];
          if (esc === "\n") continue;
          if (esc === "n") v += "\n";
          else if (esc === "t") v += "\t";
          else if (esc === "b") v = v.slice(0, -1);
          else if (esc === "\\" || esc === '"') v += esc;
          else return undefined;
          continue;
        }
        v += ch;
      }
      if (quoted) return undefined;
      value = v;
    } else if (text[i] !== "\n" && text[i] !== undefined && text[i] !== "#" && text[i] !== ";") {
      return undefined;
    }
    if (section === "submodule" && subsection !== undefined) {
      out.push({ name: subsection, key: key.toLowerCase(), value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parsing for the object graph (commit.c, tag.c)

/** A commit as `parse_commit_buffer` reads it. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
}

/**
 * git's `parse_commit_buffer`: the tree and parents, or the error it prints. Ids are
 * lowercased (git's `get_oid_hex` accepts either case).
 */
export function parseCommitBuffer(buf: Uint8Array, id: string): ParsedCommit | { error: string } {
  const tail = buf.length;
  const treeLen = HEX + 5;
  const parentLen = HEX + 7;
  if (tail <= treeLen + 1 || !startsWith(buf, 0, "tree ") || buf[treeLen] !== NL) {
    return { error: `bogus commit object ${id}` };
  }
  if (parseOidHex(buf, 5) < 0) return { error: `bad tree pointer in commit ${id}` };
  const tree = dec.decode(buf.subarray(5, 5 + HEX)).toLowerCase();
  const parents: string[] = [];
  let p = treeLen + 1;
  while (p + parentLen < tail && startsWith(buf, p, "parent ")) {
    if (tail <= p + parentLen + 1 || parseOidHex(buf, p + 7) < 0 || buf[p + parentLen] !== NL) {
      return { error: `bad parents in commit ${id}` };
    }
    parents.push(dec.decode(buf.subarray(p + 7, p + 7 + HEX)).toLowerCase());
    p += parentLen + 1;
  }
  return { tree, parents };
}

/** A tag as `parse_tag_buffer` reads it, up to the point where it looks the tagged object up. */
export interface ParsedTag {
  object: string;
  type: "commit" | "tree" | "blob" | "tag";
  /** The tag's name; undefined when the rest is malformed (git fails silently after the lookup). */
  tag: string | undefined;
}

/**
 * git's `parse_tag_buffer`: the tagged object, its type and the tag's name, or `{ error }`
 * with the message git prints before looking the tagged object up (undefined where git fails
 * silently).
 */
export function parseTagBuffer(
  buf: Uint8Array,
  id: string,
): ParsedTag | { error: string | undefined } {
  const tail = buf.length;
  if (tail < HEX + 24) return { error: undefined };
  if (!startsWith(buf, 0, "object ")) return { error: undefined };
  const q = parseOidHex(buf, 7);
  if (q < 0 || buf[q] !== NL) return { error: undefined };
  const object = dec.decode(buf.subarray(7, q)).toLowerCase();
  let p = q + 1;
  if (!startsWith(buf, p, "type ")) return { error: undefined };
  p += 5;
  let nl = indexOf(buf, NL, p);
  if (nl < 0 || nl - p >= 20) return { error: undefined };
  const type = dec.decode(buf.subarray(p, nl));
  p = nl + 1;
  if (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") {
    return { error: `unknown tag type '${type}' in ${id}` };
  }
  if (!(p + 4 < tail && startsWith(buf, p, "tag "))) return { object, type, tag: undefined };
  p += 4;
  nl = indexOf(buf, NL, p);
  if (nl < 0) return { object, type, tag: undefined };
  return { object, type, tag: dec.decode(buf.subarray(p, nl)) };
}
