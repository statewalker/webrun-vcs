/**
 * The untracked-file scan of `git status` (dir.c `read_directory`), with git's untracked
 * cache.
 *
 * ```typescript
 * const result = await scanUntracked(host, {
 *   isTracked: (path) => index.has(path),
 *   indexDirectory: (dir) => (dirs.has(dir) ? "directory" : undefined),
 *   flags: DIR_SHOW_OTHER_DIRECTORIES | DIR_HIDE_EMPTY_DIRECTORIES, // -unormal
 *   cache, // the index's UNTR made for these flags, or undefined
 *   indexSeconds,
 * });
 * result.paths; // ["new-dir/", "new-file", "nested-repo/", ...] sorted
 * result.ignored; // with DIR_SHOW_IGNORED_TOO: ["build/", "x.o"]
 * ```
 *
 * The walk is dir.c's `read_directory_recursive` with its `treat_path` and
 * `treat_directory`: the `dir_struct` flags decide whether an untracked directory shows as
 * `dir/` (`DIR_SHOW_OTHER_DIRECTORIES`), whether an empty one is hidden
 * (`DIR_HIDE_EMPTY_DIRECTORIES`, found by a `check_only` walk that stops at the first
 * untracked file) and whether ignored paths are collected (`DIR_SHOW_IGNORED_TOO`, with
 * `DIR_SHOW_IGNORED_TOO_MODE_MATCHING` for `--ignored=matching`). A pathspec of literal
 * paths starts the walk at their common leading directory (`treat_leading_path`) and
 * prunes it as git's `simplify_away` and `match_pathspec` do.
 *
 * A directory is listed unless the cache has it valid, its stat unchanged, read in the same
 * `check_only` mode, and its `.gitignore` hashing the same (`valid_cached_dir`); then its
 * untracked names and its subdirectories come from the cache. The order of everything git
 * records (which directories it reads, when it reads each `.gitignore`, the names in readdir
 * order) is git's, so the cache written afterwards holds the bytes git would write.
 */

import { compareGitPaths, foldAsciiCase } from "@statewalker/vcs-utils/encoding";
import type { DirectoryEntry, LinkStats } from "@statewalker/vcs-utils/files";
import {
  DIR_HIDE_EMPTY_DIRECTORIES,
  DIR_SHOW_IGNORED,
  DIR_SHOW_IGNORED_TOO,
  DIR_SHOW_IGNORED_TOO_MODE_MATCHING,
  DIR_SHOW_OTHER_DIRECTORIES,
  excludeFileOid,
  invalidateDirectory,
  invalidateGitignore,
  lookupUntracked,
  newUntrackedCacheDir,
  type StatMatchOptions,
  statDataMatches,
  statDataOf,
  type UntrackedCache,
  type UntrackedCacheDir,
  untrackedNullOid,
  zeroStatData,
} from "./untracked-cache.js";

/** What a worktree's `.gitignore` read gave (git's `add_patterns` with an `oid_stat`). */
export type IgnoreFileRead =
  /** Not there (or not openable: a symbolic link git never follows) */
  | { kind: "missing" }
  /** Read from disk: its bytes and stat */
  | { kind: "file"; bytes: Uint8Array; stat: LinkStats };

/**
 * What the scan reads of a worktree. Paths are worktree paths ("" is the root, no leading
 * or trailing `/`).
 */
export interface UntrackedScanHost {
  /**
   * The entries of a directory with their kinds where known; in readdir order when asked
   * (`scanUntracked` always asks: the order git walks in, and the cache records). Throws
   * when the directory cannot be read.
   */
  listDirectory(path: string, readdirOrder: boolean): Promise<DirectoryEntry[]>;
  /** The entry itself (a link not followed); undefined when nothing is there */
  lstat(path: string): Promise<LinkStats | undefined>;
  /**
   * Reads `<dir>/.gitignore` (never through a link) and makes its rules the ones of `dir`
   * for {@link isExcluded} (a missing file read from its skip-worktree index entry, as the
   * worktree does). Called at most once per directory and scan, before any path below that
   * directory is checked; never for a directory the rules exclude (nor below it).
   */
  loadIgnoreFile(dir: string): Promise<IgnoreFileRead>;
  /**
   * Whether the ignore rules loaded so far exclude `path`; a path inside an excluded
   * directory is excluded
   */
  isExcluded(path: string, isDirectory: boolean): boolean;
  /** Whether an untracked directory holds a repository of its own (shown as `dir/`) */
  isNestedRepository(path: string): Promise<boolean>;
  /** `$GIT_DIR/info/exclude` with its stat; undefined when it is not there */
  readInfoExclude?(): Promise<{ bytes: Uint8Array; stat: LinkStats } | undefined>;
  /** The worktree's path on the host (the untracked cache's "Location"), when known */
  readonly worktreePath?: string;
}

