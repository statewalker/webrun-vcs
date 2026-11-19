/**
 * git's untracked cache: the `UNTR` index extension (dir.c `untracked_cache`).
 *
 * The cache remembers, per directory of the worktree, the untracked files `git status`
 * found there, the directory's stat data when it was read, and the id of its `.gitignore`.
 * A later status trusts a directory whose stat (mtime above all) is unchanged and whose
 * ignore rules hash the same, and takes its untracked files from the cache instead of
 * reading the directory again. Index edits invalidate the directories of the paths they add
 * or remove (`untracked_cache_invalidate_path`), as the cache holds no tracked file.
 *
 * ```typescript
 * const cache = parseUntrackedCache(extension.data);
 * if (cache) {
 *   invalidateUntrackedPath(cache, "src/new-file.ts"); // `git add` of that path
 *   const bytes = encodeUntrackedCache(cache);       // what git writes back
 * }
 * ```
 *
 * The bytes are git's: an ident string ("Location <worktree>, system <sysname>"), the stat
 * data and ids of `info/exclude` and `core.excludesFile`, the directory flags the cache was
 * made for, the per-directory exclude file name, then the directories depth first, each
 * with its untracked names, followed by three EWAH bitmaps (valid, check-only, has an
 * exclude id) and the stat data and ids they select.
 */

