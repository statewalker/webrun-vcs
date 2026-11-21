/**
 * `git backfill` (git 2.49+, builtin/backfill.c over path-walk.c): in a partial clone, fetches
 * the blobs the history lacks, in batches of paths, through the promisor remotes.
 *
 * @example
 * ```typescript
 * // git backfill --min-batch-size=1000
 * const result = await git.backfill().setMinBatchSize(1000).call();
 * console.log(result.batches.length, "fetches");
 * // git backfill --sparse main..topic
 * await git.backfill().setSparse(true).addRevision("main..topic").call();
 * ```
 *
 * The commits are walked from HEAD (or the revisions given, with `^x` and `a..b` excluding
 * history), and their root trees, then the trees and blobs below them, path by path in git's
 * path-walk order: a priority queue of paths popping blob paths before tree paths, each kind
 * in byte order of the path (a tree's path ends with `/`), every object listed at the first
 * path it is met at. For each blob path the blobs the store lacks join the current batch,
 * which is fetched as one promisor fetch once it holds `--min-batch-size` ids (default
 * 50000), and what is left at the end in one last fetch. With `--sparse` (the default in a
 * sparse checkout) paths outside the sparse-checkout patterns are skipped. With an excluded
 * revision, the trees of the boundary commits (excluded parents of walked commits) are walked
 * too unless `setIncludeEdges(false)` (`--no-include-edges`).
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { SparseCheckoutPatterns } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { promisorOf } from "./promisor-remote.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { parseRevisionArgs } from "./revision-range.js";
import {
  readSparseCheckoutFile,
  readSparseCheckoutPatterns,
  sparseCheckoutConfig,
} from "./sparse-checkout-support.js";

/** What a backfill did. */
export interface BackfillResult {
  /** git's exit status: 0, 1 when it fails (or under 2.43, which has no backfill) */
  exitCode: number;
  /** What git prints on stderr */
  stderr: string;
  /** The ids each promisor fetch asked for, in order (one entry per fetch) */
  batches: ObjectId[][];
}

/** The git version whose behaviour is reproduced. */
export type BackfillCompatibility = "2.43" | "2.56";

/** One path of the walk (git's `struct type_and_oid_list`). */
interface PathList {
  type: "tree" | "blob";
  oids: ObjectId[];
}

/**
 * `git backfill [--min-batch-size=<n>] [--[no-]sparse] [--[no-]include-edges]
 * [<revision-range>]`: see the module documentation.
 */
export class BackfillCommand extends GitCommand<BackfillResult> {
  private minBatchSize = 50000;
  private sparse?: boolean;
  private includeEdges = true;
  private revisions: string[] = [];
  private compatibility: BackfillCompatibility = "2.56";

  /** `--min-batch-size=<n>`: the ids a batch gathers before it is fetched (default 50000). */
  setMinBatchSize(size: number): this {
    this.checkCallable();
    this.minBatchSize = Math.max(0, Math.floor(size));
    return this;
  }

  /**
   * `--sparse` / `--no-sparse`: only paths in the sparse checkout (default: whether
   * `core.sparseCheckout` is on).
   */
  setSparse(sparse: boolean): this {
    this.checkCallable();
    this.sparse = sparse;
    return this;
  }

  /** `--[no-]include-edges`: the boundary commits' blobs too (default true). */
  setIncludeEdges(include: boolean): this {
    this.checkCallable();
    this.includeEdges = include;
    return this;
  }

