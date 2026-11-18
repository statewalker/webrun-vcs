/**
 * merge-ort's virtual merge base (`merge_ort_internal`): with several merge bases, git
 * merges them pairwise (the oldest first, "Temporary merge branch 1" and "2" in the
 * markers, their own merge bases merged the same way) and uses the result as the base of the
 * real merge, named "merged common ancestors". The virtual commits and their trees stay in
 * memory; only the blobs of content merges are stored, as git stores them.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";

import type { CommandCommits, CommandTrees } from "../git-command.js";
import { type BaseNode, commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { flatTree, prunedFlatTrees } from "./merge-support.js";
import {
  type OrtMergeOptions,
  type OrtMergeResult,
  ortMerge,
  ortResultEntries,
} from "./ort-merge.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** The base a merge runs against, and its name after `|||||||`. */
export interface MergeBaseTree {
  /** The base as a flat map (read on demand for a stored tree) */
  tree(): Promise<Map<string, CheckedEntry>>;
  /**
   * Whether the base is a stored tree, `treeId` (undefined: the empty tree), rather than a
   * virtual merge base held in memory
   */
  stored: boolean;
  treeId?: ObjectId;
  label: string;
}

/** What the virtual base needs of a command. */
export interface VirtualBaseContext {
  commits: CommandCommits;
  trees: CommandTrees;
  blobs: Blobs;
  /**
   * A single merge base's label: git's `strbuf_add_unique_abbrev(..., DEFAULT_ABBREV)`
   * (the command's `abbreviateObjectId`)
   */
  abbreviate: (id: ObjectId) => Promise<string>;
}

/**
 * The base tree of a merge of `h1` and `h2` with merge bases `bases` (as merge-ort's
 * merge_incore_recursive computes it): the empty tree ("empty tree") without a base, the
 * base itself (its abbreviated id) with one, the virtual merge base ("merged common
 * ancestors") with several.
 */
export async function mergeBaseTree(
  ctx: VirtualBaseContext,
  h1: ObjectId,
  h2: ObjectId,
  bases: ObjectId[],
  options: Omit<OrtMergeOptions, "oursLabel" | "theirsLabel" | "baseLabel">,
): Promise<MergeBaseTree> {
  if (bases.length === 0) return emptyBase();
  const graph = new MergeBaseGraph(
    commitsBaseSource(ctx.commits, async (id) =>
      flatTree(ctx.trees, await ctx.commits.getTree(id)),
    ),
  );
  // all the merge bases, in git's order (the list given may hold only the best one)
  const ordered = await graph.mergeBases(graph.commit(h1), graph.commit(h2));
  const nodes = ordered.length > 0 ? ordered : bases.map((id) => graph.commit(id));
  return mergedBases(ctx, graph, [...nodes].reverse(), 0, options);
}

/** merge_ort_internal's loop: the bases (oldest first) merged into one. */
async function mergedBases(
  ctx: VirtualBaseContext,
  graph: MergeBaseGraph,
  bases: BaseNode[],
  depth: number,
  options: Omit<OrtMergeOptions, "oursLabel" | "theirsLabel" | "baseLabel">,
): Promise<MergeBaseTree> {
  const [first, ...rest] = bases;
  if (!first) return emptyBase();
  const label =
    rest.length > 0 ? "merged common ancestors" : first.id ? await ctx.abbreviate(first.id) : "";
  if (rest.length === 0 && first.id) {
    // one real commit: its stored tree
    const treeId = await ctx.commits.getTree(first.id);
    return { tree: () => first.tree(), stored: true, treeId, label };
  }
  let merged = first;
  for (const next of rest) {
    const tree = await innerMerge(ctx, graph, merged, next, depth + 1, options);
    merged = graph.virtual(tree, [merged, next]);
  }
  const tree = await merged.tree();
  return { tree: async () => tree, stored: false, label };
}

function emptyBase(): MergeBaseTree {
  return { tree: async () => new Map(), stored: true, label: "empty tree" };
}

/** A merge of two merge bases (`call_depth` > 0): its result tree, conflicts and all. */
async function innerMerge(
  ctx: VirtualBaseContext,
  graph: MergeBaseGraph,
  h1: BaseNode,
  h2: BaseNode,
  depth: number,
  options: Omit<OrtMergeOptions, "oursLabel" | "theirsLabel" | "baseLabel">,
): Promise<Map<string, CheckedEntry>> {
  const bases = [...(await graph.mergeBases(h1, h2))].reverse();
  const base = await mergedBases(ctx, graph, bases, depth, options);
  const merge = await ortMerge(ctx.blobs, await base.tree(), await h1.tree(), await h2.tree(), {
    ...options,
    oursLabel: "Temporary merge branch 1",
    theirsLabel: "Temporary merge branch 2",
    baseLabel: base.label,
    oursName: undefined,
    theirsName: undefined,
    callDepth: depth,
  });
  return ortResultEntries(ctx.blobs, merge);
}

/**
 * merge-ort over stored trees: `ours` and `theirs` (tree ids) against `base`. A stored base
 * merges the trees as merge-ort reads them (directories all three hold alike are never
 * read, {@link prunedFlatTrees}); a virtual base, or a merge that finds directory renames
 * (which may move a path into any directory), merges the whole trees.
 */
export async function mergeStoredTrees(
  ctx: Pick<VirtualBaseContext, "trees" | "blobs">,
  base: MergeBaseTree,
  ours: ObjectId | undefined,
  theirs: ObjectId | undefined,
  options: OrtMergeOptions,
  flat: (id: ObjectId | undefined) => Promise<Map<string, CheckedEntry>> = (id) =>
    flatTree(ctx.trees, id),
): Promise<OrtMergeResult & { ours: Map<string, CheckedEntry> }> {
  if (base.stored) {
    const { flats, dirs } = await prunedFlatTrees(ctx.trees, [base.treeId, ours, theirs]);
    const merge = await ortMerge(ctx.blobs, flats[0], flats[1], flats[2], {
      ...options,
      dirTrees: dirs,
    });
    if (!merge.directoryRenames) return { ...merge, ours: flats[1] };
  }
  const oursFlat = await flat(ours);
  const merge = await ortMerge(ctx.blobs, await base.tree(), oursFlat, await flat(theirs), options);
  return { ...merge, ours: oursFlat };
}

/** A stored tree (undefined: the empty tree) as the base of {@link mergeStoredTrees}. */
export function storedBase(
  treeId: ObjectId | undefined,
  label: string,
  flat: () => Promise<Map<string, CheckedEntry>>,
): MergeBaseTree {
  return { tree: flat, stored: true, treeId, label };
}
