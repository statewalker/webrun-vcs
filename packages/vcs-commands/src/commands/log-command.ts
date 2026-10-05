import type { Commit, ObjectId } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";

/**
 * Result of a log command iteration.
 *
 * Extends Commit with the object ID.
 */
export interface LogResult extends Commit {
  /** The SHA-1 object ID of the commit */
  id: ObjectId;
}

/**
 * Revision filter for LogCommand.
 *
 * Based on JGit's RevFilter.
 */
export enum RevFilter {
  /** Include all commits (default) */
  ALL = "all",
  /** Only include merge commits (commits with more than one parent) */
  ONLY_MERGES = "only-merges",
  /** Exclude merge commits */
  NO_MERGES = "no-merges",
}

/**
 * Show commit history.
 *
 * Equivalent to `git log`.
 *
 * Based on JGit's LogCommand.
 *
 * @example
 * ```typescript
 * // Get all commits from HEAD
 * for await (const commit of await git.log().call()) {
 *   console.log(commit.message);
 * }
 *
 * // Get commits from a specific ref
 * const commits = await git.log().add(commitId).call();
 *
 * // Limit number of commits
 * const recent = await git.log().setMaxCount(10).call();
 *
 * // Skip first N commits
 * const older = await git.log().setSkip(10).setMaxCount(10).call();
 *
 * // Filter by date range
 * const thisWeek = await git.log()
 *   .setSince(Date.now() - 7 * 24 * 60 * 60 * 1000)
 *   .call();
 *
 * // Filter by author
 * const myCommits = await git.log()
 *   .setAuthorFilter("john@example.com")
 *   .call();
 *
 * // Exclude commits
 * const newCommits = await git.log()
 *   .not(oldBranchHead)
 *   .call();
 *
 * // Only merge commits
 * const merges = await git.log()
 *   .setRevFilter(RevFilter.ONLY_MERGES)
 *   .call();
 *
 * // Exclude merge commits
 * const nonMerges = await git.log()
 *   .setRevFilter(RevFilter.NO_MERGES)
 *   .call();
 *
 * // Range syntax (commits in feature not in main)
 * const newInFeature = await git.log()
 *   .addRange(mainHead, featureHead)
 *   .call();
 * ```
 */
export class LogCommand extends GitCommand<AsyncIterable<LogResult>> {
  private startCommits: ObjectId[] = [];
  private excludeCommits: ObjectId[] = [];
  private paths: string[] = [];
  private excludePaths: string[] = [];
  private maxCount?: number;
  private skip = 0;
  private includeAll = false;
  private firstParentOnly = false;
  private sinceTime?: number;
  private untilTime?: number;
  private authorPattern?: string;
  private committerPattern?: string;
  private revFilter = RevFilter.ALL;

  /**
   * Add a starting commit for the log.
   *
   * Multiple start commits can be added - the log will include
   * ancestors of all of them.
   *
   * @param commit ObjectId of commit to start from
   */
  add(commit: ObjectId): this {
    this.checkCallable();
    this.startCommits.push(commit);
    return this;
  }

  /**
   * Filter commits to only those affecting the given path.
   *
   * @param path Repository-relative path to filter by
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Exclude commits that only affect the given path.
   *
   * If a path is both added and excluded, the exclusion wins.
   *
   * @param path Repository-relative path to exclude
   */
  excludePath(path: string): this {
    this.checkCallable();
    this.excludePaths.push(path);
    return this;
  }

