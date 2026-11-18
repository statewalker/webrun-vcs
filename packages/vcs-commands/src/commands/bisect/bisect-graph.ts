/**
 * The revision walk of `git bisect` and git's bisection algorithm (`bisect.c`), over a graph
 * of commits that lives as long as one bisect command: git keeps its commit objects for the
 * life of the process, so the parents a path-limited walk rewrites (history simplification)
 * stay rewritten for the walks after it, as in `git bisect run`.
 *
 * @example
 * ```typescript
 * const graph = new BisectGraph(source);
 * const list = await graph.walk([{ id: bad, exclude: false }, { id: good, exclude: true }], {});
 * const found = findBisection(list, 0);
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

/** revision.c's object flags, as the bisection reads them. */
export const UNINTERESTING = 1 << 0;
export const TREESAME = 1 << 1;
const SEEN = 1 << 2;
const ADDED = 1 << 3;
const BOTTOM = 1 << 4;
/** bisect.c's COUNTED */
const COUNTED = 1 << 5;

/** find_bisection's flags (`bisect.h`). */
export const FIND_BISECTION_ALL = 1 << 0;
export const FIND_BISECTION_FIRST_PARENT_ONLY = 1 << 1;

/** A commit of the walk: git's `struct commit` with its flags. */
export class BisectNode {
  parents: BisectNode[] = [];
  date = 0;
  tree = "";
  parsed = false;
  flags = 0;
  constructor(readonly id: ObjectId) {}
}

/** What the graph reads of the repository. */
export interface BisectGraphSource {
  /** The commit's tree, parents and committer date; undefined when missing. */
  header(id: ObjectId): Promise<{ tree: ObjectId; parents: ObjectId[]; date: number } | undefined>;
  /**
   * Whether trees `from` (undefined: the empty tree) and `to` differ at the pathspec `paths`
   * (git's rev_compare_tree).
   */
  differs(from: ObjectId | undefined, to: ObjectId, paths: readonly string[]): Promise<boolean>;
}

/** A revision argument: the commit and whether it is excluded (`^<rev>`). */
export interface BisectPending {
  id: ObjectId;
  exclude: boolean;
}

/** git's prio_queue ordered by commit date (newest first, ties in insertion order). */
class DateQueue {
  private heap: { node: BisectNode; seq: number }[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  private before(a: { node: BisectNode; seq: number }, b: { node: BisectNode; seq: number }) {
    return a.node.date !== b.node.date ? a.node.date > b.node.date : a.seq < b.seq;
  }

  put(node: BisectNode): void {
    const heap = this.heap;
    heap.push({ node, seq: this.seq++ });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  }

  peek(): BisectNode | undefined {
    return this.heap[0]?.node;
  }

  get(): BisectNode | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0].node;
    const last = heap.pop() as { node: BisectNode; seq: number };
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && this.before(heap[l], heap[m])) m = l;
        if (r < heap.length && this.before(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  }

  nodes(): BisectNode[] {
    return this.heap.map((e) => e.node);
  }
}

/** How many uninteresting commits limit_list reads past the interesting ones (SLOP). */
const SLOP = 5;

/** The commits of one bisect command, and git's walks over them. */
export class BisectGraph {
  private readonly nodes = new Map<ObjectId, BisectNode>();

  constructor(private readonly source: BisectGraphSource) {}