/** What the index tells the scan, and the cache it may use. */
export interface UntrackedScanOptions {
  /**
   * Whether the index has an entry at `path` (any stage): git's `index_file_exists`, which
   * folds case under `core.ignorecase` (a file differing from an index path only by case is
   * then tracked: neither untracked nor recorded in the untracked cache)
   */
  isTracked(path: string): boolean;
  /**
   * Whether the index has an entry at exactly `path` (`index_name_is_other`, which never
   * folds case: an ignored path's check); default {@link isTracked}
   */
  isTrackedExactly?(path: string): boolean;
  /**
   * The names of the index entries directly in `dir` (any stage), asked once per directory
   * listed: faster than `isTracked` per file, and folding case as it does. Optional.
   */
  trackedIn?(dir: string): ReadonlySet<string>;
  /**
   * git's `directory_exists_in_index`: entries below `dir`, or a gitlink at it (under
   * `core.ignorecase`, `directory_exists_in_index_icase`: folding case)
   */
  indexDirectory(dir: string): "directory" | "gitlink" | undefined;
  /**
   * The id git takes for a `.gitignore` from the index instead of hashing the file: the
   * stage-0 entry's id when it is up to date with the worktree (or skip-worktree, the file
   * then read from the index), and no conversion applies; undefined otherwise
   */
  indexIgnoreOid?(path: string): string | undefined;
  /**
   * The id git records for a `.gitignore` missing from the worktree: the stage-0 entry's
   * when it is skip-worktree (read_skip_worktree_file_from_index reads its blob); undefined
   * otherwise, an assume-unchanged entry included (the null id is recorded then)
   */
  skipWorktreeIgnoreOid?(path: string): string | undefined;
  /**
   * git's `dir_struct` flags: 0 (`-uall`, the default here), `DIR_SHOW_OTHER_DIRECTORIES |
   * DIR_HIDE_EMPTY_DIRECTORIES` (`-unormal`), with `DIR_SHOW_IGNORED_TOO` (and
   * `DIR_SHOW_IGNORED_TOO_MODE_MATCHING`) for `--ignored`
   */
  flags?: number;
  /**
   * Literal paths (from the worktree's root, `.` for all of it) the scan is limited to, as
   * a pathspec of git's; none: the whole worktree. {@link matcher} takes over when given.
   */
  pathspec?: readonly string[];
  /**
   * A pathspec of any kind (wildcards, magic, excludes) the scan is limited to, as dir.c
   * asks it (vcs-commands' `untrackedScanPathspec` makes one from parsed elements)
   */
  matcher?: UntrackedScanPathspec;
  /**
   * The untracked cache to use and update, made for {@link flags}; only for a whole-tree
   * scan without ignored files (git's `validate_untracked_cache`). None: a plain scan
   */
  cache?: UntrackedCache;
  /** The index file's mtime in whole seconds (racy directory stats are read again) */
  indexSeconds?: number;
  /** How directory stats are compared (`core.trustctime`, `core.checkStat`) */
  stat?: StatMatchOptions;
  /** Called for each directory (not the root) that could not be listed */
  onUnreadable?(path: string, error: unknown): void;
}

/**
 * A pathspec as dir.c's directory walk asks it. Names are worktree paths, a directory's
 * with its trailing `/`.
 */
export interface UntrackedScanPathspec {
  /**
   * `match_pathspec_with_flags` (no `seen`): how the best positive element matches `name`
   * (`MATCHED_RECURSIVELY` 1, `MATCHED_RECURSIVELY_LEADING_PATHSPEC` 2, `MATCHED_FNMATCH`
   * 3, `MATCHED_EXACTLY` 4), 0 when none does or an exclude element matches; `leading` is
   * `DO_MATCH_LEADING_PATHSPEC` (a directory that may hold matches); a promise where the
   * answer needs a read first (the attributes of `:(attr:...)` elements)
   */
  match(name: string, leading: boolean): number | Promise<number>;
  /** `simplify_away`: no element can match `path` or anything below it */
  simplifyAway(path: string): boolean;
  /** `common_prefix_len`: the leading directories (with their `/`) the walk starts at */
  commonPrefix(): string;
}

/** What the scan found. */
export interface UntrackedScanResult {
  /** The untracked paths (a directory as `dir/`), sorted as git sorts them */
  paths: string[];
  /** The ignored paths (with `DIR_SHOW_IGNORED_TOO`; a directory as `dir/`), sorted */
  ignored: string[];
  /** Directories listed (the rest came from the cache) */
  directoriesRead: number;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const stripSlash = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);

