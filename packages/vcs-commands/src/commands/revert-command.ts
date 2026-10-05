import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { MergeStage } from "@statewalker/vcs-working-tree";

import {
  InvalidMainlineParentError,
  MultipleParentsNotAllowedError,
} from "../errors/merge-errors.js";
import { NoHeadError, RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import { type RevertResult, RevertStatus } from "../results/revert-result.js";

/**
 * Entry with full path for internal use during merge.
 */
interface PathEntry {
  path: string;
  mode: number;
  id: ObjectId;
}

/**
 * Get current timezone offset as string (+HHMM or -HHMM).
 */
function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hours = Math.floor(absOffset / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absOffset % 60).toString().padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

/**
 * Create a default committer identity.
 */
function defaultCommitter(): PersonIdent {
  return {
    name: "Unknown",
    email: "unknown@example.com",
    timestamp: Math.floor(Date.now() / 1000),
    tzOffset: getTimezoneOffset(),
  };
}

/**
 * Revert commits on current branch.
 *
 * Equivalent to `git revert`.
 *
 * Based on JGit's RevertCommand.
 *
 * @example
 * ```typescript
 * // Revert a single commit
 * const result = await git.revert()
 *   .include(commitId)
 *   .call();
 *
 * // Revert without committing
 * const result = await git.revert()
 *   .include(commitId)
 *   .setNoCommit(true)
 *   .call();
 *
 * // Revert a merge commit
 * const result = await git.revert()
 *   .include(mergeCommitId)
 *   .setMainlineParentNumber(1)
 *   .call();
 * ```
 */
export class RevertCommand extends GitCommand<RevertResult> {
  private includes: string[] = [];
  private noCommit = false;
  private mainlineParent?: number;
  private strategy: MergeStrategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private ourCommitName?: string;
  private reflogPrefix = "revert:";

  /**
   * Add a commit to revert.
   *
   * @param refOrId Commit ID or reference to revert
   */
  include(refOrId: string): this {
    this.checkCallable();
    this.includes.push(refOrId);
    return this;
  }

  /**
   * Set whether to commit after revert.
   *
   * When true, changes are staged but not committed.
   *
   * @param noCommit Whether to skip committing (default: false)
   */
  setNoCommit(noCommit: boolean): this {
    this.checkCallable();
    this.noCommit = noCommit;
    return this;
  }

  /**
   * Set mainline parent number for reverting merge commits.
   *
   * For regular commits, this is not needed. For merge commits,
   * this specifies which parent to diff against (1-indexed).
   *
   * @param parent Parent number (1 = first parent, 2 = second parent)
   */
  setMainlineParentNumber(parent: number): this {
    this.checkCallable();
    this.mainlineParent = parent;
    return this;
  }

  /**
   * Set the merge strategy.
   *
   * Default is "recursive".
   *
   * @param strategy Merge strategy to use
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
   * Set the content merge strategy for handling conflicts.
   *
   * @param contentStrategy Content merge strategy
   */
  setContentMergeStrategy(contentStrategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = contentStrategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Set the name to be used for "ours" in conflict markers.
   *
   * @param name Name for ours side (default: HEAD)
   */
  setOurCommitName(name: string): this {
    this.checkCallable();
    this.ourCommitName = name;
    return this;
  }

  /**
   * Get the name used for "ours" in conflict markers.
   */
  getOurCommitName(): string | undefined {
    return this.ourCommitName;
  }

  /**
   * Set the reflog prefix.
   *
   * @param prefix Reflog message prefix (default: "revert:")
   */
  setReflogPrefix(prefix: string): this {
    this.checkCallable();
    this.reflogPrefix = prefix;
    return this;
  }

  /**
   * Get the reflog prefix.
   */
  getReflogPrefix(): string {
    return this.reflogPrefix;
  }

  async call(): Promise<RevertResult> {
    this.checkCallable();
    this.setCallable(false);

    // Get current HEAD
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("Repository has no HEAD");
    }

    let headId = headRef.objectId;
    const revertedRefs: ObjectId[] = [];

    // Revert each commit in order
    for (const refOrId of this.includes) {
      const result = await this.revertOne(refOrId, headId);

      if (result.status !== RevertStatus.OK) {
        return result;
      }

      headId = result.newHead as ObjectId;
      revertedRefs.push(refOrId);
    }

    return {
      status: RevertStatus.OK,
      newHead: headId,
      revertedRefs,
    };
  }

  /**
   * Revert a single commit.
   */
  private async revertOne(refOrId: string, headId: ObjectId): Promise<RevertResult> {
    // Resolve the commit to revert
    const resolved = await this.refsStore.resolve(refOrId);
    const commitId = resolved?.objectId ?? refOrId;

    // Load the commit
    const commit = await this.commits.load(commitId);
    if (!commit) {
      throw new RefNotFoundError(`Cannot find commit: ${refOrId}`);
    }

    // Determine the parent to diff against
    let parentId: ObjectId;
    if (commit.parents.length === 0) {
      // Root commit - diff against empty tree
      parentId = this.trees.getEmptyTreeId();
    } else if (commit.parents.length === 1) {
      parentId = commit.parents[0];
    } else {
      // Merge commit - need mainlineParent
      if (this.mainlineParent === undefined) {
        throw new MultipleParentsNotAllowedError(
          "Cannot revert merge commit without specifying mainline parent",
        );
      }
      if (this.mainlineParent < 1 || this.mainlineParent > commit.parents.length) {
        throw new InvalidMainlineParentError(this.mainlineParent, commit.parents.length);
      }
      parentId = commit.parents[this.mainlineParent - 1];
    }

    // Collect tree entries into Maps by path
    // For revert: base=commit, ours=head, theirs=parent
    // This is the OPPOSITE of cherry-pick
    const headCommit = await this.commits.load(headId);
    if (!headCommit) {
      throw new RefNotFoundError(`Cannot find head commit: ${headId}`);
    }
    const headTree = new Map<string, PathEntry>();
    const commitTree = new Map<string, PathEntry>();
    const parentTree = new Map<string, PathEntry>();
    const allPaths = new Set<string>();

    await this.collectTreeEntries(headCommit.tree, "", headTree, allPaths);
    await this.collectTreeEntries(commit.tree, "", commitTree, allPaths);
    if (parentId !== this.trees.getEmptyTreeId()) {
      // parentId is a commit ID, so we need to load the commit to get its tree
      const parentCommit = await this.commits.load(parentId);
      if (!parentCommit) {
        throw new RefNotFoundError(`Cannot find parent commit: ${parentId}`);
      }
      await this.collectTreeEntries(parentCommit.tree, "", parentTree, allPaths);
    }

    // Perform three-way merge: commit -> parent applied to head
    // This is the REVERSE of cherry-pick: we apply the inverse changes
    const { mergedEntries, conflicts } = this.threeWayMerge(
      commitTree, // base = the commit being reverted
      parentTree, // theirs = the parent (what we want to go back to)
      headTree, // ours = current HEAD
      allPaths,
    );

    if (conflicts.length > 0) {
      // Write conflict markers to staging
      await this.writeConflictStaging(commitTree, parentTree, headTree, conflicts);

      return {
        status: RevertStatus.CONFLICTING,
        revertedRefs: [],
        conflicts,
      };
    }

    // Build merged tree
    const builder = this.staging.createBuilder();
    for (const entry of mergedEntries.values()) {
      builder.add({
        path: entry.path,
        mode: entry.mode,
        objectId: entry.id,
        stage: MergeStage.MERGED,
      });
    }
    await builder.finish();

    // Write tree
    const newTreeId = await this.staging.writeTree(this.trees);

    // Create commit if not noCommit mode
    if (!this.noCommit) {
      // Generate revert commit message
      const originalMessage = commit.message.split("\n")[0];
      const revertMessage = `Revert "${originalMessage}"\n\nThis reverts commit ${commitId}.`;

      const newCommit: Commit = {
        tree: newTreeId,
        parents: [headId],
        author: defaultCommitter(),
        committer: defaultCommitter(),
        message: revertMessage,
      };

      const newCommitId = await this.commits.store(newCommit);

      // Update HEAD
      const head = await this.refsStore.get("HEAD");
      if (head && "target" in head) {
        await this.refsStore.set(head.target, newCommitId);
      } else {
        await this.refsStore.set("HEAD", newCommitId);
      }

      return {
        status: RevertStatus.OK,
        newHead: newCommitId,
        revertedRefs: [commitId],
      };
    }

    // noCommit mode - just return current HEAD
    return {
      status: RevertStatus.OK,
      newHead: headId,
      revertedRefs: [commitId],
    };
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, PathEntry>,
    allPaths: Set<string>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        // Recurse into subtree
        await this.collectTreeEntries(entry.id, path, entries, allPaths);
      } else {
        // Blob entry
        entries.set(path, { path, mode: entry.mode, id: entry.id });
        allPaths.add(path);
      }
    }
  }

  /**
   * Perform three-way merge for revert.
   *
   * The revert merge is: apply changes from commit->parent onto head.
   * This is the INVERSE of cherry-pick.
   */
  private threeWayMerge(
    baseTree: Map<string, PathEntry>,
    theirsTree: Map<string, PathEntry>,
    oursTree: Map<string, PathEntry>,
    allPaths: Set<string>,
  ): { mergedEntries: Map<string, PathEntry>; conflicts: string[] } {
    const mergedEntries = new Map<string, PathEntry>();
    const conflicts: string[] = [];

    for (const path of allPaths) {
      const baseEntry = baseTree.get(path);
      const theirsEntry = theirsTree.get(path);
      const oursEntry = oursTree.get(path);

      const result = this.mergeEntry(path, baseEntry, theirsEntry, oursEntry);

      if (result === "conflict") {
        conflicts.push(path);
      } else if (result !== "deleted") {
        mergedEntries.set(path, result);
      }
    }

    return { mergedEntries, conflicts };
  }

  /**
   * Merge a single entry in three-way merge.
   */
  private mergeEntry(
    _path: string,
    base: PathEntry | undefined,
    theirs: PathEntry | undefined,
    ours: PathEntry | undefined,
  ): PathEntry | "deleted" | "conflict" {
    const baseId = base?.id;
    const theirsId = theirs?.id;
    const oursId = ours?.id;

    // No change in reverted commit (base == theirs means no change to revert)
    if (baseId === theirsId) {
      // Revert didn't change this file, keep ours' version
      if (ours) {
        return ours;
      }
      return "deleted";
    }

    // File added in reverted commit (will be deleted in revert)
    if (baseId && !theirsId) {
      if (!oursId) {
        // Already deleted in ours
        return "deleted";
      }
      if (baseId === oursId) {
        // Ours unchanged from base, delete is clean
        return "deleted";
      }
      // Ours modified, base deleted (revert wants to delete) - conflict
      return "conflict";
    }

    // File deleted in reverted commit (will be added back in revert)
    if (!baseId && theirsId) {
      if (!oursId) {
        // Added in theirs (parent), not in ours - take theirs' version
        return theirs as PathEntry;
      }
      if (theirsId === oursId) {
        // Same content in both
        return ours as PathEntry;
      }
      // Different content - conflict
      return "conflict";
    }

    // File modified in reverted commit (will be un-modified in revert)
    if (baseId && theirsId && baseId !== theirsId) {
      if (!oursId) {
        // Ours deleted, revert wants to change - conflict
        return "conflict";
      }
      if (baseId === oursId) {
        // Ours unchanged from base, take theirs' changes (parent version)
        return theirs as PathEntry;
      }
      if (theirsId === oursId) {
        // Same changes in both
        return ours as PathEntry;
      }
      // Both modified differently - conflict
      return "conflict";
    }

    // Fallback: keep ours
    return ours ?? "deleted";
  }

  /**
   * Write conflict entries to staging.
   */
  private async writeConflictStaging(
    baseTree: Map<string, PathEntry>,
    theirsTree: Map<string, PathEntry>,
    oursTree: Map<string, PathEntry>,
    conflicts: string[],
  ): Promise<void> {
    const builder = this.staging.createBuilder();

    // Add all non-conflicting entries at stage 0
    const conflictSet = new Set(conflicts);

    // Add all entries from ours that aren't conflicting
    for (const [path, entry] of oursTree) {
      if (!conflictSet.has(path)) {
        builder.add({
          path,
          mode: entry.mode,
          objectId: entry.id,
          stage: MergeStage.MERGED,
        });
      }
    }

    // For conflicting paths, add stages 1, 2, 3
    for (const path of conflicts) {
      const base = baseTree.get(path);
      const theirs = theirsTree.get(path);
      const ours = oursTree.get(path);

      // Stage 1: base (the commit being reverted)
      if (base) {
        builder.add({
          path,
          mode: base.mode,
          objectId: base.id,
          stage: MergeStage.BASE,
        });
      }

      // Stage 2: ours (current HEAD)
      if (ours) {
        builder.add({
          path,
          mode: ours.mode,
          objectId: ours.id,
          stage: MergeStage.OURS,
        });
      }

      // Stage 3: theirs (parent of commit being reverted)
      if (theirs) {
        builder.add({
          path,
          mode: theirs.mode,
          objectId: theirs.id,
          stage: MergeStage.THEIRS,
        });
      }
    }

    await builder.finish();
  }
}
