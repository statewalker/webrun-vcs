/**
 * Reachability as git's `commit-reach.c` computes it: merge bases (`paint_down_to_common`,
 * `remove_redundant`) and ancestry (`repo_in_merge_bases`), over a source of commit headers.
 *
 * Generation numbers (from the commit-graph) cut walks short: a commit cannot reach another
 * whose generation is not lower than its own, so a walk looking for `x` skips every commit of
 * a generation below `x`'s. Commits outside the graph have generation Infinity (git's
 * GENERATION_NUMBER_INFINITY); the graph is closed under parents, so a commit in it never
 * reaches one outside it. The cutoffs and the early exits hold only when every commit's
 * generation is above its parents': a source over a graph that is not so (see
 * `CommitGraph.generationsTrusted`) gives every commit generation Infinity, and the walks are
 * then full walks in date order.
 */

import type { ObjectId } from "../../common/id/index.js";

/** What a reachability walk reads of a commit. */
export interface ReachCommit {
  parents: ObjectId[];
  /** Committer date, seconds (git's `commit->date`) */
  date: number;
  /** Generation from the commit-graph, Infinity when the commit is not in it */
  generation: number;
}

/** The commit's header (without a promise when it is at hand), or undefined when it is missing. */
export type ReachSource = (
  id: ObjectId,
) => ReachCommit | undefined | Promise<ReachCommit | undefined>;

/** How the walks order and cut. */
export interface ReachOptions {
  /**
   * The graph's generations are corrected commit dates (git's corrected_commit_dates_enabled),
   * not topological levels: they then order the walk above the graph's commits too
   */
  correctedDates?: boolean;
  /**
   * `git merge-base` without `--all` (false): the walk stops at the first merge base found
   * in the graph. Default true (every merge base).
   */
  all?: boolean;
  /** Counts each commit header read (for tests and benchmarks) */
  onVisit?: (id: ObjectId) => void;
}

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;
const ENQUEUED = 16;
/** git's GENERATION_NUMBER_V1_MAX: topological levels are below it. */
const GENERATION_NUMBER_V1_MAX = 0x3fffffff;

/** Whether a commit of generation `g` (id `id`) may reach `target` of generation `gt`. */
function mayReach(id: ObjectId, g: number, target: ObjectId, gt: number): boolean {
  if (id === target) return true;
  if (g < gt) return false;
  // equal finite generations: neither reaches the other
  return !(g === gt && Number.isFinite(gt));
}

/**
 * Whether `ancestor` is reachable from `descendant` (or is it), as git's repo_in_merge_bases:
 * a depth-first walk from `descendant` that skips commits whose generation shows they cannot
 * reach `ancestor`.
 *
 * @example
 * ```typescript
 * if (await isAncestorOf(header, base, head)) console.log("fast-forward");
 * ```
 */
export async function isAncestorOf(
  source: ReachSource,
  ancestor: ObjectId,
  descendant: ObjectId,
  options: ReachOptions = {},
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const read = (id: ObjectId) => {
    options.onVisit?.(id);
    return source(id);
  };
  const target = await read(ancestor);
  const gt = target?.generation ?? Number.POSITIVE_INFINITY;
  const start = await read(descendant);
  if (!start || !mayReach(descendant, start.generation, ancestor, gt)) return false;
  const seen = new Set<ObjectId>([descendant]);
  const stack: ReachCommit[] = [start];
  while (stack.length > 0) {
    const c = stack.pop() as ReachCommit;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      if (seen.has(p)) continue;
      seen.add(p);
      const r = read(p);
      const pc = r instanceof Promise ? await r : r;
      if (!pc || !mayReach(p, pc.generation, ancestor, gt)) continue;
      stack.push(pc);
    }
  }
  return false;
}

/** Whether `target` is reachable from one of `from` (none of which is `target`). */
async function reachableFrom(
  read: ReachSource,
  target: ObjectId,
  gt: number,
  from: ObjectId[],
): Promise<boolean> {
  const seen = new Set<ObjectId>();
  const stack: ObjectId[] = [];
  for (const f of from) {
    if (!seen.has(f)) {
      seen.add(f);
      stack.push(f);
    }
  }
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    const r = read(id);
    const c = r instanceof Promise ? await r : r;
    if (!c) continue;
    for (const p of c.parents) {
      if (p === target) return true;
      if (seen.has(p)) continue;
      seen.add(p);
      const rp = read(p);
      const pc = rp instanceof Promise ? await rp : rp;
      if (pc && mayReach(p, pc.generation, target, gt)) stack.push(p);
    }
  }
  return false;
}

/** git's commit_list_sort_by_date: newest first, stable. */
function sortByDate<T extends { date: number }>(list: T[]): T[] {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x.date - a.x.date || a.i - b.i)
    .map((e) => e.x);
}

/**
 * The merge bases of `one` and `twos` in git's order (git 2.56's repo_get_merge_bases_many,
 * as `git merge-base --all one twos...` prints them): the commits reachable from both found
 * by painting down a priority queue (generation, then date), the redundant ones (reachable
 * from another) removed, sorted by date, newest first. In the graph the walk also ends once
 * one side has nothing left to paint (git's side-exhaustion exit).
 *
 * @example
 * ```typescript
 * const [best] = await getMergeBases(header, ours, [theirs]);
 * ```
 */
