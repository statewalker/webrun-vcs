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

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { StagingEntry } from "../staging/types.js";
import type { WorktreeEntry } from "../worktree/types.js";
import type { Worktree } from "../worktree/worktree.js";
import { modeFromWorktree, type WorktreeModeTrust } from "../worktree/worktree-mode.js";

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

/** Whole seconds of a time in milliseconds. */
const seconds = (t: number | undefined) => Math.floor(ms(t) / 1000);

/**
 * Whether a time the index recorded matches the file's, compared in whole seconds as git
 * compares them in its default build (without USE_NSEC). The fraction the index keeps is not
 * reliable: writers record it differently (a time set through utimes can come back a few
 * nanoseconds off), so comparing it would make unchanged files look changed. A same-size
 * edit within the same second is caught by the racy check instead, as in git.
 */
function sameTime(recorded: number | undefined, current: number | undefined): boolean {
  return seconds(recorded) === seconds(current);
}

/**
 * Racy git: an entry whose mtime is not older than the index file (in whole seconds, as
 * git's default build compares them) may hide a same-size change, so its content is checked.
 */
function isRacy(recorded: number | undefined, indexTime: number): boolean {
  if (indexTime === 0) return true;
  return seconds(recorded) >= seconds(indexTime);
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
): Promise<WorktreeComparison> {
  const trust = options.trust ?? defaultModeTrust(worktree);
  const current = await worktree.getEntry(entry.path);
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
  const indexTime = options.indexTime ?? 0;
  const statMatches =
    ms(entry.mtime) !== 0 &&
    current.size === entry.size &&
    sameTime(entry.mtime, current.mtime) &&
    (entry.ctime === undefined ||
      current.ctime === undefined ||
      sameTime(entry.ctime, current.ctime));
  // racy git: an entry not older than the index file may hide a same-size change
  const racy = isRacy(entry.mtime, indexTime);
  if (statMatches && !racy) return found;
  // a known size that differs is a change, without reading the file (git: DATA_CHANGED)
  if (
    entry.size !== 0 &&
    current.size !== entry.size &&
    current.mode !== FileMode.SYMLINK &&
    entry.mode !== FileMode.SYMLINK
  ) {
    return { kind: "modified", ...found };
  }
  const hashedId = await worktree.computeHash(entry.path);
  if (hashedId === entry.objectId) return { ...found, hashedId };
  // a racy entry that changed: smudged when the index is written, as git does for an entry
  // its own (coarser) stat check would take as clean
  return { kind: "modified", ...found, hashedId, ...(racy ? { smudge: true } : {}) };
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
  for await (const entry of entries) {
    if (entry.stage !== 0 || entry.skipWorktree || entry.assumeValid) continue;
    if (options.filter && !options.filter(entry.path)) continue;
    const result = await compareWithWorktree(worktree, entry, options);
    if (result.kind) yield { ...result, path: entry.path, entry, kind: result.kind };
  }
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
  } = {},
): AsyncIterable<UntrackedFile> {
  const includeIgnored = options.includeIgnored ?? false;
  const ignoredDirs: string[] = [];
  const inIgnoredDir = (path: string) => ignoredDirs.some((dir) => path.startsWith(`${dir}/`));
  const visit = async function* (pathPrefix?: string): AsyncIterable<UntrackedFile> {
    for await (const entry of worktree.walk({
      includeIgnored,
      includeDirectories: true,
      ...(pathPrefix ? { pathPrefix } : {}),
    })) {
      const ignored = entry.isIgnored || inIgnoredDir(entry.path);
      if (entry.isDirectory) {
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

/** The directories that hold the given paths (`a/b/c` gives `a` and `a/b`). */
export function directoriesOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) dirs.add(path.slice(0, k));
  }
  return dirs;
}

/** A `hasTrackedUnder` predicate for {@link findUntrackedFiles} over the tracked paths. */
export function trackedUnder(tracked: Iterable<string>): (dir: string) => boolean {
  const dirs = directoriesOf(tracked);
  return (dir) => dirs.has(dir);
}
