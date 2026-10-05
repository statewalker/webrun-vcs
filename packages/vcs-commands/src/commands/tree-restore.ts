/**
 * Writing a tree back into the working tree.
 *
 * Shared by the commands that make the working tree match a tree object -
 * `reset --hard` and `stash apply`. Both need the same two-phase shape: plan
 * and validate the whole restore first, then write. A tree that cannot be
 * restored faithfully therefore fails with the working tree still intact,
 * rather than half-way through rewriting it.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";

import type { CommandTrees } from "../git-command.js";

/** One file a restore plans to write back into the working tree. */
export interface RestoreEntry {
  path: string;
  objectId: ObjectId;
  mode: number;
}

/** A validated restore, ready to execute. */
export interface TreeRestorePlan {
  /** The files to write. */
  entries: RestoreEntry[];
  /**
   * Every path the tree accounts for - the files above plus the gitlinks
   * that are deliberately not written. A tracked path missing from this set
   * is one the target tree deletes.
   */
  paths: Set<string>;
}

/**
 * Walk a tree and plan which files to restore, validating as it goes.
 *
 * Throws on anything that cannot be restored faithfully, so the caller can
 * abort before mutating the working tree.
 *
 * @param trees Tree storage to walk
 * @param blobs Blob storage, checked for the content of every planned file
 * @param treeId Tree to restore
 * @param operation Names the operation in failure messages, e.g. `reset --hard`
 */
export async function planTreeRestore(
  trees: CommandTrees,
  blobs: Blobs,
  treeId: ObjectId,
  operation: string,
): Promise<TreeRestorePlan> {
  const plan: TreeRestorePlan = { entries: [], paths: new Set() };
  await planInto(trees, blobs, treeId, "", operation, plan);
  return plan;
}

async function planInto(
  trees: CommandTrees,
  blobs: Blobs,
  treeId: ObjectId,
  prefix: string,
  operation: string,
  plan: TreeRestorePlan,
): Promise<void> {
  for await (const entry of trees.loadTree(treeId)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.mode === FileMode.TREE) {
      await planInto(trees, blobs, entry.id, path, operation, plan);
      continue;
    }

    if (entry.mode === FileMode.GITLINK) {
      // Submodule: neither `git reset --hard` nor `git stash apply` touches
      // its contents. Record it so it is not mistaken for a path to delete.
      plan.paths.add(path);
      continue;
    }

    if (entry.mode === FileMode.SYMLINK) {
      // The Worktree interface has no way to create a symbolic link, and
      // writing the target path as a regular file would silently produce a
      // working tree that does not match the tree being restored.
      throw new Error(
        `${operation} cannot restore ${path}: the worktree cannot create symbolic links`,
      );
    }

    if (!(await blobs.has(entry.id))) {
      throw new Error(`${operation} cannot restore ${path}: blob ${entry.id} is missing`);
    }

    plan.entries.push({ path, objectId: entry.id, mode: entry.mode });
    plan.paths.add(path);
  }
}

/**
 * Execute a plan produced by {@link planTreeRestore}, writing every file.
 *
 * @param worktree Working tree to write into
 * @param blobs Blob storage to read content from
 * @param plan The validated plan
 * @param operation Names the operation in failure messages
 */
export async function writeTreeRestorePlan(
  worktree: Worktree,
  blobs: Blobs,
  plan: TreeRestorePlan,
  operation: string,
): Promise<void> {
  for (const { path, objectId, mode } of plan.entries) {
    const content = await blobs.load(objectId);
    if (!content) {
      throw new Error(`${operation} cannot restore ${path}: blob ${objectId} is missing`);
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }

    await worktree.writeContent(path, chunks, { mode, createParents: true });
  }
}
