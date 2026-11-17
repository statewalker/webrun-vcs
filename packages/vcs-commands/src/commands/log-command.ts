import {
  type BloomFilterSettings,
  bloomFilterContains,
  bloomKey,
  type Commit,
  type CommitGraph,
  type GitObject,
  type ObjectId,
} from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

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
 * What a path-limited walk did (git's trace2 `bloom` statistics, and the tree work behind
 * them): how often the changed-path filters answered, and how many tree entries the walk read
 * to compare commits with their parents.
 */
export interface LogPathStatistics {
  /** Comparisons a filter settled: the paths certainly did not change */
  bloomDefinitelyNot: number;
  /** Comparisons where a filter said the paths may have changed (trees compared then) */
  bloomMaybe: number;
  /** Of `bloomMaybe`, those where the trees did not differ */
  bloomFalsePositive: number;
  /** Comparisons of commits the graph has without a filter (its layer has none) */
  bloomNotPresent: number;
  /** Comparisons of a commit's trees with a parent's (or the empty tree), at the paths */
  treeComparisons: number;
  /** Tree entries looked up for those comparisons (each reads its tree, or finds it cached) */
  treeEntryReads: number;
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
  private useBloomFilters = true;
  private readonly statistics: LogPathStatistics = {
    bloomDefinitelyNot: 0,
    bloomMaybe: 0,
    bloomFalsePositive: 0,
    bloomNotPresent: 0,
    treeComparisons: 0,
    treeEntryReads: 0,
  };

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
   * Whether a path-limited walk asks the commit-graph's changed-path Bloom filters before it
   * compares trees (default true, as git does whenever the graph has filters).
   */
  setUseBloomFilters(use: boolean): this {
    this.checkCallable();
    this.useBloomFilters = use;
    return this;
  }

  /** What the path-limited walk did so far (see {@link LogPathStatistics}). */
  getStatistics(): LogPathStatistics {
    return { ...this.statistics };
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

    return this.paths.length > 0 ? this.walkPathLimited(starts) : this.walkCommits(starts);
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
   * The walk of `git log -- <paths>` (revision.c, streaming mode): commits come out newest
   * first by committer date (equal dates in the order they were queued), and history is
   * simplified as git's try_to_simplify_commit does it. A commit is compared with each parent
   * at the paths; one that matches a parent ("TREESAME") is not shown, and when that parent is
   * the first such one only it is walked further. A root commit is shown when it has any of
   * the paths. Before comparing a commit with its first parent, the commit-graph's
   * changed-path Bloom filter of the commit is asked (git's check_maybe_different_in_bloom_filter):
   * when it says no path changed, no tree is read.
   */
  private async *walkPathLimited(starts: ObjectId[]): AsyncIterable<LogResult> {
    const excludedSet = await this.buildExcludedSet();
    const graph = await this.commits.commitGraph?.get().catch(() => undefined);
    const bloom = this.useBloomFilters ? this.bloomKeys(graph) : undefined;
    const paths = this.paths.map(pathParts);

    /** tree, parents and date: from the graph when it has the commit, else from the commit */
    const header = async (
      id: ObjectId,
    ): Promise<{ tree: ObjectId; parents: ObjectId[]; date: number; pos: number } | undefined> => {
      const pos = graph ? graph.position(id) : -1;
      if (graph && pos >= 0) {
        try {
          return {
            tree: graph.treeAt(pos),
            parents: graph.parentsAt(pos),
            date: graph.commitTimeAt(pos),
            pos,
          };
        } catch {
          // a corrupt record: the commit is read instead
        }
      }
      const commit = await this.commits.load(id);
      if (!commit) return undefined;
      return {
        tree: commit.tree,
        parents: commit.parents,
        date: commit.committer.timestamp,
        pos: -1,
      };
    };

    // git's prio_queue of commits by date, newest first, ties in insertion order
    const queue = new CommitQueue();
    const seen = new Set<ObjectId>();
    for (const id of starts) {
      if (seen.has(id)) continue;
      seen.add(id);
      const h = await header(id);
      if (h) queue.put(id, h.date);
    }

    let count = 0;
    let skipped = 0;
    for (;;) {
      const id = queue.get();
      if (id === undefined) break;
      if (excludedSet.has(id)) continue;
      const h = await header(id);
      if (!h) continue;
      // --since: older commits are dropped without walking their parents (git's max_age)
      if (this.sinceTime !== undefined && h.date < this.sinceTime) continue;

      // try_to_simplify_commit, then process_parents
      let parents = h.parents;
      let treesame = false;
      if (parents.length === 0) {
        treesame = !(await this.differsAtPaths(undefined, h.tree, paths, bloom, graph, h.pos));
      } else {
        let changed = false;
        for (let nth = 0; nth < parents.length; nth++) {
          if (nth === 1 && this.firstParentOnly) break;
          const parentId = parents[nth] as ObjectId;
          const ph = await header(parentId);
          const differs = ph
            ? await this.differsAtPaths(
                ph.tree,
                h.tree,
                paths,
                nth === 0 ? bloom : undefined,
                graph,
                h.pos,
              )
            : true;
          if (!differs) {
            parents = [parentId];
            treesame = true;
            changed = false;
            break;
          }
          changed = true;
        }
        if (!changed) treesame = true;
      }
      const walked = this.firstParentOnly ? parents.slice(0, 1) : parents;
      for (const p of walked) {
        if (seen.has(p)) continue;
        seen.add(p);
        const ph = await header(p);
        if (ph) queue.put(p, ph.date);
      }
      if (treesame) continue;

      // get_commit_action: --until, the parent counts, the author and committer filters
      if (this.untilTime !== undefined && h.date > this.untilTime) continue;
      if (this.revFilter === RevFilter.ONLY_MERGES && parents.length <= 1) continue;
      if (this.revFilter === RevFilter.NO_MERGES && parents.length > 1) continue;
      const commit = await this.commits.load(id);
      if (!commit) continue;
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) continue;
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) continue;
      if (this.excludePaths.length > 0 && (await this.onlyAffectsExcludedPaths(commit))) continue;
      if (skipped < this.skip) {
        skipped++;
        continue;
      }
      if (this.maxCount !== undefined && count >= this.maxCount) break;
      count++;
      yield { ...commit, id };
    }
  }

