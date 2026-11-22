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
  IndexPathLookup,
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
 * A missing file is no local change, but one beneath a symbolically linked directory is. With `indexTime` (the index file's mtime, as the
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
  if (!current) {
    // git's lstat follows a symbolic link on a leading directory to whatever the file there
    // is, never the one the index recorded: a change (the worktree never looks beyond links)
    return entry.mode !== FileMode.GITLINK && (await beneathSymlink(worktree, path));
  }
  return differsFrom(worktree, path, entry, current, trust, indexTime);
}

/** Whether a leading directory of `path` is a symbolic link. */
async function beneathSymlink(worktree: Worktree, path: string): Promise<boolean> {
  for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
    const entry = await worktree.getEntry(path.slice(0, k)).catch(() => undefined);
    if (!entry) return false;
    if (entry.mode === FileMode.SYMLINK) return true;
    if (!entry.isDirectory) return false;
  }
  return false;
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
 *
 * `caseVariants` is `core.ignorecase`: git's `read_directory` asks the index through name
 * hashes that fold ASCII case (`index_file_exists` with icase), so a file the index has
 * only in another case is no untracked file, and goes with the directory. Such files are
 * collected in `caseVariants.found` (complete when the answer is false); a nested
 * repository is still asked exactly (git would take it as a case variant of a tracked
 * submodule and remove it; ours keeps it and refuses).
 */
export async function untrackedUnder(
  worktree: Worktree,
  dir: string,
  tracked: (path: string) => boolean,
  /** Ignored files count too (git's `verify_clean_subdirectory` without `o->internal.dir`) */
  includeIgnored = false,
  caseVariants?: { index: IndexPathLookup; found: string[] },
): Promise<boolean> {
  if (!tracked(dir) && (await isNestedRepository(worktree, dir))) return true;
  for await (const inside of worktree.walk({
    pathPrefix: dir,
    includeDirectories: true,
    ...(includeIgnored ? { includeIgnored: true } : {}),
  })) {
    if (inside.isDirectory) {
      // a nested repository is never entered by the walk: it is untracked content itself
      if (inside.mode === FileMode.GITLINK && !tracked(inside.path)) return true;
      continue;
    }
    if (tracked(inside.path)) continue;
    if (caseVariants?.index.has(inside.path)) {
      caseVariants.found.push(inside.path);
      continue;
    }
    return true;
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
  /**
   * Under `core.ignorecase`: untracked files in a directory a written file replaces that the
   * index has in another case. git's `verify_clean_subdirectory` takes them as tracked and
   * its checkout removes them with the directory. Collected only with
   * `caseVariantsExpendable` (else they are in the way, as before); the operation removes
   * them before its writes, the directory then holding nothing it would lose.
   */
  caseVariants?: string[];
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
    /**
     * With `ignoreCase`: case variants of index paths in a directory a file replaces are no
     * untracked files (`verify_clean_subdirectory`'s read_directory) but `caseVariants`,
     * which the caller removes before it writes (checkout). Without it they are in the way.
     */
    caseVariantsExpendable?: boolean;
  },
): Promise<InTheWay> {
  const { writes, removes, index } = options;
  const untracked = new Set<string>();
  const lostDirs: string[] = [];
  const caseVariants: string[] = [];
  let folded: IndexPathLookup | undefined;
  // the index by folded path (git's index_file_exists with icase: memihash and strncasecmp
  // fold ASCII letters only), built only when needed
  let foldedEntries: Map<string, unknown> | undefined;
  const otherCase = (path: string): CheckedEntry | undefined => {
    if (!foldedEntries) {
      foldedEntries = new Map();
      for (const [p, e] of index) {
        const key = foldAsciiCase(p);
        if (!foldedEntries.has(key)) foldedEntries.set(key, e);
      }
    }
    const entry = foldedEntries.get(foldAsciiCase(path)) as CheckedEntry | undefined;
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
      // untracked files and nested repositories there would be lost (git refuses); under
      // core.ignorecase the source index is asked folding case (read_directory's
      // index_file_exists): a case variant of a tracked file there goes with the directory
      const keeps = (p: string) => tracked(p) || removes.has(p);
      folded ??=
        options.ignoreCase && options.caseVariantsExpendable
          ? new IndexPathLookup([...index.keys()], { ignoreCase: true })
          : undefined;
      const variants = folded ? { index: folded, found: [] as string[] } : undefined;
      if (await untrackedUnder(worktree, path, keeps, false, variants)) lostDirs.push(path);
      else if (variants) caseVariants.push(...variants.found);
      continue;
    }
    if (await icaseExists(path, entry)) continue;
    if (!(await worktree.isIgnored(path))) untracked.add(path);
  }
  return {
    untracked: [...untracked],
    lostDirs,
    ...(options.caseVariantsExpendable ? { caseVariants } : {}),
  };
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
 * one on a racy entry has its content checked. A missing file is no change, but one
 * beneath a symbolically linked directory is.
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
  if (!current) {
    // git's lstat follows a symbolic link among the leading directories to whatever is
    // there, never the file the index recorded: a change, as for an unflagged entry (the
    // switch then never writes through the link)
    return entry.mode !== FileMode.GITLINK && (await beneathSymlink(worktree, path));
  }
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

