/**
 * The trees of a stash, built as `git stash push` builds them:
 *
 * - the index tree: the index written as a tree (`git write-tree`);
 * - the worktree tree: the index with every tracked path that differs from HEAD in the
 *   worktree updated from the file on disk, or removed where the file is gone (git's
 *   `stash_working_tree`: `diff-index HEAD` piped to `update-index --add --remove`);
 * - the untracked tree: the files the index does not track (`ls-files -o`, with the
 *   ignore rules unless `includeIgnored`), as `stash -u` / `stash -a` keep them.
 *
 * Files are compared with the index through its stat (racy entries re-hashed); only files
 * that changed are read, once, while they are stored.
 */

import { type Blobs, FileMode, type ObjectId, type Trees } from "@statewalker/vcs-core";
import type { Staging } from "../staging/staging.js";
import { applyStatUpdate, type IndexStatUpdate } from "../staging/stat-refresh.js";
import type { StagingEntry } from "../staging/types.js";
import {
  compareWithWorktree,
  defaultModeTrust,
  findUntrackedFiles,
  trackedUnder,
  type WorktreeComparison,
} from "../status/worktree-status.js";
import { isUnknownContentId } from "../worktree/hash-worktree-file.js";
import { storeWorktreeFile } from "../worktree/store-worktree-file.js";
import type { WorktreeEntry } from "../worktree/types.js";
import type { Worktree } from "../worktree/worktree.js";
import { modeFromWorktree, type WorktreeModeTrust } from "../worktree/worktree-mode.js";
import { flattenTree } from "./checkout-utils.js";

/** What the stash trees are built from. */
export interface StashTreesSource {
  blobs: Blobs;
  trees: Trees;
  staging: Staging;
  worktree: Worktree;
  /** `core.filemode` / `core.symlinks`; defaults to what the worktree can represent */
  trust?: WorktreeModeTrust;
}

/** A blob, link or gitlink of a flattened tree. */
export interface FlatTreeEntry {
  id: ObjectId;
  mode: number;
}

/** Stores a flat path map as nested trees; returns the root tree's id. */
export async function storeFlatTree(
  trees: Trees,
  entries: Iterable<[string, FlatTreeEntry]>,
): Promise<ObjectId> {
  type Node = Map<string, Node | FlatTreeEntry>;
  const root: Node = new Map();
  for (const [path, entry] of entries) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.get(part);
      if (!(next instanceof Map)) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
    node.set(parts[parts.length - 1], entry);
  }
  const store = async (node: Node): Promise<ObjectId> => {
    const list: { name: string; mode: number; id: ObjectId }[] = [];
    for (const [name, value] of node) {
      if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
      else list.push({ name, mode: value.mode, id: value.id });
    }
    return trees.store(list);
  };
  return store(root);
}

/**
 * Refuses an index with unmerged entries, as git's `write-tree` does before a stash
 * ("<path>: needs merge").
 */
export async function assertNoUnmergedEntries(staging: Staging): Promise<void> {
  const unmerged: string[] = [];
  for await (const entry of staging.entries()) if (entry.stage !== 0) unmerged.push(entry.path);
  if (unmerged.length > 0) {
    throw new Error(
      `${[...new Set(unmerged)].map((p) => `${p}: needs merge`).join("\n")}\nerror: could not write index`,
    );
  }
}

/** The index as a tree (`git write-tree`), refused while it has unmerged entries. */
export async function createIndexTree(source: StashTreesSource): Promise<ObjectId> {
  await assertNoUnmergedEntries(source.staging);
  return source.staging.writeTree(source.trees);
}

/** One index entry (stage 0) and how its worktree file compares. */
export interface ScannedEntry {
  entry: StagingEntry;
  /** Absent for a skip-worktree entry (never compared) */
  compared?: WorktreeComparison;
}

/**
 * The index compared with the worktree once, for everything a stash needs from it (the
 * check for changes, the worktree tree, the reset, the stat refresh).
 */
export interface IndexScan {
  /** The stage-0 entries in index order */
  entries: ScannedEntry[];
  /** Paths with unmerged entries */
  unmerged: string[];
  /** Every path of the index, any stage */
  paths: Set<string>;
}

/** The index's write time as the staging reports it (0 where it cannot). */
export function indexTimeOf(staging: Staging): number {
  return typeof staging.getUpdateTime === "function" ? staging.getUpdateTime() : 0;
}

/** Compares every index entry with the worktree, through the stat (racy ones re-hashed). */
export async function scanIndex(source: StashTreesSource): Promise<IndexScan> {
  const { staging, worktree } = source;
  const trust = source.trust ?? defaultModeTrust(worktree);
  const indexTime = indexTimeOf(staging);
  const entries: ScannedEntry[] = [];
  const unmerged: string[] = [];
  const paths = new Set<string>();
  for await (const entry of staging.entries()) {
    paths.add(entry.path);
    if (entry.stage !== 0) {
      unmerged.push(entry.path);
      continue;
    }
    if (entry.skipWorktree) {
      entries.push({ entry });
      continue;
    }
    entries.push({
      entry,
      compared: await compareWithWorktree(worktree, entry, { trust, indexTime }),
    });
  }
  return { entries, unmerged: [...new Set(unmerged)], paths };
}