  /**
   * The Bloom keys of the paths, one vector per path (the path and each leading directory,
   * git's bloom_keyvec_new), hashed with the graph's settings; undefined when the graph has no
   * filters or a path cannot use them (git's prepare_to_use_bloom_filter: an empty path).
   */
  private bloomKeys(
    graph: CommitGraph | undefined,
  ): { settings: BloomFilterSettings; keys: number[][][] } | undefined {
    const settings = graph?.bloomSettings;
    if (!settings) return undefined;
    const encoder = new TextEncoder();
    const keys: number[][][] = [];
    for (const path of this.paths) {
      const bytes = encoder.encode(pathParts(path).join("/"));
      if (bytes.length === 0) return undefined;
      const vec = [bloomKey(bytes, settings)];
      for (let end = bytes.length - 1; end > 0; end--) {
        if (bytes[end] === 0x2f) vec.push(bloomKey(bytes.subarray(0, end), settings));
      }
      keys.push(vec);
    }
    return { settings, keys };
  }

  /**
   * Whether the paths differ between tree `from` (undefined: the empty tree) and tree `to` of
   * the commit at graph position `pos` (git's rev_compare_tree / rev_same_tree_as_empty):
   * with `bloom`, the commit's filter is asked first and a "certainly not" ends it.
   */
  private async differsAtPaths(
    from: ObjectId | undefined,
    to: ObjectId,
    paths: string[][],
    bloom: { settings: BloomFilterSettings; keys: number[][][] } | undefined,
    graph: CommitGraph | undefined,
    pos: number,
  ): Promise<boolean> {
    const stats = this.statistics;
    let maybe = false;
    // a commit outside the graph is not asked (its generation is infinite)
    if (bloom && graph && pos >= 0) {
      const filter = graph.bloomFilterAt(pos);
      if (!filter) {
        stats.bloomNotPresent++;
      } else {
        // bloom_filter_contains_vec over each path: one "maybe" (or an empty filter) is enough
        let result = 0;
        for (let i = 0; result === 0 && i < bloom.keys.length; i++) {
          result = 1;
          for (const key of bloom.keys[i] as number[][]) {
            result = bloomFilterContains(filter.data, key);
            if (result <= 0) break;
          }
        }
        if (result === 0) {
          stats.bloomDefinitelyNot++;
          return false;
        }
        stats.bloomMaybe++;
        maybe = result === 1;
      }
    }
    stats.treeComparisons++;
    let differs = false;
    for (const parts of paths) {
      if (await this.differsAtPath(from, to, parts, 0)) {
        differs = true;
        break;
      }
    }
    if (maybe && !differs) stats.bloomFalsePositive++;
    return differs;
  }

  /**
   * Whether the entries at `parts[i..]` below trees `a` and `b` differ (git's pathspec match:
   * the path itself, or anything below it). Equal subtrees end the walk down.
   */
  private async differsAtPath(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    parts: string[],
    i: number,
  ): Promise<boolean> {
    if (parts.length === 0) return a !== b;
    const name = parts[i] as string;
    const ea = a ? await this.entryOf(a, name) : undefined;
    const eb = b ? await this.entryOf(b, name) : undefined;
    if (!ea && !eb) return false;
    if (ea && eb && ea.id === eb.id && ea.mode === eb.mode) return false;
    if (i === parts.length - 1) return true;
    const ta = ea && isTreeMode(ea.mode) ? ea.id : undefined;
    const tb = eb && isTreeMode(eb.mode) ? eb.id : undefined;
    if (!ta && !tb) return false;
    return this.differsAtPath(ta, tb, parts, i + 1);
  }

