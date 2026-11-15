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
import {
  compareWithWorktree,
  defaultModeTrust,
  findUntrackedFiles,
  trackedUnder,
} from "../status/worktree-status.js";
import { storeWorktreeFile } from "../worktree/store-worktree-file.js";
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

/**
 * The stash's worktree tree: the index, updated from the worktree for every tracked path
 * (index or HEAD) whose file differs, removed where the file is gone, as git's
 * `stash_working_tree`. Submodules keep their index entry.
 *
 * @param headTree HEAD's tree: a path HEAD has but the index does not (`git rm --cached`)
 *   is taken from the worktree where the file is still there, as git does
 */
export async function createWorktreeTree(
  source: StashTreesSource,
  headTree?: ObjectId,
): Promise<ObjectId> {
  const { staging, worktree, blobs } = source;
  await assertNoUnmergedEntries(staging);
  const trust = source.trust ?? defaultModeTrust(worktree);
  const indexTime = typeof staging.getUpdateTime === "function" ? staging.getUpdateTime() : 0;
  const result = new Map<string, FlatTreeEntry>();
  const store = async (
    path: string,
    entry: NonNullable<Awaited<ReturnType<Worktree["getEntry"]>>>,
  ) => (await storeWorktreeFile(blobs, worktree, path, entry)).id;
  const indexed = new Set<string>();
  for await (const entry of staging.entries()) {
    indexed.add(entry.path);
    if (entry.stage !== 0) continue;
    if (entry.mode === FileMode.GITLINK || entry.skipWorktree) {
      result.set(entry.path, { id: entry.objectId, mode: entry.mode });
      continue;
    }
    const compared = await compareWithWorktree(worktree, entry, { trust, indexTime });
    if (compared.kind === "deleted" || !compared.worktreeEntry) continue;
    const mode = compared.worktreeMode ?? entry.mode;
    if (compared.kind || entry.intentToAdd) {
      result.set(entry.path, { id: await store(entry.path, compared.worktreeEntry), mode });
    } else {
      result.set(entry.path, { id: entry.objectId, mode: entry.mode });
    }
  }
  for (const [path] of await flattenTree(source.trees, headTree)) {
    if (indexed.has(path)) continue;
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
 * stores them in its third parent; undefined when there are none. Nested repositories are
 * not stored.
 */
export async function createUntrackedTree(
  source: StashTreesSource,
  options: { includeIgnored?: boolean } = {},
): Promise<UntrackedTree | undefined> {
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
  if (result.size === 0) return undefined;
  return { treeId: await storeFlatTree(source.trees, result), paths: [...result.keys()] };
}

/**
 * Whether there is anything tracked to stash: the index differs from HEAD (`diff-index
 * --cached HEAD`), or a worktree file differs from the index (`diff-files`).
 */
export async function hasTrackedChanges(
  source: StashTreesSource,
  headTree?: ObjectId,
): Promise<boolean> {
  const { staging, worktree } = source;
  const head = await flattenTree(source.trees, headTree);
  const trust = source.trust ?? defaultModeTrust(worktree);
  const indexTime = typeof staging.getUpdateTime === "function" ? staging.getUpdateTime() : 0;
  let indexed = 0;
  for await (const entry of staging.entries()) {
    if (entry.stage !== 0) return true;
    indexed++;
    const inHead = head.get(entry.path);
    if (!inHead || inHead.id !== entry.objectId || inHead.mode !== entry.mode) return true;
    if (entry.intentToAdd) return true;
    if (entry.skipWorktree || entry.assumeValid) continue;
    if ((await compareWithWorktree(worktree, entry, { trust, indexTime })).kind) return true;
  }
  return indexed !== head.size;
}
