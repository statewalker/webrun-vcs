/**
 * `--remerge-diff` (log-tree.c's do_remerge_diff): a merge's parents merged again by
 * merge-ort in memory, conflict markers and all, so the merge can be shown as the diff from
 * that automatic result to the recorded one, with merge-ort's conflict messages as
 * `remerge CONFLICT` headers.
 *
 * git writes the re-merge's blobs and trees into a temporary object directory
 * (`tmp_objdir`) it discards after each merge. Here they go to an in-memory overlay
 * ({@link remergeObjectsView}) over the repository's stores: reads see the overlay first,
 * then the repository; writes stay in the overlay, which is dropped with the view.
 *
 * @example
 * ```typescript
 * const view = remergeObjectsView(history);
 * const { treeId, pathMessages } = await new RemergeTreeCommand(workingCopy)
 *   .setObjectsView(view)
 *   .setParents(first, second)
 *   .call();
 * // diff treeId against the merge's tree through the same view
 * ```
 */

import {
  type BlobContent,
  type Blobs,
  createMemoryHistory,
  type History,
  type ObjectId,
  objectFormatOf,
  overlayMethods,
  type Trees,
} from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import { storeFlatTreeOver, subjectOf } from "./merge-support.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeBaseTree, mergeStoredTrees } from "./ort-recursive.js";

/**
 * `history` with its blobs and trees read through an in-memory store first and written only
 * to it: what is stored through the view never reaches `history`. Other stores (commits,
 * refs, tags) are `history`'s own.
 */
export function remergeObjectsView(history: History): History {
  const memory = createMemoryHistory({ objectFormat: objectFormatOf(history) });
  const top = { blobs: memory.blobs as Blobs, trees: memory.trees as Trees };
  const base = { blobs: history.blobs as Blobs, trees: history.trees as Trees };
  const blobs = overlayMethods(base.blobs, {
    store: (content: BlobContent | Iterable<Uint8Array>, size?: number) =>
      top.blobs.store(content, size),
    load: async (id: ObjectId) =>
      (await top.blobs.has(id)) ? top.blobs.load(id) : base.blobs.load(id),
    has: async (id: ObjectId) => (await top.blobs.has(id)) || base.blobs.has(id),
    size: async (id: ObjectId) =>
      (await top.blobs.has(id)) ? top.blobs.size(id) : base.blobs.size(id),
    // a partial clone's batch fetch (diff's patches, merge-ort's content merges, rename
    // detection): only the ids the overlay lacks are the promisor's to send; the re-merge's
    // own blobs exist nowhere else
    ...(base.blobs.prefetch
      ? {
          prefetch: async (ids: Iterable<ObjectId>) => {
            const absent: ObjectId[] = [];
            for (const id of ids) if (!(await top.blobs.has(id))) absent.push(id);
            if (absent.length > 0) await base.blobs.prefetch?.(absent);
          },
        }
      : {}),
    ...(base.blobs.mayFetch ? { mayFetch: () => base.blobs.mayFetch?.() ?? false } : {}),
    open: async (id: ObjectId) => {
      if (await top.blobs.has(id)) {
        if (top.blobs.open) return top.blobs.open(id);
        const content = await top.blobs.load(id);
        return content ? { size: await top.blobs.size(id), content } : undefined;
      }
      if (base.blobs.open) return base.blobs.open(id);
      const content = await base.blobs.load(id);
      return content ? { size: await base.blobs.size(id), content } : undefined;
    },
  });
  const loadTree = async (id: ObjectId) =>
    (await top.trees.has(id)) ? top.trees.load(id) : base.trees.load(id);
  const storeTree = (tree: Parameters<Trees["store"]>[0]) => top.trees.store(tree);
  // the commands' legacy names (`storeTree`, `loadTree`) are given here too: the base store
  // may carry them already, bound to itself
  const trees = overlayMethods(base.trees as Trees & Record<"storeTree" | "loadTree", unknown>, {
    store: storeTree,
    storeTree,
    load: loadTree,
    loadTree: async function* (id: ObjectId) {
      const entries = await loadTree(id);
      if (entries) yield* entries;
    },
    has: async (id: ObjectId) => (await top.trees.has(id)) || base.trees.has(id),
    getEntry: async (treeId: ObjectId, name: string) =>
      (await top.trees.has(treeId))
        ? top.trees.getEntry(treeId, name)
        : base.trees.getEntry(treeId, name),
    ...(base.trees.entries
      ? {
          entries: async (id: ObjectId) => {
            if (!(await top.trees.has(id))) return base.trees.entries?.(id);
            if (top.trees.entries) return top.trees.entries(id);
            const loaded = await top.trees.load(id);
            if (!loaded) return undefined;
            const out = [];
            for await (const e of loaded) out.push(e);
            return out;
          },
        }
      : {}),
    ...(base.trees.raw
      ? {
          raw: async (id: ObjectId) =>
            (await top.trees.has(id)) ? top.trees.raw?.(id) : base.trees.raw?.(id),
        }
      : {}),
  });
  return overlayMethods(history, { blobs, trees });
}