  /**
   * Entry `name` of tree `tree`: found in the tree's raw bytes (no entry is decoded but the
   * one asked for) when the store gives them, else through the tree store.
   */
  private async entryOf(
    tree: ObjectId,
    name: string,
  ): Promise<{ id: ObjectId; mode: number } | undefined> {
    this.statistics.treeEntryReads++;
    const raw = await this.rawTree(tree);
    if (raw === null) return this.trees.getEntry(tree, name);
    if (raw === undefined) return undefined;
    return findRawEntry(raw, NAME_ENCODER.encode(name));
  }

  /** Raw trees read lately, most recently used last: a commit's trees are its child's parent trees. */
  private readonly rawTrees = new Map<ObjectId, Uint8Array>();

  /** The raw bytes of a tree; undefined when it is missing, null without a raw object store. */
  private async rawTree(id: ObjectId): Promise<Uint8Array | undefined | null> {
    const cached = this.rawTrees.get(id);
    if (cached) {
      this.rawTrees.delete(id);
      this.rawTrees.set(id, cached);
      return cached;
    }
    const objects = this._workingCopy.history?.objects;
    if (!objects) return null;
    let obj: GitObject | undefined;
    try {
      const now = objects.getNow ? objects.getNow(id) : objects.get(id);
      obj = now instanceof Promise ? await now : now;
    } catch {
      return null;
    }
    if (!obj) return undefined;
    if (obj.type !== "tree") {
      await obj.content[Symbol.asyncIterator]().return?.();
      return null;
    }
    let bytes = obj.bytes;
    if (!bytes) {
      const chunks: Uint8Array[] = [];
      for await (const c of obj.content) chunks.push(c);
      bytes = concatBytes(chunks);
    }
    this.rawTrees.set(id, bytes);
    if (this.rawTrees.size > RAW_TREE_CACHE) {
      this.rawTrees.delete(this.rawTrees.keys().next().value as ObjectId);
    }
    return bytes;
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

const isTreeMode = (mode: number) => (mode & 0o170000) === 0o040000;

const NAME_ENCODER = new TextEncoder();

/** Raw trees a path-limited walk keeps. */
const RAW_TREE_CACHE = 512;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The entry named `name` (raw bytes) in raw tree `d`: its id and mode, or undefined. */
function findRawEntry(d: Uint8Array, name: Uint8Array): { id: ObjectId; mode: number } | undefined {
  let p = 0;
  const n = name.length;
  while (p < d.length) {
    let mode = 0;
    while (p < d.length && d[p] !== 0x20) mode = mode * 8 + ((d[p++] as number) - 0x30);
    p++;
    const start = p;
    while (p < d.length && d[p] !== 0) p++;
    const idAt = p + 1;
    if (p - start === n) {
      let k = 0;
      while (k < n && d[start + k] === name[k]) k++;
      if (k === n) return { id: bytesToHex(d.subarray(idAt, idAt + 20)), mode };
    }
    p = idAt + 20;
  }
  return undefined;
}

/** A path's components, without empty ones and "." (git's pathspec normalisation). */
const pathParts = (path: string) =>
  path.split("/").filter((part) => part.length > 0 && part !== ".");

/**
 * git's prio_queue with compare_commits_by_commit_date: the newest commit first, commits of
 * one date in the order they were put.
 */
class CommitQueue {
  private ids: ObjectId[] = [];
  private dates: number[] = [];
  private ctrs: number[] = [];
  private ctr = 0;

  put(id: ObjectId, date: number): void {
    const ids = this.ids;
    const dates = this.dates;
    const ctrs = this.ctrs;
    let ix = ids.length;
    ids.push(id);
    dates.push(date);
    ctrs.push(this.ctr++);
    while (ix > 0) {
      const parent = (ix - 1) >> 1;
      if (this.before(parent, ix)) break;
      this.swap(parent, ix);
      ix = parent;
    }
  }

  get(): ObjectId | undefined {
    const ids = this.ids;
    if (ids.length === 0) return undefined;
    const top = ids[0];
    const last = ids.length - 1;
    this.swap(0, last);
    ids.pop();
    this.dates.pop();
    this.ctrs.pop();
    let ix = 0;
    for (;;) {
      let child = 2 * ix + 1;
      if (child >= ids.length) break;
      if (child + 1 < ids.length && this.before(child + 1, child)) child++;
      if (this.before(ix, child)) break;
      this.swap(ix, child);
      ix = child;
    }
    return top;
  }

  /** Whether entry `a` comes out before entry `b`. */
  private before(a: number, b: number): boolean {
    const da = this.dates[a] as number;
    const db = this.dates[b] as number;
    if (da !== db) return da > db;
    return (this.ctrs[a] as number) < (this.ctrs[b] as number);
  }

  private swap(a: number, b: number): void {
    const { ids, dates, ctrs } = this;
    [ids[a], ids[b]] = [ids[b] as ObjectId, ids[a] as ObjectId];
    [dates[a], dates[b]] = [dates[b] as number, dates[a] as number];
    [ctrs[a], ctrs[b]] = [ctrs[b] as number, ctrs[a] as number];
  }
}