/** dir.c's `enum path_treatment`, in its order of significance. */
const PATH_NONE = 0;
const PATH_RECURSE = 1;
const PATH_EXCLUDED = 2;
const PATH_UNTRACKED = 3;

/** dir.h's match results of a pathspec item. */
const MATCHED_RECURSIVELY = 1;
const MATCHED_RECURSIVELY_LEADING_PATHSPEC = 2;
const MATCHED_EXACTLY = 4;
/** dir.c's `DO_MATCH_*` flags. */
const DO_MATCH_DIRECTORY = 1 << 1;
const DO_MATCH_LEADING_PATHSPEC = 1 << 2;

/**
 * A pathspec of literal paths, matched as dir.c's `match_pathspec_item` matches an item
 * without wildcards.
 */
class LiteralPathspec implements UntrackedScanPathspec {
  readonly items: readonly string[];

  constructor(raw: readonly string[]) {
    this.items = raw.map((item) => {
      let p = item;
      while (p.startsWith("./")) p = p.slice(2);
      return p === "." ? "" : p;
    });
  }

  /** `do_match_pathspec`: the best match of any item (0: none). */
  match(name: string, leading: boolean): number {
    const flags = leading ? DO_MATCH_LEADING_PATHSPEC : 0;
    let best = 0;
    for (const item of this.items) {
      const how = matchItem(item, name, flags);
      if (how > best) best = how;
    }
    return best;
  }

  /** `simplify_away`: no item can match `path` or anything below it. */
  simplifyAway(path: string): boolean {
    for (const item of this.items) {
      const len = Math.min(item.length, path.length);
      if (item.slice(0, len) === path.slice(0, len)) return false;
    }
    return true;
  }

  /** `common_prefix_len`: the leading directories (with their `/`) all items share. */
  commonPrefix(): string {
    let max = 0;
    const first = this.items[0] as string;
    for (let n = 0; n < this.items.length; n++) {
      const item = this.items[n] as string;
      let len = 0;
      for (let i = 0; i < item.length && (n === 0 || i < max); i++) {
        const c = item[i];
        if (c !== first[i]) break;
        if (c === "/") len = i + 1;
      }
      if (n === 0 || len < max) {
        max = len;
        if (!max) break;
      }
    }
    return first.slice(0, max);
  }
}

/** `match_pathspec_item` for a literal item (no wildcards, no magic). */
function matchItem(match: string, name: string, flags: number): number {
  if (match === "") return MATCHED_RECURSIVELY;
  const matchlen = match.length;
  const namelen = name.length;
  if (matchlen <= namelen && name.startsWith(match)) {
    if (matchlen === namelen) return MATCHED_EXACTLY;
    if (match[matchlen - 1] === "/" || name[matchlen] === "/") return MATCHED_RECURSIVELY;
  } else if (
    flags & DO_MATCH_DIRECTORY &&
    match[matchlen - 1] === "/" &&
    namelen === matchlen - 1 &&
    match.startsWith(name)
  ) {
    return MATCHED_EXACTLY;
  }
  if (flags & DO_MATCH_LEADING_PATHSPEC) {
    const offset = name[namelen - 1] === "/" ? 1 : 0;
    if (namelen < matchlen && match[namelen - offset] === "/" && match.startsWith(name)) {
      return MATCHED_RECURSIVELY_LEADING_PATHSPEC;
    }
  }
  return 0;
}

/** One entry of a directory being read: from the disk, or from the cache. */
type CachedDirEntry =
  | { kind: "disk"; entry: DirectoryEntry }
  | { kind: "dir"; node: UntrackedCacheDir }
  | { kind: "file"; name: string };

/**
 * The untracked (and, as the flags ask, ignored) files of the worktree as `git status`
 * finds them, through the cache when one is given: the cache is updated in place, its
 * statistics (`dirOpened`, `dirInvalidated`, `gitignoreInvalidated`) telling whether it
 * changed.
 */
