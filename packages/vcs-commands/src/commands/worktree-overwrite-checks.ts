/**
 * What a checkout or a stash apply must not overwrite, as git's unpack-trees checks it
 * before writing anything: local changes (`verify_uptodate`), untracked files on a path or
 * a leading component (`verify_absent`, `check_leading_path`), and untracked files in a
 * directory a file replaces (`verify_clean_subdirectory`).
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";
import {
  basicStatMatches,
  type StagingEntry,
  type Worktree,
  type WorktreeEntry,
  type WorktreeModeTrust,
  wholeSeconds,
} from "@statewalker/vcs-working-tree";

/** An index or tree entry, with the index's stat where it has one. */
export interface CheckedEntry {
  objectId: ObjectId;
  mode: number;
  size?: number;
  mtime?: number;
  ctime?: number;
}

/**
 * Whether the worktree file at `path` no longer holds the index entry (git's
 * `verify_uptodate`): changed content, type, or executable bit where the worktree shows it.
 * A missing file is no local change. With `indexTime` (the index file's mtime, as the
 * caller's index was last read or written: git's `istate->timestamp`), a stat that matches
 * as git's `ie_match_stat` compares it, on an entry older than the index (not racy),
 * settles it without reading the file, as in git; a racy entry is read. A caller that
 * rewrites the index where git does (`write_index_as_tree`) passes the new file's time.
 */
export async function worktreeDiffers(
  worktree: Worktree,
  path: string,
  entry: CheckedEntry,
  trust?: WorktreeModeTrust,
  indexTime?: number,
): Promise<boolean> {
  const current = await worktree.getEntry(path);
  if (!current) return false;
  return differsFrom(worktree, path, entry, current, trust, indexTime);
}

async function differsFrom(
  worktree: Worktree,
  path: string,
  entry: CheckedEntry,
  current: WorktreeEntry,
  trust?: WorktreeModeTrust,
  indexTime?: number,
): Promise<boolean> {
  if (current.isDirectory) return entry.mode !== FileMode.GITLINK;
  if (entry.mode === FileMode.GITLINK) return false;
  if (
    trust?.executable &&
    entry.mode !== FileMode.SYMLINK &&
    current.mode !== FileMode.SYMLINK &&
    (current.mode === FileMode.EXECUTABLE_FILE) !== (entry.mode === FileMode.EXECUTABLE_FILE)
  ) {
    return true;
  }
  // git's ie_match_stat: a recorded stat that still matches settles it, unless the entry is
  // racy (modified at or after the index file was written, so a same-size edit in that
  // second kept the stat): its content is checked. Without the index's time (absent or 0:
  // unknown) only an exact match of size, mtime and ctime is trusted.
  const known = indexTime !== undefined && indexTime > 0;
  const racy =
    known &&
    (!entry.mtime ||
      wholeSeconds(entry.mtime, (entry as StagingEntry).mtimeNs) >= wholeSeconds(indexTime));
  if (
    !racy &&
    entry.mtime &&
    current.size === entry.size &&
    current.mtime === entry.mtime &&
    (entry.ctime === undefined || current.ctime === undefined || entry.ctime === current.ctime)
  ) {
    return false;
  }
  if (
    known &&
    !racy &&
    (current.mode === FileMode.SYMLINK) === (entry.mode === FileMode.SYMLINK) &&
    basicStatMatches(entry as StagingEntry, current, trust)
  ) {
    return false;
  }
  if ((current.mode === FileMode.SYMLINK) !== (entry.mode === FileMode.SYMLINK)) {
    // a link written as a file (core.symlinks=false) is still the link
    if (worktree.capabilities?.symlinks !== false) return true;
  }
  return (await worktree.computeHash(path)) !== entry.objectId;
}

/**
 * Whether the worktree file at `path` no longer holds the index entry, a missing file
 * included: what git's `require_clean_work_tree` and `reset --hard` (`ie_match_stat` after
 * `lstat`) see as a change, where an overwrite check ({@link worktreeDiffers}) does not.
 */
