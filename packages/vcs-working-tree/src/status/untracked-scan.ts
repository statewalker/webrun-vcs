/**
 * The untracked-file scan of `git status` (dir.c `read_directory` for `-uall` without
 * ignored files), with git's untracked cache.
 *
 * ```typescript
 * const result = await scanUntracked(host, {
 *   isTracked: (path) => index.has(path),
 *   indexDirectory: (dir) => (dirs.has(dir) ? "directory" : undefined),
 *   cache, // the index's UNTR, made for `-uall` (dir flags 0), or undefined
 *   indexSeconds,
 * });
 * result.paths; // ["new-file", "nested-repo/", ...] sorted
 * ```
 *
 * A directory is listed unless the cache has it valid, its stat unchanged and its
 * `.gitignore` hashing the same (`valid_cached_dir`); then its untracked names and its
 * subdirectories come from the cache. The order of everything git records (which
 * directories it reads, when it reads each `.gitignore`, the names in readdir order) is
 * git's, so the cache written afterwards holds the bytes git would write.
 */

import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { DirectoryEntry, LinkStats } from "@statewalker/vcs-utils/files";
import {
  excludeFileOid,
  invalidateDirectory,
  invalidateGitignore,
  lookupUntracked,
  NULL_OID,
  newUntrackedCacheDir,
  type StatMatchOptions,
  statDataMatches,
  statDataOf,
  type UntrackedCache,
  type UntrackedCacheDir,
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
   * (the order the cache records). Throws when the directory cannot be read.
   */
  listDirectory(path: string, readdirOrder: boolean): Promise<DirectoryEntry[]>;
  /** The entry itself (a link not followed); undefined when nothing is there */
  lstat(path: string): Promise<LinkStats | undefined>;
  /**
   * Reads `<dir>/.gitignore` (never through a link) and makes its rules the ones of `dir`
   * for {@link isExcluded} (a missing file read from its skip-worktree index entry, as the
   * worktree does). Called at most once per directory and scan, before any path below that
   * directory is checked.
   */
  loadIgnoreFile(dir: string): Promise<IgnoreFileRead>;
  /** Whether the ignore rules loaded so far exclude `path` */
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
  /** Whether the index has an entry at `path` (any stage) */
  isTracked(path: string): boolean;
  /**
   * The names of the index entries directly in `dir` (any stage), asked once per directory
   * listed: faster than `isTracked` per file. Optional.
   */
  trackedIn?(dir: string): ReadonlySet<string>;
  /** git's `directory_exists_in_index`: entries below `dir`, or a gitlink at it */
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
  /** The untracked cache to use and update (made for dir flags 0); none: a plain scan */
  cache?: UntrackedCache;
  /** The index file's mtime in whole seconds (racy directory stats are read again) */
  indexSeconds?: number;
  /** How directory stats are compared (`core.trustctime`, `core.checkStat`) */
  stat?: StatMatchOptions;
  /** Called for each directory (not the root) that could not be listed */
  onUnreadable?(path: string, error: unknown): void;
}

