import type { Blobs, ObjectId, Ref } from "@statewalker/vcs-core";
import {
  cacheTreeOfTree,
  copyCacheTree,
  invalidateCacheTreePath,
  type ResolveUndoRecord,
  type Staging,
  type StagingEntry,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { ResetRefusedError } from "../errors/command-errors.js";
import { RefNotFoundError } from "../errors/ref-errors.js";
import { type CommandTrees, GitCommand } from "../git-command.js";
import { ResetMode } from "../types.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { flatTree, OperationState } from "./merge-support.js";
import { reflogMessages, updateHead } from "./reflog-messages.js";
import { removeBranchState, resetKeep, resetMerge } from "./sequencer-support.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";
import { flaggedEntryDiffers } from "./worktree-overwrite-checks.js";

/** Names this operation in restore failure messages. */
const RESET_HARD = "reset --hard";

/**
 * Reset HEAD to a specified state.
 *
 * Equivalent to `git reset`.
 *
 * Based on JGit's ResetCommand.
 *
 * @example
 * ```typescript
 * // Soft reset - move HEAD only
 * await git.reset()
 *   .setRef("HEAD~1")
 *   .setMode(ResetMode.SOFT)
 *   .call();
 *
 * // Mixed reset (default) - move HEAD and reset staging
 * await git.reset()
 *   .setRef("abc123")
 *   .call();
 *
 * // Hard reset - move HEAD, reset staging, and reset working tree
 * await git.reset()
 *   .setRef("HEAD~1")
 *   .setMode(ResetMode.HARD)
 *   .call();
 *
 * // Reset specific paths
 * await git.reset()
 *   .addPath("src/file.ts")
 *   .call();
 * ```
 */
export class ResetCommand extends GitCommand<Ref> {
  private ref?: string;
  private mode = ResetMode.MIXED;
  private paths: string[] = [];

  /**
   * Set the ref to reset to.
   *
   * Can be a commit ID, branch name, tag name, or relative ref like HEAD~1.
   * If not set, defaults to HEAD.
   *
   * @param ref Commit-ish to reset to
   */
  setRef(ref: string): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /**
   * Set the reset mode.
   *
   * - SOFT: Move HEAD only
   * - MIXED (default): Move HEAD and reset staging
   * - HARD: Move HEAD, reset staging, and reset working tree. DESTRUCTIVE -
   *   uncommitted changes to tracked files are discarded and tracked files
   *   absent from the target commit are deleted from the working tree.
   * - MERGE: as git's `reset --merge`: index entries that differ from the target take
   *   its version, worktree files with them; refused (ResetRefusedError) where a file
   *   with unstaged changes or an untracked file would be lost. Unmerged entries are reset.
   * - KEEP: as git's `reset --keep`: files that differ between HEAD and the target are
   *   switched, local changes elsewhere kept; refused where a switched file has local
   *   changes, and in the middle of a merge.
   *
   * Every mode records the old HEAD in ORIG_HEAD and, as git's reset, forgets a merge,
   * cherry-pick or revert in progress (MERGE_HEAD, CHERRY_PICK_HEAD, ...).
   *
   * @param mode Reset mode
   */
  setMode(mode: ResetMode): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  /**
   * Add a path to reset.
   *
   * When paths are specified, only those paths are reset in the staging area.
   * The ref must be HEAD when using paths.
   *
   * @param path Repository-relative path
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Execute the reset.
   *
   * @returns The ref that HEAD now points to
   * @throws RefNotFoundError if ref cannot be resolved
   */
  async call(): Promise<Ref> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    // If paths are specified, do path reset
    if (this.paths.length > 0) {
      return this.resetPaths();
    }

    // Resolve target commit
    const targetRef = this.ref ?? "HEAD";
    const targetId = await this.resolveRef(targetRef);

    // For HARD, capture the currently tracked paths BEFORE staging is reset:
    // a path tracked now but absent from the target tree must be deleted from
    // the working tree, and after resetStaging() that information is gone.
    const trackedBefore =
      this.mode === ResetMode.HARD ? await this.collectTrackedPaths() : undefined;

    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    // git refuses a soft or keep reset in the middle of a merge (die_if_unmerged_cache)
    if (this.mode === ResetMode.SOFT || this.mode === ResetMode.KEEP) {
      let unmerged = false;
      for await (const entry of this.staging.entries()) if (entry.stage > 0) unmerged = true;
      if (unmerged || (await state.exists("MERGE_HEAD"))) {
        throw new ResetRefusedError(
          `fatal: Cannot do a ${this.mode} reset in the middle of a merge.`,
        );
      }
    }
    // --merge and --keep: the index and worktree first, refused before anything changes
    if (this.mode === ResetMode.MERGE || this.mode === ResetMode.KEEP) {
      const ctx = {
        workingCopy: this.workingCopy,
        worktree: this.worktreeAccess,
        staging: this.staging,
        blobs: this.blobs,
        trees: this.trees,
        commits: this.commits,
        refs: this.refsStore,
      };
      const refused =
        this.mode === ResetMode.MERGE
          ? await resetMerge(ctx, targetId, targetRef)
          : await resetKeep(ctx, headId ?? targetId, targetId, targetRef);
      if (refused) throw new ResetRefusedError(refused.message, refused.paths);
    }

    // --hard: unpack-trees' one-way merge checks the entries whose flags cheat (assume-unchanged,
    // skip-worktree) before anything changes; a file kept outside the worktree stays so
    let flagged: FlaggedEntries | undefined;
    if (this.mode === ResetMode.HARD) {
      const commit = await this.commits.load(targetId);
      if (commit) {
        flagged = await checkFlaggedEntries(
          {
            trees: this.trees,
            staging: this.staging,
            workingCopy: this.workingCopy,
            worktree: this.worktreeAccess,
          },
          commit.tree,
        );
        if (flagged.refused !== undefined) {
          throw new ResetRefusedError(
            `error: Entry '${flagged.refused}' not uptodate. Cannot merge.\n` +
              `fatal: Could not reset index file to revision '${targetRef}'.`,
            [flagged.refused],
          );
        }
      }
    }

    // Move HEAD/branch, the old HEAD kept in ORIG_HEAD (git's reset_refs)
    if (headId && state.supported) await state.setRef("ORIG_HEAD", headId);
    // git's set_reflog_message: "reset: moving to <rev>", or "<action>: updating HEAD"
    const message = this.hasReflogAction()
      ? `${this.reflogAction("reset")}: updating HEAD`
      : reflogMessages.reset(targetRef);
    await updateHead(this.refsStore, targetId, this.reflogLine(message));

    // Reset staging area (for MIXED and HARD)
    if (this.mode === ResetMode.MIXED || this.mode === ResetMode.HARD) {
      await this.resetStaging(targetId);
    }

    // Reset working tree (for HARD) - this DESTROYS uncommitted changes
    if (this.mode === ResetMode.HARD) {
      await this.resetWorkingTree(targetId, trackedBefore ?? new Set(), flagged?.keptOut);
    }

    // git's remove_branch_state: a merge, cherry-pick or revert in progress is forgotten
    await removeBranchState({ commits: this.commits, refs: this.refsStore }, state);

    // Return the updated HEAD ref
    const headRef = await this.refsStore.resolve("HEAD");
    return headRef as Ref;
  }

  /**
   * Reset specific paths in staging area.
   */
  private async resetPaths(): Promise<Ref> {
    // For path reset, we reset the staging entries to match the ref
    // git's parse_tree_indirect: any tree-ish (`HEAD^{tree}` too)
    const targetRef = this.ref ?? "HEAD";
    const treeId = await this.revisionResolver().peelToType(
      await this.resolveRevision(targetRef),
      "tree",
    );
    if (treeId === undefined) {
      throw new RefNotFoundError(targetRef, `fatal: Could not parse object '${targetRef}'.`);
    }

    // Reset each path in staging
    const editor = this.staging.createEditor();

    for (const path of this.paths) {
      const entry = await this.getTreeEntryForPath(treeId, path);
      if (entry) {
        // Path exists in target - update staging to match
        editor.add({
          path,
          apply: () => ({
            path,
            mode: entry.mode,
            objectId: entry.objectId,
            stage: 0,
            size: 0,
            mtime: Date.now(),
          }),
        });
      } else {
        // Path doesn't exist in target - remove from staging
        editor.add({
          path,
          apply: () => undefined,
        });
      }
    }

    await editor.finish();
    await this.staging.write();

    const headRef = await this.refsStore.resolve("HEAD");
    return headRef as Ref;
  }

  /**
   * Collect every path currently tracked in the staging area.
   */
  private async collectTrackedPaths(): Promise<Set<string>> {
    const paths = new Set<string>();
    for await (const entry of this.staging.entries()) {
      paths.add(entry.path);
    }
    return paths;
  }

  /**
   * Make the working tree match the target commit's tree (HARD reset).
   *
   * This is destructive: uncommitted modifications to tracked files are
   * overwritten, and tracked files missing from the target tree are deleted.
   * Untracked files are left alone - removing those is `git clean`.
   *
   * A repository without a worktree (bare) has no working tree to reset, so
   * this is a no-op there. The restore is planned and validated in full before
   * any file is touched, so a tree this command cannot restore faithfully
   * (a symlink, a missing blob) fails with the working tree still intact.
   *
   * @param targetId Commit to reset the working tree to
   * @param trackedBefore Paths tracked before staging was reset
   */
  private async resetWorkingTree(
    targetId: ObjectId,
    trackedBefore: Set<string>,
    keptOut?: ReadonlySet<string>,
  ): Promise<void> {
    const worktree = this.worktreeAccess;
    if (!worktree) {
      // Bare repository: there is no working tree to reset.
      return;
    }

    const commit = await this.commits.load(targetId);
    if (!commit) {
      throw new RefNotFoundError(targetId, "Target commit not found");
    }
    await restoreWorktreeHard(
      { trees: this.trees, blobs: this.blobs, workingCopy: this.workingCopy, worktree },
      commit.tree,
      trackedBefore,
      keptOut,
    );
  }

  /**
   * Reset staging area to match a tree.
   */
  private async resetStaging(commitId: ObjectId): Promise<void> {
    const commit = await this.commits.load(commitId);
    if (commit) {
      if (this.mode !== ResetMode.MIXED) {
        // oneway_merge: an unchanged entry keeps its flags, a changed one its skip-worktree
        // bit (the stat data goes: every file is written again)
        await this.staging.readTree(this.trees, commit.tree, { keepMatching: "flags" });
        await this.primeCacheTree(commit.tree);
        await this.staging.write();
        return;
      }
      // git's reset --mixed edits the index in place (read_from_tree): the resolve-undo
      // records stay, and the conflict stages it removes are recorded as well
      const unmerged = new Map<string, ResolveUndoRecord>();
      // read_from_tree edits the index entry by entry: the cache-tree keeps its nodes, those
      // of the paths it changes invalid (not primed, as a hard reset's is)
      const cached = this.staging.getCacheTree?.();
      const before = new Map<string, string>();
      for await (const entry of this.staging.entries()) {
        before.set(
          entry.path,
          `${before.has(entry.path) ? "u" : ""}${entry.mode} ${entry.objectId}`,
        );
        if (entry.stage < 1 || entry.stage > 3) continue;
        let record = unmerged.get(entry.path);
        if (!record) {
          record = {
            path: entry.path,
            modes: [0, 0, 0],
            objectIds: [undefined, undefined, undefined],
          };
          unmerged.set(entry.path, record);
        }
        record.modes[entry.stage - 1] = entry.mode;
        record.objectIds[entry.stage - 1] = entry.objectId;
      }
      // read_from_tree leaves the entries it does not change alone (their flags and stat), and
      // a changed entry keeps its skip-worktree bit (update_index_from_diff)
      await this.staging.readTree(this.trees, commit.tree, {
        keepResolveUndo: true,
        keepMatching: true,
      });
      if (unmerged.size > 0) this.staging.recordResolveUndo?.([...unmerged.values()]);
      if (cached && this.staging.setCacheTree) {
        const tree = copyCacheTree(cached);
        for await (const entry of this.staging.entries()) {
          if (before.get(entry.path) !== `${entry.mode} ${entry.objectId}`) {
            invalidateCacheTreePath(tree, entry.path);
          }
          before.delete(entry.path);
        }
        for (const path of before.keys()) invalidateCacheTreePath(tree, path);
        this.staging.setCacheTree(tree);
      }
      await this.staging.write();
    }
  }

  /**
   * git's `prime_cache_tree` after a hard reset: the index's cache-tree is the
   * target tree's, every directory valid with the tree stored there (a tree holding 100664
   * modes is kept, so a write-tree of the unchanged index gives it back).
   */
  private async primeCacheTree(treeId: ObjectId): Promise<void> {
    if (!this.staging.setCacheTree) return;
    this.staging.setCacheTree(await cacheTreeOfTree(this.trees, treeId));
  }

  /**
   * Get tree entry for a path.
   */
  private async getTreeEntryForPath(
    treeId: ObjectId,
    path: string,
  ): Promise<{ objectId: ObjectId; mode: number } | undefined> {
    const parts = path.split("/").filter((p) => p.length > 0);
    let currentTreeId = treeId;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;

      const entry = await this.trees.getEntry(currentTreeId, name);

      if (!entry) {
        return undefined;
      }

      if (isLast) {
        return { objectId: entry.id, mode: entry.mode };
      }

      currentTreeId = entry.id;
    }

    return undefined;
  }
}