  /** git's lookup_commit: the node of a commit (not read yet). */
  lookup(id: ObjectId): BisectNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = new BisectNode(id);
      this.nodes.set(id, node);
    }
    return node;
  }

  /** git's parse_commit: false when the commit cannot be read. */
  async parse(node: BisectNode): Promise<boolean> {
    if (node.parsed) return true;
    const header = await this.source.header(node.id);
    if (!header) return false;
    node.tree = header.tree;
    node.date = header.date;
    node.parents = header.parents.map((p) => this.lookup(p));
    node.parsed = true;
    return true;
  }

  /** git's repo_clear_commit_marks(ALL_REV_FLAGS): every commit read loses its flags. */
  clearMarks(): void {
    for (const node of this.nodes.values()) node.flags = 0;
  }

  /**
   * git's clear_commit_marks_many(ALL_REV_FLAGS): the flags of the commits and, through the
   * parents as they are now (rewritten ones too), of each ancestor that still has a flag.
   */
  clearCommitMarks(ids: readonly ObjectId[]): void {
    const stack: BisectNode[] = [];
    const clearOne = (start: BisectNode) => {
      let n: BisectNode | undefined = start;
      while (n) {
        if (!n.flags) return;
        n.flags = 0;
        const parents: BisectNode[] = n.parents;
        if (parents.length === 0) return;
        for (let k = 1; k < parents.length; k++) {
          const p = parents[k] as BisectNode;
          if (p.flags) stack.push(p);
        }
        n = parents[0];
      }
    };
    for (const id of ids) clearOne(this.lookup(id));
    for (let n = stack.pop(); n; n = stack.pop()) clearOne(n);
  }

  /**
   * git's reset_revision_walk: SEEN and ADDED cleared on every commit, the other flags
   * (UNINTERESTING, BOTTOM, TREESAME) left as the walk set them.
   */
  resetRevisionWalk(): void {
    for (const node of this.nodes.values()) node.flags &= ~(SEEN | ADDED);
  }

  /**
   * git's prepare_revision_walk with `revs->limited` (limit_list): the commits taken from
   * the date queue that were interesting when taken, in that order, with their flags as the
   * walk left them (a commit taken may be marked UNINTERESTING later). With `paths`, each
   * interesting commit is simplified as try_to_simplify_commit does it (dense, history
   * simplification), its parents rewritten to the one it is TREESAME to.
   *
   * The walk starts from the flags the commits have: as in git, nothing is cleared before
   * it. The caller clears them where git does ({@link clearMarks}, {@link clearCommitMarks},
   * {@link resetRevisionWalk}), so flags git leaves behind stay for the next walk.
   */
  async walk(
    pending: BisectPending[],
    options: { paths?: readonly string[]; firstParent?: boolean } = {},
  ): Promise<BisectNode[]> {
    const paths = options.paths ?? [];
    const prune = paths.length > 0;
    const firstParentOnly = options.firstParent === true;
    const relevant = (n: BisectNode) => (n.flags & (UNINTERESTING | BOTTOM)) !== UNINTERESTING;

    const markOneParentUninteresting = (n: BisectNode, stack: BisectNode[]) => {
      if (n.flags & UNINTERESTING) return;
      n.flags |= UNINTERESTING;
      for (const p of n.parents) stack.push(p);
    };
    const markParentsUninteresting = (n: BisectNode) => {
      const stack: BisectNode[] = [];
      for (const p of n.parents) markOneParentUninteresting(p, stack);
      for (let p = stack.pop(); p; p = stack.pop()) markOneParentUninteresting(p, stack);
    };

    const differs = (from: BisectNode | undefined, to: BisectNode) =>
      this.source.differs(from?.tree, to.tree, paths);

    const simplify = async (n: BisectNode): Promise<void> => {
      if (!prune) return;
      if (n.parents.length === 0) {
        if (!(await differs(undefined, n))) n.flags |= TREESAME;
        return;
      }
      let relevantParents = 0;
      let relevantChange = false;
      let irrelevantChange = false;
      for (let nth = 0; nth < n.parents.length; nth++) {
        const p = n.parents[nth];
        if (relevant(p)) relevantParents++;
        if (nth === 1 && firstParentOnly) break;
        if (!(await this.parse(p))) {
          throw new BisectDie(`cannot simplify commit ${n.id} (because of ${p.id})`);
        }
        if (!(await differs(p, n))) {
          if (!relevant(p)) continue;
          n.parents = [p];
          n.flags |= TREESAME;
          return;
        }
        if (relevant(p)) relevantChange = true;
        else irrelevantChange = true;
      }
      if (relevantParents ? !relevantChange : !irrelevantChange) n.flags |= TREESAME;
    };

    const processParents = async (n: BisectNode, queue: DateQueue): Promise<void> => {
      if (n.flags & ADDED) return;
      n.flags |= ADDED;
      if (n.flags & UNINTERESTING) {
        for (const p of n.parents) {
          p.flags |= UNINTERESTING;
          if (!(await this.parse(p))) continue;
          if (p.parents.length > 0) markParentsUninteresting(p);
          if (p.flags & SEEN) continue;
          p.flags |= SEEN;
          queue.put(p);
        }
        return;
      }
      await simplify(n);
      for (const p of n.parents) {
        if (!(await this.parse(p)))
          throw new BisectDie(`Failed to traverse parents of commit ${n.id}`);
        if (!(p.flags & SEEN)) {
          p.flags |= SEEN;
          queue.put(p);
        }
        if (firstParentOnly) break;
      }
    };

    // the flags of the arguments first (setup_revisions), then handle_commit in order
    for (const e of pending) {
      if (e.exclude) this.lookup(e.id).flags |= UNINTERESTING | BOTTOM;
    }
    const list: BisectNode[] = [];
    for (const e of pending) {
      const n = this.lookup(e.id);
      if (!(await this.parse(n))) throw new BisectDie(`unable to parse commit ${e.id}`);
      if (n.flags & UNINTERESTING) markParentsUninteresting(n);
      if (!(n.flags & SEEN)) {
        n.flags |= SEEN;
        list.push(n);
      }
    }
    // commit_list_sort_by_date (stable), then into the queue in that order
    list.sort((a, b) => b.date - a.date);
    const queue = new DateQueue();
    for (const n of list) queue.put(n);

    const newlist: BisectNode[] = [];
    let date = Number.POSITIVE_INFINITY;
    let slop = SLOP;
    let interestingCache: BisectNode | undefined;
    const everybodyUninteresting = (): boolean => {
      if (interestingCache && !(interestingCache.flags & UNINTERESTING)) return false;
      for (const n of queue.nodes()) {
        if (n.flags & UNINTERESTING) continue;
        interestingCache = n;
        return false;
      }
      return true;
    };
    const stillInteresting = (): number => {
      const head = queue.peek();
      if (!head) return 0;
      if (date <= head.date) return SLOP;
      if (!everybodyUninteresting()) return SLOP;
      return slop - 1;
    };
    for (let n = queue.get(); n; n = queue.get()) {
      if (n === interestingCache) interestingCache = undefined;
      await processParents(n, queue);
      if (n.flags & UNINTERESTING) {
        markParentsUninteresting(n);
        slop = stillInteresting();
        if (slop) continue;
        break;
      }
      date = n.date;
      newlist.push(n);
    }
    return newlist;
  }
}