  /**
   * Limit the number of commits returned.
   *
   * @param maxCount Maximum number of commits to return
   */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.maxCount = maxCount;
    return this;
  }

  /**
   * Skip the first N commits.
   *
   * @param skip Number of commits to skip
   */
  setSkip(skip: number): this {
    this.checkCallable();
    this.skip = skip;
    return this;
  }

  /**
   * Include commits from all refs.
   *
   * When set, starts from all refs instead of just HEAD.
   */
  all(): this {
    this.checkCallable();
    this.includeAll = true;
    return this;
  }

  /**
   * Follow only the first parent on merges.
   *
   * Useful for seeing the linear history of a branch.
   */
  setFirstParent(firstParent: boolean): this {
    this.checkCallable();
    this.firstParentOnly = firstParent;
    return this;
  }

  /**
   * Exclude commits reachable from the given commit.
   *
   * Equivalent to `git log ^commit` or `A..B` syntax.
   * Useful for finding commits in one branch but not another.
   *
   * @param commit ObjectId to exclude along with its ancestors
   */
  not(commit: ObjectId): this {
    this.checkCallable();
    this.excludeCommits.push(commit);
    return this;
  }

  /**
   * Set minimum commit time (--since/--after).
   *
   * Only include commits after this timestamp.
   *
   * @param timestamp Unix timestamp in milliseconds or seconds
   */
  setSince(timestamp: number): this {
    this.checkCallable();
    // Normalize to seconds (Git uses seconds)
    this.sinceTime = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    return this;
  }

  /**
   * Set maximum commit time (--until/--before).
   *
   * Only include commits before this timestamp.
   *
   * @param timestamp Unix timestamp in milliseconds or seconds
   */
  setUntil(timestamp: number): this {
    this.checkCallable();
    // Normalize to seconds (Git uses seconds)
    this.untilTime = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    return this;
  }

  /**
   * Filter by author name or email (case-insensitive).
   *
   * Matches against "Author Name <email>" string.
   *
   * @param pattern Substring to match in author field
   */
  setAuthorFilter(pattern: string): this {
    this.checkCallable();
    this.authorPattern = pattern.toLowerCase();
    return this;
  }

  /**
   * Filter by committer name or email (case-insensitive).
   *
   * Matches against "Committer Name <email>" string.
   *
   * @param pattern Substring to match in committer field
   */
  setCommitterFilter(pattern: string): this {
    this.checkCallable();
    this.committerPattern = pattern.toLowerCase();
    return this;
  }

  /**
   * Set revision filter.
   *
   * - ALL: Include all commits (default)
   * - ONLY_MERGES: Only include merge commits
   * - NO_MERGES: Exclude merge commits
   *
   * @param filter Revision filter
   */
  setRevFilter(filter: RevFilter): this {
    this.checkCallable();
    this.revFilter = filter;
    return this;
  }

  /**
   * Add a commit range.
   *
   * Equivalent to `git log since..until` - includes commits reachable
   * from `until` but not from `since`.
   *
   * @param since Commits reachable from here are excluded
   * @param until Commits reachable from here are included (start point)
   */
  addRange(since: ObjectId, until: ObjectId): this {
    this.checkCallable();
    this.excludeCommits.push(since);
    this.startCommits.push(until);
    return this;
  }

  /**
   * Execute the log command.
   *
   * @returns AsyncIterable of commits in reverse chronological order
   */
  async call(): Promise<AsyncIterable<LogResult>> {
    this.checkCallable();
    this.setCallable(false);

    // Determine starting commits
    let starts: ObjectId[];
    if (this.startCommits.length > 0) {
      starts = this.startCommits;
    } else if (this.includeAll) {
      starts = await this.getAllRefs();
    } else {
      const headId = await this.resolveHead();
      starts = [headId];
    }

    return this.walkCommits(starts);
  }

  /**
   * Get all commit IDs from all refs.
   */
  private async getAllRefs(): Promise<ObjectId[]> {
    const ids: ObjectId[] = [];
    for await (const ref of this.refsStore.list()) {
      if ("objectId" in ref && ref.objectId) {
        ids.push(ref.objectId);
      }
    }
    return ids;
  }

  /**
   * Walk commits and yield them.
   */
  private async *walkCommits(starts: ObjectId[]): AsyncIterable<LogResult> {
    let count = 0;
    let skipped = 0;

    // Build set of excluded commits (including their ancestors)
    const excludedSet = await this.buildExcludedSet();

    for await (const commitId of this.commits.walkAncestry(starts, {
      firstParentOnly: this.firstParentOnly,
    })) {
      // Skip excluded commits
      if (excludedSet.has(commitId)) {
        continue;
      }

      const commit = await this.commits.load(commitId);
      if (!commit) {
        continue;
      }

      // RevFilter - ONLY_MERGES or NO_MERGES
      if (this.revFilter === RevFilter.ONLY_MERGES) {
        // Only include merge commits (more than one parent)
        if (commit.parents.length <= 1) {
          continue;
        }
      } else if (this.revFilter === RevFilter.NO_MERGES) {
        // Exclude merge commits
        if (commit.parents.length > 1) {
          continue;
        }
      }

      // Date filtering - since (after)
      if (this.sinceTime !== undefined && commit.committer.timestamp < this.sinceTime) {
        // Commits are in reverse chronological order, so we can stop early
        break;
      }

      // Date filtering - until (before)
      if (this.untilTime !== undefined && commit.committer.timestamp > this.untilTime) {
        continue;
      }

      // Author filtering
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) {
        continue;
      }

      // Committer filtering
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) {
        continue;
      }

      // Path filtering (include paths)
      if (this.paths.length > 0 && !(await this.affectsPath(commit, commitId))) {
        continue;
      }

      // Path filtering (exclude paths) - if commit only affects excluded paths, skip it
      if (this.excludePaths.length > 0 && (await this.onlyAffectsExcludedPaths(commit))) {
        continue;
      }

      // Skip first N commits
      if (skipped < this.skip) {
        skipped++;
        continue;
      }

      // Check max count
      if (this.maxCount !== undefined && count >= this.maxCount) {
        break;
      }

      count++;
      yield { ...commit, id: commitId };
    }
  }

  /**
   * Build set of commits to exclude.
   */
  private async buildExcludedSet(): Promise<Set<ObjectId>> {
    if (this.excludeCommits.length === 0) {
      return new Set();
    }

    const excluded = new Set<ObjectId>();
    for await (const commitId of this.commits.walkAncestry(this.excludeCommits, {
      firstParentOnly: false,
    })) {
      excluded.add(commitId);
    }
    return excluded;
  }

  /**
   * Check if commit author matches the filter pattern.
   */
  private matchesAuthor(commit: Commit): boolean {
    if (!this.authorPattern) return true;
    const authorStr = `${commit.author.name} <${commit.author.email}>`.toLowerCase();
    return authorStr.includes(this.authorPattern);
  }

  /**
   * Check if commit committer matches the filter pattern.
   */
  private matchesCommitter(commit: Commit): boolean {
    if (!this.committerPattern) return true;
    const committerStr = `${commit.committer.name} <${commit.committer.email}>`.toLowerCase();
    return committerStr.includes(this.committerPattern);
  }

  /**
   * Check if a commit affects any of the filtered paths.
   */
  private async affectsPath(commit: Commit, _commitId: ObjectId): Promise<boolean> {
    // If no parents, this is the initial commit - include if tree has the path
    if (commit.parents.length === 0) {
      return this.treeHasPath(commit.tree);
    }

    // Compare with first parent's tree
    const parentCommit = await this.commits.load(commit.parents[0]);
    if (!parentCommit) {
      return true; // No parent found, consider it affects paths
    }
    const parentTree = parentCommit.tree;

    // Check if any path differs between trees
    for (const path of this.paths) {
      const entryInCurrent = await this.getTreeEntryForPath(commit.tree, path);
      const entryInParent = await this.getTreeEntryForPath(parentTree, path);

      // Different if one exists and other doesn't, or if object IDs differ
      const currentId = entryInCurrent?.objectId;
      const parentId = entryInParent?.objectId;

      if (currentId !== parentId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a commit only affects excluded paths.
   *
   * If the commit only changes files in excludePaths, it should be filtered out.
   */
  private async onlyAffectsExcludedPaths(commit: Commit): Promise<boolean> {
    if (this.excludePaths.length === 0) {
      return false;
    }

    // For initial commit, check if all paths in tree are excluded
    if (commit.parents.length === 0) {
      // For simplicity, don't exclude initial commits based on path
      return false;
    }

    // Compare with first parent's tree
    const parentCommit = await this.commits.load(commit.parents[0]);
    if (!parentCommit) {
      return false; // No parent found, don't filter out
    }

    // Check each excluded path - if ALL changes are to excluded paths, return true
    for (const path of this.excludePaths) {
      const entryInCurrent = await this.getTreeEntryForPath(commit.tree, path);
      const entryInParent = await this.getTreeEntryForPath(parentCommit.tree, path);

      const currentId = entryInCurrent?.objectId;
      const parentId = entryInParent?.objectId;

      if (currentId !== parentId) {
        // This excluded path was modified - check if there are non-excluded changes
        // For simplicity, we filter out commits that touch any excluded path
        return true;
      }
    }

    return false;
  }

  /**
   * Check if tree contains any of the filtered paths.
   */
  private async treeHasPath(treeId: ObjectId): Promise<boolean> {
    for (const path of this.paths) {
      const entry = await this.getTreeEntryForPath(treeId, path);
      if (entry) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get tree entry for a path (supports nested paths).
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

      // Navigate into subtree
      currentTreeId = entry.id;
    }

    return undefined;
  }
}