/** What {@link RemergeTreeCommand} found. */
export interface RemergeResult {
  /** merge-ort's result tree (conflicted files with their markers), in the view */
  treeId: ObjectId;
  /**
   * merge-ort's conflict messages by the path they are about (no omittable hints), as
   * `--remerge-diff` shows them: `remerge ` first, each newline followed by a space
   */
  pathMessages: Map<string, string[]>;
}

/**
 * do_remerge_diff's merge: the two parents merged as merge_incore_recursive merges them
 * (their merge bases, a virtual one for several), sides named `<abbrev> (<subject>)`. Run it
 * over a {@link remergeObjectsView} (`setObjectsView`): it stores the merge's blobs and trees.
 */
export class RemergeTreeCommand extends GitCommand<RemergeResult> {
  private parents?: [ObjectId, ObjectId];
  private parentless?: ReadonlySet<ObjectId>;

  /**
   * Commits read as having no parents in the merge-base computation (git 2.43's log freed
   * the parents of the commits it had shown)
   */
  setParentlessCommits(ids: ReadonlySet<ObjectId>): this {
    this.checkCallable();
    this.parentless = new Set(ids);
    return this;
  }

  /** The merge's first and second parent */
  setParents(first: ObjectId, second: ObjectId): this {
    this.checkCallable();
    this.parents = [first, second];
    return this;
  }

  async call(): Promise<RemergeResult> {
    this.checkCallable();
    this.setCallable(false);
    const parents = this.parents;
    if (!parents) throw new Error("RemergeTreeCommand: setParents first");
    const [p1, p2] = parents;
    const c1 = await this.commits.load(p1);
    const c2 = await this.commits.load(p2);
    if (!c1 || !c2) throw new Error(`could not parse commit ${c1 ? p2 : p1}`);
    // repo_format_commit_message(..., "%h (%s)") with DEFAULT_ABBREV
    const label = async (id: ObjectId, message: string) =>
      `${await this.abbreviateObjectId(id)} (${subjectOf(message)})`;
    const oursLabel = await label(p1, c1.message);
    const theirsLabel = await label(p2, c2.message);
    // init_ui_merge_options: merge.* and diff.renames as configured, git_xmerge_config's style
    const common = {
      style: conflictStyleOf(this.workingCopy),
      ...ortConfigOptions(this.workingCopy, undefined),
    };
    const parentless = this.parentless;
    const commits =
      parentless && parentless.size > 0
        ? overlayMethods(this.commits, {
            load: async (id: ObjectId) => {
              const commit = await this.commits.load(id);
              return commit && parentless.has(id) ? { ...commit, parents: [] } : commit;
            },
            // no commit-graph: its headers would give the parents back
            headerReader: undefined,
          })
        : this.commits;
    let bases: ObjectId[];
    if (commits === this.commits) bases = await this.commits.findMergeBase(p1, p2);
    else {
      const graph = new MergeBaseGraph(commitsBaseSource(commits, async () => new Map()));
      bases = (await graph.mergeBases(graph.commit(p1), graph.commit(p2))).flatMap((n) =>
        n.id ? [n.id] : [],
      );
    }
    const base = await mergeBaseTree(
      {
        commits,
        trees: this.trees,
        blobs: this.blobs,
        abbreviate: (id) => this.abbreviateObjectId(id),
      },
      p1,
      p2,
      bases,
      common,
    );
    const merge = await mergeStoredTrees(
      { trees: this.trees, blobs: this.blobs },
      base,
      c1.tree,
      c2.tree,
      {
        ...common,
        oursLabel,
        theirsLabel,
        baseLabel: base.label,
      },
    );
    const target = await ortResultEntries(this.blobs, merge);
    const treeId = await storeFlatTreeOver(this.trees, c1.tree, merge.ours, target);
    // path_msg under record_conflict_msgs_as_headers: the prefix, a space after each newline
    const pathMessages = new Map<string, string[]>();
    for (const [path, texts] of merge.pathMessages ?? []) {
      pathMessages.set(
        path,
        texts.map((t) => `remerge ${t.replaceAll("\n", "\n ")}`),
      );
    }
    return { treeId, pathMessages };
  }

  /** The re-merge stores its objects only in its view */
  protected override writesNoObjects(): boolean {
    return true;
  }
}