/** Where git dies (`die()`): the message of its `fatal:` line. */
export class BisectDie extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BisectDie";
  }
}

/** What find_bisection found. */
export interface Bisection {
  /** The best commit alone, or (FIND_BISECTION_ALL) every testable commit, best first */
  list: BisectNode[];
  /** How many commits the best one reaches (its weight) */
  reaches: number;
  /** How many commits are testable (not TREESAME) */
  all: number;
}

/**
 * bisect.c's find_bisection over the list a limited walk gave: the commits still
 * interesting, reversed (oldest first), each weighed by the commits it reaches, and the one
 * nearest to halfway taken (or, with FIND_BISECTION_ALL, all sorted by that distance).
 */
export function findBisection(walked: BisectNode[], bisectFlags: number): Bisection {
  const list: BisectNode[] = [];
  let nr = 0;
  for (const n of walked) {
    if (n.flags & UNINTERESTING) continue;
    list.push(n);
    if (!(n.flags & TREESAME)) nr++;
  }
  list.reverse();
  const weights = new Map<BisectNode, number>();
  for (const n of list) weights.set(n, 0);
  const best = doFindBisection(list, nr, weights, bisectFlags);
  if (best.length === 0) return { list: [], reaches: 0, all: nr };
  const first = best[0] as BisectNode;
  const reaches = weights.get(first) ?? 0;
  return {
    list: bisectFlags & FIND_BISECTION_ALL ? best : [first],
    reaches,
    all: nr,
  };
}