export async function scanUntracked(
  host: UntrackedScanHost,
  options: UntrackedScanOptions,
): Promise<UntrackedScanResult> {
  const flags = options.flags ?? 0;
  const pathspec: UntrackedScanPathspec | undefined =
    options.matcher ??
    (options.pathspec && options.pathspec.length > 0
      ? new LiteralPathspec(options.pathspec)
      : undefined);
  const cache = pathspec || flags & DIR_SHOW_IGNORED_TOO ? undefined : options.cache;
  const indexSeconds = options.indexSeconds ?? 0;
  const showIgnoredToo = (flags & DIR_SHOW_IGNORED_TOO) !== 0;
  const matching = showIgnoredToo && (flags & DIR_SHOW_IGNORED_TOO_MODE_MATCHING) !== 0;
  const hideEmpty = (flags & DIR_HIDE_EMPTY_DIRECTORIES) !== 0;
  const otherDirectories = (flags & DIR_SHOW_OTHER_DIRECTORIES) !== 0;
  // dir->entries and dir->ignored
  const entries: string[] = [];
  const ignored: string[] = [];
  let directoriesRead = 0;
  // git's exclude stack: each directory's .gitignore handled once per scan, ancestors first;
  // `stopped` holds the directories the rules exclude (nothing below them is read)
  const prepped = new Set<string>();
  const stopped = new Set<string>();
  const nodes = new Map<string, UntrackedCacheDir>();
  if (cache?.root) nodes.set("", cache.root);

  /** The cache node of `dir`, created down from the root (git's lookups in prep_exclude). */
  const nodeOf = (dir: string): UntrackedCacheDir | undefined => {
    if (!cache?.root) return undefined;
    const known = nodes.get(dir);
    if (known) return known;
    const slash = dir.lastIndexOf("/");
    const parent = nodeOf(slash < 0 ? "" : dir.slice(0, slash)) as UntrackedCacheDir;
    const node = lookupUntracked(cache, parent, slash < 0 ? dir : dir.slice(slash + 1));
    nodes.set(dir, node);
    return node;
  };

  /** git's `prep_exclude` for the directory `dir` (and its ancestors not yet done). */
  const prep = async (dir: string): Promise<void> => {
    if (prepped.has(dir)) return;
    if (dir !== "") {
      const slash = dir.lastIndexOf("/");
      const parent = slash < 0 ? "" : dir.slice(0, slash);
      await prep(parent);
      prepped.add(dir);
      // "Abort if the directory is excluded": its rules (and those below) are not read
      if (stopped.has(parent) || host.isExcluded(dir, true)) {
        stopped.add(dir);
        return;
      }
    }
    prepped.add(dir);
    const node = nodeOf(dir);
    // a directory the cache has valid with no .gitignore id is not read (git skips the
    // ENOENT it expects); otherwise its .gitignore is read and its id computed
    if (node?.valid && node.excludeOid === untrackedNullOid(cache)) return;
    const read = await host.loadIgnoreFile(dir);
    if (!node || !cache) return;
    const path = join(dir, ".gitignore");
    const nullOid = untrackedNullOid(cache);
    let oid = nullOid;
    if (read.kind === "file") {
      oid =
        read.bytes.length === 0
          ? await excludeFileOid(read.bytes, cache.objectFormat)
          : (options.indexIgnoreOid?.(path) ??
            (await excludeFileOid(read.bytes, cache.objectFormat)));
    } else {
      // read_skip_worktree_file_from_index: a skip-worktree entry's blob, by its id
      oid = options.skipWorktreeIgnoreOid?.(path) ?? nullOid;
    }
    if (oid !== node.excludeOid) {
      invalidateGitignore(cache, node);
      node.excludeOid = oid;
    }
  };

  /** git's `valid_cached_dir`: whether `dir`'s cached content can stand for it. */
  const validCachedDir = async (
    dir: string,
    node: UntrackedCacheDir,
    checkOnly: boolean,
  ): Promise<boolean> => {
    const st = await host.lstat(dir);
    if (!st) {
      node.stat = zeroStatData();
      return false;
    }
    const sd = statDataOf(st);
    if (!node.valid || !statDataMatches(node.stat, sd, indexSeconds, options.stat)) {
      node.stat = sd;
      return false;
    }
    if (node.checkOnly !== checkOnly) return false;
    await prep(dir);
    return node.valid;
  };

  /** `dir_add_name`: an untracked path, unless the index has it. */
  const addName = (path: string) => {
    if (!path.endsWith("/") && options.isTracked(path)) return;
    entries.push(path);
  };
  /** `dir_add_ignored`: an ignored path, unless the index has it (`index_name_is_other`). */
  const isTrackedExactly = options.isTrackedExactly ?? options.isTracked;
  const addIgnored = (path: string) => {
    if (isTrackedExactly(stripSlash(path))) return;
    ignored.push(path);
  };

  /** `add_path_to_appropriate_result_list` (without `DIR_SHOW_IGNORED`/`COLLECT_IGNORED`). */
  const addToResult = (
    path: string,
    state: number,
    node: UntrackedCacheDir | undefined,
    name: string,
    fromDisk: boolean,
  ) => {
    if (state === PATH_EXCLUDED) {
      if (showIgnoredToo) addIgnored(path);
    } else if (state === PATH_UNTRACKED) {
      addName(path);
      if (fromDisk && node) node.untracked.push(name);
    }
  };

  /**
   * `treat_directory`: what the untracked or ignored directory `path` (no `/`) in `parent`
   * is, read below as the flags ask.
   */
  const treatDirectory = async (
    path: string,
    parent: UntrackedCacheDir | undefined,
    name: string,
    excluded: boolean,
  ): Promise<number> => {
    const inIndex = options.indexDirectory(path);
    if (inIndex === "directory") return PATH_RECURSE;
    if (inIndex === "gitlink") return PATH_NONE;
    let matchesHow = 0;
    if (pathspec && !excluded) {
      const how = pathspec.match(`${path}/`, true);
      matchesHow = typeof how === "number" ? how : await how;
      if (!matchesHow) return PATH_NONE;
    }
    if (await host.isNestedRepository(path)) {
      if (matchesHow === MATCHED_RECURSIVELY_LEADING_PATHSPEC) return PATH_NONE;
      return excluded ? PATH_EXCLUDED : PATH_UNTRACKED;
    }
    if (!otherDirectories) {
      if (excluded && matching) {
        if (!hideEmpty) return PATH_EXCLUDED;
        const state = await readDirectoryRecursive(path, undefined, true, true);
        return state === PATH_EXCLUDED ? PATH_EXCLUDED : PATH_NONE;
      }
      return PATH_RECURSE;
    }
    if (matchesHow === MATCHED_RECURSIVELY_LEADING_PATHSPEC) return PATH_RECURSE;
    if (excluded) {
      if (!hideEmpty) return PATH_EXCLUDED;
      if (matching) return PATH_EXCLUDED;
    }
    if (!excluded && !(flags & (DIR_SHOW_IGNORED | DIR_SHOW_IGNORED_TOO)) && !hideEmpty) {
      return PATH_UNTRACKED;
    }
    const checkOnly = hideEmpty && !showIgnoredToo;
    const stopEarly = checkOnly && excluded;
    const oldIgnored = ignored.length;
    const oldUntracked = entries.length;
    const sub = parent && cache ? lookupUntracked(cache, parent, name) : undefined;
    if (sub) nodes.set(path, sub);
    let state = await readDirectoryRecursive(path, sub, checkOnly, stopEarly);
    if (state === PATH_EXCLUDED) {
      // everything below is ignored: the directory itself shows (or, with
      // --ignored=matching, the ignored paths below instead of it)
      if (matching) state = PATH_NONE;
      else ignored.length = oldIgnored;
    }
    // the untracked paths below never show with ignored ones (no DIR_KEEP_UNTRACKED_CONTENTS)
    if (showIgnoredToo) entries.length = oldUntracked;
    if (state === PATH_NONE && !hideEmpty) state = excluded ? PATH_EXCLUDED : PATH_UNTRACKED;
    return state;
  };

  /**
   * `treat_path` for an entry read from the disk: its treatment and its path (a directory's
   * with its `/`).
   */
  const treatPath = async (
    dir: string,
    node: UntrackedCacheDir | undefined,
    entry: DirectoryEntry,
    trackedHere: ReadonlySet<string> | undefined,
  ): Promise<{ state: number; path: string; name: string }> => {
    const name = entry.name;
    const path = join(dir, name);
    if (name === ".git") return { state: PATH_NONE, path, name };
    if (pathspec?.simplifyAway(path)) return { state: PATH_NONE, path, name };
    let kind = entry.kind;
    // always exclude indexed files (git asks the index before anything else)
    if (kind !== undefined && kind !== "directory" && trackedHere?.has(name)) {
      return { state: PATH_NONE, path, name };
    }
    if (kind === undefined) kind = (await host.lstat(path))?.kind;
    if (kind === undefined) return { state: PATH_NONE, path, name };
    const isDirectory = kind === "directory";
    if (!isDirectory && (trackedHere ? trackedHere.has(name) : options.isTracked(path))) {
      return { state: PATH_NONE, path, name };
    }
    // is_excluded: the rules of the directory and its parents
    await prep(dir);
    const excluded = host.isExcluded(path, isDirectory);
    if (excluded && !showIgnoredToo) return { state: PATH_EXCLUDED, path, name };
    if (isDirectory) {
      const state = await treatDirectory(path, node, name, excluded);
      return { state, path: `${path}/`, name: `${name}/` };
    }
    // a FIFO, socket or device is nothing git tracks
    if (kind === "other") return { state: PATH_NONE, path, name };
    if (pathspec) {
      const how = pathspec.match(path, false);
      if (!(typeof how === "number" ? how : await how)) return { state: PATH_NONE, path, name };
    }
    return { state: excluded ? PATH_EXCLUDED : PATH_UNTRACKED, path, name };
  };

  /**
   * git's `read_directory_recursive`: reads `dir` (no `/`; "" the root), from the cache
   * where it is valid, and gives the most significant treatment met. With `checkOnly` it
   * only finds whether the directory holds anything, stopping at the first untracked file
   * (or, with `stopAtFirstFile`, at the first file of any kind).
   */
  const readDirectoryRecursive = async (
    dir: string,
    node: UntrackedCacheDir | undefined,
    checkOnly: boolean,
    stopAtFirstFile: boolean,
  ): Promise<number> => {
    let dirState = PATH_NONE;
    // open_cached_dir
    let listing: DirectoryEntry[] | undefined;
    if (!(node && cache && (await validCachedDir(dir, node, checkOnly)))) {
      try {
        // in readdir order, as git reads a directory: a check-only walk stops at the first
        // untracked file it meets, so the order decides which directories it opens (and
        // warns about), and the cache records the names in that order
        listing = await host.listDirectory(dir, true);
      } catch (error) {
        if (dir !== "") options.onUnreadable?.(dir, error);
        if (node && cache) {
          invalidateDirectory(cache, node);
          cache.dirOpened++;
        }
        return PATH_NONE;
      }
      directoriesRead++;
      if (node && cache) {
        invalidateDirectory(cache, node);
        cache.dirOpened++;
      }
    }
    if (node) node.checkOnly = checkOnly;
    const fromDisk = listing !== undefined;
    // read_cached_dir: the disk's entries, else the cached subdirectories reached last
    // time, then the cached untracked names
    let items: CachedDirEntry[] | undefined;
    if (!listing) {
      const cached = node as UntrackedCacheDir;
      items = [];
      for (const sub of [...cached.dirs]) if (sub.recurse) items.push({ kind: "dir", node: sub });
      for (const name of cached.untracked) items.push({ kind: "file", name });
    }
    const trackedHere = fromDisk ? options.trackedIn?.(dir) : undefined;
    const count = listing ? listing.length : (items as CachedDirEntry[]).length;
    for (let k = 0; k < count; k++) {
      let state: number;
      let path: string;
      let name: string;
      if (listing) {
        const entry = listing[k] as DirectoryEntry;
        // a tracked file (of a known kind) is nothing to the walk: treatPath would give
        // PATH_NONE, which changes neither the state nor the result, so it is skipped here
        // without a promise, a path or a result object per file
        if (entry.kind !== undefined && entry.kind !== "directory" && trackedHere?.has(entry.name))
          continue;
        ({ state, path, name } = await treatPath(dir, node, entry, trackedHere));
      } else {
        const item = (items as CachedDirEntry[])[k] as CachedDirEntry;
        if (item.kind === "disk") {
          ({ state, path, name } = await treatPath(dir, node, item.entry, trackedHere));
        } else if (item.kind === "dir") {
          // treat_path_fast: a directory read only to check it is checked again so
          name = `${item.node.name}/`;
          path = join(dir, name);
          nodes.set(stripSlash(path), item.node);
          state = item.node.checkOnly
            ? await readDirectoryRecursive(stripSlash(path), item.node, true, false)
            : PATH_RECURSE;
        } else {
          name = item.name;
          path = join(dir, name);
          state = PATH_UNTRACKED;
        }
      }
      if (state > dirState) dirState = state;
      if (state === PATH_RECURSE) {
        const subPath = stripSlash(path);
        const sub = node && cache ? lookupUntracked(cache, node, name) : undefined;
        if (sub) nodes.set(subPath, sub);
        const subState = await readDirectoryRecursive(subPath, sub, checkOnly, stopAtFirstFile);
        if (subState > dirState) dirState = subState;
        if (pathspec) {
          const how = pathspec.match(path, false);
          if (!(typeof how === "number" ? how : await how)) state = PATH_NONE;
        }
      }
      if (checkOnly) {
        if (stopAtFirstFile && dirState >= PATH_EXCLUDED) {
          dirState = PATH_EXCLUDED;
          break;
        }
        if (dirState === PATH_UNTRACKED) {
          if (fromDisk && node) node.untracked.push(name);
          break;
        }
        continue;
      }
      addToResult(path, state, node, name, fromDisk);
    }
    // close_cached_dir: read through, so valid
    if (node) {
      node.valid = true;
      node.recurse = true;
    }
    return dirState;
  };

  /** git's `treat_leading_path`: whether the walk may start at `prefix` (ends with `/`). */
  const treatLeadingPath = async (prefix: string): Promise<boolean> => {
    const path = prefix.replace(/\/+$/, "");
    if (!path) return true;
    let baselen = 0;
    let state = PATH_NONE;
    let last: { path: string; name: string } | undefined;
    for (;;) {
      const prevlen = baselen + (baselen ? 1 : 0);
      const slash = path.indexOf("/", prevlen);
      baselen = slash < 0 ? path.length : slash;
      if ((await host.lstat(path.slice(0, baselen)))?.kind !== "directory") break;
      const parent = prevlen ? path.slice(0, prevlen - 1) : "";
      const name = path.slice(prevlen, baselen);
      const treated = await treatPath(parent, undefined, { name, kind: "directory" }, undefined);
      state = treated.state;
      last = treated;
      if (state !== PATH_RECURSE) break;
      if (path.length <= baselen) break;
    }
    if (last) addToResult(last.path, state, undefined, last.name, false);
    return state === PATH_RECURSE;
  };

  /** git's `has_symlink_leading_path`: a directory of `prefix` is a symbolic link. */
  const hasSymlinkLeadingPath = async (prefix: string): Promise<boolean> => {
    const parts = prefix.split("/").filter((p) => p !== "");
    for (let i = 1; i <= parts.length; i++) {
      const st = await host.lstat(parts.slice(0, i).join("/"));
      if (!st) return false;
      if (st.kind === "symlink") return true;
      if (st.kind !== "directory") return false;
    }
    return false;
  };

  // read_directory, from the pathspec's common leading directory
  const prefix = pathspec?.commonPrefix() ?? "";
  if (!prefix || !(await hasSymlinkLeadingPath(prefix))) {
    let root: UntrackedCacheDir | undefined;
    if (cache && !prefix) {
      // validate_untracked_cache: a cache without a root gets one (the caller marks it changed)
      cache.root ??= newUntrackedCacheDir("");
      root = cache.root;
      root.recurse = true;
      nodes.set("", root);
    }
    if (!prefix || (await treatLeadingPath(prefix))) {
      await readDirectoryRecursive(stripSlash(prefix), root, false, false);
    }
  }

  // as git status: the index decides what is untracked (`index_name_is_other`), and each
  // path is listed once (`string_list_sort_u`), in byte order
  const finish = (list: string[]) => {
    const out = [...new Set(list)].filter((p) => !options.isTracked(stripSlash(p)));
    out.sort(compareGitPaths);
    return out;
  };
  return { paths: finish(entries), ignored: finish(ignored), directoriesRead };
}