export async function worktreeModified(
  worktree: Worktree,
  path: string,
  entry: CheckedEntry,
  trust?: WorktreeModeTrust,
  indexTime?: number,
): Promise<boolean> {
  const current = await worktree.getEntry(path);
  if (!current) return entry.mode !== FileMode.GITLINK;
  return differsFrom(worktree, path, entry, current, trust, indexTime);
}

/**
 * Whether the directory at `dir` holds anything git's `verify_clean_subdirectory` would
 * lose by replacing it: an untracked file or link that is not ignored, or a nested
 * repository (a directory with a `.git` that is not a tracked submodule), the directory
 * itself being one included. `tracked` tells the paths the index keeps track of there.
 */
export async function untrackedUnder(
  worktree: Worktree,
  dir: string,
  tracked: (path: string) => boolean,
): Promise<boolean> {
  if (!tracked(dir) && (await isNestedRepository(worktree, dir))) return true;
  for await (const inside of worktree.walk({ pathPrefix: dir, includeDirectories: true })) {
    if (inside.isDirectory) {
      // a nested repository is never entered by the walk: it is untracked content itself
      if (inside.mode === FileMode.GITLINK && !tracked(inside.path)) return true;
      continue;
    }
    if (!tracked(inside.path)) return true;
  }
  return false;
}

/** Whether `dir` holds a `.git` of its own (a nested repository, or what may be one). */
async function isNestedRepository(worktree: Worktree, dir: string): Promise<boolean> {
  if (worktree.isRepository) return worktree.isRepository(dir);
  return worktree.exists(`${dir}/.git`);
}

/** What stands where an operation writes: untracked files, and directories with some. */
export interface InTheWay {
  /** Untracked files or links on a written path, or on a leading component of one */
  untracked: string[];
  /**
   * Directories a written file replaces that hold untracked files, or tracked files the
   * operation does not remove (never replaced behind the index's back)
   */
  lostDirs: string[];
}

/**
 * Finds what stands where `writes` (paths not in the index) are written, `removes` being
 * the tracked paths the operation deletes first. Ignored files are expendable, as in git.
 * With `ignoreCase`, a file that is an index entry seen in another case is no obstacle (a
 * case-only rename on a case-folding worktree), as git's `icase_exists`: only where the
 * worktree folds case (`foldsCase` not false) and the file's stat matches that entry's,
 * so it is that entry's file. An untracked file of its own in the other case (a
 * case-sensitive worktree with `core.ignorecase` set) is still in the way.
 */
