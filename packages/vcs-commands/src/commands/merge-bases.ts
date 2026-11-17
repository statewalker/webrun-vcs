/**
 * git's merge bases in git's order (`repo_get_merge_bases`), over real commits and the
 * virtual commits merge-ort makes of merged merge bases (in memory, never stored).
 *
 * The order matters to merge-ort: with several bases it merges them pairwise, the oldest
 * first, and which base is "Temporary merge branch 1" decides the virtual base's markers.
 * git paints both sides down a queue ordered by committer date (ties in insertion order),
 * collects the commits reached from both in the order they come out, drops the ones reachable
 * from another, and sorts the rest by date (stable).
 *
 * With a commit-graph that has corrected commit dates the queue is ordered by generation
 * first, as git's `compare_commits_by_gen_then_commit_date` (commits outside the graph and
 * virtual ones have generation Infinity), and the redundancy check skips commits whose
 * generation shows they cannot reach the base checked.
 */

import type { Commits, ObjectId } from "@statewalker/vcs-core";

import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** A commit as the merge-base walk sees it: real (by id) or virtual (merge-ort's). */
export interface BaseNode {
  /** The id of a real commit; undefined for a virtual one */
  id?: ObjectId;
  /** A key unique among the nodes (the id, or `virtual:<n>`) */
  key: string;
  /** Committer date (git's `commit->date`; 0 for a virtual commit) */
  date: number;
  /** The commit-graph generation (Infinity outside the graph and for a virtual commit) */
  generation: number;
  /** The parents, loaded on demand for a real commit */
  parents(): Promise<BaseNode[]>;
  /** The commit's tree as a flat map */
  tree(): Promise<Map<string, CheckedEntry>>;
}

/** What {@link MergeBaseGraph} reads of real commits. */
export interface MergeBaseSource {
  /**
   * The commit's parents and committer timestamp (and commit-graph generation, Infinity when
   * absent), undefined when missing
   */
  load(
    id: ObjectId,
  ): Promise<{ parents: ObjectId[]; date: number; generation?: number } | undefined>;
  /** The flat tree of a commit */
  tree(id: ObjectId): Promise<Map<string, CheckedEntry>>;
  /** Whether generations are corrected commit dates (the queue is then ordered by them) */
  generationOrder?(): Promise<boolean>;
}

/**
 * A source over a commit store: headers from the commit-graph where it has the commit (no
 * commit is read), the queue ordered as git orders it with that graph.
 */
export function commitsBaseSource(
  commits: Commits,
  tree: (id: ObjectId) => Promise<Map<string, CheckedEntry>>,
): MergeBaseSource {
  return {
    load: async (id) => {
      if (commits.getHeader) {
        const h = await commits.getHeader(id).catch(() => undefined);
        return h ? { parents: h.parents, date: h.commitTime, generation: h.generation } : undefined;
      }
      const commit = await commits.load(id).catch(() => undefined);
      return commit ? { parents: commit.parents, date: commit.committer.timestamp } : undefined;
    },
    tree,
    generationOrder: async () =>
      (await commits.commitGraph?.get().catch(() => undefined))?.correctedDates ?? false,
  };
}

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;

/** Real and virtual commits, and git's merge-base computation over them. */
export class MergeBaseGraph {
  private readonly nodes = new Map<string, BaseNode>();
  private virtuals = 0;
  private byGeneration?: boolean;

  constructor(private readonly source: MergeBaseSource) {}

  /** The node of a real commit. */
  commit(id: ObjectId): BaseNode {
    const known = this.nodes.get(id);
    if (known) return known;
    let loaded:
      | Promise<{ parents: ObjectId[]; date: number; generation?: number } | undefined>
      | undefined;
    const load = () => {
      loaded ??= this.source.load(id);
      return loaded;
    };
    let date = 0;
    let generation = Number.POSITIVE_INFINITY;
    const node: BaseNode = {
      id,
      key: id,
      get date() {
        return date;
      },
      get generation() {
        return generation;
      },
      parents: async () => ((await load())?.parents ?? []).map((p) => this.commit(p)),
      tree: () => this.source.tree(id),
    };
    // the date is needed synchronously by the queue: read before the node is queued
    (node as { ready?: Promise<void> }).ready = load().then((c) => {
      date = c?.date ?? 0;
      generation = c?.generation ?? Number.POSITIVE_INFINITY;
    });
    this.nodes.set(id, node);
    return node;
  }

  /** A virtual commit (merge-ort's `make_virtual_commit`): date 0, the given parents. */
  virtual(tree: Map<string, CheckedEntry>, parents: BaseNode[]): BaseNode {
    const node: BaseNode = {
      key: `virtual:${this.virtuals++}`,
      date: 0,
      generation: Number.POSITIVE_INFINITY,
      parents: async () => parents,
      tree: async () => tree,
    };
    this.nodes.set(node.key, node);
    return node;
  }

  private async ready(node: BaseNode): Promise<void> {
    await (node as { ready?: Promise<void> }).ready;
  }

  /**
   * git's paint_down_to_common: the commits reached from both `one` and `twos`, in the
   * order the date queue yields them (`flags` is left as the walk painted it).
   */
  private async paintDownToCommon(
    one: BaseNode,
    twos: BaseNode[],
    flags: Map<string, number>,
  ): Promise<BaseNode[]> {
    const result: BaseNode[] = [];
    const flag = (n: BaseNode) => flags.get(n.key) ?? 0;
    // a priority queue by date (newest first), ties in insertion order (git's prio_queue)
    type Item = { node: BaseNode; ctr: number };
    const heap: Item[] = [];
    const byGeneration = this.byGeneration === true;
    const before = (a: Item, b: Item) => {
      if (byGeneration && a.node.generation !== b.node.generation) {
        return a.node.generation > b.node.generation;
      }
      return a.node.date > b.node.date || (a.node.date === b.node.date && a.ctr < b.ctr);
    };
    // how many queued entries each commit has, and how many entries are not stale
    const queued = new Map<string, number>();
    let nonStale = 0;
    let ctr = 0;
    const put = async (node: BaseNode) => {
      await this.ready(node);
      const item = { node, ctr: ctr++ };
      heap.push(item);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (!before(heap[i], heap[p])) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
      queued.set(node.key, (queued.get(node.key) ?? 0) + 1);
      if (!(flag(node) & STALE)) nonStale++;
    };
    const get = (): BaseNode => {
      const top = heap[0];
      const last = heap.pop() as Item;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && before(heap[l], heap[m])) m = l;
          if (r < heap.length && before(heap[r], heap[m])) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      queued.set(top.node.key, (queued.get(top.node.key) ?? 1) - 1);
      if (!(flag(top.node) & STALE)) nonStale--;
      return top.node;
    };
    const paint = (node: BaseNode, add: number) => {
      const was = flag(node);
      flags.set(node.key, was | add);
      // a commit turning stale: its queued entries are stale now
      if (!(was & STALE) && add & STALE) nonStale -= queued.get(node.key) ?? 0;
    };
    paint(one, PARENT1);
    if (twos.length === 0) return [one];
    await put(one);
    for (const two of twos) {
      paint(two, PARENT2);
      await put(two);
    }
    while (nonStale > 0) {
      const commit = get();
      let f = flag(commit) & (PARENT1 | PARENT2 | STALE);
      if (f === (PARENT1 | PARENT2)) {
        if (!(flag(commit) & RESULT)) {
          paint(commit, RESULT);
          result.push(commit);
        }
        // the parents of a found merge base are stale
        f |= STALE;
      }
      for (const parent of await commit.parents()) {
        if ((flag(parent) & f) === f) continue;
        paint(parent, f);
        await put(parent);
      }
    }
    return result;
  }

  /**
   * Whether `node` is reachable from one of `from` (git's redundancy check). A commit whose
   * generation is below `node`'s (or equal and finite) cannot reach it and is not walked.
   */
  private async reachable(node: BaseNode, from: BaseNode[]): Promise<boolean> {
    await this.ready(node);
    const target = node.generation;
    const cannotReach = (n: BaseNode) =>
      n.generation < target || (n.generation === target && Number.isFinite(target));
    const seen = new Set<string>();
    const stack = [...from];
    while (stack.length > 0) {
      const n = stack.pop() as BaseNode;
      if (seen.has(n.key)) continue;
      seen.add(n.key);
      if (n !== node && n.key === node.key) return true;
      for (const p of await n.parents()) {
        if (p.key === node.key) return true;
        await this.ready(p);
        if (!seen.has(p.key) && !cannotReach(p)) stack.push(p);
      }
    }
    return false;
  }

  /** git's repo_get_merge_bases(one, two), in git's order (newest first). */
  async mergeBases(one: BaseNode, two: BaseNode): Promise<BaseNode[]> {
    return this.mergeBasesMany(one, [two]);
  }

  /** git's repo_get_merge_bases_many(one, twos) (`git merge-base --all one twos...`). */
  async mergeBasesMany(one: BaseNode, twos: BaseNode[]): Promise<BaseNode[]> {
    if (twos.some((two) => two.key === one.key)) return [one];
    this.byGeneration ??= (await this.source.generationOrder?.()) ?? false;
    const flags = new Map<string, number>();
    const list = await this.paintDownToCommon(one, twos, flags);
    const byDate = (nodes: BaseNode[]) => nodes.map((n, i) => ({ n, i }));
    const sortByDate = (nodes: BaseNode[]) =>
      byDate(nodes)
        .sort((a, b) => b.n.date - a.n.date || a.i - b.i)
        .map((x) => x.n);
    const result = sortByDate(list.filter((n) => !((flags.get(n.key) ?? 0) & STALE)));
    if (result.length <= 1) return result;
    // remove_redundant: a base reachable from another is dropped (the array's order kept)
    const redundant = new Array(result.length).fill(false);
    for (let i = 0; i < result.length; i++) {
      if (redundant[i]) continue;
      const others = result.filter((_, j) => j !== i && !redundant[j]);
      if (await this.reachable(result[i], others)) redundant[i] = true;
      for (let j = 0; j < result.length; j++) {
        if (j === i || redundant[j]) continue;
        if (await this.reachable(result[j], [result[i]])) redundant[j] = true;
      }
    }
    return sortByDate(result.filter((_, i) => !redundant[i]));
  }
}