/**
 * The entries a scan found clean only by hashing (their stat no longer matched, or was
 * racy): their fresh stat lets the next comparison skip reading them, as git's index
 * refresh does.
 */
export function refreshableEntries(scan: IndexScan): IndexStatUpdate[] {
  const out: IndexStatUpdate[] = [];
  for (const { entry, compared } of scan.entries) {
    const update = statUpdateOf(entry, compared);
    if (update) out.push(update);
  }
  return out;
}

/**
 * The index stat to write for an entry after comparing it: its fresh stat (nanoseconds,
 * device, inode and owner included where the worktree reports them) when it was proved
 * clean by hashing, or size 0 when it changed though racy (git's smudging); undefined when
 * nothing needs writing. Assume-unchanged and skip-worktree entries are never refreshed.
 */
export function statUpdateOf(
  entry: StagingEntry,
  compared: WorktreeComparison | undefined,
): IndexStatUpdate | undefined {
  if (!compared || entry.intentToAdd || entry.assumeValid || entry.skipWorktree) return undefined;
  const expected = {
    path: entry.path,
    objectId: entry.objectId,
    mode: entry.mode,
    expectedSize: entry.size,
    expectedMtime: entry.mtime,
  };
  if (compared.smudge) return { ...expected, size: 0, mtime: entry.mtime, smudge: true };
  const file = compared.worktreeEntry;
  if (compared.kind || !file || file.isDirectory || compared.hashedId !== entry.objectId) {
    return undefined;
  }
  return {
    ...expected,
    size: file.size,
    mtime: file.mtime,
    ...(file.ctime !== undefined ? { ctime: file.ctime } : {}),
    ...(file.mtimeNs !== undefined ? { mtimeNs: file.mtimeNs } : {}),
    ...(file.ctimeNs !== undefined ? { ctimeNs: file.ctimeNs } : {}),
    ...(file.dev !== undefined ? { dev: file.dev } : {}),
    ...(file.ino !== undefined ? { ino: file.ino } : {}),
    ...(file.uid !== undefined ? { uid: file.uid } : {}),
    ...(file.gid !== undefined ? { gid: file.gid } : {}),
  };
}

/**
 * Stores fresh stats in the index, as git refreshes the index during status: per entry
 * compare-and-set (an entry changed meanwhile, by an add or a flag, is left as it is; the
 * rest of each entry is kept). An index file is written only when it is unchanged since it
 * was read, under `index.lock`, and without other in-memory edits (`Staging.refreshStats`);
 * a failure is given up quietly. Returns whether anything was stored.
 */
export async function refreshIndexStats(
  staging: Staging,
  updates: IndexStatUpdate[],
): Promise<boolean> {
  if (updates.length === 0) return false;
  if (typeof staging.refreshStats === "function") return staging.refreshStats(updates);
  try {
    // a store without an index file: the same compare-and-set through its editor
    const now = Date.now();
    let applied = false;
    const editor = staging.createEditor();
    for (const u of updates) {
      editor.add({
        path: u.path,
        apply: (existing) => {
          const next = applyStatUpdate(existing, u, now);
          if (next) applied = true;
          return next ?? existing;
        },
      });
    }
    await editor.finish();
    if (applied) await staging.write();
    return applied;
  } catch {
    return false;
  }
}

/** Whether a leading component of `path` is a symbolic link. */
async function beyondSymlink(worktree: Worktree, path: string): Promise<boolean> {
  const parts = path.split("/");
  for (let k = 1; k < parts.length; k++) {
    const entry = await worktree.getEntry(parts.slice(0, k).join("/"));
    if (!entry) return false;
    if (entry.mode === FileMode.SYMLINK) return true;
    if (!entry.isDirectory) return false;
  }
  return false;
}

/**
 * The stash's worktree tree, as git's `stash_working_tree` (`diff-index HEAD` piped to
 * `update-index --add --remove` on a copy of the index tree):
 * - a tracked file that changed is taken from the worktree, with the mode git stages;
 * - a file gone from the worktree is removed, but a file that is not in HEAD (staged new)
 *   keeps its staged blob and a file replaced by a directory keeps its index entry;
 * - a path beyond a symbolic link refuses the stash, as does an intent-to-add entry;
 * - a submodule takes the commit checked out in it;
 * - a path HEAD has but the index does not (`git rm --cached`) is taken from the worktree
 *   where the file is still there.
 *
 * @param scan The index already compared with the worktree ({@link scanIndex}); computed
 *   here when absent
 */
