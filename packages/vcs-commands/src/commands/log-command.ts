import {
  type BloomFilterSettings,
  bloomFilterContains,
  bloomKey,
  type Commit,
  type CommitGraph,
  EMPTY_TREE_ID,
  type GitObject,
  type ObjectId,
} from "@statewalker/vcs-core";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { configBool, configValue } from "./merge-config.js";
import {
  ALL_ENTRIES_NOT_INTERESTING,
  bloomPathOf,
  ENTRY_NOT_INTERESTING,
  latin1String,
  type PathspecItem,
  parsePathspecItem,
  pathspecForbidsBloom,
  type TreePathspec,
  treeEntryInteresting,
  treePathspec,
} from "./pathspec.js";

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
  /** The commits given, included and excluded, in the order given (git's pending list) */
  private readonly pending: { id: ObjectId; exclude: boolean }[] = [];
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
    this.pending.push({ id: commit, exclude: false });
    return this;
  }

  /**
   * Filter commits to only those affecting the given path.
   *
   * The path is a git pathspec element, as `git log -- <path>` reads it: a path from the top
   * of the repository (a directory names everything below it), with wildcards (`*`, `?`,
   * `[...]`, matched as git's `git_fnmatch` does) and magic (`:(glob)`, `:(literal)`,
   * `:(icase)`, `:(exclude)` or `:!`).
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
   * The path is an `:(exclude)` pathspec element (`git log -- . ':!<path>'`): changes below
   * it do not count when commits are compared with their parents. If a path is both added
   * and excluded, the exclusion wins.
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
    this.pending.push({ id: commit, exclude: true });
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
    this.pending.push({ id: since, exclude: true }, { id: until, exclude: false });
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

    if (this.paths.length === 0 && this.excludePaths.length === 0) return this.walkCommits(starts);
    const pending = [...this.pending];
    if (this.startCommits.length === 0) {
      for (const id of starts) pending.push({ id, exclude: false });
    }
    return this.walkPathLimited(pending);
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
   * The walk of `git log -- <pathspec>`, ported from git's revision.c. Commits come out newest
   * first by committer date (equal dates in the order they were queued), and history is
   * simplified as try_to_simplify_commit does it: a commit is compared with each parent at
   * the paths; one that matches a relevant parent ("TREESAME") is not shown, and only that
   * parent is walked further. A root commit is shown when it has any of the paths. Before
   * comparing a commit with its first parent, the commit-graph's changed-path Bloom filter of
   * the commit is asked (check_maybe_different_in_bloom_filter): when it says no path
   * changed, no tree is read.
   *
   * Without excluded commits the walk streams (get_revision_1). With some (`not`,
   * `addRange`), it is limited first as limit_list does it: one date-ordered queue holds the
   * included and the excluded commits, UNINTERESTING spreads to parents as commits are
   * taken, a commit's relevance is judged with what is marked so far, `--since` marks older
   * commits UNINTERESTING, and the walk stops once only uninteresting commits are left
   * (still_interesting); what is shown is filtered by the final marks.
   */
  private async *walkPathLimited(
    pending: { id: ObjectId; exclude: boolean }[],
  ): AsyncIterable<LogResult> {
    const graph = await this.commits.commitGraph?.get().catch(() => undefined);
    const pathspec = this.pathspec();
    const bloom = this.useBloomFilters ? this.bloomKeys(graph, pathspec.items) : undefined;
    const bloomVersion = bloom ? this.changedPathsVersion() : -1;
    const fast = pathspec.literal;
    const firstParentOnly = this.firstParentOnly;

    const commits = new Map<ObjectId, RevCommit>();
    const lookup = (id: ObjectId): RevCommit => {
      let c = commits.get(id);
      if (!c) {
        c = { id, flags: 0, parsed: false, tree: "", date: 0, pos: -1, parents: undefined };
        commits.set(id, c);
      }
      return c;
    };
    /** git's parse_commit: tree, parents and date, from the graph when it has the commit */
    const parse = async (c: RevCommit): Promise<boolean> => {
      if (c.parsed) return true;
      let parents: ObjectId[] | undefined;
      const pos = graph ? graph.position(c.id) : -1;
      if (graph && pos >= 0) {
        try {
          c.tree = graph.treeAt(pos);
          c.date = graph.commitTimeAt(pos);
          parents = graph.parentsAt(pos);
          c.pos = pos;
        } catch {
          // a corrupt record: the commit is read instead
          parents = undefined;
        }
      }
      if (!parents) {
        const commit = await this.commits.load(c.id).catch(() => undefined);
        if (!commit) return false;
        c.tree = commit.tree;
        c.date = commit.committer.timestamp;
        c.pos = -1;
        parents = commit.parents;
      }
      c.parents = parents.map(lookup);
      c.parsed = true;
      return true;
    };
    /** git's mark_parents_uninteresting: through the parents known (parsed) so far */
    const markParentsUninteresting = (c: RevCommit): void => {
      const stack: RevCommit[] = [];
      const markOne = (p: RevCommit) => {
        if (p.flags & UNINTERESTING) return;
        p.flags |= UNINTERESTING;
        if (p.parents) for (const q of p.parents) stack.push(q);
      };
      for (const p of c.parents ?? []) markOne(p);
      for (let p = stack.pop(); p; p = stack.pop()) markOne(p);
    };
    const differs = (from: ObjectId | undefined, c: RevCommit, nth: number) =>
      this.differsAtPaths(
        from,
        c.tree,
        pathspec,
        fast,
        nth === 0 ? bloom : undefined,
        bloomVersion,
        graph,
        c.pos,
      );
    /** git's try_to_simplify_commit (prune, dense, simplify_history, no show_pulls) */
    const simplify = async (c: RevCommit): Promise<void> => {
      const parents = c.parents as RevCommit[];
      if (parents.length === 0) {
        if (!(await differs(undefined, c, 0))) c.flags |= TREESAME;
        return;
      }
      let relevantParents = 0;
      let relevantChange = false;
      let irrelevantChange = false;
      for (let nth = 0; nth < parents.length; nth++) {
        const p = parents[nth] as RevCommit;
        if (relevant(p)) relevantParents++;
        if (nth === 1 && firstParentOnly) break;
        if (!(await parse(p))) {
          throw new GitApiError(`cannot simplify commit ${c.id} (because of ${p.id})`);
        }
        if (!(await differs(p.tree, c, nth))) {
          // a merge with an irrelevant side that brought the whole change keeps its others
          if (!relevant(p)) continue;
          c.parents = [p];
          c.flags |= TREESAME;
          return;
        }
        if (relevant(p)) relevantChange = true;
        else irrelevantChange = true;
      }
      if (relevantParents ? !relevantChange : !irrelevantChange) c.flags |= TREESAME;
    };
    /** git's process_parents */
    const processParents = async (c: RevCommit, queue: CommitQueue<RevCommit>): Promise<void> => {
      if (c.flags & ADDED) return;
      c.flags |= ADDED;
      if (c.flags & UNINTERESTING) {
        for (const p of c.parents ?? []) {
          p.flags |= UNINTERESTING;
          if (!(await parse(p))) continue;
          if (p.parents?.length) markParentsUninteresting(p);
          if (p.flags & SEEN) continue;
          p.flags |= SEEN;
          queue.put(p, p.date);
        }
        return;
      }
      await simplify(c);
      for (const p of c.parents as RevCommit[]) {
        if (!(await parse(p))) {
          throw new GitApiError(`Failed to traverse parents of commit ${c.id}`);
        }
        if (!(p.flags & SEEN)) {
          p.flags |= SEEN;
          queue.put(p, p.date);
        }
        if (firstParentOnly) break;
      }
    };
    /** git's get_commit_action (no parent rewriting: TREESAME commits are never shown) */
    const shown = async (c: RevCommit): Promise<Commit | undefined> => {
      if (c.flags & (UNINTERESTING | TREESAME)) return undefined;
      if (this.untilTime !== undefined && c.date > this.untilTime) return undefined;
      const n = (c.parents as RevCommit[]).length;
      if (this.revFilter === RevFilter.ONLY_MERGES && n < 2) return undefined;
      if (this.revFilter === RevFilter.NO_MERGES && n > 1) return undefined;
      const commit = await this.commits.load(c.id);
      if (!commit) return undefined;
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) return undefined;
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) return undefined;
      return commit;
    };

    // prepare_revision_walk: the flags of every argument first, then handle_commit in order
    for (const e of pending) if (e.exclude) lookup(e.id).flags |= UNINTERESTING | BOTTOM;
    const list: RevCommit[] = [];
    let limited = false;
    for (const e of pending) {
      const c = lookup(e.id);
      if (!(await parse(c))) continue;
      if (c.flags & UNINTERESTING) {
        markParentsUninteresting(c);
        limited = true;
      }
      if (!(c.flags & SEEN)) {
        c.flags |= SEEN;
        list.push(c);
      }
    }
    // commit_list_sort_by_date (stable), then into the date queue in that order
    list.sort((a, b) => b.date - a.date);
    const queue = new CommitQueue<RevCommit>();
    for (const c of list) queue.put(c, c.date);

    let count = 0;
    let skipped = 0;
    // git's -n 0 reads nothing more in a streaming walk; a limited walk is done before
    const none = this.maxCount !== undefined && this.maxCount <= 0;
    if (!limited) {
      if (none) return;
      // get_revision_1, streaming
      for (let c = queue.get(); c; c = queue.get()) {
        // --since: older commits are dropped without walking their parents (max_age)
        if (this.sinceTime !== undefined && c.date < this.sinceTime) continue;
        await processParents(c, queue);
        const commit = await shown(c);
        if (!commit) continue;
        if (skipped < this.skip) {
          skipped++;
          continue;
        }
        yield { ...commit, id: c.id };
        if (this.maxCount !== undefined && ++count >= this.maxCount) return;
      }
      return;
    }

    // limit_list
    const newlist: RevCommit[] = [];
    let date = Number.POSITIVE_INFINITY;
    let slop = SLOP;
    let interestingCache: RevCommit | undefined;
    /** git's everybody_uninteresting */
    const everybodyUninteresting = (): boolean => {
      if (interestingCache && !(interestingCache.flags & UNINTERESTING)) return false;
      for (const c of queue.items()) {
        if (c.flags & UNINTERESTING) continue;
        interestingCache = c;
        return false;
      }
      return true;
    };
    /** git's still_interesting */
    const stillInteresting = (): number => {
      const head = queue.peek();
      if (!head) return 0;
      if (date <= head.date) return SLOP;
      if (!everybodyUninteresting()) return SLOP;
      return slop - 1;
    };
    for (let c = queue.get(); c; c = queue.get()) {
      if (c === interestingCache) interestingCache = undefined;
      if (this.sinceTime !== undefined && c.date < this.sinceTime) c.flags |= UNINTERESTING;
      await processParents(c, queue);
      if (c.flags & UNINTERESTING) {
        markParentsUninteresting(c);
        slop = stillInteresting();
        if (slop) continue;
        break;
      }
      if (this.untilTime !== undefined && c.date > this.untilTime) continue;
      date = c.date;
      newlist.push(c);
    }
    if (none) return;
    for (const c of newlist) {
      const commit = await shown(c);
      if (!commit) continue;
      if (skipped < this.skip) {
        skipped++;
        continue;
      }
      yield { ...commit, id: c.id };
      if (this.maxCount !== undefined && ++count >= this.maxCount) return;
    }
  }

  /**
   * The pathspec of the walk: the paths added, the excluded ones as `:(exclude)` elements,
   * and `.` when every element excludes (git's parse_pathspec). `literal` holds each
   * element's path components when all are plain paths (no wildcard, no magic, no trailing
   * slash): those are compared by looking their entries up, without a tree diff.
   */
  private pathspec(): TreePathspec & { literal: string[][] | undefined } {
    const items: PathspecItem[] = this.paths.map(parsePathspecItem);
    for (const p of this.excludePaths) items.push({ ...parsePathspecItem(p), exclude: true });
    if (items.every((i) => i.exclude)) items.push(parsePathspecItem("."));
    const plain = items.every(
      (i) => !i.exclude && !i.icase && i.nowildcardLen === i.match.length && !i.match.endsWith("/"),
    );
    return {
      ...treePathspec(items),
      literal: plain ? items.map((i) => pathParts(i.match)) : undefined,
    };
  }

  /** git's `commitGraph.changedPathsVersion` (-1: any; 0 when `readChangedPaths` is false). */
  private changedPathsVersion(): number {
    const raw = configValue(this._workingCopy, "commitGraph.changedPathsVersion");
    if (raw !== undefined && /^\s*[-+]?\d+\s*$/.test(raw)) return Number.parseInt(raw, 10);
    return configBool(this._workingCopy, "commitGraph.readChangedPaths", true) ? -1 : 0;
  }

  /**
   * The Bloom keys of the pathspec, one vector per element (its path and each leading
   * directory, git's bloom_keyvec_new), hashed with the graph's settings; undefined when the
   * graph has no filters or the pathspec cannot use them (git's prepare_to_use_bloom_filter:
   * exclude or icase magic, or an element without a literal leading directory).
   */
  private bloomKeys(
    graph: CommitGraph | undefined,
    items: PathspecItem[],
  ): { settings: BloomFilterSettings; keys: number[][][] } | undefined {
    const settings = graph?.bloomSettings;
    if (!settings || pathspecForbidsBloom(items)) return undefined;
    const keys: number[][][] = [];
    for (const item of items) {
      const path = bloomPathOf(item);
      if (path === undefined) return undefined;
      const bytes = Uint8Array.from(path, (ch) => ch.charCodeAt(0));
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
   * with `bloom`, the commit's filter is asked first and a "certainly not" ends it. A filter
   * of another hash version than `commitGraph.changedPathsVersion` asks for is not there
   * (git's get_bloom_filter).
   */
  private async differsAtPaths(
    from: ObjectId | undefined,
    to: ObjectId,
    pathspec: TreePathspec,
    literal: string[][] | undefined,
    bloom: { settings: BloomFilterSettings; keys: number[][][] } | undefined,
    bloomVersion: number,
    graph: CommitGraph | undefined,
    pos: number,
  ): Promise<boolean> {
    const stats = this.statistics;
    let maybe = false;
    // a commit outside the graph is not asked (its generation is infinite)
    if (bloom && graph && pos >= 0) {
      const found = graph.bloomFilterAt(pos);
      const filter =
        found && (bloomVersion === -1 || found.settings.hashVersion === bloomVersion)
          ? found
          : undefined;
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
    if (literal) {
      for (const parts of literal) {
        if (await this.differsAtPath(from, to, parts, 0)) {
          differs = true;
          break;
        }
      }
    } else {
      differs = await this.treesDiffer(from, to, pathspec, "");
    }
    if (maybe && !differs) stats.bloomFalsePositive++;
    return differs;
  }

  /**
   * Whether trees `a` and `b` (undefined: empty) under `base` differ at a path in the
   * pathspec: git's pruned, recursive diff_tree_oid with `quick` (the first change ends it).
   * Entries are taken in git's tree order on both sides, those `tree_entry_interesting`
   * rejects skipped; a directory that differs, or is only on one side, is walked down.
   */
  private async treesDiffer(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    ps: TreePathspec,
    base: string,
  ): Promise<boolean> {
    this.statistics.treeEntryReads++;
    // git reads the parent's tree, then the commit's
    const da = a ? await this.requireTree(a) : EMPTY_TREE;
    const db = b ? await this.requireTree(b) : EMPTY_TREE;
    const ca = new RawEntries(da);
    const cb = new RawEntries(db);
    const skip = (c: RawEntries) => {
      while (!c.done) {
        c.read();
        const r = treeEntryInteresting(ps, c.name, c.mode, base);
        if (r === ALL_ENTRIES_NOT_INTERESTING) {
          c.at = c.d.length;
          return;
        }
        if (r !== ENTRY_NOT_INTERESTING) return;
        c.next();
      }
    };
    for (;;) {
      skip(ca);
      skip(cb);
      if (ca.done && cb.done) return false;
      const cmp = ca.done ? 1 : cb.done ? -1 : ca.compare(cb);
      if (cmp === 0) {
        const same = ca.mode === cb.mode && ca.sameId(cb);
        if (!same) {
          if (!isTreeMode(ca.mode) || !isTreeMode(cb.mode)) return true;
          if (await this.treesDiffer(ca.id(), cb.id(), ps, `${base}${ca.name}/`)) return true;
        }
        ca.next();
        cb.next();
        continue;
      }
      // an entry on one side only: a file is a change, a directory is walked against nothing
      const one = cmp < 0 ? ca : cb;
      if (!isTreeMode(one.mode)) return true;
      const sub = one.id();
      const below =
        cmp < 0
          ? await this.treesDiffer(sub, undefined, ps, `${base}${one.name}/`)
          : await this.treesDiffer(undefined, sub, ps, `${base}${one.name}/`);
      if (below) return true;
      one.next();
    }
  }

  /** A tree's raw bytes; git's "unable to read tree" when it is missing. */
  private async requireTree(id: ObjectId): Promise<Uint8Array> {
    const raw = await this.rawTree(id);
    if (raw instanceof Uint8Array) return raw;
    if (raw === null) {
      // no raw object store: the entries are encoded back
      const entries = await this.trees.load(id);
      if (!entries) throw new GitApiError(`unable to read tree (${id})`);
      const parts: Uint8Array[] = [];
      for await (const e of entries) {
        parts.push(NAME_ENCODER.encode(`${e.mode.toString(8)} ${e.name}\0`), hexToBytes(e.id));
      }
      return concatBytes(parts);
    }
    throw new GitApiError(`unable to read tree (${id})`);
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
    // the whole tree (`.`, `:/`): a root commit compares with the empty tree, as in git
    if (parts.length === 0) return (a ?? EMPTY_TREE_ID) !== (b ?? EMPTY_TREE_ID);
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
    if (raw === undefined) throw new GitApiError(`unable to read tree (${tree})`);
    return findRawEntry(raw, NAME_ENCODER.encode(name));
  }

  /** Raw trees read lately, most recently used last: a commit's trees are its child's parent trees. */
  private readonly rawTrees = new Map<ObjectId, Uint8Array>();
  private rawTreeBytes = 0;

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
    this.rawTreeBytes += bytes.length;
    while (this.rawTrees.size > RAW_TREE_CACHE || this.rawTreeBytes > RAW_TREE_CACHE_BYTES) {
      const oldest = this.rawTrees.keys().next().value as ObjectId;
      if (oldest === id) break;
      this.rawTreeBytes -= (this.rawTrees.get(oldest) as Uint8Array).length;
      this.rawTrees.delete(oldest);
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
}

const isTreeMode = (mode: number) => (mode & 0o170000) === 0o040000;

const NAME_ENCODER = new TextEncoder();

/** Raw trees a path-limited walk keeps. */
const RAW_TREE_CACHE = 512;

/** The bytes of raw trees a path-limited walk keeps at most (besides the one just read). */
const RAW_TREE_CACHE_BYTES = 32 * 1024 * 1024;

const EMPTY_TREE = new Uint8Array(0);

// revision.c's object flags, as the walk uses them
const UNINTERESTING = 1 << 1;
const BOTTOM = 1 << 2;
const SEEN = 1 << 3;
const ADDED = 1 << 4;
const TREESAME = 1 << 5;

/** How many extra uninteresting commits limit_list looks at (git's SLOP). */
const SLOP = 5;

/** A commit as revision.c holds it: flags, and once parsed its tree, date and parents. */
interface RevCommit {
  id: ObjectId;
  flags: number;
  parsed: boolean;
  tree: ObjectId;
  /** Committer date (seconds) */
  date: number;
  /** Position in the commit-graph, or -1 */
  pos: number;
  /** The parents once parsed; simplification may leave only the one followed */
  parents: RevCommit[] | undefined;
}

/** git's relevant_commit: not UNINTERESTING, or an excluded commit given (BOTTOM). */
const relevant = (c: RevCommit) => (c.flags & (UNINTERESTING | BOTTOM)) !== UNINTERESTING;

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
class CommitQueue<T> {
  private entries: T[] = [];
  private dates: number[] = [];
  private ctrs: number[] = [];
  private ctr = 0;

  put(entry: T, date: number): void {
    const { entries, dates, ctrs } = this;
    let ix = entries.length;
    entries.push(entry);
    dates.push(date);
    ctrs.push(this.ctr++);
    while (ix > 0) {
      const parent = (ix - 1) >> 1;
      if (this.before(parent, ix)) break;
      this.swap(parent, ix);
      ix = parent;
    }
  }

  get(): T | undefined {
    const { entries } = this;
    if (entries.length === 0) return undefined;
    const top = entries[0];
    const last = entries.length - 1;
    this.swap(0, last);
    entries.pop();
    this.dates.pop();
    this.ctrs.pop();
    let ix = 0;
    for (;;) {
      let child = 2 * ix + 1;
      if (child >= entries.length) break;
      if (child + 1 < entries.length && this.before(child + 1, child)) child++;
      if (this.before(ix, child)) break;
      this.swap(ix, child);
      ix = child;
    }
    return top;
  }

  /** The entry `get` returns next (git's prio_queue_peek). */
  peek(): T | undefined {
    return this.entries[0];
  }

  /** The entries in heap order (git's prio_queue_for_each). */
  items(): readonly T[] {
    return this.entries;
  }

  /** Whether entry `a` comes out before entry `b`. */
  private before(a: number, b: number): boolean {
    const da = this.dates[a] as number;
    const db = this.dates[b] as number;
    if (da !== db) return da > db;
    return (this.ctrs[a] as number) < (this.ctrs[b] as number);
  }

  private swap(a: number, b: number): void {
    const { entries, dates, ctrs } = this;
    [entries[a], entries[b]] = [entries[b] as T, entries[a] as T];
    [dates[a], dates[b]] = [dates[b] as number, dates[a] as number];
    [ctrs[a], ctrs[b]] = [ctrs[b] as number, ctrs[a] as number];
  }
}

/**
 * A cursor over a raw tree's entries for the pruned diff: `read()` decodes the entry at `at`
 * (mode, name as one character per byte), `next()` moves past it.
 */
class RawEntries {
  at = 0;
  mode = 0;
  name = "";
  private nameStart = 0;
  private nul = 0;
  constructor(readonly d: Uint8Array) {}
  get done(): boolean {
    return this.at >= this.d.length;
  }
  read(): void {
    const d = this.d;
    let p = this.at;
    let mode = 0;
    while (p < d.length && d[p] !== 0x20) mode = mode * 8 + ((d[p++] as number) - 0x30);
    this.mode = mode;
    this.nameStart = ++p;
    while (p < d.length && d[p] !== 0) p++;
    this.nul = p;
    this.name = latin1String(d.subarray(this.nameStart, p));
  }
  next(): void {
    this.at = this.nul + 21;
  }
  id(): ObjectId {
    return bytesToHex(this.d.subarray(this.nul + 1, this.nul + 21));
  }
  sameId(other: RawEntries): boolean {
    for (let k = 1; k <= 20; k++) {
      if (this.d[this.nul + k] !== other.d[other.nul + k]) return false;
    }
    return true;
  }
  /** git's base_name_compare of the names: a tree's name is followed by "/". */
  compare(other: RawEntries): number {
    const a = this.name;
    const b = other.name;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = a.charCodeAt(i) - b.charCodeAt(i);
      if (d !== 0) return d;
    }
    const ca = n < a.length ? a.charCodeAt(n) : isTreeMode(this.mode) ? 0x2f : 0;
    const cb = n < b.length ? b.charCodeAt(n) : isTreeMode(other.mode) ? 0x2f : 0;
    return ca - cb;
  }
}
