/**
 * Pieces of git's sequencer shared by `merge`, `cherry-pick`, `revert` and `rebase`:
 * `git reset --merge` / `--hard` as their `--abort` runs it, the commit message cleanup
 * their `--continue` applies, and `SQUASH_MSG`.
 */

import {
  FileMode,
  formatPersonIdent,
  type ObjectId,
  type PersonIdent,
} from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  entryStatOf,
  type IndexEntryOptions,
  type StagingEntry,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import type { CommandCommits, CommandRefs } from "../git-command.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  flatTree,
  type MergeRefusal,
  type MergeWriteContext,
  type OperationState,
  planPathsRestore,
  rewriteIndex,
} from "./merge-support.js";
import { stripspace } from "./message-cleanup.js";
import { pushSparseWarnings, SparseUnpack } from "./sparse-checkout-support.js";
import { StashApplyCommand } from "./stash-apply-command.js";
import { StashCreateCommand } from "./stash-create-command.js";
import { STASH_REF } from "./stash-list-command.js";
import { writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  flaggedEntryDiffers,
  pruneEmptyParents,
  untrackedUnder,
  worktreeDiffers,
  worktreeModified,
} from "./worktree-overwrite-checks.js";

/** What resetting the index and worktree needs. */
export interface SequencerContext extends MergeWriteContext {
  commits: CommandCommits;
  refs: CommandRefs;
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/**
 * git's `reset --merge <commit>` (and with `hard`, the `reset --hard` of `reset_head` that
 * `rebase --abort`, `--skip` and the autostash run) of the index and the worktree, as
 * unpack-trees' `oneway_merge` runs it with update: unmerged entries and entries that
 * differ from the commit's tree take its version; paths the index and the commit agree on
 * keep their worktree file as it is (with `hard`, a modified or missing file is written
 * again). Refused before anything is written, with git's plumbing messages, where it
 * would lose work: a file holding unstaged changes (`verify_uptodate`, not with `hard`),
 * an untracked file where a file goes or on a leading path of one (`verify_absent`), an
 * untracked file or nested repository in a directory a file replaces
 * (`verify_clean_subdirectory`). Ignored files are expendable. HEAD is not moved.
 */
export async function resetMerge(
  ctx: SequencerContext,
  targetId: ObjectId,
  label: string,
  options: { hard?: boolean } = {},
): Promise<MergeRefusal | undefined> {
  // in a sparse checkout: unpack-trees with its patterns; reset prints its sparse warnings
  // as plain errors (no porcelain messages)
  const sparse = await SparseUnpack.start(ctx);
  const done = await resetMergeWith(ctx, targetId, label, options, sparse);
  if (done.refused) return done.refused;
  if (sparse) {
    const outcome = await sparse.finish(ctx, {
      written: done.written,
      overwrite: options.hard === true,
    });
    pushSparseWarnings(ctx.sparseWarnings, sparse, outcome, false);
  }
  return undefined;
}

async function resetMergeWith(
  ctx: SequencerContext,
  targetId: ObjectId,
  label: string,
  options: { hard?: boolean },
  sparse: SparseUnpack | undefined,
): Promise<{ refused?: MergeRefusal; written: Set<string> }> {
  const refusedWith = (refused: MergeRefusal) => ({ refused, written: new Set<string>() });
  // a path staying outside the sparse checkout: neither checked nor touched in the worktree
  const quiet = (path: string) => sparse?.leavesAlone(path) === true;
  const checkUptodate = !options.hard;
  const targetTree = await ctx.commits.getTree(targetId);
  const target = await flatTree(ctx.trees, targetTree);
  const index = new Map<string, CheckedEntry>();
  const unmerged = new Set<string>();
  // what read_index_unmerged leaves of a conflict: its first stage, as a stage-0 entry
  const conflictEntries = new Map<string, CheckedEntry>();
  for await (const entry of ctx.staging.entries()) {
    if (entry.stage === 0) index.set(entry.path, entry);
    else {
      unmerged.add(entry.path);
      if (!conflictEntries.has(entry.path)) {
        conflictEntries.set(entry.path, { objectId: entry.objectId, mode: entry.mode });
      }
    }
  }
  const worktree = ctx.worktree;
  const checked = conflictEntries.size > 0 ? new Map([...index, ...conflictEntries]) : index;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const indexTime = ctx.staging.getUpdateTime();
  const refuse = (message: string, path: string): MergeRefusal => ({
    message: `error: ${message}\nfatal: Could not reset index file to revision '${label}'.`,
    paths: [path],
  });
  const notUptodate = (path: string) => refuse(`Entry '${path}' not uptodate. Cannot merge.`, path);
  // verify_uptodate_1: an entry whose flags cheat (assume-unchanged, skip-worktree) is checked
  // by its stat even by a hard reset; any other only when not resetting hard
  const notUptodateEntry = async (i: CheckedEntry): Promise<boolean> => {
    if (!worktree) return false;
    const e = i as StagingEntry;
    if (e.assumeValid || e.skipWorktree) {
      return flaggedEntryDiffers(worktree, e.path, e, trust, indexTime);
    }
    return checkUptodate && worktreeDiffers(worktree, e.path, i, trust, indexTime);
  };
  const changes: string[] = [];
  /** Paths the reset removes from the index (git's CE_REMOVE in the result) */
  const removing = new Set<string>();
  const inIndex = (p: string) => index.has(p) || unmerged.has(p);
  const paths = [...new Set([...index.keys(), ...unmerged, ...target.keys()])].sort(compareBytes);
  for (const path of paths) {
    const i = index.get(path);
    const t = target.get(path);
    const conflicted = unmerged.has(path);
    if (!t) {
      // deleted_entry: a directory standing there keeps what is untracked in it
      // (a submodule's directory is not touched)
      const gitlink = i?.mode === FileMode.GITLINK;
      if (
        worktree &&
        !gitlink &&
        !quiet(path) &&
        (await directoryLosesUntracked(worktree, path, inIndex))
      ) {
        return refusedWith(refuse(`Updating '${path}' would lose untracked files in it`, path));
      }
      if (!conflicted && i && worktree && !quiet(path) && (await notUptodateEntry(i))) {
        return refusedWith(notUptodate(path));
      }
      removing.add(path);
      changes.push(path);
      continue;
    }
    if (!conflicted && sameEntry(i, t)) {
      // reset --hard writes a modified or missing file again (a skip-worktree entry is left
      // alone: oneway_merge)
      if (
        options.hard &&
        i &&
        worktree &&
        !(i as StagingEntry).skipWorktree &&
        (!sparse || sparse.writes(path)) &&
        (await worktreeModified(worktree, path, i, trust, indexTime))
      ) {
        changes.push(path);
      }
      continue;
    }
    if (worktree && !i && !conflicted && !quiet(path)) {
      // a new path: verify_absent
      const refusal = await verifyAbsent(worktree, path, t, checked, removing, {
        hard: options.hard === true,
        tracked: inIndex,
        trust,
        indexTime,
        refuse,
        notUptodate,
      });
      if (refusal) return refusedWith(refusal);
    } else if (worktree && i && !conflicted && !quiet(path) && (await notUptodateEntry(i))) {
      return refusedWith(notUptodate(path));
    }
    changes.push(path);
  }

  // the files written: in a sparse checkout, those of the paths in its patterns only
  const writing = new Set(changes.filter((p) => target.has(p) && (!sparse || sparse.writes(p))));
  if (worktree) {
    if (sparse) {
      // apply_sparse_checkout before check_updates: the files leaving the checkout
      const changed = new Set(changes);
      const unlink = await sparse.leaving(
        worktree,
        (p) => (changed.has(p) ? target.get(p) : (index.get(p) ?? target.get(p))),
        { reset: options.hard === true, trust },
      );
      await sparse.unlink(worktree, unlink);
    }
    for (const path of changes) {
      if (target.has(path) || quiet(path)) continue;
      const entry = await worktree.getEntry(path);
      if (entry && !entry.isDirectory) {
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
      }
    }
    if (writing.size > 0) {
      const plan = await planPathsRestore(ctx, target, targetTree, writing, "reset");
      await writeTreeRestorePlan(worktree, ctx.blobs, plan, "reset", {
        symlinks: trust?.symlinks ?? true,
        gitlinks: true,
        replaceInTheWay: true,
      });
    }
  }
  const edits = new Map<string, IndexEntryOptions[]>();
  for (const path of changes) {
    const t = target.get(path);
    if (!t) {
      edits.set(path, []);
      continue;
    }
    const stats = worktree && writing.has(path) ? await worktree.getEntry(path) : undefined;
    // an unchanged entry rewritten keeps its flags (oneway_merge keeps the old entry); a
    // changed one keeps the skip-worktree bit (merged_entry)
    const old = index.get(path) as StagingEntry | undefined;
    const same = old !== undefined && !unmerged.has(path) && sameEntry(old, t);
    edits.set(path, [
      {
        path,
        objectId: t.objectId,
        mode: t.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
        ...(old?.skipWorktree && !unmerged.has(path) ? { skipWorktree: true } : {}),
        ...(same && old?.assumeValid ? { assumeValid: true } : {}),
        ...(same && old?.intentToAdd ? { intentToAdd: true } : {}),
      },
    ]);
  }
  // unpack-trees writes a new index: no resolve-undo record survives the reset
  ctx.staging.clearResolveUndo?.();
  await rewriteIndex(ctx.staging, edits, { updateCacheTreeWith: ctx.trees });
  return { written: worktree ? writing : new Set() };
}

/**
 * The first step of `am --abort`'s `clean_index`: `read_index_unmerged`, then unpack-trees'
 * `twoway_merge` from HEAD to HEAD with update and `UNPACK_RESET_PROTECT_UNTRACKED`. With
 * the old tree equal to the new one only conflicted entries change: each takes HEAD's
 * version (or leaves the index and the worktree where HEAD has no such path) without the
 * up-to-date check. Every other index entry stays as it is, worktree file and all, and a
 * path missing from the index stays a staged deletion.
 */
export async function resetUnmergedToHead(
  ctx: SequencerContext,
  headId: ObjectId | undefined,
): Promise<void> {
  const unmerged = new Set<string>();
  for await (const entry of ctx.staging.entries()) {
    if (entry.stage !== 0) unmerged.add(entry.path);
  }
  if (unmerged.size === 0) return;
  const headTree = headId ? await ctx.commits.getTree(headId) : undefined;
  const head = headTree ? await flatTree(ctx.trees, headTree) : new Map<string, CheckedEntry>();
  const worktree = ctx.worktree;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const paths = [...unmerged].sort(compareBytes);
  if (worktree) {
    for (const path of paths) {
      if (head.has(path)) continue;
      const entry = await worktree.getEntry(path);
      if (entry && !entry.isDirectory) {
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
      }
    }
    const writing = new Set(paths.filter((p) => head.has(p)));
    if (writing.size > 0 && headTree) {
      const plan = await planPathsRestore(ctx, head, headTree, writing, "reset");
      await writeTreeRestorePlan(worktree, ctx.blobs, plan, "reset", {
        symlinks: trust?.symlinks ?? true,
        gitlinks: true,
        replaceInTheWay: true,
      });
    }
  }
  const edits = new Map<string, IndexEntryOptions[]>();
  for (const path of paths) {
    const h = head.get(path);
    if (!h) {
      edits.set(path, []);
      continue;
    }
    const stats = worktree ? await worktree.getEntry(path) : undefined;
    edits.set(path, [
      {
        path,
        objectId: h.objectId,
        mode: h.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
      },
    ]);
  }
  ctx.staging.clearResolveUndo?.();
  await rewriteIndex(ctx.staging, edits, { updateCacheTreeWith: ctx.trees });
}

/**
 * git's `reset --keep <commit>` of the index and the worktree: unpack-trees' `twoway_merge`
 * from HEAD to the commit with update, then the index reset to the commit (`reset_index`
 * MIXED). Paths HEAD and the commit agree on keep their worktree file, local changes and
 * all (a staged change stays as an unstaged one); a path they differ on takes the commit's
 * version, refused before anything is written where that would lose work: an index entry
 * that is neither HEAD's nor the commit's ("would be overwritten"), a file with unstaged
 * changes (`verify_uptodate`), an untracked file in the way (`verify_absent`). HEAD is not
 * moved. The caller refuses an index with unmerged entries first.
 */
export async function resetKeep(
  ctx: SequencerContext,
  headId: ObjectId,
  targetId: ObjectId,
  label: string,
): Promise<MergeRefusal | undefined> {
  // in a sparse checkout: unpack-trees with its patterns; reset prints its sparse warnings
  // as plain errors (no porcelain messages)
  const sparse = await SparseUnpack.start(ctx);
  const done = await resetKeepWith(ctx, headId, targetId, label, sparse);
  if (done.refused) return done.refused;
  if (sparse) {
    const outcome = await sparse.finish(ctx, { written: done.written });
    pushSparseWarnings(ctx.sparseWarnings, sparse, outcome, false);
  }
  return undefined;
}

async function resetKeepWith(
  ctx: SequencerContext,
  headId: ObjectId,
  targetId: ObjectId,
  label: string,
  sparse: SparseUnpack | undefined,
): Promise<{ refused?: MergeRefusal; written: Set<string> }> {
  const refusedWith = (refused: MergeRefusal) => ({ refused, written: new Set<string>() });
  // a path staying outside the sparse checkout: neither checked nor touched in the worktree
  const quiet = (path: string) => sparse?.leavesAlone(path) === true;
  const head = await flatTree(ctx.trees, await ctx.commits.getTree(headId));
  const targetTree = await ctx.commits.getTree(targetId);
  const target = await flatTree(ctx.trees, targetTree);
  const index = new Map<string, CheckedEntry>();
  for await (const entry of ctx.staging.entries()) {
    if (entry.stage === 0) index.set(entry.path, entry);
  }
  const worktree = ctx.worktree;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const indexTime = ctx.staging.getUpdateTime();
  const refuse = (message: string, path: string): MergeRefusal => ({
    message: `error: ${message}\nfatal: Could not reset index file to revision '${label}'.`,
    paths: [path],
  });
  const notUptodate = (path: string) => refuse(`Entry '${path}' not uptodate. Cannot merge.`, path);
  const changes: string[] = [];
  const removing = new Set<string>();
  const paths = [...new Set([...index.keys(), ...head.keys(), ...target.keys()])].sort(
    compareBytes,
  );
  for (const path of paths) {
    const h = head.get(path);
    const t = target.get(path);
    const i = index.get(path);
    // HEAD and the commit agree: index and worktree stay as they are
    if (sameEntry(h, t)) continue;
    if (!sameEntry(i, h)) {
      // the index has the commit's version already, or a change the reset would lose
      if (sameEntry(i, t)) continue;
      return refusedWith(
        refuse(`Entry '${path}' would be overwritten by merge. Cannot merge.`, path),
      );
    }
    if (worktree && i && !quiet(path)) {
      // verify_uptodate_1: an entry whose flags cheat is checked by its stat
      const e = i as StagingEntry;
      const differs =
        e.assumeValid || e.skipWorktree
          ? await flaggedEntryDiffers(worktree, path, e, trust, indexTime)
          : await worktreeDiffers(worktree, path, i, trust, indexTime);
      if (differs) return refusedWith(notUptodate(path));
    }
    if (!t) {
      removing.add(path);
    } else if (worktree && !i && !quiet(path)) {
      const refusal = await verifyAbsent(worktree, path, t, index, removing, {
        hard: false,
        tracked: (p) => index.has(p),
        trust,
        indexTime,
        refuse,
        notUptodate,
      });
      if (refusal) return refusedWith(refusal);
    }
    changes.push(path);
  }

  // the files written: in a sparse checkout, those of the paths in its patterns only
  const writing = new Set(changes.filter((p) => target.has(p) && (!sparse || sparse.writes(p))));
  if (worktree) {
    if (sparse) {
      // apply_sparse_checkout before check_updates: the files leaving the checkout
      const changed = new Set(changes);
      const unlink = await sparse.leaving(
        worktree,
        (p) => (changed.has(p) || !index.has(p) ? target.get(p) : index.get(p)),
        { trust },
      );
      await sparse.unlink(worktree, unlink);
    }
    for (const path of removing) {
      if (quiet(path)) continue;
      const entry = await worktree.getEntry(path);
      if (entry && !entry.isDirectory) {
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
      }
    }
    if (writing.size > 0) {
      const plan = await planPathsRestore(ctx, target, targetTree, writing, "reset");
      await writeTreeRestorePlan(worktree, ctx.blobs, plan, "reset", {
        symlinks: trust?.symlinks ?? true,
        gitlinks: true,
        replaceInTheWay: true,
      });
    }
  }
  // the index is the commit's tree: an entry that holds it already keeps its stat, a file
  // just written takes the stat it has now
  const written = new Set([...writing]);
  const edits = new Map<string, IndexEntryOptions[]>();
  for (const path of index.keys()) if (!target.has(path)) edits.set(path, []);
  for (const [path, t] of target) {
    if (sameEntry(index.get(path), t) && !written.has(path)) continue;
    const stats = worktree && written.has(path) ? await worktree.getEntry(path) : undefined;
    // merged_entry: the replaced entry's skip-worktree bit migrates over
    const old = index.get(path) as StagingEntry | undefined;
    edits.set(path, [
      {
        path,
        objectId: t.objectId,
        mode: t.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
        ...(old?.skipWorktree ? { skipWorktree: true } : {}),
      },
    ]);
  }
  ctx.staging.clearResolveUndo?.();
  await rewriteIndex(ctx.staging, edits, { updateCacheTreeWith: ctx.trees });
  return { written: worktree ? writing : new Set() };
}

/**
 * git's remove_branch_state (a branch switch, a reset): the merge, cherry-pick or revert
 * stopped before its commit is forgotten (MERGE_HEAD, MERGE_MSG, MERGE_MODE, SQUASH_MSG,
 * CHERRY_PICK_HEAD, REVERT_HEAD, AUTO_MERGE), its MERGE_AUTOSTASH kept on `refs/stash`.
 */
export async function removeBranchState(
  ctx: Pick<SequencerContext, "commits" | "refs">,
  state: OperationState,
): Promise<string[]> {
  if (!state.supported) return [];
  await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD");
  await state.remove("SQUASH_MSG");
  return removeMergeBranchState(ctx, state);
}

/**
 * git's `remove_merge_branch_state` (an "Already up to date." merge, `merge --quit`, and
 * through remove_branch_state a reset or a branch switch): MERGE_HEAD, MERGE_RR, MERGE_MSG,
 * MERGE_MODE and AUTO_MERGE go, a MERGE_AUTOSTASH is kept on `refs/stash`
 * (`save_autostash_ref`). Returns the lines git prints on stderr for a kept autostash.
 */
export async function removeMergeBranchState(
  ctx: Pick<SequencerContext, "commits" | "refs">,
  state: OperationState,
): Promise<string[]> {
  if (!state.supported) return [];
  await state.removeRef("MERGE_HEAD", "AUTO_MERGE");
  await state.remove("MERGE_RR", "MERGE_MSG", "MERGE_MODE");
  const autostash = (await state.read("MERGE_AUTOSTASH"))?.trim();
  if (!autostash) return [];
  await saveAutostash(ctx, autostash);
  await state.remove("MERGE_AUTOSTASH");
  return [...AUTOSTASH_SAVED_LINES];
}

/** What git's `apply_save_autostash_oid` prints when it stores an autostash it does not apply. */
export const AUTOSTASH_SAVED_LINES: readonly string[] = [
  "Autostash exists; creating a new stash entry.",
  "Your changes are safe in the stash.",
  'You can run "git stash pop" or "git stash drop" at any time.',
];

/** Byte order of paths, as git sorts the index. */
function compareBytes(a: string, b: string): number {
  return compareGitPaths(a, b);
}

/** Whether a directory stands at `path` holding untracked content (not a link to one). */
async function directoryLosesUntracked(
  worktree: Worktree,
  path: string,
  tracked: (p: string) => boolean,
): Promise<boolean> {
  const entry = await worktree.getEntry(path);
  if (!entry?.isDirectory) return false;
  return untrackedUnder(worktree, path, tracked);
}

/**
 * unpack-trees' `verify_absent` for a path the reset adds: an untracked (not ignored) file
 * or link on a leading path or at the path itself, or a directory there with tracked files
 * holding local changes or untracked content, refuses the reset.
 */
async function verifyAbsent(
  worktree: Worktree,
  path: string,
  t: CheckedEntry,
  index: Map<string, CheckedEntry>,
  removing: Set<string>,
  options: {
    hard: boolean;
    /** Paths the index tracks, at any stage (unmerged ones are no untracked files) */
    tracked: (path: string) => boolean;
    trust: ReturnType<typeof worktreeModeTrust> | undefined;
    /** The index file's mtime (racy entries are checked by content) */
    indexTime?: number;
    refuse: (message: string, path: string) => MergeRefusal;
    notUptodate: (path: string) => MergeRefusal;
  },
): Promise<MergeRefusal | undefined> {
  const overwritten = (p: string) =>
    options.refuse(`Untracked working tree file '${p}' would be overwritten by merge.`, p);
  // check_leading_path: the first leading component that is no directory
  const parts = path.split("/");
  for (let k = 1; k < parts.length; k++) {
    const prefix = parts.slice(0, k).join("/");
    const entry = await worktree.getEntry(prefix);
    if (!entry) return undefined;
    if (entry.isDirectory) continue;
    if (removing.has(prefix) || (await worktree.isIgnored(prefix))) return undefined;
    return overwritten(prefix);
  }
  const entry = await worktree.getEntry(path);
  if (!entry) return undefined;
  if (entry.isDirectory) {
    // a submodule's directory stays as it is
    if (t.mode === FileMode.GITLINK) return undefined;
    // verify_clean_subdirectory: the tracked files there unchanged (a conflicted one must
    // hold its first stage), nothing untracked
    const under = `${path}/`;
    for (const [p, i] of index) {
      if (!p.startsWith(under)) continue;
      if (
        !options.hard &&
        (await worktreeDiffers(worktree, p, i, options.trust, options.indexTime))
      ) {
        return options.notUptodate(p);
      }
    }
    if (await untrackedUnder(worktree, path, options.tracked)) {
      return options.refuse(`Updating '${path}' would lose untracked files in it`, path);
    }
    return undefined;
  }
  if (await worktree.isIgnored(path)) return undefined;
  return overwritten(path);
}

/**
 * git's autostash (`rebase.autoStash`, `merge.autoStash`): the local changes saved as a
 * stash commit (not on `refs/stash`), the index and worktree reset to HEAD. Undefined when
 * there is nothing to save.
 */
export async function createAutostash(
  ctx: SequencerContext,
  headId: ObjectId,
): Promise<ObjectId | undefined> {
  const id = await new StashCreateCommand(ctx.workingCopy)
    .setRef(null)
    .setMessage("autostash")
    .call();
  if (!id) return undefined;
  await resetMerge(ctx, headId, "HEAD", { hard: true });
  return id;
}

/**
 * Applies an autostash back (`Applied autostash.`); where it conflicts, the stash is kept on
 * `refs/stash` as git keeps it. Returns git's lines.
 */
export async function applyAutostash(ctx: SequencerContext, id: ObjectId): Promise<string[]> {
  try {
    const result = await new StashApplyCommand(ctx.workingCopy).setStashRef(id).call();
    if (result.status === StashApplyStatus.OK) return ["Applied autostash."];
  } catch {
    // refused: kept in the stash below
  }
  await saveAutostash(ctx, id);
  return [
    "Applying autostash resulted in conflicts.",
    "Your changes are safe in the stash.",
    'You can run "git stash pop" or "git stash drop" at any time.',
  ];
}

/** An autostash kept on `refs/stash` (git's `save_autostash`), for `git stash pop` later. */
export async function saveAutostash(
  ctx: Pick<SequencerContext, "commits" | "refs">,
  id: ObjectId,
): Promise<void> {
  const commit = await ctx.commits.load(id);
  await ctx.refs.batch([{ name: STASH_REF, new: id }], {
    ident: commit ? formatPersonIdent(commit.committer) : undefined,
    message: "autostash",
    createReflog: true,
  });
}

/**
 * git's commit message cleanup (`strip`, as `git commit` applies it to an edited message):
 * comment lines dropped, trailing whitespace removed, runs of blank lines collapsed, blank
 * lines at the start and end dropped, a final newline.
 */
export function cleanupMessage(message: string, commentChar = "#"): string {
  return stripspace(message, commentChar);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** git's default date format (`Tue Nov 14 22:13:20 2023 +0000`), in the ident's zone. */
export function formatGitDate(ident: PersonIdent): string {
  const tz = ident.tzOffset || "+0000";
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((ident.timestamp + minutes * 60) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()} ${tz}`;
}

/**
 * git's `SQUASH_MSG`: `Squashed commit of the following:` and the commits `src` has that
 * `head` has not, newest first, as `git log` prints them. Several heads (an octopus) list
 * what any of them has. `abbreviate` shortens the parents of `Merge:` lines.
 */
export async function squashMessage(
  commits: CommandCommits,
  headId: ObjectId,
  srcId: ObjectId | ObjectId[],
  abbreviate: (id: ObjectId) => Promise<string>,
): Promise<string> {
  const reachable = new Set<ObjectId>();
  const stack = [headId];
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const commit = await commits.load(id);
    if (commit) stack.push(...commit.parents);
  }
  const listed: { id: ObjectId; time: number; order: number }[] = [];
  const seen = new Set<ObjectId>();
  const queue = Array.isArray(srcId) ? [...srcId] : [srcId];
  while (queue.length > 0) {
    const id = queue.shift() as ObjectId;
    if (seen.has(id) || reachable.has(id)) continue;
    seen.add(id);
    const commit = await commits.load(id);
    if (!commit) continue;
    listed.push({ id, time: commit.committer.timestamp, order: listed.length });
    queue.push(...commit.parents);
  }
  listed.sort((a, b) => b.time - a.time || a.order - b.order);
  let out = "Squashed commit of the following:\n";
  for (const { id } of listed) {
    const commit = await commits.load(id);
    if (!commit) continue;
    out += `\ncommit ${id}\n`;
    if (commit.parents.length > 1) {
      // pp_header: each parent through repo_find_unique_abbrev (DEFAULT_ABBREV)
      const parents: string[] = [];
      for (const p of commit.parents) parents.push(await abbreviate(p));
      out += `Merge: ${parents.join(" ")}\n`;
    }
    out += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    out += `Date:   ${formatGitDate(commit.author)}\n\n`;
    const body = commit.message.replace(/\n+$/, "");
    out += `${body
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}\n`;
  }
  return out;
}