function countInterestingParents(n: BisectNode, bisectFlags: number): number {
  let count = 0;
  for (const p of n.parents) {
    if (!(p.flags & UNINTERESTING)) count++;
    if (bisectFlags & FIND_BISECTION_FIRST_PARENT_ONLY) break;
  }
  return count;
}

/** bisect.c's count_distance: the commits reachable, each once (COUNTED). */
function countDistance(start: BisectNode): number {
  let nr = 0;
  let entry: BisectNode | undefined = start;
  while (entry) {
    if (entry.flags & (UNINTERESTING | COUNTED)) break;
    if (!(entry.flags & TREESAME)) nr++;
    entry.flags |= COUNTED;
    const parents: BisectNode[] = entry.parents;
    entry = parents[0];
    for (let k = 1; k < parents.length; k++) nr += countDistance(parents[k] as BisectNode);
  }
  return nr;
}

function approxHalfway(n: BisectNode, weight: number, nr: number): boolean {
  if (n.flags & TREESAME) return false;
  const diff = 2 * weight - nr;
  if (diff >= -1 && diff <= 1) return true;
  return Math.abs(diff) < Math.trunc(nr / 1024);
}

function doFindBisection(
  list: BisectNode[],
  nr: number,
  weights: Map<BisectNode, number>,
  bisectFlags: number,
): BisectNode[] {
  const fp = (bisectFlags & FIND_BISECTION_FIRST_PARENT_ONLY) !== 0;
  const all = (bisectFlags & FIND_BISECTION_ALL) !== 0;
  const weight = (n: BisectNode) => weights.get(n);
  let counted = 0;
  for (const n of list) {
    switch (countInterestingParents(n, bisectFlags)) {
      case 0:
        if (!(n.flags & TREESAME)) {
          weights.set(n, 1);
          counted++;
        }
        break;
      case 1:
        weights.set(n, -1);
        break;
      default:
        weights.set(n, -2);
        break;
    }
  }

  for (const n of list) {
    if (n.flags & UNINTERESTING) continue;
    if (weight(n) !== -2) continue;
    if (fp) throw new Error("BUG: shouldn't be calling count-distance in fp mode");
    weights.set(n, countDistance(n));
    for (const c of list) c.flags &= ~COUNTED;
    if (!all && approxHalfway(n, weight(n) as number, nr)) return [n];
    counted++;
  }

  while (counted < nr) {
    let progress = false;
    for (const n of list) {
      const w = weight(n) as number;
      if (0 <= w) continue;
      let found: BisectNode | undefined;
      for (const q of n.parents) {
        if (!(q.flags & UNINTERESTING)) {
          const wq = weight(q);
          if (wq !== undefined && 0 <= wq) {
            found = q;
            break;
          }
        }
        if (fp) break;
      }
      if (!found) continue;
      progress = true;
      const wq = weight(found) as number;
      if (!(n.flags & TREESAME)) {
        weights.set(n, wq + 1);
        counted++;
      } else weights.set(n, wq);
      if (!all && approxHalfway(n, weight(n) as number, nr)) return [n];
    }
    // git would loop for ever: nothing more can be weighed
    if (!progress) break;
  }

  if (!all) return bestBisection(list, nr, weights);
  return bestBisectionSorted(list, nr, weights);
}

function bestBisection(list: BisectNode[], nr: number, weights: Map<BisectNode, number>) {
  if (list.length === 0) return [];
  let best = list[0] as BisectNode;
  let bestDistance = -1;
  for (const n of list) {
    if (n.flags & TREESAME) continue;
    let distance = weights.get(n) as number;
    if (nr - distance < distance) distance = nr - distance;
    if (distance > bestDistance) {
      best = n;
      bestDistance = distance;
    }
  }
  return [best];
}

