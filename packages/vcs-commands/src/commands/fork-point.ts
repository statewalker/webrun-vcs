/**
 * git's get_fork_point (commit.c), shared by `git merge-base --fork-point` and
 * `git rebase --fork-point`: the commit a branch forked from, found in the reflog of the
 * ref it was built on.
 *
 * @example
 * ```typescript
 * // main was rewound after `side` forked from its old tip C: the fork point is C
 * const fork = await findForkPoint(source, "main", sideTip); // C's id
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { GitApiError } from "../errors/index.js";
import { forkPointOf, type MergeBaseGraph } from "./merge-bases.js";

/** What the search reads of the repository. */
export interface ForkPointSource {
  /** git's repo_dwim_ref: every ref the name may stand for, with its value */
  dwimRef(name: string): Promise<{ id: ObjectId; ref: string }[]>;
  /** The ref's reflog, oldest entry first (empty or undefined when it has none) */
  reflog(ref: string): Promise<{ oldId: ObjectId; newId: ObjectId }[] | undefined>;
  /** Whether `id` names a commit that can be read (git's lookup_commit + parse_commit) */
  isCommit(id: ObjectId): Promise<boolean>;
  /** The merge-base walk */
  graph: MergeBaseGraph;
}

const NULL_ID = /^0+$/;

/**
 * The fork point of `commit` from `refname`'s reflog, or undefined when there is none
 * (no single merge base among the logged values).
 *
 * @throws GitApiError `fatal: No such ref: '<name>'` / `fatal: Ambiguous refname: '<name>'`
 */
export async function findForkPoint(
  source: ForkPointSource,
  refname: string,
  commit: ObjectId,
): Promise<ObjectId | undefined> {
  const found = await source.dwimRef(refname);
  if (found.length === 0) throw new GitApiError(`fatal: No such ref: '${refname}'`);
  if (found.length > 1) throw new GitApiError(`fatal: Ambiguous refname: '${refname}'`);
  const { id: value, ref } = found[0] as { id: ObjectId; ref: string };
  const candidates: ObjectId[] = [];
  const seen = new Set<ObjectId>();
  const add = async (id: ObjectId) => {
    if (NULL_ID.test(id) || seen.has(id)) return;
    if (!(await source.isCommit(id))) return;
    seen.add(id);
    candidates.push(id);
  };
  const entries = (await source.reflog(ref)) ?? [];
  for (const [i, entry] of entries.entries()) {
    // collect_one_reflog_ent: the first entry's old value, then each new value
    if (i === 0) await add(entry.oldId);
    await add(entry.newId);
  }
  if (candidates.length === 0) await add(value);
  return forkPointOf(source.graph, commit, candidates);
}
