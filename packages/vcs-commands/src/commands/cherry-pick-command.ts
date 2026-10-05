import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { MergeStage } from "@statewalker/vcs-working-tree";

import {
  InvalidMainlineParentError,
  MultipleParentsNotAllowedError,
} from "../errors/merge-errors.js";
import { NoHeadError, RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { type CherryPickResult, CherryPickStatus } from "../results/cherry-pick-result.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";

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
 * Cherry-pick commits onto current branch.
 *
 * Equivalent to `git cherry-pick`.
 *
 * Based on JGit's CherryPickCommand.
 *
 * @example
 * ```typescript
 * // Cherry-pick a single commit
 * const result = await git.cherryPick()
 *   .include(commitId)
 *   .call();
 *
 * // Cherry-pick without committing
 * const result = await git.cherryPick()
 *   .include(commitId)
 *   .setNoCommit(true)
 *   .call();
 *
 * // Cherry-pick a merge commit
 * const result = await git.cherryPick()
 *   .include(mergeCommitId)
 *   .setMainlineParentNumber(1)
 *   .call();
 * ```
 */
export class CherryPickCommand extends GitCommand<CherryPickResult> {
  private includes: string[] = [];
  private noCommit = false;
  private mainlineParent?: number;
  private strategy: MergeStrategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private ourCommitName?: string;
  private reflogPrefix = "cherry-pick:";

  /**
   * Add a commit to cherry-pick.
   *
   * @param refOrId Commit ID or reference to cherry-pick
   */
  include(refOrId: string): this {
    this.checkCallable();
    this.includes.push(refOrId);
    return this;
  }

  /**
   * Set whether to commit after cherry-pick.
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
   * Set mainline parent number for cherry-picking merge commits.
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
   * @param prefix Reflog message prefix (default: "cherry-pick:")
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

  async call(): Promise<CherryPickResult> {
    this.checkCallable();
    this.setCallable(false);

    // Get current HEAD
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("Repository has no HEAD");
    }

    let headId = headRef.objectId;
    const cherryPickedRefs: ObjectId[] = [];

    // Cherry-pick each commit in order
    for (const refOrId of this.includes) {
      const result = await this.cherryPickOne(refOrId, headId);

      if (result.status !== CherryPickStatus.OK) {
        return result;
      }

      headId = result.newHead as ObjectId;
      cherryPickedRefs.push(refOrId);
    }

    return {
      status: CherryPickStatus.OK,
      newHead: headId,
      cherryPickedRefs,
    };
  }

  /**
   * Cherry-pick a single commit.
   */
  private async cherryPickOne(refOrId: string, headId: ObjectId): Promise<CherryPickResult> {
    // Resolve the commit to cherry-pick
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
          "Cannot cherry-pick merge commit without specifying mainline parent",
        );
      }
      if (this.mainlineParent < 1 || this.mainlineParent > commit.parents.length) {
        throw new InvalidMainlineParentError(this.mainlineParent, commit.parents.length);
      }
      parentId = commit.parents[this.mainlineParent - 1];
    }

    // Collect tree entries into Maps by path
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

    // Perform three-way merge: parent -> commit applied to head
    const { mergedEntries, conflicts } = this.threeWayMerge(
      parentTree,
      commitTree,
      headTree,
      allPaths,
    );

    if (conflicts.length > 0) {
      // Write conflict markers to staging
      await this.writeConflictStaging(parentTree, commitTree, headTree, conflicts);

      return {
        status: CherryPickStatus.CONFLICTING,
        cherryPickedRefs: [],
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
      const newCommit: Commit = {
        tree: newTreeId,
        parents: [headId],
        author: commit.author,
        committer: defaultCommitter(),
        message: commit.message,
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
        status: CherryPickStatus.OK,
        newHead: newCommitId,
        cherryPickedRefs: [commitId],
      };
    }

    // noCommit mode - just return current HEAD
    return {
      status: CherryPickStatus.OK,
      newHead: headId,
      cherryPickedRefs: [commitId],
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
   * Perform three-way merge for cherry-pick.
   *
   * The cherry-pick merge is: apply changes from parent->commit onto head.
   */
  private threeWayMerge(
    parentTree: Map<string, PathEntry>,
    commitTree: Map<string, PathEntry>,
    headTree: Map<string, PathEntry>,
    allPaths: Set<string>,
  ): { mergedEntries: Map<string, PathEntry>; conflicts: string[] } {
    const mergedEntries = new Map<string, PathEntry>();
    const conflicts: string[] = [];

    for (const path of allPaths) {
      const parentEntry = parentTree.get(path);
      const commitEntry = commitTree.get(path);
      const headEntry = headTree.get(path);

      const result = this.mergeEntry(path, parentEntry, commitEntry, headEntry);

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
    parent: PathEntry | undefined,
    commit: PathEntry | undefined,
    head: PathEntry | undefined,
  ): PathEntry | "deleted" | "conflict" {
    const parentId = parent?.id;
    const commitId = commit?.id;
    const headId = head?.id;

    // No change in cherry-picked commit
    if (parentId === commitId) {
      // Cherry-pick didn't change this file, keep head's version
      if (head) {
        return head;
      }
      return "deleted";
    }

    // File added in cherry-picked commit
    if (!parentId && commitId) {
      if (!headId) {
        // Added in commit, not in head - take commit's version
        return commit as PathEntry;
      }
      if (commitId === headId) {
        // Same content added in both
        return head as PathEntry;
      }
      // Different content added - conflict
      return "conflict";
    }

    // File deleted in cherry-picked commit
    if (parentId && !commitId) {
      if (!headId) {
        // Already deleted in head
        return "deleted";
      }
      if (parentId === headId) {
        // Head unchanged from parent, delete is clean
        return "deleted";
      }
      // Head modified, commit deleted - conflict
      return "conflict";
    }

    // File modified in cherry-picked commit
    if (parentId && commitId && parentId !== commitId) {
      if (!headId) {
        // Head deleted, commit modified - conflict
        return "conflict";
      }
      if (parentId === headId) {
        // Head unchanged, take commit's changes
        return commit as PathEntry;
      }
      if (commitId === headId) {
        // Same changes in both
        return head as PathEntry;
      }
      // Both modified differently - conflict
      return "conflict";
    }

    // Fallback: keep head
    return head ?? "deleted";
  }

  /**
   * Write conflict entries to staging.
   */
  private async writeConflictStaging(
    parentTree: Map<string, PathEntry>,
    commitTree: Map<string, PathEntry>,
    headTree: Map<string, PathEntry>,
    conflicts: string[],
  ): Promise<void> {
    const builder = this.staging.createBuilder();

    // Add all non-conflicting entries at stage 0
    const conflictSet = new Set(conflicts);

    // Add all entries from head that aren't conflicting
    for (const [path, entry] of headTree) {
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
      const parent = parentTree.get(path);
      const commit = commitTree.get(path);
      const head = headTree.get(path);

      // Stage 1: base (parent)
      if (parent) {
        builder.add({
          path,
          mode: parent.mode,
          objectId: parent.id,
          stage: MergeStage.BASE,
        });
      }

      // Stage 2: ours (head)
      if (head) {
        builder.add({
          path,
          mode: head.mode,
          objectId: head.id,
          stage: MergeStage.OURS,
        });
      }

      // Stage 3: theirs (commit being cherry-picked)
      if (commit) {
        builder.add({
          path,
          mode: commit.mode,
          objectId: commit.id,
          stage: MergeStage.THEIRS,
        });
      }
    }

    await builder.finish();
  }
}