/**
 * The working tree half of `git reset --hard` (unpack-trees `oneway_merge` with `update`):
 * `treeId` written over the worktree, the paths of `trackedBefore` it lacks deleted first.
 * Untracked files in the way are overwritten, as git's reset does. The restore is planned
 * in full before any file is touched.
 */
export async function restoreWorktreeHard(
  deps: { trees: CommandTrees; blobs: Blobs; workingCopy: WorkingCopy; worktree: Worktree },
  treeId: ObjectId,
  trackedBefore: Set<string>,
  keptOut?: ReadonlySet<string>,
): Promise<void> {
  const { trees, blobs, workingCopy, worktree } = deps;
  // Plan the whole restore first. Anything unrestorable then fails while the
  // working tree is still untouched, instead of half-way through rewriting it.
  const fullPlan = await planTreeRestore(trees, blobs, treeId, RESET_HARD, {
    symlinks: true,
    ...(await restoreCaseOptions(worktree, coreBool(workingCopy, "ignorecase", false))),
    windows: worktree.capabilities?.windowsPaths === true,
    reservedNames: worktree.capabilities?.reservedNames,
  });
  // a skip-worktree entry the tree keeps is not checked out (oneway_merge skips it)
  const plan =
    keptOut && keptOut.size > 0
      ? {
          ...fullPlan,
          entries: fullPlan.entries.filter((e) => !keptOut.has(e.path)),
          gitlinks: fullPlan.gitlinks.filter((e) => !keptOut.has(e.path)),
        }
      : fullPlan;

  // Delete the files that were tracked but are not in the target tree first, as git's
  // unpack-trees does: a tracked file or symlink `d` then makes way for `d/x`, and is
  // never written beneath or through.
  for (const path of trackedBefore) {
    if (plan.paths.has(path)) continue;
    await worktree.remove(path);
  }

  // a forced checkout: a file or link where a directory must go is unlinked, never
  // written through; links are written as links where the worktree has them
  await writeTreeRestorePlan(worktree, blobs, plan, RESET_HARD, {
    symlinks: worktreeModeTrust(workingCopy, worktree).symlinks,
    replaceInTheWay: true,
    // git's reset --hard overwrites untracked files (UNPACK_RESET_OVERWRITE_UNTRACKED)
    discardUntracked: true,
  });
}