/**
 * Lookups over the index's paths for the untracked scan, by binary search in the sorted
 * entries instead of sets built of every path: the names directly in a directory
 * (`trackedIn`), and whether entries lie below a directory (`hasEntriesBelow`).
 *
 * ```typescript
 * const index = new IndexPathLookup(staging.entryList().map((e) => e.path));
 * index.trackedIn("src"); // Set { "a.ts", "b.ts" }
 * index.hasEntriesBelow("src"); // true
 *
 * // core.ignorecase, as every untracked walk asks the index (status, add, clean, stash -u)
 * const icase = new IndexPathLookup(paths, { ignoreCase: true, gitlinks: ["Sub"] });
 * icase.has("SRC/A.TS"); // true: index_file_exists with icase
 * icase.hasExactly("SRC/A.TS"); // false: index_name_is_other's exact check
 * icase.indexDirectory("sub"); // "gitlink": directory_exists_in_index_icase
 * ```
 */
export class IndexPathLookup {
  private readonly paths: readonly string[];
  private readonly ignoreCase: boolean;
  /** The gitlinks' paths (folded under `ignoreCase`) */
  private readonly gitlinks: ReadonlySet<string>;
  /** Under `ignoreCase`: the folded paths, and the folded names directly in each folded directory */
  private folded?: { paths: Set<string>; dirs: Map<string, CaseFoldedNames> };