  /** A revision to walk from (`x`, `^x`, `a..b`, `a...b`); none: HEAD. */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisions.push(revision);
    return this;
  }

  /** The git version reproduced (default 2.56); 2.43 has no backfill. */
  setCompatibility(version: BackfillCompatibility): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<BackfillResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.compatibility === "2.43") {
      return {
        exitCode: 1,
        stderr: "git: 'backfill' is not a git command. See 'git --help'.\n",
        batches: [],
      };
    }
    let patterns: SparseCheckoutPatterns | undefined;
    const sparse = this.sparse ?? sparseCheckoutConfig(this.workingCopy).enabled;
    if (sparse) {
      const content = await readSparseCheckoutFile(this.workingCopy);
      if (content === undefined) {
        return { exitCode: 1, stderr: "error: problem loading sparse-checkout\n", batches: [] };
      }
      patterns = await readSparseCheckoutPatterns(this.workingCopy);
    }
    const rootTrees = await this.rootTrees();
    const batches = await this.walkPaths(rootTrees, patterns);
    return { exitCode: 0, stderr: "", batches };
  }

  /**
   * The revision walk's root trees, each once: the boundary commits' first (git's
   * `mark_edges_uninteresting` with `edge_hint`), then the walked commits'.
   */
  private async rootTrees(): Promise<ObjectId[]> {
    const include: ObjectId[] = [];
    const exclude: ObjectId[] = [];
    if (this.revisions.length === 0) {
      include.push(await this.resolveHead());
    } else {
      const parsed = await parseRevisionArgs(this.revisionResolver(), this.revisions, {
        committish: true,
        mergeBases: (a: string, b: string) => revisionMergeBases(this.walkCommits, a, b),
      });
      for (const entry of parsed.entries) (entry.exclude ? exclude : include).push(entry.id);
    }
    const parentsOf = async (id: ObjectId): Promise<ObjectId[]> => {
      try {
        return await this.commits.getParents(id);
      } catch {
        return [];
      }
    };
    // UNINTERESTING: every ancestor of an excluded commit
    const uninteresting = new Set<ObjectId>();
    const stack = [...exclude];
    while (stack.length > 0) {
      const id = stack.pop() as ObjectId;
      if (uninteresting.has(id)) continue;
      uninteresting.add(id);
      stack.push(...(await parentsOf(id)));
    }
    const walked: ObjectId[] = [];
    const edges: ObjectId[] = [];
    const seen = new Set<ObjectId>();
    const edgeSeen = new Set<ObjectId>();
    const queue = include.filter((id) => !uninteresting.has(id));
    while (queue.length > 0) {
      const id = queue.shift() as ObjectId;
      if (seen.has(id)) continue;
      seen.add(id);
      walked.push(id);
      for (const parent of await parentsOf(id)) {
        if (uninteresting.has(parent)) {
          if (!edgeSeen.has(parent)) {
            edgeSeen.add(parent);
            edges.push(parent);
          }
        } else if (!seen.has(parent)) {
          queue.push(parent);
        }
      }
    }
    const trees: ObjectId[] = [];
    const treeSeen = new Set<ObjectId>();
    for (const id of [...(this.includeEdges ? edges : []), ...walked]) {
      const tree = await this.commits.getTree(id);
      if (!tree || treeSeen.has(tree)) continue;
      treeSeen.add(tree);
      trees.push(tree);
    }
    return trees;
  }

  /** path-walk.c's walk_objects_by_path with backfill's fill_missing_blobs: the batches. */
  private async walkPaths(
    rootTrees: ObjectId[],
    patterns: SparseCheckoutPatterns | undefined,
  ): Promise<ObjectId[][]> {
    // odb_has_object without fetching
    const objects = this.workingCopy.history.objects;
    const has = (id: ObjectId) => (objects ? objects.has(id) : this.blobs.has(id));
    const promisor = promisorOf(this.workingCopy);
    const lists = new Map<string, PathList>();
    const pushed = new Set<string>();
    const seen = new Set<ObjectId>(rootTrees);
    const queue = new PathQueue(lists);
    const push = (path: string) => {
      if (pushed.has(path)) return;
      pushed.add(path);
      queue.put(path);
    };
    lists.set("", { type: "tree", oids: [...rootTrees] });
    push("");

    const batches: ObjectId[][] = [];
    let batch: ObjectId[] = [];
    const download = async () => {
      const ids = batch;
      batch = [];
      if (ids.length === 0) return;
      batches.push(ids);
      await promisor?.fetchObjects(ids);
    };

    const addTreeEntries = async (base: string, id: ObjectId) => {
      const entries = (await this.trees.entries?.(id)) ?? (await collectEntries(this.trees, id));
      if (!entries) throw new Error(`failed to walk children of tree ${id}: not found`);
      for (const entry of entries) {
        if (entry.mode === FileMode.GITLINK) continue;
        const isTree = entry.mode === FileMode.TREE;
        const path = `${base}${entry.name}${isTree ? "/" : ""}`;
        if (seen.has(entry.id)) continue;
        // pl_sparse_trees: a path outside the patterns is left, tree or blob (cone mode);
        // without cone patterns only blobs are matched
        if (patterns && (isTree ? patterns.cone : true) && !patterns.includes(path)) continue;
        seen.add(entry.id);
        let list = lists.get(path);
        if (!list) {
          list = { type: isTree ? "tree" : "blob", oids: [] };
          lists.set(path, list);
        }
        list.oids.push(entry.id);
        push(path);
      }
    };

    for (let path = queue.get(); path !== undefined; path = queue.get()) {
      const list = lists.get(path);
      if (!list) continue;
      if (list.oids.length > 0) {
        if (list.type === "blob") {
          for (const id of list.oids) if (!(await has(id))) batch.push(id);
          if (batch.length >= this.minBatchSize) await download();
        } else {
          for (const id of list.oids) await addTreeEntries(path, id);
        }
      }
      lists.delete(path);
    }
    await download();
    return batches;
  }
}

async function collectEntries(
  trees: {
    load(
      id: ObjectId,
    ): Promise<AsyncIterable<{ mode: number; name: string; id: ObjectId }> | undefined>;
  },
  id: ObjectId,
): Promise<{ mode: number; name: string; id: ObjectId }[] | undefined> {
  const loaded = await trees.load(id);
  if (!loaded) return undefined;
  const out: { mode: number; name: string; id: ObjectId }[] = [];
  for await (const entry of loaded) out.push(entry);
  return out;
}

/** strcmp of the paths' UTF-8 bytes: code point order. */
function comparePaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

/**
 * path-walk.c's `path_stack` (a prio_queue ordered by compare_by_type): blob paths before
 * tree paths, each kind in byte order.
 */
class PathQueue {
  private readonly heap: string[] = [];
  constructor(private readonly lists: Map<string, PathList>) {}

  private less(a: string, b: string): boolean {
    const ta = this.lists.get(a)?.type;
    const tb = this.lists.get(b)?.type;
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta === "blob";
    return comparePaths(a, b) < 0;
  }

  put(path: string): void {
    const heap = this.heap;
    heap.push(path);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(heap[i] as string, heap[parent] as string)) break;
      [heap[i], heap[parent]] = [heap[parent] as string, heap[i] as string];
      i = parent;
    }
  }

  get(): string | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop() as string;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && this.less(heap[l] as string, heap[m] as string)) m = l;
        if (r < heap.length && this.less(heap[r] as string, heap[m] as string)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as string, heap[i] as string];
        i = m;
      }
    }
    return top;
  }
}