export async function createWorktreeTree(
  source: StashTreesSource,
  headTree?: ObjectId,
  scan?: IndexScan,
): Promise<ObjectId> {
  const { worktree, blobs } = source;
  const scanned = scan ?? (await scanIndex(source));
  if (scanned.unmerged.length > 0) await assertNoUnmergedEntries(source.staging);
  const cannot = "Cannot save the current worktree state";
  for (const { entry } of scanned.entries) {
    if (entry.intentToAdd) {
      throw new Error(`error: Entry '${entry.path}' not uptodate. Cannot merge.\n${cannot}`);
    }
  }
  const trust = source.trust ?? defaultModeTrust(worktree);
  const head = await flattenTree(source.trees, headTree);
  const store = async (path: string, file: WorktreeEntry, known?: ObjectId) => {
    if (known && !isUnknownContentId(known) && (await blobs.has(known))) return known;
    return (await storeWorktreeFile(blobs, worktree, path, file)).id;
  };
  const result = new Map<string, FlatTreeEntry>();
  for (const { entry, compared } of scanned.entries) {
    const kept = { id: entry.objectId, mode: entry.mode };
    if (!compared) {
      result.set(entry.path, kept);
      continue;
    }
    if (entry.mode === FileMode.GITLINK) {
      const moved = compared.kind === "modified" && compared.hashedId;
      result.set(
        entry.path,
        moved ? { id: compared.hashedId as ObjectId, mode: entry.mode } : kept,
      );
      continue;
    }
    if (compared.kind === "deleted") {
      if (await beyondSymlink(worktree, entry.path)) {
        throw new Error(
          `error: '${entry.path}' is beyond a symbolic link\nfatal: Unable to process path ${entry.path}\n${cannot}`,
        );
      }
      // update-index keeps an entry whose path became a directory; diff-index does not
      // report a staged new file that is gone (match_missing off)
      if (compared.worktreeEntry?.isDirectory || !head.has(entry.path))
        result.set(entry.path, kept);
      continue;
    }
    if (compared.kind && compared.worktreeEntry) {
      result.set(entry.path, {
        id: await store(entry.path, compared.worktreeEntry, compared.hashedId),
        mode: compared.worktreeMode ?? entry.mode,
      });
      continue;
    }
    result.set(entry.path, kept);
  }
  for (const [path] of head) {
    if (scanned.paths.has(path)) continue;
    const current = await worktree.getEntry(path);
    if (!current || current.isDirectory) continue;
    result.set(path, {
      id: await store(path, current),
      mode: modeFromWorktree(current.mode, undefined, trust),
    });
  }
  return storeFlatTree(source.trees, result);
}

/** The stash's untracked tree, and the paths it holds. */
export interface UntrackedTree {
  treeId: ObjectId;
  paths: string[];
}

/**
 * The files the index does not track, as `git stash -u` (or `-a` with `includeIgnored`)
 * stores them in its third parent. As git, the tree is written even when there is none
 * (the empty tree). Nested repositories are not stored.
 */
export async function createUntrackedTree(
  source: StashTreesSource,
  options: { includeIgnored?: boolean } = {},
): Promise<UntrackedTree> {
  const { staging, worktree, blobs } = source;
  const trust = source.trust ?? defaultModeTrust(worktree);
  const tracked = new Set<string>();
  for await (const entry of staging.entries()) tracked.add(entry.path);
  const result = new Map<string, FlatTreeEntry>();
  for await (const file of findUntrackedFiles(worktree, (p) => tracked.has(p), {
    hasTrackedUnder: trackedUnder(tracked),
    includeIgnored: options.includeIgnored,
  })) {
    if (file.path.endsWith("/")) continue;
    const stored = await storeWorktreeFile(blobs, worktree, file.path, file.entry);
    result.set(file.path, {
      id: stored.id,
      mode: modeFromWorktree(file.entry.mode, undefined, trust),
    });
  }
  return { treeId: await storeFlatTree(source.trees, result), paths: [...result.keys()] };
}

/**
 * Whether there is anything tracked to stash (git's `check_changes_tracked_files`): the
 * index differs from HEAD, or a worktree file differs from the index; submodules ignored.
 */
export async function hasTrackedChanges(
  source: StashTreesSource,
  headTree?: ObjectId,
  scan?: IndexScan,
): Promise<boolean> {
  const scanned = scan ?? (await scanIndex(source));
  if (scanned.unmerged.length > 0) return true;
  const head = await flattenTree(source.trees, headTree);
  for (const { entry, compared } of scanned.entries) {
    const inHead = head.get(entry.path);
    if (!inHead || inHead.id !== entry.objectId || inHead.mode !== entry.mode) return true;
    if (entry.intentToAdd) return true;
    if (entry.mode === FileMode.GITLINK || entry.assumeValid) continue;
    if (compared?.kind) return true;
  }
  return scanned.entries.length !== head.size;
}