  /**
   * @param paths The index's paths in index order (byte order; repeated for stages)
   * @param options `ignoreCase` (`core.ignorecase`): `has`, `hasEntriesBelow` and
   *   `trackedIn` fold ASCII case, as git's name hashes (`index_file_exists` with icase,
   *   `index_dir_exists`) do; `gitlinks`: the paths of the index's submodule entries, for
   *   {@link indexDirectory}; `sorted`: the paths are known to be in byte order already (the
   *   `all` of another lookup), not checked again
   */
  constructor(
    paths: readonly string[],
    options: { ignoreCase?: boolean; gitlinks?: Iterable<string>; sorted?: boolean } = {},
  ) {
    let sorted = true;
    for (let i = 1; i < paths.length && !options.sorted && sorted; i++) {
      if (compareGitPaths(paths[i - 1] as string, paths[i] as string) > 0) sorted = false;
    }
    this.paths = sorted ? paths : [...paths].sort(compareGitPaths);
    this.ignoreCase = options.ignoreCase ?? false;
    const fold = this.ignoreCase ? foldAsciiCase : (p: string) => p;
    this.gitlinks = new Set([...(options.gitlinks ?? [])].map(fold));
  }

  /**
   * git's `directory_exists_in_index`: "gitlink" for a submodule entry at `dir`, "directory"
   * for entries below it. Without `ignoreCase` the gitlink wins (it sorts first); with it,
   * `directory_exists_in_index_icase` asks the directory hash first, both folding case.
   */
  indexDirectory(dir: string): "directory" | "gitlink" | undefined {
    if (this.ignoreCase) {
      if (this.hasEntriesBelow(dir)) return "directory";
      return this.gitlinks.has(foldAsciiCase(dir)) ? "gitlink" : undefined;
    }
    if (this.gitlinks.has(dir)) return "gitlink";
    return this.hasEntriesBelow(dir) ? "directory" : undefined;
  }