/** What {@link checkFlaggedEntries} found. */
export interface FlaggedEntries {
  /** The first path whose flagged entry the tree changes or deletes over a changed file. */
  refused?: string;
  /** The skip-worktree entries the tree keeps: their files are left alone. */
  keptOut: Set<string>;
}

/**
 * The index entries whose flags cheat (assume-unchanged, skip-worktree) before a one-way
 * reset onto `treeId` (`reset --hard`, `checkout -f`): unpack-trees checks them even when it
 * resets (`verify_uptodate_1`: "CE_VALID and CE_SKIP_WORKTREE cheat"), so one the tree
 * changes or deletes is refused while its file differs from it (by stat, as
 * `ie_match_stat`; a missing file is fine). A skip-worktree entry the tree keeps is not
 * checked out (`oneway_merge`).
 */
export async function checkFlaggedEntries(
  deps: {
    trees: CommandTrees;
    staging: Staging;
    workingCopy: WorkingCopy;
    worktree?: Worktree;
  },
  treeId: ObjectId,
): Promise<FlaggedEntries> {
  const flagged: StagingEntry[] = [];
  for await (const entry of deps.staging.entries()) {
    if (entry.stage === 0 && (entry.assumeValid || entry.skipWorktree)) flagged.push(entry);
  }
  const keptOut = new Set<string>();
  if (flagged.length === 0) return { keptOut };
  const target = await flatTree(deps.trees, treeId);
  const worktree = deps.worktree;
  const trust = worktree ? worktreeModeTrust(deps.workingCopy, worktree) : undefined;
  const indexTime = deps.staging.getUpdateTime();
  for (const entry of flagged) {
    const t = target.get(entry.path);
    if (t && t.mode === entry.mode && t.objectId === entry.objectId) {
      if (entry.skipWorktree) keptOut.add(entry.path);
      continue;
    }
    if (worktree && (await flaggedEntryDiffers(worktree, entry.path, entry, trust, indexTime))) {
      return { refused: entry.path, keptOut };
    }
  }
  return { keptOut };
}