export async function findInTheWay(
  worktree: Worktree,
  options: {
    writes: string[];
    removes: Set<string>;
    /** The index's entries (their stat compared where `ignoreCase` needs it) */
    index: Map<string, unknown>;
    ignoreCase?: boolean;
    /** Whether the worktree folds case ({@link Worktree.foldsCase}); undefined: unknown */
    foldsCase?: boolean;
  },
): Promise<InTheWay> {
  const { writes, removes, index } = options;
  const untracked = new Set<string>();
  const lostDirs: string[] = [];
  // the index by folded path (git's index_file_exists with icase: memihash and strncasecmp
  // fold ASCII letters only), built only when needed
  let folded: Map<string, unknown> | undefined;
  const otherCase = (path: string): CheckedEntry | undefined => {
    if (!folded) {
      folded = new Map();
      for (const [p, e] of index) {
        const key = foldAsciiCase(p);
        if (!folded.has(key)) folded.set(key, e);
      }
    }
    const entry = folded.get(foldAsciiCase(path)) as CheckedEntry | undefined;
    return typeof entry?.mode === "number" ? entry : undefined;
  };
  const icaseExists = async (path: string, current: WorktreeEntry): Promise<boolean> => {
    if (!options.ignoreCase || options.foldsCase === false) return false;
    const entry = otherCase(path);
    if (!entry) return false;
    if ((current.mode === FileMode.SYMLINK) !== (entry.mode === FileMode.SYMLINK)) return false;
    if (basicStatMatches(entry as StagingEntry, current)) return true;
    // an entry without a usable stat (a store that records none): its content tells
    return !entry.mtime && !(await differsFrom(worktree, path, entry, current));
  };
  const tracked = (p: string) => index.has(p) && !removes.has(p);
  // directories holding tracked files that stay: a file written there would replace them
  // (read from the index only when something is written)
  let trackedDirs: Set<string> | undefined;
  const holdsTracked = (dir: string) => {
    if (!trackedDirs) {
      trackedDirs = new Set<string>();
      for (const p of index.keys()) {
        if (removes.has(p)) continue;
        for (let k = p.indexOf("/"); k > 0; k = p.indexOf("/", k + 1)) {
          trackedDirs.add(p.slice(0, k));
        }
      }
    }
    return trackedDirs.has(dir);
  };
  for (const path of writes) {
    if (holdsTracked(path)) {
      lostDirs.push(path);
      continue;
    }
    if (index.has(path)) continue;
    const parts = path.split("/");
    let blocked = false;
    for (let k = 1; k < parts.length && !blocked; k++) {
      const prefix = parts.slice(0, k).join("/");
      const entry = await worktree.getEntry(prefix);
      if (!entry || entry.isDirectory || removes.has(prefix)) continue;
      if (!(await worktree.isIgnored(prefix))) untracked.add(prefix);
      blocked = true;
    }
    if (blocked) continue;
    const entry = await worktree.getEntry(path);
    if (!entry) continue;
    if (entry.isDirectory) {
      // untracked files and nested repositories there would be lost (git refuses)
      const keeps = (p: string) => tracked(p) || removes.has(p);
      if (await untrackedUnder(worktree, path, keeps)) lostDirs.push(path);
      continue;
    }
    if (await icaseExists(path, entry)) continue;
    if (!(await worktree.isIgnored(path))) untracked.add(path);
  }
  return { untracked: [...untracked], lostDirs };
}

/**
 * Removes the directory at `dir` if it holds nothing at all, as git's `rmdir`: never a
 * directory with a file, link, subdirectory, nested repository (`.git`) or FIFO in it, and
 * never recursively. Returns whether it was removed.
 */
export async function removeDirectoryIfEmpty(
  worktree: Worktree,
  dir: string,
  options?: { nonRepositoryGitDirs?: boolean },
): Promise<boolean> {
  if (worktree.removeEmptyDirectory) return worktree.removeEmptyDirectory(dir, options);
  // a `.git` that is no repository can only be removed by a worktree that knows it
  if (options?.nonRepositoryGitDirs && dir.split("/").includes(".git")) return false;
  // a worktree without the operation: the walk shows directories (nested repositories too)
  const entry = await worktree.getEntry(dir);
  if (!entry?.isDirectory) return false;
  const inside = worktree.walk({ pathPrefix: dir, includeIgnored: true, includeDirectories: true });
  for await (const _ of inside) return false;
  if (await worktree.exists(`${dir}/.git`)) return false;
  // never recursive: a worktree that cannot remove a directory that way keeps it
  return worktree.remove(dir);
}

/**
 * Removes the directories a removal left empty, bottom-up to the worktree root, as git's
 * `schedule_dir_for_removal`: each only if it is truly empty, stopping at the first that is
 * not (a nested repository, an ignored or untracked file, a FIFO keeps its directory).
 */
export async function pruneEmptyParents(worktree: Worktree, path: string): Promise<void> {
  const parts = path.split("/");
  for (let k = parts.length - 1; k > 0; k--) {
    if (!(await removeDirectoryIfEmpty(worktree, parts.slice(0, k).join("/")))) return;
  }
}