/** What {@link statThroughLeadingLinks} found beyond a link. */
export interface LinkedStat {
  /** The entry the path reaches through the link(s); undefined when nothing is there */
  entry?: WorktreeEntry;
  /** The link points outside the worktree (or loops): what is there cannot be looked at */
  unknown?: boolean;
}

/** Links followed in one path at most before it is given up (POSIX `ELOOP`). */
const MAX_LINKS = 40;

/**
 * What `lstat(path)` finds when a leading directory of `path` is a symbolic link, which
 * the system follows (git's `check_local_mod`, `verify_uptodate`): the entry at the place
 * the link names, resolved within the worktree only (nothing is read beyond it: an
 * absolute target or one climbing out of the worktree is `unknown`). Undefined when no
 * leading directory of `path` is a link (the path's own `getEntry` is the answer). Only
 * reads: nothing is ever written through a link.
 */
export async function statThroughLeadingLinks(
  worktree: Worktree,
  path: string,
): Promise<LinkedStat | undefined> {
  let current = path;
  let linked = false;
  for (let followed = 0; ; ) {
    const parts = current.split("/");
    let next: string | undefined;
    for (let k = 1; k < parts.length; k++) {
      const prefix = parts.slice(0, k).join("/");
      const entry = await worktree.getEntry(prefix).catch(() => undefined);
      if (!entry) return linked ? {} : undefined;
      if (entry.mode === FileMode.SYMLINK) {
        if (++followed > MAX_LINKS) return { unknown: true };
        const resolved = resolveLinkTarget(prefix, await readLinkTarget(worktree, prefix));
        if (resolved === undefined) return { unknown: true };
        const rest = parts.slice(k).join("/");
        next = resolved ? `${resolved}/${rest}` : rest;
        break;
      }
      // ENOTDIR: a file among the leading components
      if (!entry.isDirectory) return linked ? {} : undefined;
    }
    if (next === undefined) {
      if (!linked) return undefined;
      const entry = await worktree.getEntry(current).catch(() => undefined);
      return entry ? { entry } : {};
    }
    linked = true;
    current = next;
  }
}

/**
 * What `stat(path)` finds: every symbolic link on the way followed, the last component's
 * included, within the worktree only (a link pointing out of it, or looping, finds nothing).
 * Undefined when nothing is there.
 */
export async function statFollowingLinks(
  worktree: Worktree,
  path: string,
): Promise<WorktreeEntry | undefined> {
  let current = path;
  for (let followed = 0; followed <= MAX_LINKS; followed++) {
    const through = await statThroughLeadingLinks(worktree, current);
    if (through) {
      if (through.unknown || !through.entry) return undefined;
      // a link reached through another one: where it lies is not tracked here
      return through.entry.mode === FileMode.SYMLINK ? undefined : through.entry;
    }
    const entry = await worktree.getEntry(current).catch(() => undefined);
    if (entry?.mode !== FileMode.SYMLINK) return entry;
    const resolved = resolveLinkTarget(current, await readLinkTarget(worktree, current));
    if (resolved === undefined) return undefined;
    if (resolved === "") return worktree.getEntry("").catch(() => undefined);
    current = resolved;
  }
  return undefined;
}

async function readLinkTarget(worktree: Worktree, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
  let size = 0;
  for (const c of chunks) size += c.length;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The worktree path the link at `linkPath` names with `target` ("" for the root), or
 * undefined when it lies outside the worktree (absolute, or climbing above the root).
 */
function resolveLinkTarget(linkPath: string, target: string): string | undefined {
  if (target === "" || target.startsWith("/")) return undefined;
  const out = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