export async function getMergeBases(
  source: ReachSource,
  one: ObjectId,
  twos: ObjectId[],
  options: ReachOptions = {},
): Promise<ObjectId[]> {
  if (twos.includes(one)) return [one];
  const headers = new Map<ObjectId, ReachCommit | null>();
  const remember = (id: ObjectId, h: ReachCommit | undefined) => {
    headers.set(id, h ?? null);
    return h;
  };
  const read = (id: ObjectId): ReachCommit | undefined | Promise<ReachCommit | undefined> => {
    const known = headers.get(id);
    if (known !== undefined) return known ?? undefined;
    options.onVisit?.(id);
    const r = source(id);
    return r instanceof Promise ? r.then((h) => remember(id, h)) : remember(id, r);
  };
  const oneHeader = await read(one);
  if (!oneHeader) return [];
  if (twos.length === 0) return [one];

  // paint_down_to_common (git 2.56): a queue ordered by generation, then date (commits
  // outside the graph have generation Infinity, so without a graph it is by date), each
  // commit queued once, with counts of the commits only one side reached and of candidates
  const flags = new Map<ObjectId, number>();
  const flag = (id: ObjectId) => flags.get(id) ?? 0;
  type Item = { id: ObjectId; c: ReachCommit; ctr: number };
  const before = (a: Item, b: Item) => {
    if (a.c.generation !== b.c.generation) return a.c.generation > b.c.generation;
    if (a.c.date !== b.c.date) return a.c.date > b.c.date;
    return a.ctr < b.ctr;
  };
  // the side-exhaustion exit holds where the queue is in topological order: in the graph
  const topoCeiling = options.correctedDates ? Number.POSITIVE_INFINITY : GENERATION_NUMBER_V1_MAX;
  const heap: Item[] = [];
  const counts = { p1: 0, p2: 0, candidates: 0 };
  const count = (f: number, delta: number) => {
    switch (f & (PARENT1 | PARENT2 | STALE)) {
      case PARENT1:
        counts.p1 += delta;
        break;
      case PARENT2:
        counts.p2 += delta;
        break;
      case PARENT1 | PARENT2:
        counts.candidates += delta;
        break;
    }
  };
  let ctr = 0;
  const put = (id: ObjectId, c: ReachCommit, add: number) => {
    const was = flag(id);
    const now = was | add;
    if (was & ENQUEUED) {
      flags.set(id, now);
      count(was, -1);
      count(now, 1);
      return;
    }
    flags.set(id, now | ENQUEUED);
    count(now, 1);
    const item = { id, c, ctr: ctr++ };
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!before(heap[i] as Item, heap[p] as Item)) break;
      [heap[i], heap[p]] = [heap[p] as Item, heap[i] as Item];
      i = p;
    }
  };
  const get = (): Item | undefined => {
    const top = heap[0];
    if (!top) return undefined;
    const last = heap.pop() as Item;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && before(heap[l] as Item, heap[m] as Item)) m = l;
        if (r < heap.length && before(heap[r] as Item, heap[m] as Item)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as Item, heap[i] as Item];
        i = m;
      }
    }
    const f = flag(top.id) & ~ENQUEUED;
    flags.set(top.id, f);
    if (counts.candidates === 0) {
      // only stale entries remain, or one side is exhausted where the order is topological
      if (counts.p1 === 0 && counts.p2 === 0) return undefined;
      if ((counts.p1 === 0 || counts.p2 === 0) && top.c.generation < topoCeiling) return undefined;
    }
    count(f, -1);
    return top;
  };

  flags.set(one, PARENT1);
  put(one, oneHeader, 0);
  for (const two of twos) {
    const h = await read(two);
    if (!h) return [];
    put(two, h, PARENT2);
  }
  const painted: { id: ObjectId; date: number }[] = [];
  for (let item = get(); item; item = get()) {
    const { id, c } = item;
    let f = flag(id) & (PARENT1 | PARENT2 | STALE);
    if (f === (PARENT1 | PARENT2)) {
      if (!(flag(id) & RESULT)) {
        flags.set(id, flag(id) | RESULT);
        painted.push({ id, date: c.date });
        // generation-ordered: no common ancestor left can descend from this one
        if (options.all === false && c.generation < topoCeiling) break;
      }
      f |= STALE;
    }
    for (const p of c.parents) {
      if ((flag(p) & f) === f) continue;
      const r = read(p);
      const ph = r instanceof Promise ? await r : r;
      // a missing parent (a shallow or broken history) ends that line, as walkAncestry does
      if (!ph) continue;
      put(p, ph, f);
    }
  }

  // merge_bases_many: the painted commits that are not stale, by date (a stable sort)
  const list = sortByDate(painted.filter((item) => !(flag(item.id) & STALE)));
  if (list.length <= 1) return list.map((x) => x.id);

  // remove_redundant: a base reachable from another goes (the order is kept)
  const redundant = new Array<boolean>(list.length).fill(false);
  for (let i = 0; i < list.length; i++) {
    if (redundant[i]) continue;
    const id = (list[i] as { id: ObjectId }).id;
    const gi = (await read(id))?.generation ?? Number.POSITIVE_INFINITY;
    const others = list.filter((_, j) => j !== i && !redundant[j]).map((x) => x.id);
    if (await reachableFrom(read, id, gi, others)) {
      redundant[i] = true;
      continue;
    }
    for (let j = 0; j < list.length; j++) {
      if (j === i || redundant[j]) continue;
      const other = (list[j] as { id: ObjectId }).id;
      const gj = (await read(other))?.generation ?? Number.POSITIVE_INFINITY;
      if (await reachableFrom(read, other, gj, [id])) redundant[j] = true;
    }
  }
  return sortByDate(list.filter((_, i) => !redundant[i])).map((x) => x.id);
}
