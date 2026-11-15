import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  InvalidArgumentError,
  NoHeadError,
  RefNotFoundError,
  StashApplyFailedError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { StashApplyResult } from "../results/stash-result.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { mergeTreesThreeWay } from "../tree-merge/index.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { STASH_REF } from "./stash-list-command.js";
import { planTreeRestore, type TreeRestorePlan, writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** Names this operation in restore failure messages. */
const STASH_APPLY = "stash apply";

/**
 * Command to apply a stashed commit.
 *
 * Equivalent to `git stash apply`.
 *
 * Based on JGit's StashApplyCommand.
 *
 * The stashed changes are three-way merged against the current HEAD and the
 * result is written back: the merged working tree always, the merged index
 * when `restoreIndex` is set, and the stashed untracked files when
 * `restoreUntracked` is set. A conflict aborts before anything is written.
 *
 * Known limits, shared with `reset --hard`:
 * - a symlink in the merged tree is refused, because the `Worktree` interface
 *   has no primitive to create one - writing the target as a regular file
 *   would silently produce a working tree that does not match;
 * - a gitlink's contents are not restored, as in git;
 * - directories left empty by a deletion are not pruned;
 * - the restore is not atomic across the working tree and the index.
 *
 * @example
 * ```typescript
 * // Apply most recent stash
 * const result = await git.stashApply().call();
 *
 * // Apply specific stash
 * const result = await git.stashApply()
 *   .setStashRef("stash@{2}")
 *   .call();
 *
 * // Apply without restoring index
 * const result = await git.stashApply()
 *   .setRestoreIndex(false)
 *   .call();
 * ```
 */
export class StashApplyCommand extends GitCommand<StashApplyResult> {
  private stashRef?: string;
  private restoreIndex = true;
  private restoreUntracked = true;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;

  /**
   * Set the stash reference to apply.
   *
   * Defaults to stash@{0} (most recent) if not specified.
   *
   * @param stashRef Name of the stash ref to apply
   */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  /**
   * Get the stash reference.
   */
  getStashRef(): string | undefined {
    return this.stashRef;
  }

  /**
   * Set whether to restore the index state.
   *
   * @param restoreIndex true to restore index (default)
   */
  setRestoreIndex(restoreIndex: boolean): this {
    this.checkCallable();
    this.restoreIndex = restoreIndex;
    return this;
  }

  /**
   * Get whether index will be restored.
   */
  getRestoreIndex(): boolean {
    return this.restoreIndex;
  }

  /**
   * Set whether to restore untracked files.
   *
   * @param restoreUntracked true to restore untracked files (default)
   */
  setRestoreUntracked(restoreUntracked: boolean): this {
    this.checkCallable();
    this.restoreUntracked = restoreUntracked;
    return this;
  }

  /**
   * Get whether untracked files will be restored.
   */
  getRestoreUntracked(): boolean {
    return this.restoreUntracked;
  }

  /**
   * Set whether to ignore repository state when applying.
   *
   * Note: Currently not implemented - stash apply always ignores repo state.
   *
   * @param _ignore true to ignore state
   */
  setIgnoreRepositoryState(_ignore: boolean): this {
    this.checkCallable();
    // Not currently implemented - reserved for future use
    return this;
  }

  /**
   * Set the merge strategy to use.
   *
   * @param strategy The merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Get the merge strategy.
   */
  getStrategy(): MergeStrategy {
    return this.strategy;
  }

  /**
   * Set the content merge strategy for file-level conflicts.
   *
   * @param strategy The content merge strategy
   */
  setContentMergeStrategy(strategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = strategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Execute the stash apply command.
   *
   * @returns Result of the apply operation
   */
  async call(): Promise<StashApplyResult> {
    this.checkCallable();
    this.setCallable(false);

    // Applying a stash means putting files back. A repository with no working
    // tree has nowhere to put them, and reporting OK there would be the same
    // silent no-op this command used to be.
    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new StoreNotAvailableError("worktree", "stash apply requires a working tree");
    }

    // Get HEAD commit
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("HEAD is required to apply stash");
    }

    // Get stash commit
    const stashId = await this.resolveStashRef();
    const stashCommit = await this.commits.load(stashId);
    if (!stashCommit) {
      throw new RefNotFoundError(stashId, "Stash commit not found");
    }

    // Validate stash commit structure
    if (stashCommit.parents.length < 2 || stashCommit.parents.length > 3) {
      throw new InvalidArgumentError(
        "stashRef",
        stashId,
        `Stash commit ${stashId} has invalid number of parents: ${stashCommit.parents.length}`,
      );
    }

    const stashHeadCommit = stashCommit.parents[0];
    const stashIndexCommit = stashCommit.parents[1];
    const stashUntrackedCommit = stashCommit.parents[2]; // Optional

    // Three-way merge: stash base -> current HEAD with stash changes
    const headCommit = await this.commits.load(headRef.objectId);
    const stashHeadCommitObj = await this.commits.load(stashHeadCommit);
    if (!headCommit || !stashHeadCommitObj) {
      throw new RefNotFoundError(headRef.objectId, "Head or stash commit not found");
    }
    const stashHeadTree = stashHeadCommitObj.tree;
    const stashWorkingTree = stashCommit.tree;

    // Merge working tree changes. The base is the tree of the commit the stash
    // was taken from, so base->ours is exactly the stashed change and
    // base->theirs is what the branch did since.
    const mergeResult = await mergeTreesThreeWay(
      this.trees,
      stashHeadTree,
      stashWorkingTree,
      headCommit.tree,
    );

    if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
      return {
        status: StashApplyStatus.CONFLICTS,
        stashCommit: stashId,
        conflicts: mergeResult.conflicts,
      };
    }

    // If restoreIndex, also merge index changes. Both merges are resolved
    // before anything is written, so a conflict in either leaves the working
    // tree and the index exactly as they were.
    let mergedIndexTree: ObjectId | undefined;
    if (this.restoreIndex) {
      const stashIndexCommitObj = await this.commits.load(stashIndexCommit);
      const stashIndexTree = stashIndexCommitObj?.tree ?? stashHeadTree;
      const indexMergeResult = await mergeTreesThreeWay(
        this.trees,
        stashHeadTree,
        stashIndexTree,
        headCommit.tree,
      );

      if (indexMergeResult.conflicts && indexMergeResult.conflicts.length > 0) {
        return {
          status: StashApplyStatus.CONFLICTS,
          stashCommit: stashId,
          conflicts: indexMergeResult.conflicts,
        };
      }

      mergedIndexTree = indexMergeResult.tree;
    }

    // Plan the whole restore - the merged working tree, the paths it deletes,
    // and the untracked files - and validate it before touching anything. A
    // stash this command cannot restore faithfully then fails with the working
    // tree intact rather than half applied.
    // symlinks are restored as links, or as files holding the target where the worktree
    // or core.symlinks cannot have links (as clone writes them)
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const worktreePlan = await planTreeRestore(
      this.trees,
      this.blobs,
      mergeResult.tree,
      STASH_APPLY,
      { symlinks: true, ignoreCase, windows: worktree.capabilities?.windowsPaths === true },
    );

    // Only what the stash changes is touched: the paths where the merged tree differs from
    // HEAD's are written or removed, every other file (an unrelated unstaged edit, a newly
    // staged file) is left alone, as git's merge leaves it.
    const head = await this.flatTree(headCommit.tree);
    const merged = await this.flatTree(mergeResult.tree);
    const index = new Map<string, CheckedEntry>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) index.set(entry.path, entry);
    }
    const changed = [...new Set([...head.keys(), ...merged.keys()])]
      .filter((p) => !sameEntry(head.get(p), merged.get(p)))
      .sort();
    // a path whose index entry already holds the result is not touched (its worktree file
    // stays as it is), as git's merge leaves an unchanged entry
    const settled = (p: string) => sameEntry(index.get(p), merged.get(p));
    const writes = changed.filter((p) => merged.has(p) && !settled(p));
    const removes = changed.filter((p) => !merged.has(p) && index.has(p));

    // git's merge refuses before writing anything (protecting untracked files): local
    // changes on a path the stash changes, untracked files where it writes, untracked
    // files in a directory a file of the stash replaces
    const local: string[] = [];
    for (const path of changed) {
      const i = index.get(path);
      if (sameEntry(i, merged.get(path))) continue; // the index already holds the result
      if (!sameEntry(i, head.get(path))) local.push(path);
      else if (i && (await worktreeDiffers(worktree, path, i, trust))) local.push(path);
    }
    const found = await findInTheWay(worktree, {
      writes,
      removes: new Set(removes),
      index,
      ignoreCase,
    });
    const refused = overwriteMessage("merge", { local, ...found });
    if (refused) {
      throw new StashApplyFailedError(
        stashId,
        [...local, ...found.lostDirs, ...found.untracked],
        refused,
      );
    }

    const untrackedPlan = await this.planUntrackedRestore(
      stashUntrackedCommit,
      worktreePlan,
      worktree,
    );

    // Everything below this line writes. Deletions first, as git's unpack-trees: a
    // deleted file or link `d` makes way for `d/x` and is never written through.
    for (const path of removes) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
    // what stands in the way was checked above: a tracked file or link where a directory
    // goes is unlinked, a clean directory where a file goes is replaced
    const writing = new Set(writes);
    await writeTreeRestorePlan(
      worktree,
      this.blobs,
      {
        ...worktreePlan,
        entries: worktreePlan.entries.filter((e) => writing.has(e.path)),
        gitlinks: [],
      },
      STASH_APPLY,
      { symlinks: trust.symlinks, replaceInTheWay: true },
    );
    if (untrackedPlan) {
      // Restored untracked files are written to the working tree only - they
      // were untracked when stashed and stay untracked now.
      await writeTreeRestorePlan(worktree, this.blobs, untrackedPlan, STASH_APPLY, {
        symlinks: trust.symlinks,
      });
    }
    if (mergedIndexTree !== undefined) {
      await this.staging.readTree(this.trees, mergedIndexTree);
      await this.staging.write();
    }

    return {
      status: StashApplyStatus.OK,
      stashCommit: stashId,
    };
  }

  /** The blobs, links and gitlinks of a tree, by path. */
  private async flatTree(treeId: ObjectId): Promise<Map<string, CheckedEntry>> {
    const out = new Map<string, CheckedEntry>();
    const walk = async (id: ObjectId, prefix: string): Promise<void> => {
      for await (const entry of this.trees.loadTree(id)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === FileMode.TREE) await walk(entry.id, path);
        else out.set(path, { objectId: entry.id, mode: entry.mode });
      }
    };
    await walk(treeId, "");
    return out;
  }

  /**
   * Plan the restore of the stash's untracked files, if there are any to restore.
   *
   * Untracked files are stashed in their own parentless commit and are not
   * merged with anything: they are simply written back. A stashed untracked
   * file whose path is already taken - by a file on disk, or by one the merged
   * tree is about to write - is refused rather than overwritten, since nothing
   * in the stash records what the displaced content was.
   *
   * @param untrackedCommitId The stash's third parent, if it has one
   * @param worktreePlan The already-planned restore of the merged working tree
   * @param worktree The working tree, checked for existing files
   * @returns The plan, or undefined if there is nothing to restore
   */
  private async planUntrackedRestore(
    untrackedCommitId: ObjectId | undefined,
    worktreePlan: TreeRestorePlan,
    worktree: Worktree,
  ): Promise<TreeRestorePlan | undefined> {
    if (!this.restoreUntracked || !untrackedCommitId) {
      return undefined;
    }

    const untrackedCommit = await this.commits.load(untrackedCommitId);
    if (!untrackedCommit) {
      throw new RefNotFoundError(untrackedCommitId, "Stash untracked commit not found");
    }

    const plan = await planTreeRestore(this.trees, this.blobs, untrackedCommit.tree, STASH_APPLY, {
      symlinks: true,
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      windows: worktree.capabilities?.windowsPaths === true,
    });

    for (const { path } of plan.entries) {
      if (worktreePlan.paths.has(path) || (await worktree.exists(path))) {
        throw new StashApplyFailedError(
          untrackedCommitId,
          undefined,
          `stash apply would overwrite ${path} with a stashed untracked file`,
        );
      }
    }

    return plan;
  }

  /**
   * Resolve the stash reference to a commit ID.
   */
  private async resolveStashRef(): Promise<ObjectId> {
    const refName = this.stashRef ?? `${STASH_REF}@{0}`;

    // Handle stash@{N} syntax
    const match = refName.match(/^(.+)@\{(\d+)\}$/);
    if (match) {
      let baseRef = match[1];
      const index = parseInt(match[2], 10);

      // Normalize stash to refs/stash
      if (baseRef === "stash") {
        baseRef = STASH_REF;
      }

      // For index 0, just resolve the ref
      if (index === 0) {
        const ref = await this.refsStore.resolve(baseRef);
        if (!ref?.objectId) {
          throw new RefNotFoundError(refName);
        }
        return ref.objectId;
      }

      // Older entries are in the ref's reflog (stash@{n}), as git reads them
      const reflog = await this.refsStore.getReflog?.(baseRef);
      if (!reflog) {
        throw new RefNotFoundError(refName, `Stash entry ${index} not found (no reflog)`);
      }
      const entry = await reflog.getReverseEntry(index);
      if (!entry) throw new RefNotFoundError(refName, `Stash entry ${index} not found`);
      return entry.newId;
    }

    // Try as direct ref
    const ref = await this.refsStore.resolve(refName);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as commit ID
    if (await this.commits.has(refName)) {
      return refName;
    }

    throw new RefNotFoundError(refName);
  }
}