function bestBisectionSorted(list: BisectNode[], nr: number, weights: Map<BisectNode, number>) {
  const array: { node: BisectNode; distance: number }[] = [];
  for (const n of list) {
    if (n.flags & TREESAME) continue;
    let distance = weights.get(n) as number;
    if (nr - distance < distance) distance = nr - distance;
    array.push({ node: n, distance });
  }
  array.sort((a, b) =>
    a.distance !== b.distance
      ? b.distance - a.distance
      : a.node.id < b.node.id
        ? -1
        : a.node.id > b.node.id
          ? 1
          : 0,
  );
  // nothing testable: the list keeps its first commit
  if (array.length === 0) return list.length > 0 ? [list[0] as BisectNode] : [];
  return array.map((e) => e.node);
}

/** The PRNG of bisect.c's skip_away (`man 3 rand`, seeded with the count). */
export const PRN_MODULO = 32768;

function getPrn(count: number): number {
  const c = (Math.imul(count, 1103515245) + 12345) >>> 0;
  return Math.floor(c / 65536) % PRN_MODULO;
}

/** bisect.c's sqrti: Newton's method in single precision floats. */
function sqrti(val: number): number {
  if (!val) return 0;
  const f = Math.fround;
  let x = f(val);
  let d: number;
  do {
    const y = f(f(x + f(f(val) / x)) / 2);
    d = y > x ? f(y - x) : f(x - y);
    x = y;
  } while (d >= 0.5);
  return Math.trunc(x);
}

/** C's `int` division (truncated toward zero) of 32-bit values. */
const idiv = (a: number, b: number) => Math.trunc(a / b) | 0;

/** The index skip_away takes among `count` commits (C's 32-bit arithmetic, overflow included). */
export function skipAwayIndex(count: number): number {
  const prn = getPrn(count);
  return idiv(Math.imul(idiv(Math.imul(count, prn), PRN_MODULO), sqrti(prn)), sqrti(PRN_MODULO));
}

/**
 * bisect.c's skip_away: a commit away from the skipped best one, chosen with git's
 * pseudo-random index into the remaining commits (never the bad commit itself unless it is
 * the first). The list from the chosen commit on.
 */
export function skipAway(list: BisectNode[], count: number, badId: ObjectId): BisectNode[] {
  const index = skipAwayIndex(count);
  let result = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === index) {
      if ((list[i] as BisectNode).id !== badId) result = i;
      else if (i > 0) result = i - 1;
      else result = 0;
      break;
    }
  }
  return list.slice(result);
}

/**
 * bisect.c's managed_skipped: the list without the skipped commits when the best one is
 * skipped (then a commit away from it, {@link skipAway}), else the best one; `tried` holds
 * the skipped commits met.
 */
export function managedSkipped(
  list: BisectNode[],
  skipped: ReadonlySet<ObjectId>,
  badId: ObjectId,
): { list: BisectNode[]; tried: BisectNode[] } {
  const tried: BisectNode[] = [];
  if (skipped.size === 0) return { list, tried };
  // filter_skipped(list, tried, 0, &count, &skipped_first)
  const filtered: BisectNode[] = [];
  let skippedFirst = false;
  let count = 0;
  for (const n of list) {
    if (skipped.has(n.id)) {
      skippedFirst = true;
      tried.push(n);
    } else {
      if (!skippedFirst) return { list: [n], tried };
      filtered.push(n);
      count++;
    }
  }
  if (!skippedFirst) return { list: filtered, tried };
  return { list: filtered.length > 0 ? skipAway(filtered, count, badId) : filtered, tried };
}

/** bisect.c's estimate_bisect_steps. */
export function estimateBisectSteps(all: number): number {
  if (all < 3) return 0;
  const n = 31 - Math.clz32(all);
  const e = 1 << n;
  const x = all - e;
  return e < 3 * x ? n : n - 1;
}
