/**
 * The worktree side of `git status`: index entries compared with the files on disk
 * (git's `run_diff_files`), and the files the index does not track (untracked, ignored).
 *
 * The comparison trusts the stat the index recorded, as git's `ie_match_stat` does: a file
 * whose size and modification time still match its entry is unchanged and never read. An
 * entry whose modification time is not older than the index file itself is "racily clean"
 * (it may have changed within the same tick after it was staged), so it is re-hashed, as
 * git re-hashes such entries. Only files whose stat does not match are read.
 */

import { EMPTY_BLOB_ID, FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { StagingEntry } from "../staging/types.js";
import type { WorktreeEntry } from "../worktree/types.js";
import type { Worktree } from "../worktree/worktree.js";
import { modeFromWorktree, type WorktreeModeTrust } from "../worktree/worktree-mode.js";
import type { UntrackedScanHost } from "./untracked-scan.js";

const S_IFMT = 0o170000;

/** How a worktree file differs from its index entry. */
export type WorktreeChangeKind = "modified" | "deleted" | "typechange";

/** The outcome of comparing one index entry with the worktree. */
export interface WorktreeComparison {
  /** How the file differs; undefined when it still holds the entry */
  kind?: WorktreeChangeKind;
  /** The file on disk, when there is one (a directory counts as none) */
  worktreeEntry?: WorktreeEntry;
  /** The mode git would stage for the file (`ce_mode_from_stat`), when there is one */
  worktreeMode?: number;
  /** The file's blob id, when it had to be hashed */
  hashedId?: ObjectId;
  /**
   * The file changed though its entry is racy (modified at or after the index was written):
   * writing the index must give it size 0 so the next comparison reads it again even when
   * its stat matches (git's smudging)
   */
  smudge?: boolean;
}

/** What the comparison of index entries with the worktree needs. */
export interface WorktreeCompareOptions {
  /** What the worktree's modes can be trusted for (`core.filemode`, `core.symlinks`) */
  trust?: WorktreeModeTrust;
  /**
   * When the index was last written (ms), as `Staging.getUpdateTime()` reports it: entries
   * modified at or after it are re-hashed (racy git). 0 or absent: every entry is racy.
   */
  indexTime?: number;
}

/** What the worktree's modes can be trusted for, from its capabilities alone. */
export function defaultModeTrust(worktree: Worktree): WorktreeModeTrust {
  return {
    executable: worktree.capabilities?.executable !== false,
    symlinks: worktree.capabilities?.symlinks !== false,
  };
}

/** Whether `a` and `b` are the same kind of entry (file, link, gitlink). */
function sameType(a: number, b: number): boolean {
  return (a & S_IFMT) === (b & S_IFMT);
}

/** Times in whole milliseconds: the index and the filesystem may keep fractions differently. */
const ms = (t: number | undefined) => Math.floor(t ?? 0);

/**
 * Whole seconds of a time in milliseconds. When the exact nanoseconds within the second are
 * known they decide: a double cannot hold nanoseconds at today's dates, so a time just below
 * a whole second (.999999931) can read as the next second in milliseconds.
 */
function seconds(t: number | undefined, ns?: number): number {
  const time = t ?? 0;
  if (ns !== undefined && Number.isInteger(ns) && ns >= 0 && ns < 1e9) {
    const approx = (((time % 1000) + 1000) % 1000) * 1e6;
    const distance = Math.abs(approx - ns);
    if (Math.min(distance, 1e9 - distance) < 2e6) return Math.round((time - ns / 1e6) / 1000);
  }
  return Math.floor(ms(time) / 1000);
}

/**
 * Whether a time the index recorded matches the file's, compared in whole seconds as git
 * compares them in its default build (without USE_NSEC). The fraction the index keeps is not
 * reliable: writers record it differently (a time set through utimes can come back a few
 * nanoseconds off), so comparing it would make unchanged files look changed. A same-size
 * edit within the same second is caught by the racy check instead, as in git.
 */
function sameTime(
  recorded: number | undefined,
  recordedNs: number | undefined,
  current: number | undefined,
  currentNs: number | undefined,
): boolean {
  return seconds(recorded, recordedNs) === seconds(current, currentNs);
}

/** Whole seconds of a time in milliseconds, the exact nanoseconds deciding where known. */
export const wholeSeconds = seconds;

/** What git's `ce_match_stat_basic` compares of a file against its index entry. */
export interface StatTrust {
  /** Compare ctime (`core.trustctime`, not `core.checkStat=minimal`); default true */
  ctime?: boolean;
  /** Compare inode, owner and group (not `core.checkStat=minimal`); default true */
  fullStat?: boolean;
}

/**
 * Whether the file's stat still matches the index entry, as git's `ce_match_stat_basic`
 * (default build): size, mtime and ctime in whole seconds, and inode, owner and group where
 * the worktree reports them (an entry recorded without them, as 0, then does not match, as
 * in git). An entry git smudged (size 0 while its blob is not the empty blob) never matches.
 */
export function basicStatMatches(
  entry: StagingEntry,
  current: WorktreeEntry,
  trust: StatTrust = {},
): boolean {
  if (ms(entry.mtime) === 0) return false;
  if (entry.size === 0 && entry.objectId !== EMPTY_BLOB_ID && entry.mode !== FileMode.GITLINK) {
    return false;
  }
  if (current.size !== entry.size) return false;
  if (!sameTime(entry.mtime, entry.mtimeNs, current.mtime, current.mtimeNs)) return false;
  if (
    trust.ctime !== false &&
    entry.ctime !== undefined &&
    current.ctime !== undefined &&
    !sameTime(entry.ctime, entry.ctimeNs, current.ctime, current.ctimeNs)
  ) {
    return false;
  }
  if (trust.fullStat !== false) {
    // git compares st_ino (and st_dev only when built with USE_STDEV, which it is not by
    // default), st_uid and st_gid, in 32 bits
    // An entry without an inode (written before stats were recorded) is checked again, as
    // git does for its ino 0. Owner and group are compared only where the entry kept them:
    // stores that do not keep them would otherwise re-hash every file on every status.
    const ino = current.ino;
    if (ino !== undefined && (entry.ino ?? 0) >>> 0 !== ino >>> 0) return false;
    for (const key of ["uid", "gid"] as const) {
      const now = current[key];
      const recorded = entry[key];
      if (now !== undefined && recorded !== undefined && recorded >>> 0 !== now >>> 0) return false;
    }
  }
  return true;
}

/**
 * Racy git: an entry whose mtime is not older than the index file (in whole seconds, as
 * git's default build compares them) may hide a same-size change, so its content is checked.
 */
function isRacy(
  recorded: number | undefined,
  recordedNs: number | undefined,
  indexTime: number,
): boolean {
  if (indexTime === 0) return true;
  return seconds(recorded, recordedNs) >= seconds(indexTime);
}

/**
 * Compares one index entry (stage 0) with the worktree, as git's `run_diff_files`: missing
 * (or a directory in its place) is "deleted", a file of another kind is "typechange", other
 * content or (where trusted) executable bit is "modified". A matching stat that is not racy
 * settles it without reading the file.
 */
export async function compareWithWorktree(
  worktree: Worktree,
  entry: StagingEntry,
  options: WorktreeCompareOptions = {},
  prefetched?: WorktreeEntry | null,
): Promise<WorktreeComparison> {
  const trust = options.trust ?? defaultModeTrust(worktree);
  // `prefetched`: the entry's file as a stat pass found it (`withWorktreeEntries`), null for none
  const current =
    prefetched === undefined ? await worktree.getEntry(entry.path) : (prefetched ?? undefined);
  const quick = compareWithWorktreeStat(entry, current ?? null, trust, options.indexTime ?? 0);
  if (quick) return quick;
  if (entry.mode === FileMode.GITLINK) {
    // a submodule: its directory (populated or not) is no change; its contents are not ours
    if (!current) return { kind: "deleted" };
    if (current.isDirectory) {
      // the commit checked out there against the index's (an unpopulated one is no change)
      const head = await worktree.readGitlinkHead?.(entry.path);
      const found = { worktreeEntry: current, worktreeMode: FileMode.GITLINK };
      if (head && head !== entry.objectId) return { kind: "modified", ...found, hashedId: head };
      return found;
    }
    return { kind: "typechange", worktreeEntry: current, worktreeMode: current.mode };
  }
  // undecided by the stat: a file of the entry's kind whose stat changed (or is racy) while
  // its size did not
  const file = current as WorktreeEntry;
  const found = {
    worktreeEntry: file,
    worktreeMode: modeFromWorktree(file.mode, entry.mode, trust),
  };
  const statMatches = basicStatMatches(entry, file, trust);
  const racy = isRacy(entry.mtime, entry.mtimeNs, options.indexTime ?? 0);
  const hashedId = await worktree.computeHash(entry.path);
  if (hashedId === entry.objectId) return { ...found, hashedId };
  // a racy entry that changed: smudged when the index is written, as git does for an entry
  // its own (coarser) stat check would take as clean
  return { kind: "modified", ...found, hashedId, ...(statMatches && racy ? { smudge: true } : {}) };
}

/**
 * Whether the file still holds the entry by its stat alone, without allocating: a file (or
 * link) of the entry's kind and mode whose stat matches and is not racy. The common answer
 * of a stat pass; anything else goes to {@link compareWithWorktreeStat}.
 */
export function isCleanByStat(
  entry: StagingEntry,
  current: WorktreeEntry | null,
  trust: WorktreeModeTrust,
  indexTime: number,
): boolean {
  if (!current || current.isDirectory || entry.intentToAdd) return false;
  if (entry.mode === FileMode.GITLINK) return false;
  const worktreeMode = modeFromWorktree(current.mode, entry.mode, trust);
  if (worktreeMode !== entry.mode) return false;
  if (!basicStatMatches(entry, current, trust)) return false;
  return !isRacy(entry.mtime, entry.mtimeNs, indexTime);
}

/**
 * {@link compareWithWorktree} for the entries its stat settles, synchronously: a file
 * missing, of another kind or mode, clean by a stat that is not racy, or changed in size.
 * Undefined when the answer needs a read (a submodule, a racy or stat-changed same-size
 * file): the caller then awaits `compareWithWorktree`. A stat pass over many entries calls
 * this first so that only the few undecided ones cost a promise.
 *
 * @param current The entry's file as the stat pass found it (null: nothing there)
 * @param indexTime When the index was written (ms); 0 makes every entry racy
 */
export function compareWithWorktreeStat(
  entry: StagingEntry,
  current: WorktreeEntry | null,
  trust: WorktreeModeTrust,
  indexTime: number,
): WorktreeComparison | undefined {
  if (entry.mode === FileMode.GITLINK) return undefined;
  if (!current) return { kind: "deleted" };
  // a directory where the file was: deleted, the directory kept for the caller to see
  if (current.isDirectory) return { kind: "deleted", worktreeEntry: current };
  const worktreeMode = modeFromWorktree(current.mode, entry.mode, trust);
  const found = { worktreeEntry: current, worktreeMode };
  if (!sameType(worktreeMode, entry.mode)) return { kind: "typechange", ...found };
  if (entry.intentToAdd) return found;
  if (entry.mode !== FileMode.SYMLINK && worktreeMode !== entry.mode) {
    return { kind: "modified", ...found };
  }
  const statMatches = basicStatMatches(entry, current, trust);
  // racy git: an entry not older than the index file may hide a same-size change
  if (statMatches && !isRacy(entry.mtime, entry.mtimeNs, indexTime)) return found;
  // a known size that differs is a change, without reading the file (git: DATA_CHANGED)
  if (
    entry.size !== 0 &&
    current.size !== entry.size &&
    current.mode !== FileMode.SYMLINK &&
    entry.mode !== FileMode.SYMLINK
  ) {
    return { kind: "modified", ...found };
  }
  return undefined;
}

/** One index entry that no longer matches the worktree. */
export interface WorktreeChange extends WorktreeComparison {
  path: string;
  kind: WorktreeChangeKind;
  /** The index entry (stage 0) */
  entry: StagingEntry;
}

/**
 * The index entries (stage 0) whose worktree file differs, in index order, one entry at a
 * time (git's `diff-files`). Entries marked skip-worktree or assume-valid are not checked,
 * as in git; `filter` limits the paths.
 */
export async function* diffIndexWithWorktree(
  entries: AsyncIterable<StagingEntry> | Iterable<StagingEntry>,
  worktree: Worktree,
  options: WorktreeCompareOptions & { filter?: (path: string) => boolean } = {},
): AsyncIterable<WorktreeChange> {
  const filter = options.filter;
  const wanted = (entry: StagingEntry) =>
    entry.stage === 0 &&
    !entry.skipWorktree &&
    !entry.assumeValid &&
    (!filter || filter(entry.path));
  for await (const { item: entry, current } of withWorktreeEntries(worktree, entries, wanted)) {
    if (current === undefined) continue;
    const result = await compareWithWorktree(worktree, entry, options, current);
    if (result.kind) yield { ...result, path: entry.path, entry, kind: result.kind };
  }
}

/**
 * The worktree entries of `paths` (undefined where nothing is), in their order: one
 * `getEntries` where the worktree has it, else `getEntry` path by path.
 */
export async function getWorktreeEntries(
  worktree: Pick<Worktree, "getEntry" | "getEntries">,
  paths: readonly string[],
): Promise<Array<WorktreeEntry | undefined>> {
  if (worktree.getEntries) return worktree.getEntries(paths);
  const out: Array<WorktreeEntry | undefined> = [];
  for (const path of paths) out.push(await worktree.getEntry(path));
  return out;
}

/** How many paths a stat pass asks the worktree for at once. */
const STAT_CHUNK = 4096;

/**
 * Items (index entries) with the worktree entries of their paths, stat'ed a chunk at a time
 * (git's `preload_index` before `refresh_index`): `current` is the file (null for none) of
 * each item `wanted` accepts, undefined for the others, which are not stat'ed. The items
 * keep their order; a chunk is stat'ed just before its items are yielded.
 */
export async function* withWorktreeEntries<T extends { path: string }>(
  worktree: Worktree,
  items: AsyncIterable<T> | Iterable<T>,
  wanted: (item: T) => boolean = () => true,
): AsyncIterable<{ item: T; current: WorktreeEntry | null | undefined }> {
  let chunk: T[] = [];
  let asked: boolean[] = [];
  let paths: string[] = [];
  const flush = async function* () {
    const found = paths.length > 0 ? await getWorktreeEntries(worktree, paths) : [];
    let k = 0;
    const done = chunk;
    const doneAsked = asked;
    chunk = [];
    asked = [];
    paths = [];
    for (let i = 0; i < done.length; i++) {
      const item = done[i] as T;
      if (!doneAsked[i]) yield { item, current: undefined };
      else yield { item, current: found[k++] ?? null };
    }
  };
  for await (const item of items) {
    const want = wanted(item);
    chunk.push(item);
    asked.push(want);
    if (want) paths.push(item.path);
    if (paths.length >= STAT_CHUNK || chunk.length >= 4 * STAT_CHUNK) yield* flush();
  }
  yield* flush();
}

/** A file on disk the index does not track. */
export interface UntrackedFile {
  /** The path; a nested repository's directory ends with `/`, as git shows it */
  path: string;
  /** The worktree's entry */
  entry: WorktreeEntry;
  /** Whether the ignore rules exclude it */
  ignored: boolean;
}

/**
 * The files the index does not track (git's `ls-files -o`): every file, link, and nested
 * repository (`sub/`) the worktree walk finds that `isTracked` does not claim. Ignored files
 * only with `includeIgnored`; a file in an ignored directory is ignored. Directories are not
 * listed: an untracked directory shows as the files in it (`-uall`).
 */
export async function* findUntrackedFiles(
  worktree: Worktree,
  isTracked: (path: string) => boolean,
  options: {
    includeIgnored?: boolean;
    filter?: (path: string) => boolean;
    /**
     * Whether the index tracks paths below a directory: a nested repository's directory
     * holding tracked paths is descended into (git treats it as an ordinary directory)
     */
    hasTrackedUnder?: (dir: string) => boolean;
    /**
     * Whether the index has a submodule (gitlink) at a path: its directory is never entered,
     * populated or not (a deinitialised submodule's leftover files are not untracked)
     */
    isGitlink?: (path: string) => boolean;
    /**
     * Called for each directory the scan could not list (and `filter` accepts), with the
     * error: git's "could not open directory" warning ({@link unreadableDirectoryWarning})
     */
    onUnreadable?: (path: string, error?: unknown) => void;
  } = {},
): AsyncIterable<UntrackedFile> {
  const includeIgnored = options.includeIgnored ?? false;
  const ignoredDirs: string[] = [];
  const inIgnoredDir = (path: string) => ignoredDirs.some((dir) => path.startsWith(`${dir}/`));
  const skippedDirs: string[] = [];
  const inSkippedDir = (path: string) => skippedDirs.some((dir) => path.startsWith(`${dir}/`));
  const report = options.onUnreadable;
  const onUnreadable = report
    ? (path: string, error?: unknown) => {
        if (path === "" || inSkippedDir(path)) return;
        if (options.filter && !options.filter(path)) return;
        report(path, error);
      }
    : undefined;
  const visit = async function* (pathPrefix?: string): AsyncIterable<UntrackedFile> {
    for await (const entry of worktree.walk({
      includeIgnored,
      includeDirectories: true,
      // tracked files are passed over unstat'ed (git's treat_path asks the index first)
      skipFile: isTracked,
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(onUnreadable ? { onUnreadable } : {}),
    })) {
      if (inSkippedDir(entry.path)) continue;
      const ignored = entry.isIgnored || inIgnoredDir(entry.path);
      if (entry.isDirectory) {
        if (options.isGitlink?.(entry.path)) {
          skippedDirs.push(entry.path);
          continue;
        }
        if (entry.isIgnored) ignoredDirs.push(entry.path);
        if (entry.mode !== FileMode.GITLINK || isTracked(entry.path)) continue;
        if (options.hasTrackedUnder?.(entry.path)) {
          yield* visit(entry.path);
          continue;
        }
        if (options.filter && !options.filter(entry.path)) continue;
        if (ignored && !includeIgnored) continue;
        yield { path: `${entry.path}/`, entry, ignored };
        continue;
      }
      if (isTracked(entry.path)) continue;
      if (options.filter && !options.filter(entry.path)) continue;
      if (ignored && !includeIgnored) continue;
      yield { path: entry.path, entry, ignored };
    }
  };
  yield* visit();
}

/**
 * An {@link UntrackedScanHost} over a worktree that offers none of its own (one in memory):
 * built from one walk of everything, ignored paths and directories included, so that
 * `scanUntracked` can run dir.c's walk on it. The worktree's own ignore answers stand for
 * the rules (a path inside an ignored directory is ignored); no `.gitignore` is read and no
 * untracked cache can be used (no worktree location).
 *
 * ```typescript
 * const host = worktree.untrackedScanHost
 *   ? await worktree.untrackedScanHost()
 *   : await walkUntrackedScanHost(worktree);
 * ```
 */
export async function walkUntrackedScanHost(worktree: Worktree): Promise<UntrackedScanHost> {
  const children = new Map<string, Array<{ name: string; kind: LinkKind }>>();
  const entries = new Map<string, WorktreeEntry>();
  const unreadable = new Map<string, unknown>();
  const walked = new Set<string>();
  const kindOf = (e: WorktreeEntry): LinkKind =>
    e.isDirectory ? "directory" : e.mode === FileMode.SYMLINK ? "symlink" : "file";
  const walkFrom = async (prefix: string) => {
    walked.add(prefix);
    if (!children.has(prefix)) children.set(prefix, []);
    for await (const e of worktree.walk({
      includeIgnored: true,
      includeDirectories: true,
      ...(prefix ? { pathPrefix: prefix } : {}),
      onUnreadable: (path, error) => unreadable.set(path, error),
    })) {
      if (entries.has(e.path)) continue;
      entries.set(e.path, e);
      const slash = e.path.lastIndexOf("/");
      const dir = slash < 0 ? "" : e.path.slice(0, slash);
      let list = children.get(dir);
      if (!list) {
        list = [];
        children.set(dir, list);
      }
      list.push({ name: e.name, kind: kindOf(e) });
      // a nested repository is not entered by the walk: listed on demand
      if (e.isDirectory && e.mode !== FileMode.GITLINK) {
        walked.add(e.path);
        if (!children.has(e.path)) children.set(e.path, []);
      }
    }
  };
  await walkFrom("");
  const ignoredSelf = (path: string) => entries.get(path)?.isIgnored === true;
  return {
    listDirectory: async (path) => {
      if (unreadable.has(path)) throw unreadable.get(path);
      if (!walked.has(path)) await walkFrom(path);
      return children.get(path) ?? [];
    },
    lstat: async (path) => {
      if (path === "") return { kind: "directory", size: 0, lastModified: 0 };
      const e = entries.get(path);
      return e ? { kind: kindOf(e), size: e.size, lastModified: e.mtime } : undefined;
    },
    loadIgnoreFile: async () => ({ kind: "missing" }),
    isExcluded: (path) => {
      if (ignoredSelf(path)) return true;
      for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
        if (ignoredSelf(path.slice(0, k))) return true;
      }
      return false;
    },
    isNestedRepository: async (path) => entries.get(path)?.mode === FileMode.GITLINK,
  };
}

