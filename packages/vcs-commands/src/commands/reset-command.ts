import type { ObjectId, Ref } from "@statewalker/vcs-core";
import type { ResolveUndoRecord } from "@statewalker/vcs-working-tree";

import { ResetRefusedError } from "../errors/command-errors.js";
import { RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { ResetMode } from "../types.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { OperationState } from "./merge-support.js";
import { reflogMessages, updateHead } from "./reflog-messages.js";
import { removeBranchState, resetKeep, resetMerge } from "./sequencer-support.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";

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
      await this.resetWorkingTree(targetId, trackedBefore ?? new Set());
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
    const targetRef = this.ref ?? "HEAD";
    const targetId = await this.resolveRef(targetRef);

    // Load target commit's tree
    const targetCommit = await this.commits.load(targetId);
    if (!targetCommit) {
      throw new RefNotFoundError(targetId, "Target commit not found");
    }
    const treeId = targetCommit.tree;

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
  private async resetWorkingTree(targetId: ObjectId, trackedBefore: Set<string>): Promise<void> {
    const worktree = this.worktreeAccess;
    if (!worktree) {
      // Bare repository: there is no working tree to reset.
      return;
    }

    const commit = await this.commits.load(targetId);
    if (!commit) {
      throw new RefNotFoundError(targetId, "Target commit not found");
    }

    // Plan the whole restore first. Anything unrestorable then fails while the
    // working tree is still untouched, instead of half-way through rewriting it.
    const plan = await planTreeRestore(this.trees, this.blobs, commit.tree, RESET_HARD, {
      symlinks: true,
      ...(await restoreCaseOptions(worktree, coreBool(this.workingCopy, "ignorecase", false))),
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    // Delete the files that were tracked but are not in the target tree first, as git's
    // unpack-trees does: a tracked file or symlink `d` then makes way for `d/x`, and is
    // never written beneath or through.
    for (const path of trackedBefore) {
      if (plan.paths.has(path)) continue;
      await worktree.remove(path);
    }

    // a forced checkout: a file or link where a directory must go is unlinked, never
    // written through; links are written as links where the worktree has them
    await writeTreeRestorePlan(worktree, this.blobs, plan, RESET_HARD, {
      symlinks: worktreeModeTrust(this.workingCopy, worktree).symlinks,
      replaceInTheWay: true,
      // git's reset --hard overwrites untracked files (UNPACK_RESET_OVERWRITE_UNTRACKED)
      discardUntracked: true,
    });
  }

  /**
   * Reset staging area to match a tree.
   */
  private async resetStaging(commitId: ObjectId): Promise<void> {
    const commit = await this.commits.load(commitId);
    if (commit) {
      if (this.mode !== ResetMode.MIXED) {
        await this.staging.readTree(this.trees, commit.tree);
        await this.staging.write();
        return;
      }
      // git's reset --mixed edits the index in place (read_from_tree): the resolve-undo
      // records stay, and the conflict stages it removes are recorded as well
      const unmerged = new Map<string, ResolveUndoRecord>();
      for await (const entry of this.staging.entries()) {
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
      await this.staging.readTree(this.trees, commit.tree, { keepResolveUndo: true });
      if (unmerged.size > 0) this.staging.recordResolveUndo?.([...unmerged.values()]);
      await this.staging.write();
    }
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