/** git's refusal messages (unpack-trees), for `checkout` or `merge` (stash apply). */
export function overwriteMessage(
  action: "checkout" | "merge",
  found: {
    /** Staged changes the operation would lose (git's ERROR_WOULD_OVERWRITE), listed first */
    staged?: string[];
    local?: string[];
    lostDirs?: string[];
    untracked?: string[];
    untrackedRemoved?: string[];
  },
): string | undefined {
  const list = (paths: string[]) => paths.map((p) => `\t${p}`);
  const advice =
    action === "checkout"
      ? "Please commit your changes or stash them before you switch branches."
      : "Please commit your changes or stash them before you merge.";
  const move =
    action === "checkout"
      ? "Please move or remove them before you switch branches."
      : "Please move or remove them before you merge.";
  const parts: string[] = [];
  for (const paths of [found.staged, found.local]) {
    if (!paths?.length) continue;
    parts.push(
      [
        `error: Your local changes to the following files would be overwritten by ${action}:`,
        ...list(paths),
        advice,
      ].join("\n"),
    );
  }
  if (found.lostDirs?.length) {
    parts.push(
      [
        "error: Updating the following directories would lose untracked files in them:",
        ...list(found.lostDirs),
        "",
      ].join("\n"),
    );
  }
  if (found.untracked?.length) {
    parts.push(
      [
        `error: The following untracked working tree files would be overwritten by ${action}:`,
        ...list(found.untracked),
        move,
      ].join("\n"),
    );
  }
  if (found.untrackedRemoved?.length) {
    parts.push(
      [
        `error: The following untracked working tree files would be removed by ${action}:`,
        ...list(found.untrackedRemoved),
        move,
      ].join("\n"),
    );
  }
  return parts.length > 0 ? [...parts, "Aborting"].join("\n") : undefined;
}

/**
 * Whether the worktree file at `path` differs from an index entry whose flags cheat
 * (assume-unchanged, skip-worktree), as git's `verify_uptodate_1` checks such an entry
 * before overwriting or removing its file: `ie_match_stat` with `CE_MATCH_IGNORE_VALID`, so
 * a stat that no longer matches is a change (the content is not compared), and a matching
 * one on a racy entry has its content checked. A missing file is no change.
 */
export async function flaggedEntryDiffers(
  worktree: Worktree,
  path: string,
  entry: StagingEntry,
  trust?: WorktreeModeTrust,
  indexTime?: number,
  /** The file's worktree entry when the caller stat'ed it already (null: none) */
  stat?: WorktreeEntry | null,
): Promise<boolean> {
  const current = stat === undefined ? await worktree.getEntry(path) : stat;
  if (!current) return false;
  if (current.isDirectory) return entry.mode !== FileMode.GITLINK;
  if (entry.mode === FileMode.GITLINK) return false;
  // an intent-to-add entry never matches its file (ie_match_stat: DATA_CHANGED)
  if (entry.intentToAdd) return true;
  if ((current.mode === FileMode.SYMLINK) !== (entry.mode === FileMode.SYMLINK)) return true;
  if (
    trust?.executable &&
    entry.mode !== FileMode.SYMLINK &&
    (current.mode === FileMode.EXECUTABLE_FILE) !== (entry.mode === FileMode.EXECUTABLE_FILE)
  ) {
    return true;
  }
  if (!basicStatMatches(entry, current, trust)) return true;
  // an index without a timestamp (0) has no racy entry (git's is_racy_stat)
  const racy =
    indexTime === undefined ||
    (indexTime > 0 && wholeSeconds(entry.mtime, entry.mtimeNs) >= wholeSeconds(indexTime));
  return racy && (await worktree.computeHash(path)) !== entry.objectId;
}

/**
 * git's `verify_uptodate` of an index entry before a switch overwrites or removes its file:
 * an entry whose flags cheat (assume-unchanged, skip-worktree) by its stat
 * ({@link flaggedEntryDiffers}), any other as {@link worktreeDiffers} (git refreshed it).
 */
export async function entryNotUptodate(
  worktree: Worktree,
  path: string,
  entry: CheckedEntry,
  trust?: WorktreeModeTrust,
  indexTime?: number,
): Promise<boolean> {
  const e = entry as StagingEntry;
  if (e.assumeValid || e.skipWorktree) {
    return flaggedEntryDiffers(worktree, path, e, trust, indexTime);
  }
  return worktreeDiffers(worktree, path, entry, trust, indexTime);
}