/** What the scan found. */
export interface UntrackedScanResult {
  /** The untracked paths (a nested repository as `dir/`), sorted as git sorts them */
  paths: string[];
  /** Directories listed (the rest came from the cache) */
  directoriesRead: number;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * The untracked files of the worktree as `git status -uall` finds them (no ignored files,
 * no pathspec), through the cache when one is given: the cache is updated in place, its
 * statistics (`dirOpened`, `dirInvalidated`, `gitignoreInvalidated`) telling whether it
 * changed.
 */
export async function scanUntracked(
  host: UntrackedScanHost,
  options: UntrackedScanOptions,
): Promise<UntrackedScanResult> {
  const cache = options.cache;
  const indexSeconds = options.indexSeconds ?? 0;
  const found: string[] = [];
  let directoriesRead = 0;
  // git's exclude stack: each directory's .gitignore handled once per scan, ancestors first
  const prepped = new Set<string>();
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
      await prep(slash < 0 ? "" : dir.slice(0, slash));
    }
    prepped.add(dir);
    const node = nodeOf(dir);
    // a directory the cache has valid with no .gitignore id is not read (git skips the
    // ENOENT it expects); otherwise its .gitignore is read and its id computed
    if (node?.valid && node.excludeOid === NULL_OID) return;
    const read = await host.loadIgnoreFile(dir);
    if (!node || !cache) return;
    const path = join(dir, ".gitignore");
    let oid = NULL_OID;
    if (read.kind === "file") {
      oid =
        read.bytes.length === 0
          ? await excludeFileOid(read.bytes)
          : (options.indexIgnoreOid?.(path) ?? (await excludeFileOid(read.bytes)));
    } else {
      // read_skip_worktree_file_from_index: a skip-worktree entry's blob, by its id
      oid = options.skipWorktreeIgnoreOid?.(path) ?? NULL_OID;
    }
    if (oid !== node.excludeOid) {
      invalidateGitignore(cache, node);
      node.excludeOid = oid;
    }
  };

  /** git's `valid_cached_dir`: whether `dir`'s cached content can stand for it. */
  const validCachedDir = async (dir: string, node: UntrackedCacheDir): Promise<boolean> => {
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
    if (node.checkOnly) return false;
    await prep(dir);
    return node.valid;
  };

  /** git's `read_directory_recursive` (check_only 0). */
  const readDirectory = async (dir: string, node: UntrackedCacheDir | undefined) => {
    if (node && cache && (await validCachedDir(dir, node))) {
      node.checkOnly = false;
      // the cached subdirectories first, then the cached files (read_cached_dir)
      for (const sub of [...node.dirs]) {
        if (!sub.recurse) continue;
        const path = join(dir, sub.name);
        nodes.set(path, sub);
        await readDirectory(path, sub);
      }
      for (const name of node.untracked) found.push(join(dir, name));
      node.valid = true;
      node.recurse = true;
      return;
    }
    let entries: DirectoryEntry[];
    try {
      entries = await host.listDirectory(dir, !!cache);
    } catch (error) {
      if (dir !== "") options.onUnreadable?.(dir, error);
      if (node && cache) {
        invalidateDirectory(cache, node);
        cache.dirOpened++;
      }
      return;
    }
    directoriesRead++;
    if (node && cache) {
      invalidateDirectory(cache, node);
      cache.dirOpened++;
      node.checkOnly = false;
    }
    const trackedHere = options.trackedIn?.(dir);
    for (const entry of entries) {
      const name = entry.name;
      if (name === ".git") continue;
      let kind = entry.kind;
      // always exclude indexed files (git asks the index before anything else)
      if (kind !== undefined && kind !== "directory" && trackedHere?.has(name)) continue;
      const path = join(dir, name);
      if (kind === undefined) kind = (await host.lstat(path))?.kind;
      if (kind === undefined) continue;
      const isDirectory = kind === "directory";
      if (!isDirectory && (trackedHere ? trackedHere.has(name) : options.isTracked(path))) continue;
      // is_excluded: the rules of the directory and its parents
      await prep(dir);
      if (host.isExcluded(path, isDirectory)) continue;
      if (isDirectory) {
        // treat_directory
        const inIndex = options.indexDirectory(path);
        if (inIndex === "gitlink") continue;
        if (inIndex === undefined && (await host.isNestedRepository(path))) {
          found.push(`${path}/`);
          if (node) node.untracked.push(`${name}/`);
          continue;
        }
        const sub = node && cache ? lookupUntracked(cache, node, name) : undefined;
        if (sub) nodes.set(path, sub);
        await readDirectory(path, sub);
        continue;
      }
      // a FIFO, socket or device is nothing git tracks
      if (kind === "other") continue;
      found.push(path);
      if (node) node.untracked.push(name);
    }
    if (node) {
      node.valid = true;
      node.recurse = true;
    }
  };

  let root: UntrackedCacheDir | undefined;
  if (cache) {
    // validate_untracked_cache: a cache without a root gets one (the caller marks it changed)
    cache.root ??= newUntrackedCacheDir("");
    root = cache.root;
    root.recurse = true;
    nodes.set("", root);
  }
  await readDirectory("", root);

  // as git status: the index decides what is untracked, whatever the cache said
  const paths = found.filter((p) => !options.isTracked(p.endsWith("/") ? p.slice(0, -1) : p));
  // byte order, as git's cmp_dir_entry and string-list sort
  paths.sort(compareGitPaths);
  return { paths, directoriesRead };
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
 * ```
 */
export class IndexPathLookup {
  private readonly paths: readonly string[];

  /** @param paths The index's paths in index order (byte order; repeated for stages) */
  constructor(paths: readonly string[]) {
    let sorted = true;
    for (let i = 1; i < paths.length && sorted; i++) {
      if (compareGitPaths(paths[i - 1] as string, paths[i] as string) > 0) sorted = false;
    }
    this.paths = sorted ? paths : [...paths].sort(compareGitPaths);
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

  /** Whether the index has an entry at `path` (any stage). */
  has(path: string): boolean {
    const at = this.lowerBound(path);
    return at < this.paths.length && this.paths[at] === path;
  }

  /** The paths, in index order. */
  get all(): readonly string[] {
    return this.paths;
  }

  /** Whether some path lies below `dir` (git's `index_directory`). */
  hasEntriesBelow(dir: string): boolean {
    const prefix = `${dir}/`;
    const at = this.lowerBound(prefix);
    return at < this.paths.length && (this.paths[at] as string).startsWith(prefix);
  }

  /** The names of the paths directly in `dir` ("" the root); subdirectories skipped whole. */
  trackedIn(dir: string): Set<string> {
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