import { bytesToHex, createSha1, hexToBytes } from "@statewalker/vcs-utils";
import { compareGitPaths, decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { LinkStats } from "@statewalker/vcs-utils/files";

/** The null object id: no exclude file. */
export const NULL_OID = "0000000000000000000000000000000000000000";
/** The id of the empty blob (an exclude file of size 0). */
export const EMPTY_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** git's `dir_struct` flags the cache records (`dir_flags`). */
export const DIR_SHOW_IGNORED = 1 << 0;
export const DIR_SHOW_OTHER_DIRECTORIES = 1 << 1;
export const DIR_HIDE_EMPTY_DIRECTORIES = 1 << 2;

/** git's `stat_data`: the stat of a directory or exclude file, each field 32 bits. */
export interface StatData {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
}

/** A stat of all zeros (a file that is not there). */
export function zeroStatData(): StatData {
  return {
    ctimeSec: 0,
    ctimeNsec: 0,
    mtimeSec: 0,
    mtimeNsec: 0,
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
    size: 0,
  };
}

/** git's `oid_stat`: an exclude file's stat and id (the null id when it is absent). */
export interface OidStat {
  stat: StatData;
  oid: string;
}

/** One directory of the cache (git's `untracked_cache_dir`). */
export interface UntrackedCacheDir {
  /** The directory's own name ("" for the root) */
  name: string;
  /** The untracked names in it, as read (a nested repository ends with `/`) */
  untracked: string[];
  /** Its subdirectories, sorted by name (byte order) */
  dirs: UntrackedCacheDir[];
  /** Its untracked list is complete and its stat is the one it was read with */
  valid: boolean;
  /** Read only to find whether it holds anything (`DIR_SHOW_OTHER_DIRECTORIES` scans) */
  checkOnly: boolean;
  /** Reached by the last scan: written out (a directory not reached is dropped) */
  recurse: boolean;
  /** The directory's stat when it was read */
  stat: StatData;
  /** The id of its `.gitignore` as git computed it (the null id: none read) */
  excludeOid: string;
}

/** The untracked cache of an index (git's `untracked_cache`). */
export interface UntrackedCache {
  /** "Location <worktree>, system <sysname>" and a NUL: where the cache is valid */
  ident: Uint8Array;
  /** `$GIT_DIR/info/exclude` when the cache was made */
  infoExclude: OidStat;
  /** `core.excludesFile` when the cache was made */
  excludesFile: OidStat;
  /** The `dir_struct` flags the cache was made for (0: `-uall`) */
  dirFlags: number;
  /** The per-directory exclude file (`.gitignore`) */
  excludePerDir: string;
  /** The root directory; none before the first scan */
  root?: UntrackedCacheDir;
  /** Statistics of this session (git's trace2 `read_directory` data); never written */
  dirCreated: number;
  gitignoreInvalidated: number;
  dirInvalidated: number;
  dirOpened: number;
}

/** A directory node as git's `lookup_untracked` creates it. */
export function newUntrackedCacheDir(name: string): UntrackedCacheDir {
  return {
    name,
    untracked: [],
    dirs: [],
    valid: false,
    checkOnly: false,
    recurse: false,
    stat: zeroStatData(),
    excludeOid: NULL_OID,
  };
}

/** The ident string git writes for a worktree on a system (`get_ident_string`). */
export function untrackedCacheIdent(worktreePath: string, systemName: string): string {
  return `Location ${worktreePath}, system ${systemName}`;
}

/**
 * A new, empty cache (git's `new_untracked_cache`): the ident with its trailing NUL, no
 * exclude files, no root.
 */
export function newUntrackedCache(ident: string, dirFlags: number): UntrackedCache {
  const text = encodeGitPath(ident);
  const bytes = new Uint8Array(text.length + 1);
  bytes.set(text);
  return {
    ident: bytes,
    infoExclude: { stat: zeroStatData(), oid: NULL_OID },
    excludesFile: { stat: zeroStatData(), oid: NULL_OID },
    dirFlags,
    excludePerDir: ".gitignore",
    dirCreated: 0,
    gitignoreInvalidated: 0,
    dirInvalidated: 0,
    dirOpened: 0,
  };
}

/** Whether the cache's ident (up to its first NUL) is `ident` (git's `ident_in_untracked`). */
export function untrackedCacheIdentIs(cache: UntrackedCache, ident: string): boolean {
  const nul = cache.ident.indexOf(0);
  const own = cache.ident.subarray(0, nul < 0 ? cache.ident.length : nul);
  const want = encodeGitPath(ident);
  if (own.length !== want.length) return false;
  for (let i = 0; i < own.length; i++) if (own[i] !== want[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Stat data

/**
 * The stat data git records of an entry (`fill_stat_data`): whole seconds and nanoseconds
 * of ctime and mtime, the low 32 bits of device, inode, owner, group and size (a
 * directory's `st_size` included).
 */
export function statDataOf(link: LinkStats): StatData {
  return {
    ctimeSec: secondsOf(link.ctime ?? link.lastModified, link.ctimeNs),
    ctimeNsec: (link.ctimeNs ?? 0) >>> 0,
    mtimeSec: secondsOf(link.lastModified, link.mtimeNs),
    mtimeNsec: (link.mtimeNs ?? 0) >>> 0,
    dev: (link.dev ?? 0) >>> 0,
    ino: (link.ino ?? 0) >>> 0,
    uid: (link.uid ?? 0) >>> 0,
    gid: (link.gid ?? 0) >>> 0,
    size: (link.statSize ?? link.size) >>> 0,
  };
}

/** Whole seconds of a time in ms whose nanoseconds within the second are `ns`, 32 bits. */
function secondsOf(ms: number, ns: number | undefined): number {
  const seconds =
    ns !== undefined && Number.isInteger(ns) && ns >= 0 && ns < 1e9
      ? Math.round((ms - ns / 1e6) / 1000)
      : Math.floor(ms / 1000);
  return seconds >>> 0;
}

/** What git's `match_stat_data` compares. */
export interface StatMatchOptions {
  /** `core.trustctime` (and not `core.checkStat=minimal`); default true */
  ctime?: boolean;
  /** Not `core.checkStat=minimal`: owner, group and inode compared; default true */
  fullStat?: boolean;
}

/**
 * Whether `recorded` still describes `current` (git's `match_stat_data_racy` in its default
 * build): not when the recorded mtime is not older than the index file (`indexSeconds`,
 * whole seconds; 0: unknown, never racy), nor when mtime, ctime, owner, group, inode or
 * size differ.
 */
export function statDataMatches(
  recorded: StatData,
  current: StatData,
  indexSeconds: number,
  options: StatMatchOptions = {},
): boolean {
  // is_racy_stat without USE_NSEC
  if (indexSeconds !== 0 && indexSeconds <= recorded.mtimeSec) return false;
  if (recorded.mtimeSec !== current.mtimeSec) return false;
  const fullStat = options.fullStat !== false;
  if (options.ctime !== false && fullStat && recorded.ctimeSec !== current.ctimeSec) return false;
  if (fullStat) {
    if (recorded.uid !== current.uid || recorded.gid !== current.gid) return false;
    if (recorded.ino !== current.ino) return false;
  }
  return recorded.size === current.size;
}

// ---------------------------------------------------------------------------------------
// Exclude file ids

/**
 * The id git records for an exclude file it read from disk (`add_patterns`): the empty
 * blob for an empty file, else the blob id of its content with a newline appended (git
 * hashes the buffer it parsed, which ends in one more `\n` than the file).
 */
export async function excludeFileOid(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) return EMPTY_BLOB_OID;
  const hasher = createSha1();
  hasher.update(encodeGitPath(`blob ${bytes.length + 1}\0`));
  hasher.update(bytes);
  hasher.update(NEWLINE);
  return bytesToHex(await hasher.digest());
}

const NEWLINE = new Uint8Array([10]);

// ---------------------------------------------------------------------------------------
// Tree operations (dir.c)

/**
 * The subdirectory `name` of `dir`, created (sorted in) when it is not there (git's
 * `lookup_untracked`). A trailing `/` of the name is ignored.
 */
export function lookupUntracked(
  cache: UntrackedCache,
  dir: UntrackedCacheDir,
  name: string,
): UntrackedCacheDir {
  const key = name.endsWith("/") ? name.slice(0, -1) : name;
  let first = 0;
  let last = dir.dirs.length;
  while (last > first) {
    const next = first + ((last - first) >> 1);
    const d = dir.dirs[next] as UntrackedCacheDir;
    const cmp = compareGitPaths(key, d.name);
    if (cmp === 0) return d;
    if (cmp < 0) last = next;
    else first = next + 1;
  }
  cache.dirCreated++;
  const d = newUntrackedCacheDir(key);
  dir.dirs.splice(first, 0, d);
  return d;
}

/** The ignore rules of `dir` changed: it and everything below it are invalid. */
export function invalidateGitignore(cache: UntrackedCache, dir: UntrackedCacheDir): void {
  cache.gitignoreInvalidated++;
  doInvalidateGitignore(dir);
}

function doInvalidateGitignore(dir: UntrackedCacheDir): void {
  dir.valid = false;
  dir.untracked = [];
  for (const d of dir.dirs) doInvalidateGitignore(d);
}

/**
 * `dir` is read again (git's `invalidate_directory`): invalid, no untracked names, and its
 * subdirectories not reached until the scan reaches them again.
 */
export function invalidateDirectory(cache: UntrackedCache, dir: UntrackedCacheDir): void {
  if (dir.valid) cache.dirInvalidated++;
  dir.valid = false;
  dir.untracked = [];
  for (const d of dir.dirs) d.recurse = false;
}

/** git's `invalidate_one_directory`. */
function invalidateOneDirectory(cache: UntrackedCache, dir: UntrackedCacheDir): void {
  cache.dirInvalidated++;
  dir.valid = false;
  dir.untracked = [];
}

/** git's `invalidate_one_component`: true when the parents must be invalidated too. */
function invalidateOneComponent(
  cache: UntrackedCache,
  dir: UntrackedCacheDir,
  path: string,
): boolean {
  const slash = path.indexOf("/");
  if (slash >= 0) {
    const d = lookupUntracked(cache, dir, path.slice(0, slash));
    const ret = invalidateOneComponent(cache, d, path.slice(slash + 1));
    if (ret) invalidateOneDirectory(cache, dir);
    return ret;
  }
  invalidateOneDirectory(cache, dir);
  return (cache.dirFlags & DIR_SHOW_OTHER_DIRECTORIES) !== 0;
}

/**
 * An index entry at `path` was added or removed (git's `untracked_cache_invalidate_path`):
 * the directory holding it no longer has a valid untracked list (and, for a cache of
 * `DIR_SHOW_OTHER_DIRECTORIES` scans, neither have its parents). Nothing without a root.
 */
export function invalidateUntrackedPath(cache: UntrackedCache, path: string): void {
  if (!cache.root) return;
  invalidateOneComponent(cache, cache.root, path);
}

// ---------------------------------------------------------------------------------------
// The extension's bytes

/** git's `encode_varint` (offset encoding, as index v4 path prefixes). */
function pushVarint(out: number[], value: number): void {
  const bytes = [value & 127];
  let v = Math.floor(value / 128);
  while (v > 0) {
    v -= 1;
    bytes.unshift(128 | (v & 127));
    v = Math.floor(v / 128);
  }
  for (const b of bytes) out.push(b);
}

/** git's `decode_varint`; undefined past `end` or on overflow. */
function readVarint(
  data: Uint8Array,
  at: number,
  end: number,
): { value: number; next: number } | undefined {
  if (at >= end) return undefined;
  let c = data[at++] as number;
  let value = c & 127;
  while (c & 128) {
    value += 1;
    if (at >= end || value > 2 ** 45) return undefined;
    c = data[at++] as number;
    value = value * 128 + (c & 127);
  }
  return { value, next: at };
}

const STAT_DATA_SIZE = 36;
const HASH_SIZE = 20;
/** `struct ondisk_untracked_cache`: two stat datas and the flags. */
const OUC_SIZE = 2 * STAT_DATA_SIZE + 4;

function pushU32(out: number[], value: number): void {
  out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function pushStat(out: number[], s: StatData): void {
  for (const v of [
    s.ctimeSec,
    s.ctimeNsec,
    s.mtimeSec,
    s.mtimeNsec,
    s.dev,
    s.ino,
    s.uid,
    s.gid,
    s.size,
  ]) {
    pushU32(out, v >>> 0);
  }
}

function readU32(data: Uint8Array, at: number): number {
  return (
    (((data[at] as number) << 24) |
      ((data[at + 1] as number) << 16) |
      ((data[at + 2] as number) << 8) |
      (data[at + 3] as number)) >>>
    0
  );
}

function readStat(data: Uint8Array, at: number): StatData {
  return {
    ctimeSec: readU32(data, at),
    ctimeNsec: readU32(data, at + 4),
    mtimeSec: readU32(data, at + 8),
    mtimeNsec: readU32(data, at + 12),
    dev: readU32(data, at + 16),
    ino: readU32(data, at + 20),
    uid: readU32(data, at + 24),
    gid: readU32(data, at + 28),
    size: readU32(data, at + 32),
  };
}

function pushBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i] as number);
}

function pushString(out: number[], text: string): void {
  pushBytes(out, encodeGitPath(text));
  out.push(0);
}

/**
 * The `UNTR` payload of a cache (git's `write_untracked_extension`). Directories not
 * reached by the last scan (`recurse` unset) are left out; an invalid one is written with
 * no untracked names and no check-only bit (git resets them as it writes, and so does this).
 */
export function encodeUntrackedCache(cache: UntrackedCache): Uint8Array {
  const out: number[] = [];
  pushVarint(out, cache.ident.length);
  pushBytes(out, cache.ident);
  pushStat(out, cache.infoExclude.stat);
  pushStat(out, cache.excludesFile.stat);
  pushU32(out, cache.dirFlags >>> 0);
  pushBytes(out, hexToBytes(cache.infoExclude.oid));
  pushBytes(out, hexToBytes(cache.excludesFile.oid));
  pushString(out, cache.excludePerDir);
  if (!cache.root) {
    pushVarint(out, 0);
    return new Uint8Array(out);
  }
  const dirs: number[] = [];
  const valid = new Ewah();
  const checkOnly = new Ewah();
  const hashValid = new Ewah();
  const stats: number[] = [];
  const hashes: number[] = [];
  let index = 0;
  const writeOne = (dir: UntrackedCacheDir) => {
    const i = index++;
    if (!dir.valid) {
      dir.untracked = [];
      dir.checkOnly = false;
    }
    if (dir.checkOnly) checkOnly.set(i);
    if (dir.valid) {
      valid.set(i);
      pushStat(stats, dir.stat);
    }
    if (dir.excludeOid !== NULL_OID) {
      hashValid.set(i);
      pushBytes(hashes, hexToBytes(dir.excludeOid));
    }
    pushVarint(dirs, dir.untracked.length);
    let reached = 0;
    for (const d of dir.dirs) if (d.recurse) reached++;
    pushVarint(dirs, reached);
    pushString(dirs, dir.name);
    for (const name of dir.untracked) pushString(dirs, name);
    for (const d of dir.dirs) if (d.recurse) writeOne(d);
  };
  writeOne(cache.root);
  pushVarint(out, index);
  for (const b of dirs) out.push(b);
  valid.serialize(out);
  checkOnly.serialize(out);
  hashValid.serialize(out);
  for (const b of stats) out.push(b);
  for (const b of hashes) out.push(b);
  out.push(0);
  return new Uint8Array(out);
}

/**
 * The cache in a `UNTR` payload (git's `read_untracked_extension`); undefined when it is
 * malformed (git then has no cache). Every directory read is reached (`recurse`).
 */
export function parseUntrackedCache(data: Uint8Array): UntrackedCache | undefined {
  if (data.length <= 1 || data[data.length - 1] !== 0) return undefined;
  const end = data.length - 1;
  const identLen = readVarint(data, 0, end);
  if (!identLen || identLen.next + identLen.value > end) return undefined;
  let next = identLen.next;
  const ident = data.slice(next, next + identLen.value);
  next += identLen.value;
  const excludePerDirOffset = OUC_SIZE + 2 * HASH_SIZE;
  if (next + excludePerDirOffset + 1 > end) return undefined;
  const nul = data.indexOf(0, next + excludePerDirOffset);
  if (nul < 0 || nul > end) return undefined;
  const cache: UntrackedCache = {
    ident,
    infoExclude: {
      stat: readStat(data, next),
      oid: bytesToHex(data.subarray(next + OUC_SIZE, next + OUC_SIZE + HASH_SIZE)),
    },
    excludesFile: {
      stat: readStat(data, next + STAT_DATA_SIZE),
      oid: bytesToHex(data.subarray(next + OUC_SIZE + HASH_SIZE, next + OUC_SIZE + 2 * HASH_SIZE)),
    },
    dirFlags: readU32(data, next + 2 * STAT_DATA_SIZE),
    excludePerDir: decodeGitPath(data.subarray(next + excludePerDirOffset, nul)),
    dirCreated: 0,
    gitignoreInvalidated: 0,
    dirInvalidated: 0,
    dirOpened: 0,
  };
  next = nul + 1;
  if (next >= end) return next === end ? cache : undefined;
  const count = readVarint(data, next, end);
  if (!count) return undefined;
  if (count.value === 0) return count.next === end ? cache : undefined;
  next = count.next;
  const all: UntrackedCacheDir[] = [];
  const readOne = (): UntrackedCacheDir | undefined => {
    const untrackedNr = readVarint(data, next, end);
    if (!untrackedNr) return undefined;
    next = untrackedNr.next;
    const dirsNr = readVarint(data, next, end);
    if (!dirsNr) return undefined;
    next = dirsNr.next;
    const nameEnd = data.indexOf(0, next);
    if (nameEnd < 0 || nameEnd >= end) return undefined;
    const dir = newUntrackedCacheDir(decodeGitPath(data.subarray(next, nameEnd)));
    dir.recurse = true;
    next = nameEnd + 1;
    for (let i = 0; i < untrackedNr.value; i++) {
      const e = data.indexOf(0, next);
      if (e < 0 || e >= end) return undefined;
      dir.untracked.push(decodeGitPath(data.subarray(next, e)));
      next = e + 1;
    }
    all.push(dir);
    if (all.length > count.value) return undefined;
    for (let i = 0; i < dirsNr.value; i++) {
      const d = readOne();
      if (!d) return undefined;
      dir.dirs.push(d);
    }
    return dir;
  };
  const root = readOne();
  if (!root || all.length !== count.value) return undefined;
  const valid = Ewah.read(data, next, end);
  if (!valid) return undefined;
  const checkOnly = Ewah.read(data, valid.next, end);
  if (!checkOnly) return undefined;
  const hashValid = Ewah.read(data, checkOnly.next, end);
  if (!hashValid) return undefined;
  next = hashValid.next;
  for (const pos of checkOnly.bitmap.bits()) {
    const d = all[pos];
    if (!d) return undefined;
    d.checkOnly = true;
  }
  for (const pos of valid.bitmap.bits()) {
    const d = all[pos];
    if (!d || next + STAT_DATA_SIZE > end) return undefined;
    d.stat = readStat(data, next);
    d.valid = true;
    next += STAT_DATA_SIZE;
  }
  for (const pos of hashValid.bitmap.bits()) {
    const d = all[pos];
    if (!d || next + HASH_SIZE > end) return undefined;
    d.excludeOid = bytesToHex(data.subarray(next, next + HASH_SIZE));
    next += HASH_SIZE;
  }
  if (next !== end) return undefined;
  cache.root = root;
  return cache;
}

/** A deep copy of a cache (its statistics reset). */
export function copyUntrackedCache(cache: UntrackedCache): UntrackedCache {
  const copyDir = (d: UntrackedCacheDir): UntrackedCacheDir => ({
    ...d,
    untracked: [...d.untracked],
    dirs: d.dirs.map(copyDir),
    stat: { ...d.stat },
  });
  return {
    ...cache,
    ident: cache.ident.slice(),
    infoExclude: { stat: { ...cache.infoExclude.stat }, oid: cache.infoExclude.oid },
    excludesFile: { stat: { ...cache.excludesFile.stat }, oid: cache.excludesFile.oid },
    ...(cache.root ? { root: copyDir(cache.root) } : {}),
    dirCreated: 0,
    gitignoreInvalidated: 0,
    dirInvalidated: 0,
    dirOpened: 0,
  };
}

// ---------------------------------------------------------------------------------------
// EWAH bitmaps (git's ewah/ewah_bitmap.c, ewah_io.c), 64-bit words

const WORD_BITS = 64;
const MASK64 = (1n << 64n) - 1n;
const RUNNING_BITS = 32n;
const LARGEST_RUNNING = (1n << RUNNING_BITS) - 1n;
const LARGEST_LITERAL = (1n << (64n - 1n - RUNNING_BITS)) - 1n;
const RUNNING_SHIFT_MASK = LARGEST_RUNNING << 1n;
const RUNNING_LEN_PLUS_BIT = (1n << (RUNNING_BITS + 1n)) - 1n;

/** A compressed bitmap built by setting increasing bits, serialized as git does. */
export class Ewah {
  private buffer: bigint[] = [0n];
  private rlw = 0;
  private bitSize = 0;

  private runBit(): bigint {
    return (this.buffer[this.rlw] as bigint) & 1n;
  }
  private setRunBit(b: boolean): void {
    const w = this.buffer[this.rlw] as bigint;
    this.buffer[this.rlw] = b ? w | 1n : w & (MASK64 ^ 1n);
  }
  private runningLen(): bigint {
    return ((this.buffer[this.rlw] as bigint) >> 1n) & LARGEST_RUNNING;
  }
  private setRunningLen(l: bigint): void {
    let w = (this.buffer[this.rlw] as bigint) | RUNNING_SHIFT_MASK;
    w &= (l << 1n) | (MASK64 ^ RUNNING_SHIFT_MASK);
    this.buffer[this.rlw] = w & MASK64;
  }
  private literalWords(): bigint {
    return (this.buffer[this.rlw] as bigint) >> (1n + RUNNING_BITS);
  }
  private setLiteralWords(l: bigint): void {
    let w = (this.buffer[this.rlw] as bigint) | (MASK64 ^ RUNNING_LEN_PLUS_BIT);
    w &= (l << (RUNNING_BITS + 1n)) | RUNNING_LEN_PLUS_BIT;
    this.buffer[this.rlw] = w & MASK64;
  }
  private pushRlw(value: bigint): void {
    this.buffer.push(value);
    this.rlw = this.buffer.length - 1;
  }

  private addEmptyWords(v: boolean, count: bigint): void {
    let number = count;
    const bit = v ? 1n : 0n;
    if (this.runBit() !== bit && this.runningLen() + this.literalWords() === 0n) {
      this.setRunBit(v);
    } else if (this.literalWords() !== 0n || this.runBit() !== bit) {
      this.pushRlw(0n);
      if (v) this.setRunBit(v);
    }
    const runlen = this.runningLen();
    const canAdd = number < LARGEST_RUNNING - runlen ? number : LARGEST_RUNNING - runlen;
    this.setRunningLen(runlen + canAdd);
    number -= canAdd;
    while (number >= LARGEST_RUNNING) {
      this.pushRlw(0n);
      if (v) this.setRunBit(v);
      this.setRunningLen(LARGEST_RUNNING);
      number -= LARGEST_RUNNING;
    }
    if (number > 0n) {
      this.pushRlw(0n);
      if (v) this.setRunBit(v);
      this.setRunningLen(number);
    }
  }

  private addLiteral(word: bigint): void {
    const current = this.literalWords();
    if (current >= LARGEST_LITERAL) {
      this.pushRlw(0n);
      this.setLiteralWords(1n);
      this.buffer.push(word);
      return;
    }
    this.setLiteralWords(current + 1n);
    this.buffer.push(word);
  }

  private addEmptyWord(v: boolean): void {
    const noLiteral = this.literalWords() === 0n;
    const runLen = this.runningLen();
    if (noLiteral && runLen === 0n) this.setRunBit(v);
    if (noLiteral && this.runBit() === (v ? 1n : 0n) && runLen < LARGEST_RUNNING) {
      this.setRunningLen(runLen + 1n);
      return;
    }
    this.pushRlw(0n);
    this.setRunBit(v);
    this.setRunningLen(1n);
  }

  /** Sets bit `i`; bits must be set in increasing order (git's `ewah_set`). */
  set(i: number): void {
    const dist = Math.ceil((i + 1) / WORD_BITS) - Math.ceil(this.bitSize / WORD_BITS);
    if (i < this.bitSize) throw new Error("Ewah.set: bits must be set in increasing order");
    this.bitSize = i + 1;
    const bit = 1n << BigInt(i % WORD_BITS);
    if (dist > 0) {
      if (dist > 1) this.addEmptyWords(false, BigInt(dist - 1));
      this.addLiteral(bit);
      return;
    }
    if (this.literalWords() === 0n) {
      this.setRunningLen(this.runningLen() - 1n);
      this.addLiteral(bit);
      return;
    }
    const last = this.buffer.length - 1;
    this.buffer[last] = (this.buffer[last] as bigint) | bit;
    if (this.buffer[last] === MASK64) {
      this.buffer.pop();
      this.setLiteralWords(this.literalWords() - 1n);
      this.addEmptyWord(true);
    }
  }

  /** git's `ewah_serialize_to`: bit size, word count, the words, the RLW position. */
  serialize(out: number[]): void {
    pushU32(out, this.bitSize >>> 0);
    pushU32(out, this.buffer.length);
    for (const w of this.buffer) {
      pushU32(out, Number(w >> 32n) >>> 0);
      pushU32(out, Number(w & 0xffffffffn) >>> 0);
    }
    pushU32(out, this.rlw);
  }

  /** The positions of the set bits, ascending (git's `ewah_each_bit`). */
  *bits(): Generator<number> {
    let pos = 0;
    let pointer = 0;
    while (pointer < this.buffer.length) {
      const word = this.buffer[pointer] as bigint;
      const run = Number((word >> 1n) & LARGEST_RUNNING) * WORD_BITS;
      if (word & 1n) {
        for (let k = 0; k < run; k++) yield pos++;
      } else pos += run;
      pointer++;
      const literals = Number(word >> (1n + RUNNING_BITS));
      for (let k = 0; k < literals; k++) {
        const lit = this.buffer[pointer] as bigint;
        for (let c = 0; c < WORD_BITS; c++, pos++) {
          if ((lit >> BigInt(c)) & 1n) yield pos;
        }
        pointer++;
      }
    }
  }

  /** git's `ewah_read_mmap`: a bitmap at `at`, and where it ends; undefined when truncated. */
  static read(
    data: Uint8Array,
    at: number,
    end: number,
  ): { bitmap: Ewah; next: number } | undefined {
    if (at + 8 > end) return undefined;
    const bitSize = readU32(data, at);
    const words = readU32(data, at + 4);
    let next = at + 8;
    if (next + words * 8 + 4 > end) return undefined;
    const bitmap = new Ewah();
    bitmap.buffer = new Array(words);
    for (let i = 0; i < words; i++) {
      bitmap.buffer[i] = (BigInt(readU32(data, next)) << 32n) | BigInt(readU32(data, next + 4));
      next += 8;
    }
    bitmap.rlw = readU32(data, next);
    bitmap.bitSize = bitSize;
    next += 4;
    return { bitmap, next };
  }
}