type LinkKind = "file" | "directory" | "symlink" | "other";

/** strerror(3) of the errno codes a directory listing fails with. */
const STRERROR: Record<string, string> = {
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOTDIR: "Not a directory",
  ENOENT: "No such file or directory",
  ELOOP: "Too many levels of symbolic links",
  EMFILE: "Too many open files",
  ENFILE: "Too many open files in system",
  EIO: "Input/output error",
};

/**
 * git's warning for a directory its scan could not open (`warning_errno("could not open
 * directory '%s'")`), the reason as strerror gives it for the error's code (an `EACCES`
 * error, or a message that starts with the code): "Permission denied" when the code is not
 * known.
 *
 * @example
 * ```typescript
 * unreadableDirectoryWarning("u/v", { code: "EACCES" });
 * // "warning: could not open directory 'u/v/': Permission denied"
 * ```
 */
export function unreadableDirectoryWarning(path: string, error?: unknown): string {
  const code =
    (error as { code?: unknown } | undefined)?.code ??
    /^([A-Z][A-Z0-9]+)\b/.exec((error as Error | undefined)?.message ?? "")?.[1];
  const reason = (typeof code === "string" && STRERROR[code]) || "Permission denied";
  return `warning: could not open directory '${path}/': ${reason}`;
}

/** The directories that hold the given paths (`a/b/c` gives `a` and `a/b`). */
export function directoriesOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  // paths in index order share their directory with the one before: added once
  let last = "";
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) continue;
    if (path.length > slash && last.length === slash && path.startsWith(last)) continue;
    last = path.slice(0, slash);
    for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) dirs.add(path.slice(0, k));
  }
  return dirs;
}

/** A `hasTrackedUnder` predicate for {@link findUntrackedFiles} over the tracked paths. */
export function trackedUnder(tracked: Iterable<string>): (dir: string) => boolean {
  const dirs = directoriesOf(tracked);
  return (dir) => dirs.has(dir);
}
