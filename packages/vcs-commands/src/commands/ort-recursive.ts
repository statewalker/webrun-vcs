/**
 * merge-ort's virtual merge base (`merge_ort_internal`): with several merge bases, git
 * merges them pairwise (the oldest first, "Temporary merge branch 1" and "2" in the
 * markers, their own merge bases merged the same way) and uses the result as the base of the
 * real merge, named "merged common ancestors". The virtual commits and their trees stay in
 * memory; only the blobs of content merges are stored, as git stores them.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";

import type { CommandCommits, CommandTrees } from "../git-command.js";
import { type BaseNode, MergeBaseGraph } from "./merge-bases.js";
import { abbrev, flatTree } from "./merge-support.js";
import { type OrtMergeOptions, ortMerge, ortResultEntries } from "./ort-merge.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** The base a merge runs against, and its name after `|||||||`. */
export interface MergeBaseTree {
  tree: Map<string, CheckedEntry>;
  label: string;
}

/** What the virtual base needs of a command. */
export interface VirtualBaseContext {
  commits: CommandCommits;
  trees: CommandTrees;
  blobs: Blobs;
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
  if (bases.length === 0) return { tree: new Map(), label: "empty tree" };
  const graph = new MergeBaseGraph({
    load: async (id) => {
      const commit = await ctx.commits.load(id);
      return commit ? { parents: commit.parents, date: commit.committer.timestamp } : undefined;
    },
    tree: async (id) => flatTree(ctx.trees, await ctx.commits.getTree(id)),
  });
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
  if (!first) return { tree: new Map(), label: "empty tree" };
  const label = rest.length > 0 ? "merged common ancestors" : abbrev(first.id ?? "");
  let merged = first;
  for (const next of rest) {
    const tree = await innerMerge(ctx, graph, merged, next, depth + 1, options);
    merged = graph.virtual(tree, [merged, next]);
  }
  return { tree: await merged.tree(), label };
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
  const merge = await ortMerge(ctx.blobs, base.tree, await h1.tree(), await h2.tree(), {
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
