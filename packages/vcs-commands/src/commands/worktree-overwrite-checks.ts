/**
 * What a checkout or a stash apply must not overwrite, as git's unpack-trees checks it
 * before writing anything: local changes (`verify_uptodate`), untracked files on a path or
 * a leading component (`verify_absent`, `check_leading_path`), and untracked files in a
 * directory a file replaces (`verify_clean_subdirectory`).
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { Worktree, WorktreeModeTrust } from "@statewalker/vcs-working-tree";

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
 * A missing file is no local change.
 */
export async function worktreeDiffers(
  worktree: Worktree,
  path: string,
  entry: CheckedEntry,
  trust?: WorktreeModeTrust,
): Promise<boolean> {
  const current = await worktree.getEntry(path);
  if (!current) return false;
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
  // the stat the index recorded still matches: unchanged, as git's ie_match_stat
  if (
    entry.mtime &&
    current.size === entry.size &&
    current.mtime === entry.mtime &&
    (entry.ctime === undefined || current.ctime === undefined || entry.ctime === current.ctime)
  ) {
    return false;
  }
  if ((current.mode === FileMode.SYMLINK) !== (entry.mode === FileMode.SYMLINK)) {
    // a link written as a file (core.symlinks=false) is still the link
    if (worktree.capabilities?.symlinks !== false) return true;
  }
  return (await worktree.computeHash(path)) !== entry.objectId;
}

/** What stands where an operation writes: untracked files, and directories with some. */
export interface InTheWay {
  /** Untracked files or links on a written path, or on a leading component of one */
  untracked: string[];
  /** Directories a written file replaces that hold untracked files */
  lostDirs: string[];
}

/**
 * Finds what stands where `writes` (paths not in the index) are written, `removes` being
 * the tracked paths the operation deletes first. Ignored files are expendable, as in git.
 * With `ignoreCase`, a file that is one of `removes` in another case is no obstacle (a
 * case-only rename on a case-folding worktree).
 */
export async function findInTheWay(
  worktree: Worktree,
  options: {
    writes: string[];
    removes: Set<string>;
    index: Map<string, unknown>;
    ignoreCase?: boolean;
  },
): Promise<InTheWay> {
  const { writes, removes, index } = options;
  const untracked = new Set<string>();
  const lostDirs: string[] = [];
  const removingFolded = new Set([...removes].map((p) => p.toLowerCase()));
  const tracked = (p: string) => index.has(p) && !removes.has(p);
  for (const path of writes) {
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
      for await (const inside of worktree.walk({ pathPrefix: path })) {
        if (!tracked(inside.path) && !removes.has(inside.path)) {
          lostDirs.push(path);
          break;
        }
      }
      continue;
    }
    if (options.ignoreCase && removingFolded.has(path.toLowerCase())) continue;
    if (!(await worktree.isIgnored(path))) untracked.add(path);
  }
  return { untracked: [...untracked], lostDirs };
}

/** Removes the directories a removal left empty, up to the worktree root (as git). */
export async function pruneEmptyParents(worktree: Worktree, path: string): Promise<void> {
  const parts = path.split("/");
  for (let k = parts.length - 1; k > 0; k--) {
    const dir = parts.slice(0, k).join("/");
    const entry = await worktree.getEntry(dir);
    if (!entry?.isDirectory) return;
    for await (const _ of worktree.walk({ pathPrefix: dir, includeIgnored: true })) return;
    await worktree.remove(dir, { recursive: true });
  }
}

/** git's refusal messages (unpack-trees), for `checkout` or `merge` (stash apply). */
export function overwriteMessage(
  action: "checkout" | "merge",
  found: {
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
  if (found.local?.length) {
    parts.push(
      [
        `error: Your local changes to the following files would be overwritten by ${action}:`,
        ...list(found.local),
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
