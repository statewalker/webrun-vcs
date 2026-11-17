import {
  type BloomFilterSettings,
  bloomFilterContains,
  bloomKey,
  type Commit,
  type CommitGraph,
  commitFromBytes,
  EMPTY_TREE_ID,
  type GitObject,
  type ObjectId,
  parseGraphCommit,
} from "@statewalker/vcs-core";
import { OrderedMap } from "@statewalker/vcs-utils";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { configBool, configValue } from "./merge-config.js";
import {
  ALL_ENTRIES_NOT_INTERESTING,
  bloomPathOf,
  ENTRY_NOT_INTERESTING,
  NEED_ATTRIBUTES,
  type PathspecAttributeValue,
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
  /** Commits the walk met (parsed, or seen as a parent) */
  commitsWalked?: number;
  /** Bytes the walk's table of commits takes (a few dozen per commit met) */
  walkTableBytes?: number;
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
  /** The commits of the last walk (for its statistics). */
  private lastWalk: RevTable | undefined;

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
    return {
      ...this.statistics,
      commitsWalked: this.lastWalk?.size ?? 0,
      walkTableBytes: this.lastWalk?.bytes ?? 0,
    };
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

    const pending = [...this.pending];
    if (this.startCommits.length === 0) {
      for (const id of starts) pending.push({ id, exclude: false });
    }
    return this.walk(pending);
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
   * The walk of `git log`, ported from git's revision.c. Commits come out newest first by
   * committer date (equal dates in the order they were queued). With a pathspec, history is
   * simplified as try_to_simplify_commit does it: a commit is compared with each parent at the
   * paths; one that matches a relevant parent ("TREESAME") is not shown, and only that parent
   * is walked further. A root commit is shown when it has any of the paths. Before comparing a
   * commit with its first parent, the commit-graph's changed-path Bloom filter of the commit
   * is asked (check_maybe_different_in_bloom_filter): when it says no path changed, no tree is
   * read. Without a pathspec nothing is simplified (git's `revs->prune` is off).
   *
   * Without excluded commits the walk streams (get_revision_1). With some (`not`,
   * `addRange`), it is limited first as limit_list does it: one date-ordered queue holds the
   * included and the excluded commits, UNINTERESTING spreads to parents as commits are
   * taken, a commit's relevance is judged with what is marked so far, `--since` marks older
   * commits UNINTERESTING, and the walk stops once only uninteresting commits are left
   * (still_interesting); what is shown is filtered by the final marks.
   *
   * The commits met are held in a `RevTable` (typed arrays, a few dozen bytes each); commits
   * the commit-graph has are reached by their graph positions, without building their ids.
   */
  private async *walk(pending: { id: ObjectId; exclude: boolean }[]): AsyncIterable<LogResult> {
    const prune = this.paths.length > 0 || this.excludePaths.length > 0;
    // a shallow commit has no parents (git's shallow grafts); the graph is off then
    const shallowIds = (await this.refsStore.getShallow?.().catch(() => undefined)) ?? [];
    const shallow = new Set(shallowIds);
    const graph =
      shallow.size > 0 ? undefined : await this.commits.commitGraph?.get().catch(() => undefined);
    const pathspec = prune ? this.pathspec() : undefined;
    const bloom =
      pathspec && this.useBloomFilters ? this.bloomKeys(graph, pathspec.items) : undefined;
    const bloomVersion = bloom ? this.changedPathsVersion() : -1;
    const fast = pathspec?.literal;
    const firstParentOnly = this.firstParentOnly;
    const t = new RevTable(graph);
    this.lastWalk = t;
    /** Raw commits read by `parse` (no graph), kept until shown: read once, not twice. */
    const raw = new Map<number, Uint8Array>();

    /** git's parse_commit: tree, parents and date, from the graph when it has the commit */
    const parse = async (n: number): Promise<boolean> => {
      if (t.parsed(n)) return true;
      const gpos = t.gpos[n] as number;
      if (graph && gpos >= 0) {
        let parents: number[] | undefined;
        let date = 0;
        try {
          date = graph.commitTimeAt(gpos);
          parents = graph.parentPositionsAt(gpos);
        } catch {
          // a corrupt record: the commit is read instead
          parents = undefined;
        }
        if (parents) {
          t.setParsed(n, date, true, undefined, parents.length);
          for (let k = 0; k < parents.length; k++)
            t.setParent(n, k, t.lookupPos(parents[k] as number));
          return true;
        }
      }
      const id = t.idOf(n);
      const header = await this.readCommitHeader(id);
      if (!header) return false;
      const parents = shallow.has(id) ? [] : header.parents;
      t.setParsed(n, header.date, false, header.tree, parents.length);
      for (let k = 0; k < parents.length; k++) t.setParent(n, k, t.lookup(parents[k] as ObjectId));
      if (header.raw) raw.set(n, header.raw);
      return true;
    };
    const relevant = (n: number) => (t.flag(n) & (UNINTERESTING | BOTTOM)) !== UNINTERESTING;
    /** git's mark_parents_uninteresting: through the parents known (parsed) so far */
    const markParentsUninteresting = (n: number): void => {
      const stack: number[] = [];
      const markOne = (p: number) => {
        if (t.flag(p) & UNINTERESTING) return;
        t.mark(p, UNINTERESTING);
        for (let k = 0, c = t.parentCount(p); k < c; k++) stack.push(t.parent(p, k));
      };
      for (let k = 0, c = t.parentCount(n); k < c; k++) markOne(t.parent(n, k));
      for (let p = stack.pop(); p !== undefined; p = stack.pop()) markOne(p);
    };
    const differs = (from: ObjectId | undefined, n: number, nth: number) =>
      this.differsAtPaths(
        from,
        t.treeOf(n),
        pathspec as TreePathspec,
        fast,
        nth === 0 ? bloom : undefined,
        bloomVersion,
        graph,
        t.bloomPos(n),
      );
    /** git's try_to_simplify_commit (prune, dense, simplify_history, no show_pulls) */
    const simplify = async (n: number): Promise<void> => {
      if (!prune) return;
      const count = t.parentCount(n);
      if (count === 0) {
        if (!(await differs(undefined, n, 0))) t.mark(n, TREESAME);
        return;
      }
      let relevantParents = 0;
      let relevantChange = false;
      let irrelevantChange = false;
      for (let nth = 0; nth < count; nth++) {
        const p = t.parent(n, nth);
        if (relevant(p)) relevantParents++;
        if (nth === 1 && firstParentOnly) break;
        if (!(await parse(p))) {
          throw new GitApiError(`cannot simplify commit ${t.idOf(n)} (because of ${t.idOf(p)})`);
        }
        if (!(await differs(t.treeOf(p), n, nth))) {
          // a merge with an irrelevant side that brought the whole change keeps its others
          if (!relevant(p)) continue;
          t.keepOnlyParent(n, p);
          t.mark(n, TREESAME);
          return;
        }
        if (relevant(p)) relevantChange = true;
        else irrelevantChange = true;
      }
      if (relevantParents ? !relevantChange : !irrelevantChange) t.mark(n, TREESAME);
    };
    /** git's process_parents */
    const processParents = async (n: number, queue: CommitQueue<number>): Promise<void> => {
      if (t.flag(n) & ADDED) return;
      t.mark(n, ADDED);
      if (t.flag(n) & UNINTERESTING) {
        for (let k = 0, c = t.parentCount(n); k < c; k++) {
          const p = t.parent(n, k);
          t.mark(p, UNINTERESTING);
          if (!(await parse(p))) continue;
          if (t.parentCount(p) > 0) markParentsUninteresting(p);
          if (t.flag(p) & SEEN) continue;
          t.mark(p, SEEN);
          queue.put(p, t.date(p));
        }
        return;
      }
      await simplify(n);
      for (let k = 0, c = t.parentCount(n); k < c; k++) {
        const p = t.parent(n, k);
        if (!(await parse(p))) {
          throw new GitApiError(`Failed to traverse parents of commit ${t.idOf(n)}`);
        }
        if (!(t.flag(p) & SEEN)) {
          t.mark(p, SEEN);
          queue.put(p, t.date(p));
        }
        if (firstParentOnly) break;
      }
    };
    /** git's get_commit_action (no parent rewriting: TREESAME commits are never shown) */
    const shown = async (n: number): Promise<LogResult | undefined> => {
      const bytes = raw.get(n);
      if (bytes) raw.delete(n);
      if (t.flag(n) & (UNINTERESTING | TREESAME)) return undefined;
      if (this.untilTime !== undefined && t.date(n) > this.untilTime) return undefined;
      const parents = t.parentCount(n);
      if (this.revFilter === RevFilter.ONLY_MERGES && parents < 2) return undefined;
      if (this.revFilter === RevFilter.NO_MERGES && parents > 1) return undefined;
      const id = t.idOf(n);
      const commit = bytes ? decodeCommit(bytes) : await this.commits.load(id);
      if (!commit) return undefined;
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) return undefined;
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) return undefined;
      return { ...commit, id };
    };

    // prepare_revision_walk: the flags of every argument first, then handle_commit in order
    for (const e of pending) {
      if (!e.exclude) continue;
      const n = t.lookup(e.id);
      t.mark(n, UNINTERESTING | BOTTOM);
    }
    const list: number[] = [];
    let limited = false;
    for (const e of pending) {
      const n = t.lookup(e.id);
      if (!(await parse(n))) continue;
      if (t.flag(n) & UNINTERESTING) {
        markParentsUninteresting(n);
        limited = true;
      }
      if (!(t.flag(n) & SEEN)) {
        t.mark(n, SEEN);
        list.push(n);
      }
    }
    // commit_list_sort_by_date (stable), then into the date queue in that order
    list.sort((a, b) => t.date(b) - t.date(a));
    const queue = new CommitQueue<number>();
    for (const n of list) queue.put(n, t.date(n));

    let count = 0;
    let skipped = 0;
    // git's -n 0 reads nothing more in a streaming walk; a limited walk is done before
    const none = this.maxCount !== undefined && this.maxCount <= 0;
    if (!limited) {
      if (none) return;
      // get_revision_1, streaming
      for (let n = queue.get(); n !== undefined; n = queue.get()) {
        // --since: older commits are dropped without walking their parents (max_age)
        if (this.sinceTime !== undefined && t.date(n) < this.sinceTime) {
          raw.delete(n);
          continue;
        }
        await processParents(n, queue);
        const commit = await shown(n);
        if (!commit) continue;
        if (skipped < this.skip) {
          skipped++;
          continue;
        }
        yield commit;
        if (this.maxCount !== undefined && ++count >= this.maxCount) return;
      }
      return;
    }

    // limit_list
    const newlist: number[] = [];
    let date = Number.POSITIVE_INFINITY;
    let slop = SLOP;
    let interestingCache = -1;
    /** git's everybody_uninteresting */
    const everybodyUninteresting = (): boolean => {
      if (interestingCache >= 0 && !(t.flag(interestingCache) & UNINTERESTING)) return false;
      for (const n of queue.items()) {
        if (t.flag(n) & UNINTERESTING) continue;
        interestingCache = n;
        return false;
      }
      return true;
    };
    /** git's still_interesting */
    const stillInteresting = (): number => {
      const head = queue.peek();
      if (head === undefined) return 0;
      if (date <= t.date(head)) return SLOP;
      if (!everybodyUninteresting()) return SLOP;
      return slop - 1;
    };
    for (let n = queue.get(); n !== undefined; n = queue.get()) {
      // what is shown is read again at the end: a limited walk does not keep raw commits
      raw.delete(n);
      if (n === interestingCache) interestingCache = -1;
      if (this.sinceTime !== undefined && t.date(n) < this.sinceTime) t.mark(n, UNINTERESTING);
      await processParents(n, queue);
      if (t.flag(n) & UNINTERESTING) {
        markParentsUninteresting(n);
        slop = stillInteresting();
        if (slop) continue;
        break;
      }
      if (this.untilTime !== undefined && t.date(n) > this.untilTime) continue;
      date = t.date(n);
      newlist.push(n);
    }
    raw.clear();
    if (none) return;
    for (const n of newlist) {
      const commit = await shown(n);
      if (!commit) continue;
      if (skipped < this.skip) {
        skipped++;
        continue;
      }
      yield commit;
      if (this.maxCount !== undefined && ++count >= this.maxCount) return;
    }
  }

  /**
   * The tree, parents and date of a commit (git's parse_commit_buffer), from its raw bytes
   * when the store gives them (kept in `raw` to be decoded whole if the commit is shown),
   * else from the commit store; undefined when it is missing or not a commit.
   */
  private async readCommitHeader(
    id: ObjectId,
  ): Promise<{ tree: ObjectId; parents: ObjectId[]; date: number; raw?: Uint8Array } | undefined> {
    const objects = this._workingCopy.history?.objects;
    if (objects) {
      let obj: GitObject | undefined;
      let failed = false;
      try {
        const now = objects.getNow ? objects.getNow(id) : objects.get(id);
        obj = now instanceof Promise ? await now : now;
      } catch {
        obj = undefined;
        failed = true;
      }
      if (!obj && !failed) return undefined;
      if (obj?.bytes && obj.type === "commit") {
        try {
          const header = parseGraphCommit(obj.bytes, id);
          return { ...header, raw: obj.bytes };
        } catch {
          // read as the commit store reads it
        }
      } else if (obj) {
        await obj.content[Symbol.asyncIterator]().return?.();
      }
    }
    const commit = await this.commits.load(id).catch(() => undefined);
    if (!commit) return undefined;
    return { tree: commit.tree, parents: commit.parents, date: commit.committer.timestamp };
  }

  /**
   * The pathspec of the walk: the paths added, the excluded ones as `:(exclude)` elements,
   * and `.` when every element excludes (git's parse_pathspec). `literal` holds each
   * element's path components when all are plain paths (no wildcard, no magic, no trailing
   * slash): those are compared by looking their entries up, without a tree diff.
   */
  private pathspec(): TreePathspec & { literal: Uint8Array[][] | undefined } {
    const parse = (p: string) => parsePathspecItem(p, { attr: true });
    const items: PathspecItem[] = this.paths.map(parse);
    for (const p of this.excludePaths) items.push({ ...parse(p), exclude: true });
    if (items.every((i) => i.exclude)) items.push(parse("."));
    const plain = items.every(
      (i) =>
        !i.exclude &&
        !i.icase &&
        !i.attr &&
        i.prefix === undefined &&
        i.nowildcardLen === i.match.length &&
        !i.match.endsWith("/"),
    );
    return {
      ...treePathspec(items),
      literal: plain
        ? items.map((i) => pathParts(i.match).map((part) => NAME_ENCODER.encode(part)))
        : undefined,
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
    literal: Uint8Array[][] | undefined,
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
      differs = await this.treesDiffer(from, to, pathspec, EMPTY_TREE);
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
    base: Uint8Array,
  ): Promise<boolean> {
    this.statistics.treeEntryReads++;
    // git reads the parent's tree, then the commit's
    const da = a ? await this.requireTree(a) : EMPTY_TREE;
    const db = b ? await this.requireTree(b) : EMPTY_TREE;
    const ca = new RawEntries(da);
    const cb = new RawEntries(db);
    // entries are matched where they lie in the tree's bytes: no name is decoded; an `:(attr)`
    // element waits for the attributes of a path, then the entry is matched again
    const skip = (c: RawEntries): Promise<void> | undefined => {
      while (!c.done) {
        c.read();
        const r = treeEntryInteresting(ps, c.d, c.nameStart, c.nul, c.mode, base);
        if (r === NEED_ATTRIBUTES) return this.loadAttributes(ps).then(() => skip(c));
        if (r === ALL_ENTRIES_NOT_INTERESTING) {
          c.at = c.d.length;
          return undefined;
        }
        if (r !== ENTRY_NOT_INTERESTING) return undefined;
        c.next();
      }
      return undefined;
    };
    for (;;) {
      const sa = skip(ca);
      if (sa) await sa;
      const sb = skip(cb);
      if (sb) await sb;
      if (ca.done && cb.done) return false;
      const cmp = ca.done ? 1 : cb.done ? -1 : ca.compare(cb);
      if (cmp === 0) {
        const same = ca.mode === cb.mode && ca.sameId(cb);
        if (!same) {
          if (!isTreeMode(ca.mode) || !isTreeMode(cb.mode)) return true;
          if (await this.treesDiffer(ca.id(), cb.id(), ps, ca.below(base))) return true;
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
          ? await this.treesDiffer(sub, undefined, ps, one.below(base))
          : await this.treesDiffer(undefined, sub, ps, one.below(base));
      if (below) return true;
      one.next();
    }
  }

  /**
   * The attributes `treeEntryInteresting` asks for (an `:(attr)` element): read as git's
   * match_pathspec_attrs reads them, from the worktree's `.gitattributes` first, then the
   * index's (git_check_attr, check-in direction).
   */
  private async loadAttributes(ps: TreePathspec): Promise<void> {
    const attributes = ps.attributes;
    const path = attributes?.pending;
    if (!attributes || path === undefined) return;
    attributes.pending = undefined;
    const filter = this.worktreeAccess?.contentFilter as
      | {
          attributes?(
            path: string,
            names: readonly string[],
            direction?: "checkin",
          ): Promise<Map<string, PathspecAttributeValue>>;
        }
      | undefined;
    if (!filter?.attributes)
      throw new GitApiError("pathspec magic 'attr' needs the attributes of a worktree");
    attributes.values.set(path, await filter.attributes(path, attributes.names, "checkin"));
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
    parts: Uint8Array[],
    i: number,
  ): Promise<boolean> {
    // the whole tree (`.`, `:/`): a root commit compares with the empty tree, as in git
    if (parts.length === 0) return (a ?? EMPTY_TREE_ID) !== (b ?? EMPTY_TREE_ID);
    const name = parts[i] as Uint8Array;
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
    name: Uint8Array,
  ): Promise<{ id: ObjectId; mode: number } | undefined> {
    this.statistics.treeEntryReads++;
    const raw = await this.rawTree(tree);
    if (raw === null) return this.trees.getEntry(tree, NAME_DECODER.decode(name));
    if (raw === undefined) throw new GitApiError(`unable to read tree (${tree})`);
    return findRawEntry(raw, name);
  }

  /** Raw trees read lately, most recently used last: a commit's trees are its child's parent trees. */
  private readonly rawTrees = new OrderedMap<ObjectId, Uint8Array>();
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
      const oldest = this.rawTrees.oldestKey() as ObjectId;
      if (oldest === id) break;
      this.rawTreeBytes -= (this.rawTrees.get(oldest) as Uint8Array).length;
      this.rawTrees.delete(oldest);
    }
    return bytes;
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
const NAME_DECODER = new TextDecoder();

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

/**
 * The commits a walk meets, as revision.c's object table holds them: flags, and once parsed
 * the date, the parents and (outside the commit-graph) the tree. Each commit is a number
 * indexing typed arrays, a few dozen bytes per commit instead of an object with its id, tree
 * and parent array. Commits the graph has are found by graph position (`lookupPos`), their
 * ids and trees read from the graph when needed; others by id.
 */
class RevTable {
  /** commits held */
  size = 0;
  /** revision.c flags (UNINTERESTING, SEEN, ...) */
  flags = new Uint8Array(INITIAL_REVS);
  /** committer dates (seconds) */
  private dates = new Float64Array(INITIAL_REVS);
  /** position in the commit-graph, -1 for a commit it does not have */
  gpos = new Int32Array(INITIAL_REVS);
  /** where the parents start in `pool`, once parsed */
  private parentAt = new Int32Array(INITIAL_REVS);
  /** how many parents, -1 before the commit is parsed */
  private parents = new Int32Array(INITIAL_REVS);
  /** every parsed commit's parents, in turn */
  private pool = new Int32Array(INITIAL_REVS);
  private poolUsed = 0;
  /** ids known without the graph (looked up by id), by commit */
  private readonly ids: (ObjectId | undefined)[] = [];
  /** trees of commits parsed outside the graph, by commit */
  private readonly trees: (ObjectId | undefined)[] = [];
  /** commits outside the graph, by id */
  private readonly byId = new Map<ObjectId, number>();
  /** commit + 1 by graph position (0: not met yet) */
  private readonly byPos: Int32Array | undefined;

  constructor(private readonly graph: CommitGraph | undefined) {
    this.byPos = graph ? new Int32Array(graph.size) : undefined;
  }

  /** Bytes the table's arrays take (the ids and trees kept besides them not counted). */
  get bytes(): number {
    return (
      this.flags.byteLength +
      this.dates.byteLength +
      this.gpos.byteLength +
      this.parentAt.byteLength +
      this.parents.byteLength +
      this.pool.byteLength +
      (this.byPos?.byteLength ?? 0)
    );
  }

  /** The commit `id`, added when first met (git's lookup_commit). */
  lookup(id: ObjectId): number {
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    const pos = this.graph ? this.graph.position(id) : -1;
    if (pos >= 0) {
      const n = this.lookupPos(pos);
      this.ids[n] = id;
      return n;
    }
    const n = this.add(-1);
    this.ids[n] = id;
    this.byId.set(id, n);
    return n;
  }

  /** The commit at graph position `pos`, added when first met. */
  lookupPos(pos: number): number {
    const byPos = this.byPos as Int32Array;
    const known = (byPos[pos] as number) - 1;
    if (known >= 0) return known;
    const n = this.add(pos);
    byPos[pos] = n + 1;
    return n;
  }

  idOf(n: number): ObjectId {
    return this.ids[n] ?? (this.graph as CommitGraph).idAt(this.gpos[n] as number);
  }

  flag(n: number): number {
    return this.flags[n] as number;
  }

  mark(n: number, flags: number): void {
    this.flags[n] = (this.flags[n] as number) | flags;
  }

  parsed(n: number): boolean {
    return (this.parents[n] as number) >= 0;
  }

  date(n: number): number {
    return this.dates[n] as number;
  }

  /** The tree of a parsed commit. */
  treeOf(n: number): ObjectId {
    if ((this.flags[n] as number) & GRAPH_PARSED)
      return (this.graph as CommitGraph).treeAt(this.gpos[n] as number);
    return this.trees[n] as ObjectId;
  }

  /** The graph position of a commit parsed from the graph (its Bloom filter), else -1. */
  bloomPos(n: number): number {
    return (this.flags[n] as number) & GRAPH_PARSED ? (this.gpos[n] as number) : -1;
  }

  /** Records a commit as parsed, with room for `count` parents (`setParent`). */
  setParsed(
    n: number,
    date: number,
    fromGraph: boolean,
    tree: ObjectId | undefined,
    count: number,
  ): void {
    this.dates[n] = date;
    if (fromGraph) this.mark(n, GRAPH_PARSED);
    else this.trees[n] = tree;
    if (this.poolUsed + count > this.pool.length) {
      const grown = new Int32Array(Math.max(this.pool.length * 2, this.poolUsed + count));
      grown.set(this.pool);
      this.pool = grown;
    }
    this.parentAt[n] = this.poolUsed;
    this.parents[n] = count;
    this.poolUsed += count;
  }

  setParent(n: number, k: number, p: number): void {
    this.pool[(this.parentAt[n] as number) + k] = p;
  }

  /** The parents of a parsed commit (0 before it is parsed). */
  parentCount(n: number): number {
    return Math.max(0, this.parents[n] as number);
  }

  parent(n: number, k: number): number {
    return this.pool[(this.parentAt[n] as number) + k] as number;
  }

  /** Simplification keeps only parent `p` (git rewrites `commit->parents`). */
  keepOnlyParent(n: number, p: number): void {
    this.pool[this.parentAt[n] as number] = p;
    this.parents[n] = 1;
  }

  private add(pos: number): number {
    const n = this.size++;
    if (n === this.flags.length) this.grow();
    this.gpos[n] = pos;
    this.parents[n] = -1;
    return n;
  }

  private grow(): void {
    const size = this.flags.length * 2;
    const flags = new Uint8Array(size);
    flags.set(this.flags);
    this.flags = flags;
    const dates = new Float64Array(size);
    dates.set(this.dates);
    this.dates = dates;
    const gpos = new Int32Array(size);
    gpos.set(this.gpos);
    this.gpos = gpos;
    const parentAt = new Int32Array(size);
    parentAt.set(this.parentAt);
    this.parentAt = parentAt;
    const parents = new Int32Array(size);
    parents.set(this.parents);
    this.parents = parents;
  }
}

/** Commits a `RevTable` has room for before it first grows. */
const INITIAL_REVS = 1024;
/** `RevTable` flag: parsed from the commit-graph (its tree and Bloom filter are there). */
const GRAPH_PARSED = 1 << 6;

/** A commit read whole, as the commit store decodes it; undefined if it does not parse. */
function decodeCommit(bytes: Uint8Array): Commit | undefined {
  try {
    return commitFromBytes(bytes);
  } catch {
    return undefined;
  }
}

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
 * (its mode, where its name starts and ends), `next()` moves past it. Names stay bytes.
 */
class RawEntries {
  at = 0;
  mode = 0;
  nameStart = 0;
  /** where the name ends (its NUL; the id follows) */
  nul = 0;
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
  }
  next(): void {
    this.at = this.nul + 21;
  }
  id(): ObjectId {
    return bytesToHex(this.d.subarray(this.nul + 1, this.nul + 21));
  }
  /** The base of the entries below this one (a directory): `base`, its name and "/". */
  below(base: Uint8Array): Uint8Array {
    const length = this.nul - this.nameStart;
    const out = new Uint8Array(base.length + length + 1);
    out.set(base);
    out.set(this.d.subarray(this.nameStart, this.nul), base.length);
    out[base.length + length] = 0x2f;
    return out;
  }
  sameId(other: RawEntries): boolean {
    for (let k = 1; k <= 20; k++) {
      if (this.d[this.nul + k] !== other.d[other.nul + k]) return false;
    }
    return true;
  }
  /** git's base_name_compare of the names: a tree's name is followed by "/". */
  compare(other: RawEntries): number {
    const a = this.d;
    const b = other.d;
    const la = this.nul - this.nameStart;
    const lb = other.nul - other.nameStart;
    const n = Math.min(la, lb);
    for (let i = 0; i < n; i++) {
      const d = (a[this.nameStart + i] as number) - (b[other.nameStart + i] as number);
      if (d !== 0) return d;
    }
    const ca = n < la ? (a[this.nameStart + n] as number) : isTreeMode(this.mode) ? 0x2f : 0;
    const cb = n < lb ? (b[other.nameStart + n] as number) : isTreeMode(other.mode) ? 0x2f : 0;
    return ca - cb;
  }
}