  /** The folded lookups, built on first use. */
  private foldedLookups(): { paths: Set<string>; dirs: Map<string, CaseFoldedNames> } {
    if (this.folded) return this.folded;
    const paths = new Set<string>();
    const dirs = new Map<string, CaseFoldedNames>([["", new CaseFoldedNames()]]);
    for (const path of this.paths) {
      const key = foldAsciiCase(path);
      if (paths.has(key)) continue;
      paths.add(key);
      // every leading directory (git's directory hash), the name in its parent
      let start = 0;
      for (let at = key.indexOf("/"); at >= 0; at = key.indexOf("/", at + 1)) {
        const dir = key.slice(0, at);
        if (!dirs.has(dir)) dirs.set(dir, new CaseFoldedNames());
        start = at + 1;
      }
      (dirs.get(start ? key.slice(0, start - 1) : "") as CaseFoldedNames).add(key.slice(start));
    }
    this.folded = { paths, dirs };
    return this.folded;
  }

  /** Whether the index has an entry at exactly `path` (any stage), whatever `ignoreCase` says. */
  hasExactly(path: string): boolean {
    const at = this.lowerBound(path);
    return at < this.paths.length && this.paths[at] === path;
  }

  /** The first position whose path is not before `key`. */
  private lowerBound(key: string, from = 0): number {
    let lo = from;
    let hi = this.paths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareGitPaths(this.paths[mid] as string, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Whether the index has an entry at `path` (any stage), folding case under `ignoreCase`. */
  has(path: string): boolean {
    if (this.hasExactly(path)) return true;
    return this.ignoreCase && this.foldedLookups().paths.has(foldAsciiCase(path));
  }

  /** The paths, in index order. */
  get all(): readonly string[] {
    return this.paths;
  }

  /** Whether some path lies below `dir` (git's `index_directory`). */
  hasEntriesBelow(dir: string): boolean {
    if (this.ignoreCase) return this.foldedLookups().dirs.has(foldAsciiCase(dir));
    const prefix = `${dir}/`;
    const at = this.lowerBound(prefix);
    return at < this.paths.length && (this.paths[at] as string).startsWith(prefix);
  }

  /**
   * The names of the paths directly in `dir` ("" the root); subdirectories skipped whole.
   * Under `ignoreCase`, `dir` folds case, and so do the names (listed folded; `has` folds
   * the name it is asked).
   */
  trackedIn(dir: string): ReadonlySet<string> {
    if (this.ignoreCase) {
      return this.foldedLookups().dirs.get(foldAsciiCase(dir)) ?? new CaseFoldedNames();
    }
    const prefix = dir ? `${dir}/` : "";
    const names = new Set<string>();
    let i = prefix ? this.lowerBound(prefix) : 0;
    const n = this.paths.length;
    while (i < n) {
      const path = this.paths[i] as string;
      if (prefix && !path.startsWith(prefix)) break;
      const slash = path.indexOf("/", prefix.length);
      if (slash < 0) {
        names.add(prefix ? path.slice(prefix.length) : path);
        i++;
        continue;
      }
      // a subdirectory: everything below it sorts before "<sub>0" ('/' + 1)
      i = this.lowerBound(`${path.slice(0, slash)}0`, i + 1);
    }
    return names;
  }
}

/** Names kept folded (ASCII lower case), `has` folding the name asked. */
class CaseFoldedNames extends Set<string> {
  override has(name: string): boolean {
    return super.has(foldAsciiCase(name));
  }
}
