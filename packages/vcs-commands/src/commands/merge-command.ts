import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { DEFAULT_BIG_FILE_THRESHOLD, FileMode, isSymbolicRef } from "@statewalker/vcs-core";
import {
  attributesIndexOf,
  type ContentAttributesContext,
  entryStatOf,
  type IndexEntryOptions,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { InvalidArgumentError } from "../errors/command-errors.js";
import {
  InvalidMergeHeadsError,
  MergeFailureReason,
  NoMergeBaseError,
  NotFastForwardError,
} from "../errors/merge-errors.js";
import { NoHeadError, RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import {
  ContentMergeStrategy,
  FastForwardMode,
  type MergeResult,
  MergeStatus,
  MergeStrategy,
} from "../results/merge-result.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { configBool, conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
  abbrev,
  conflictsComment,
  defaultIdent,
  flatTree,
  indexChanges,
  OperationState,
  readIndex,
  rewriteIndex,
  storeFlatTree,
  switchTrees,
} from "./merge-support.js";
import { octopusMerge } from "./octopus-merge.js";
import { ortMerge, ortResultEntries } from "./ort-merge.js";
import { mergeBaseTree } from "./ort-recursive.js";
import {
  applyAutostash,
  cleanupMessage,
  createAutostash,
  resetMerge,
  saveAutostash,
  squashMessage,
} from "./sequencer-support.js";
import { WorkingCopyStashProvider } from "./stash-working-tree.js";
import { pruneEmptyParents } from "./worktree-overwrite-checks.js";

/** What `git merge` is asked to do. */
export enum MergeOperation {
  /** Merge the included commit (`git merge <commit>`) */
  MERGE = "merge",
  /** Give up the merge in progress (`git merge --abort`) */
  ABORT = "abort",
  /** Commit the resolved merge in progress (`git merge --continue`) */
  CONTINUE = "continue",
}

/** git's refusal while the index has unmerged entries. */
export const UNMERGED_FILES_MESSAGE = (action: "Merging" | "Committing") =>
  [
    `error: ${action} is not possible because you have unmerged files.`,
    "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
    "hint: as appropriate to mark resolution and make a commit.",
    "fatal: Exiting because of an unresolved conflict.",
  ].join("\n");

/**
 * Merge branches.
 *
 * Equivalent to `git merge`: a fast-forward, or git's merge-ort, written to the index and
 * the working tree as git writes them. Before anything is written the merge is refused, with
 * git's messages, where it would overwrite local changes or untracked files (or the index
 * holds staged changes, or unmerged entries, or a merge is already in progress). A merge
 * with conflicts leaves the files with git's conflict markers (`merge.conflictStyle`), the
 * conflicts staged at stages 1-3, and git's state (`MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`,
 * `ORIG_HEAD`, `AUTO_MERGE`), so native git can `--continue` or `--abort` it and the other
 * way round (`setOperation`).
 *
 * The result's `output` holds what git prints (`Auto-merging f`, `CONFLICT (...)`, ...)
 * without the diffstat; a refused merge has status FAILED and git's error in `message`.
 *
 * @example
 * ```typescript
 * const result = await git.merge().include("feature-branch").call();
 * if (result.status === MergeStatus.CONFLICTING) {
 *   // resolve, `git add`, then
 *   await git.merge().setOperation(MergeOperation.CONTINUE).call();
 * }
 *
 * // Force merge commit (no fast-forward)
 * await git.merge().include("feature").setFastForwardMode(FastForwardMode.NO_FF).call();
 * ```
 */
export class MergeCommand extends GitCommand<MergeResult> {
  private includes: string[] = [];
  private fastForwardMode = FastForwardMode.FF;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private squash = false;
  private commit = true;
  private message?: string;
  private bigFileThreshold = DEFAULT_BIG_FILE_THRESHOLD;
  private operation = MergeOperation.MERGE;
  private author?: PersonIdent;
  private committer?: PersonIdent;
  private autoStash?: boolean;
  private renormalize?: boolean;

  /**
   * Add a commit/branch to merge.
   *
   * @param refOrId Commit ID, branch name, or tag name to merge
   */
  include(refOrId: string): this {
    this.checkCallable();
    this.includes.push(refOrId);
    return this;
  }

  /**
   * Set fast-forward mode.
   *
   * - FF (default): Fast-forward when possible
   * - NO_FF: Always create merge commit
   * - FF_ONLY: Abort if fast-forward not possible
   *
   * @param mode Fast-forward mode
   */
  setFastForwardMode(mode: FastForwardMode): this {
    this.checkCallable();
    this.fastForwardMode = mode;
    return this;
  }

  /**
   * Set merge strategy.
   *
   * - RECURSIVE (default): git's merge-ort
   * - OURS: Keep our tree, ignore their changes (creates merge commit)
   * - THEIRS: Replace our tree with theirs (creates merge commit)
   * - RESOLVE: as RECURSIVE
   *
   * @param strategy Merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Set content merge strategy for handling file-level conflicts (git's `-X ours`,
   * `-X theirs`, `merge=union`): conflicting hunks are resolved to that side instead of
   * producing conflict markers.
   *
   * @param contentStrategy Content merge strategy
   */
  setContentMergeStrategy(contentStrategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = contentStrategy;
    return this;
  }

  /**
   * Set the size above which files are binary to the content merge (git's
   * `core.bigFileThreshold`, default 50 MiB).
   *
   * A binary file (over the threshold, or a NUL byte in its first 8000 bytes) is
   * never content-merged: as git does, OURS and THEIRS take that side's file whole, and
   * otherwise ours stays with a conflict.
   *
   * @param threshold Size in bytes
   */
  setBigFileThreshold(threshold: number): this {
    this.checkCallable();
    this.bigFileThreshold = threshold;
    return this;
  }

  /**
   * Set squash mode (`git merge --squash`): the merge's result is written to the index and
   * the worktree with `SQUASH_MSG`, and HEAD is not updated.
   *
   * @param squash Whether to squash
   */
  setSquash(squash: boolean): this {
    this.checkCallable();
    this.squash = squash;
    return this;
  }

  /**
   * Set whether to commit after merge (`--no-commit` when false: the merge stops before
   * committing, with `MERGE_HEAD` and `MERGE_MSG` written for a later commit).
   *
   * @param commit Whether to commit (default: true)
   */
  setCommit(commit: boolean): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  /**
   * Set the merge commit message (default git's: `Merge branch 'feature'`).
   *
   * @param message Commit message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * Merge (default), or `--abort` / `--continue` the merge in progress.
   *
   * @param operation What to do
   */
  setOperation(operation: MergeOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /**
   * Merge content as if checked out and checked in afresh (`-X renormalize`,
   * `-X no-renormalize`; default `merge.renormalize`, false): a side whose change is only a
   * change of line endings or filters does not conflict.
   */
  setRenormalize(renormalize: boolean): this {
    this.checkCallable();
    this.renormalize = renormalize;
    return this;
  }

  /**
   * Stash local changes away before the merge and apply them after it (`--autostash`;
   * default `merge.autoStash`, false). A merge that stops (conflicts, `--no-commit`) keeps
   * them in MERGE_AUTOSTASH until it is continued or aborted.
   */
  setAutoStash(autoStash: boolean): this {
    this.checkCallable();
    this.autoStash = autoStash;
    return this;
  }

  /** The author of the merge commit (default: the committer, else `Unknown`). */
  setAuthor(author: PersonIdent): this {
    this.checkCallable();
    this.author = author;
    return this;
  }

  /** The committer of the merge commit (default: the author, else `Unknown`). */
  setCommitter(committer: PersonIdent): this {
    this.checkCallable();
    this.committer = committer;
    return this;
  }

  /**
   * Execute the merge.
   *
   * @returns MergeResult with status and details
   */
  async call(): Promise<MergeResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktree = this.worktreeAccess;
    const run = () => this.run(worktree);
    return worktree?.batch ? worktree.batch(run) : run();
  }

  private async run(worktree: Worktree | undefined): Promise<MergeResult> {
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    if (this.operation === MergeOperation.ABORT) return this.abort(state, worktree);
    if (this.operation === MergeOperation.CONTINUE) return this.continueMerge(state);

    // Validate parameters
    if (this.includes.length === 0) {
      throw new InvalidMergeHeadsError("No merge head specified");
    }

    // git refuses on an index with unmerged entries, and while a merge is in progress
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length > 0) return failed(UNMERGED_FILES_MESSAGE("Merging"), unmerged);
    if ((await this.mergeHeads(state)).length > 0) {
      return failed(
        "fatal: You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.",
      );
    }
    if (await state.ref("CHERRY_PICK_HEAD")) {
      return failed(
        "fatal: You have not concluded your cherry-pick (CHERRY_PICK_HEAD exists).\nPlease, commit your changes before you merge.",
      );
    }

    // Get HEAD
    const head = await this.refsStore.get("HEAD");
    if (!head) {
      throw new NoHeadError("Cannot merge without HEAD");
    }
    const headResolved = await this.refsStore.resolve("HEAD");
    if (!headResolved?.objectId) {
      throw new NoHeadError("HEAD does not point to a commit");
    }
    const headId = headResolved.objectId;

    // Resolve merge source
    let srcRef = this.includes[0];
    let srcId = await this.resolveRef(srcRef);
    if (this.includes.length > 1) {
      // several heads: the independent ones besides HEAD (git's reduce_heads); two or more
      // are an octopus, one a merge of that head
      const named: { id: ObjectId; name: string }[] = [];
      for (const name of this.includes) named.push({ id: await this.resolveRef(name), name });
      const candidates = [{ id: headId, name: "HEAD" }, ...named].filter(
        (c, k, all) => all.findIndex((x) => x.id === c.id) === k,
      );
      const independent: { id: ObjectId; name: string }[] = [];
      for (const c of candidates) {
        let reachable = false;
        for (const other of candidates) {
          if (other.id !== c.id && (await this.isAncestor(c.id, other.id))) reachable = true;
        }
        if (!reachable) independent.push(c);
      }
      const headSubsumed = !independent.some((c) => c.id === headId);
      const remotes = independent.filter((c) => c.id !== headId);
      // the message names the heads left (fmt-merge-msg of the reduced heads)
      const message = this.message ?? (await this.octopusMessage(remotes));
      if (remotes.length === 0) {
        await state.setRef("ORIG_HEAD", headId);
        return {
          status: MergeStatus.ALREADY_UP_TO_DATE,
          newHead: headId,
          mergedCommits: named.map((n) => n.id),
          output: ["Already up to date."],
        };
      }
      if (remotes.length > 1) {
        return this.doOctopus(headId, head, remotes, headSubsumed, message, state, worktree);
      }
      srcRef = remotes[0].name;
      srcId = remotes[0].id;
    }

    // git records where HEAD was before every merge
    await state.setRef("ORIG_HEAD", headId);

    // Check if already up to date (src is ancestor of HEAD)
    if (await this.isAncestor(srcId, headId)) {
      return {
        status: MergeStatus.ALREADY_UP_TO_DATE,
        newHead: headId,
        mergedCommits: [srcId],
        output: [this.squash ? "Already up to date. (nothing to squash)" : "Already up to date."],
      };
    }

    // Check if fast-forward is possible (HEAD is ancestor of src)
    const canFastForward = await this.isAncestor(headId, srcId);
    const fastForward = canFastForward && this.fastForwardMode !== FastForwardMode.NO_FF;
    if (!fastForward && this.fastForwardMode === FastForwardMode.FF_ONLY) {
      throw new NotFastForwardError("fatal: Not possible to fast-forward, aborting.");
    }

    // git refuses unrelated histories before anything is stashed or written
    const mergeBases = fastForward ? [] : await this.commits.findMergeBase(headId, srcId);
    if (!fastForward && mergeBases.length === 0) throw new NoMergeBaseError([headId, srcId]);

    // merge.autoStash: local changes stashed away, applied again once the merge is done
    const created: string[] = [];
    if (worktree && (this.autoStash ?? configBool(this.workingCopy, "merge.autoStash", false))) {
      if (!state.supported) {
        // the stash could be kept nowhere: refused rather than stranded
        throw new InvalidArgumentError(
          "autoStash",
          true,
          "merge --autostash needs a checkout that keeps state files (MERGE_AUTOSTASH)",
        );
      }
      const autostash = await createAutostash(this.context(worktree), headId);
      if (autostash) {
        await state.write("MERGE_AUTOSTASH", `${autostash}\n`);
        created.push(`Created autostash: ${abbrev(autostash)}`);
      }
    }
    let result: MergeResult;
    try {
      result = fastForward
        ? await this.doFastForward(headId, srcId, head, state, worktree)
        : await this.doMerge(headId, srcId, srcRef, head, state, worktree, mergeBases);
    } catch (error) {
      // nothing is stranded in the autostash: applied back as git's apply_autostash
      await this.popAutostash(state, worktree).catch(() => undefined);
      throw error;
    }
    const output = [...created, ...(result.output ?? [])];
    // a merge stopped for the user (conflicts, --no-commit) keeps the autostash for later
    if (
      result.status !== MergeStatus.CONFLICTING &&
      result.status !== MergeStatus.MERGED_NOT_COMMITTED
    ) {
      const applied = await this.popAutostash(state, worktree);
      output.push(...applied);
      // a merge that moved HEAD ends with git's remove_merge_branch_state, after the
      // autostash was applied (whose own merge recorded AUTO_MERGE)
      if (
        applied.length > 0 &&
        (result.status === MergeStatus.MERGED || result.status === MergeStatus.FAST_FORWARD)
      ) {
        await state.removeRef("AUTO_MERGE");
      }
    }
    return { ...result, output };
  }

  /** Applies MERGE_AUTOSTASH back, if there is one. */
  private async popAutostash(
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<string[]> {
    const id = (await state.read("MERGE_AUTOSTASH"))?.trim();
    if (!id) return [];
    await state.remove("MERGE_AUTOSTASH");
    return applyAutostash(this.context(worktree), id);
  }

  /**
   * Perform a fast-forward merge (git's checkout_fast_forward: a two-way switch).
   */
  private async doFastForward(
    headId: ObjectId,
    srcId: ObjectId,
    head: Awaited<ReturnType<typeof this.refsStore.get>>,
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<MergeResult> {
    const output = [`Updating ${abbrev(headId)}..${abbrev(srcId)}`];
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const srcTree = await flatTree(this.trees, await this.commits.getTree(srcId));
    const refused = await switchTrees(this.context(worktree), headTree, srcTree, {
      action: "merge",
      operation: "merge",
    });
    if (refused) {
      return {
        status: MergeStatus.FAILED,
        newHead: headId,
        mergedCommits: [headId, srcId],
        message: refused.message,
        failingPaths: failing(refused.paths),
        output,
      };
    }
    output.push("Fast-forward");
    if (this.squash) {
      await state.write("SQUASH_MSG", await squashMessage(this.commits, headId, srcId));
      output.push("Squash commit -- not updating HEAD");
      return {
        status: MergeStatus.FAST_FORWARD_SQUASHED,
        newHead: headId,
        mergedCommits: [headId, srcId],
        message: "Squashed commit of merged changes",
        output,
      };
    }
    await this.updateHead(head, srcId);
    return {
      status: MergeStatus.FAST_FORWARD,
      newHead: srcId,
      mergedCommits: [headId, srcId],
      output,
    };
  }

  /**
   * Perform a three-way merge (git's merge-ort).
   */
  private async doMerge(
    headId: ObjectId,
    srcId: ObjectId,
    srcName: string,
    head: Awaited<ReturnType<typeof this.refsStore.get>>,
    state: OperationState,
    worktree: Worktree | undefined,
    mergeBases: ObjectId[],
  ): Promise<MergeResult> {
    if (mergeBases.length === 0) {
      throw new NoMergeBaseError([headId, srcId]);
    }
    const baseId = mergeBases[0];
    const headCommit = await this.commits.load(headId);
    const srcCommit = await this.commits.load(srcId);
    if (!headCommit || !srcCommit) {
      throw new RefNotFoundError(headId, "Failed to load commits for merge");
    }
    const headTree = await flatTree(this.trees, headCommit.tree);
    const { index } = await readIndex(this.staging);

    const mergeName = await this.describeMergeSource(srcName, srcId);
    const output: string[] = [];
    let target: Map<string, { objectId: ObjectId; mode: number }>;
    let merge: Awaited<ReturnType<typeof ortMerge>> | undefined;
    if (this.strategy === MergeStrategy.OURS) {
      target = headTree;
    } else if (this.strategy === MergeStrategy.THEIRS) {
      target = await flatTree(this.trees, srcCommit.tree);
    } else {
      const common = {
        style: conflictStyleOf(this.workingCopy),
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
        bigFileThreshold: this.bigFileThreshold,
        ...ortConfigOptions(this.workingCopy, worktree, { renormalize: this.renormalize }),
      };
      // several merge bases: merge-ort's virtual merge base, built in memory
      const base = await mergeBaseTree(
        { commits: this.commits, trees: this.trees, blobs: this.blobs },
        headId,
        srcId,
        mergeBases,
        common,
      );
      merge = await ortMerge(
        this.blobs,
        base.tree,
        headTree,
        await flatTree(this.trees, srcCommit.tree),
        {
          ...common,
          oursLabel: "HEAD",
          theirsLabel: srcName,
          baseLabel: base.label,
          favor: favorOf(this.contentStrategy),
        },
      );
      target = await ortResultEntries(this.blobs, merge);
    }
    const treeId = await storeFlatTree(this.trees, target);
    // merge-ort records its result tree (AUTO_MERGE) whether or not it can be written
    if (merge) await state.setRef("AUTO_MERGE", treeId);

    // merge-ort's sanity check: the index must match HEAD (merge-ort-wrappers' unclean())
    const staged = indexChanges(index, headTree);
    if (staged.length > 0) {
      await this.restoreStateQuirk(state, headCommit.tree, worktree);
      return {
        status: MergeStatus.FAILED,
        newHead: headId,
        mergeBase: baseId,
        mergedCommits: [headId, srcId],
        message: `error: Your local changes to the following files would be overwritten by merge:\n  ${staged.join(" ")}\nMerge with strategy ort failed.`,
        failingPaths: new Map(staged.map((p) => [p, MergeFailureReason.DIRTY_INDEX])),
      };
    }

    const conflicts = merge ? [...merge.conflicts.values()] : [];
    const refused = await switchTrees(this.context(worktree), headTree, target, {
      action: "merge",
      operation: "merge",
      conflicts,
    });
    if (refused) {
      await this.restoreStateQuirk(state, headCommit.tree, worktree);
      return {
        status: MergeStatus.FAILED,
        newHead: headId,
        mergeBase: baseId,
        mergedCommits: [headId, srcId],
        message: `${refused.message}\nMerge with strategy ort failed.`,
        failingPaths: failing(refused.paths),
      };
    }
    output.push(...(merge?.messages ?? []));
    // a message given is the commit's as it is; git's default ends with a newline
    const message = this.message ?? (await this.defaultMessage(mergeName));

    if (conflicts.length > 0 || merge?.clean === false) {
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort();
      if (this.squash) {
        await state.write("SQUASH_MSG", await squashMessage(this.commits, headId, srcId));
        await state.write("MERGE_MSG", conflictsComment(paths, true));
        output.push("Squash commit -- not updating HEAD");
      } else {
        const text = message.endsWith("\n") ? message : `${message}\n`;
        await this.writeMergeState(state, srcId, `${text}${conflictsComment(paths, true)}`);
      }
      output.push("Automatic merge failed; fix conflicts and then commit the result.");
      return {
        status: MergeStatus.CONFLICTING,
        mergeBase: baseId,
        mergedCommits: [headId, srcId],
        conflicts: paths,
        output,
      };
    }
    if (this.squash) {
      await state.write("SQUASH_MSG", await squashMessage(this.commits, headId, srcId));
      output.push(
        "Squash commit -- not updating HEAD",
        "Automatic merge went well; stopped before committing as requested",
      );
      return {
        status: MergeStatus.MERGED_SQUASHED,
        newHead: headId,
        mergeBase: baseId,
        mergedCommits: [headId, srcId],
        output,
      };
    }
    if (!this.commit) {
      await this.writeMergeState(state, srcId, message);
      output.push("Automatic merge went well; stopped before committing as requested");
      return {
        status: MergeStatus.MERGED_NOT_COMMITTED,
        newHead: headId,
        mergeBase: baseId,
        mergedCommits: [headId, srcId],
        output,
      };
    }

    const newCommitId = await this.storeCommit(treeId, [headId, srcId], message);
    await this.updateHead(head, newCommitId);
    // the commit ends the merge: git's remove_merge_branch_state
    await state.removeRef("AUTO_MERGE");
    output.push(`Merge made by the '${this.strategyName()}' strategy.`);
    return {
      status: MergeStatus.MERGED,
      newHead: newCommitId,
      mergeBase: baseId,
      mergedCommits: [headId, srcId],
      output,
    };
  }

  /**
   * An octopus (git-merge-octopus): the heads merged one after the other; written when it
   * merged or left conflicts with the last head, nothing written when it gave up.
   */
  private async doOctopus(
    headId: ObjectId,
    head: Awaited<ReturnType<typeof this.refsStore.get>>,
    remotes: { id: ObjectId; name: string }[],
    headSubsumed: boolean,
    message: string,
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<MergeResult> {
    await state.setRef("ORIG_HEAD", headId);
    const mergedCommits = [headId, ...remotes.map((r) => r.id)];
    if (this.fastForwardMode === FastForwardMode.FF_ONLY) {
      throw new NotFastForwardError("fatal: Not possible to fast-forward, aborting.");
    }
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const { index } = await readIndex(this.staging);
    const outcome = await octopusMerge(
      {
        commits: this.commits,
        trees: this.trees,
        blobs: this.blobs,
        style: conflictStyleOf(this.workingCopy),
      },
      headId,
      remotes,
      indexChanges(index, headTree),
    );
    const output = [...outcome.output];
    // git restores the state it saved (reset --hard, stash apply): AUTO_MERGE as for ort
    const giveUp = async (lines: string[]): Promise<MergeResult> => {
      const tree = (await this.commits.getTree(headId)) as ObjectId;
      await this.restoreStateQuirk(state, tree, worktree);
      return {
        status: MergeStatus.FAILED,
        newHead: headId,
        mergedCommits,
        message: [...lines, "Merge with strategy octopus failed."].join("\n"),
        output,
      };
    };
    if (outcome.status === 2) return giveUp(outcome.errors);
    const target = new Map(outcome.index);
    for (const [path, entry] of outcome.worktree) target.set(path, entry);
    const refused = await switchTrees(this.context(worktree), headTree, target, {
      action: "merge",
      operation: "merge",
      conflicts: outcome.conflicts,
    });
    if (refused) return giveUp([refused.message]);
    const writeState = async (text: string) => {
      await state.write("MERGE_HEAD", remotes.map((r) => `${r.id}\n`).join(""));
      await state.write("MERGE_MSG", text);
      await state.write(
        "MERGE_MODE",
        this.fastForwardMode === FastForwardMode.NO_FF ? "no-ff" : "",
      );
    };
    if (outcome.status === 1) {
      const paths = [...new Set(outcome.conflicts.map((c) => c.stagePath))].sort();
      await writeState(`${message}${conflictsComment(paths, true)}`);
      output.push("Automatic merge failed; fix conflicts and then commit the result.");
      return {
        status: MergeStatus.CONFLICTING,
        mergedCommits,
        conflicts: paths,
        output,
      };
    }
    if (!this.commit) {
      await writeState(message);
      output.push("Automatic merge went well; stopped before committing as requested");
      return { status: MergeStatus.MERGED_NOT_COMMITTED, newHead: headId, mergedCommits, output };
    }
    const treeId = await storeFlatTree(this.trees, outcome.index);
    const parents = [...(headSubsumed ? [] : [headId]), ...remotes.map((r) => r.id)];
    const newCommitId = await this.storeCommit(treeId, parents, message);
    await this.updateHead(head, newCommitId);
    output.push("Merge made by the 'octopus' strategy.");
    return { status: MergeStatus.MERGED, newHead: newCommitId, mergedCommits, output };
  }

  /** git's fmt-merge-msg title for several heads: `Merge branches 'a', 'b' and tag 'v1'`. */
  private async octopusMessage(heads: { id: ObjectId; name: string }[]): Promise<string> {
    const groups = new Map<string, string[]>();
    for (const { id, name } of heads) {
      const described = await this.describeMergeSource(name, id);
      const k = described.indexOf(" '");
      const kind = described.slice(0, k);
      const list = groups.get(kind) ?? [];
      list.push(described.slice(k + 1));
      groups.set(kind, list);
    }
    const plural: Record<string, string> = {
      branch: "branches",
      "remote-tracking branch": "remote-tracking branches",
      tag: "tags",
      commit: "commits",
    };
    const parts: string[] = [];
    for (const kind of ["branch", "remote-tracking branch", "tag", "commit"]) {
      const list = groups.get(kind);
      if (!list) continue;
      const joined =
        list.length === 1
          ? list[0]
          : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
      parts.push(`${list.length === 1 ? kind : plural[kind]} ${joined}`);
    }
    const branch = await this.getCurrentBranch();
    const short = branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : "HEAD";
    const into = short === "main" || short === "master" ? "" : ` into ${short}`;
    return `Merge ${parts.join(", ")}${into}\n`;
  }

  /** The heads MERGE_HEAD names (one per line: several for an octopus). */
  private async mergeHeads(state: OperationState): Promise<ObjectId[]> {
    const text = await state.read("MERGE_HEAD");
    const lines = (text ?? "").split("\n").filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    if (lines.length > 0) return lines;
    const single = await state.ref("MERGE_HEAD");
    return single ? [single] : [];
  }

  /** `git merge --continue`: commits the resolved merge with MERGE_MSG. */
  private async continueMerge(state: OperationState): Promise<MergeResult> {
    const heads = await this.mergeHeads(state);
    const mergeHead = heads[0];
    if (!mergeHead) {
      return failed("fatal: There is no merge in progress (MERGE_HEAD missing).");
    }
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length > 0) {
      return failed(UNMERGED_FILES_MESSAGE("Committing"), unmerged);
    }
    const headId = await this.resolveHead();
    const head = await this.refsStore.get("HEAD");
    const treeId = await this.staging.writeTree(this.trees);
    const message = cleanupMessage(
      this.message ?? (await state.read("MERGE_MSG")) ?? `Merge commit '${mergeHead}'\n`,
    );
    const newCommitId = await this.storeCommit(treeId, [headId, ...heads], message);
    await this.updateHead(head, newCommitId);
    await state.removeRef("MERGE_HEAD", "AUTO_MERGE");
    await state.remove("MERGE_MSG", "MERGE_MODE", "SQUASH_MSG");
    return {
      status: MergeStatus.MERGED,
      newHead: newCommitId,
      mergedCommits: [headId, ...heads],
      output: await this.popAutostash(state, this.worktreeAccess),
    };
  }

  /** `git merge --abort`: `git reset --merge`, the merge's state removed. */
  private async abort(state: OperationState, worktree: Worktree | undefined): Promise<MergeResult> {
    const mergeHead = (await this.mergeHeads(state))[0];
    if (!mergeHead) {
      return failed("fatal: There is no merge to abort (MERGE_HEAD missing).");
    }
    const headId = await this.resolveHead();
    const refused = await resetMerge(this.context(worktree), headId, "HEAD");
    if (refused) {
      // git has taken MERGE_AUTOSTASH away by now (and dies in the reset): ours is kept on
      // refs/stash rather than lost
      const autostash = (await state.read("MERGE_AUTOSTASH"))?.trim();
      if (autostash) {
        await state.remove("MERGE_AUTOSTASH");
        await saveAutostash(this.context(worktree), autostash);
      }
      return failed(refused.message, refused.paths);
    }
    await state.setRef("ORIG_HEAD", headId);
    await state.removeRef("MERGE_HEAD", "AUTO_MERGE");
    await state.remove("MERGE_MSG", "MERGE_MODE", "SQUASH_MSG");
    return {
      status: MergeStatus.ABORTED,
      newHead: headId,
      mergedCommits: [mergeHead],
      output: await this.popAutostash(state, worktree),
    };
  }

  /**
   * A failed strategy leaves AUTO_MERGE as git leaves it: git's merge restores the local
   * changes it saved (`restore_state`, a stash of them applied by merge-ort), so AUTO_MERGE
   * ends up the tree of the index and the tracked files' worktree content, and is absent
   * when there was nothing to save.
   */
  private async restoreStateQuirk(
    state: OperationState,
    headTree: ObjectId,
    worktree: Worktree | undefined,
  ): Promise<void> {
    await state.removeRef("AUTO_MERGE");
    if (!worktree) return;
    const provider = new WorkingCopyStashProvider({
      workingCopy: this.workingCopy,
      trees: this.trees,
      blobs: this.blobs,
      staging: this.staging,
      worktree,
      headTree: async () => headTree,
    });
    if (!(await provider.hasLocalChanges())) return;
    const savedTree = await provider.getWorkingTree();
    await state.setRef("AUTO_MERGE", savedTree);
    // restore_state's `reset --hard` and `stash apply --index`: every changed file is
    // written again from what was saved, through the checkout filters (eol, smudge)
    const saved = await flatTree(this.trees, savedTree);
    const head = await flatTree(this.trees, headTree);
    const { index } = await readIndex(this.staging);
    const attributes: ContentAttributesContext = {
      direction: "checkout",
      index: attributesIndexOf([...index].map(([p, e]) => [p, e.objectId] as const)),
    };
    const symlinks = worktreeModeTrust(this.workingCopy, worktree).symlinks;
    const restaged = new Map<string, IndexEntryOptions[]>();
    for (const [path, entry] of saved) {
      const before = head.get(path);
      if (before?.objectId === entry.objectId && before.mode === entry.mode) continue;
      if (entry.mode === FileMode.GITLINK) continue;
      const content = await this.blobs.load(entry.objectId);
      if (!content) continue;
      const mode =
        entry.mode === FileMode.SYMLINK && !symlinks ? FileMode.REGULAR_FILE : entry.mode;
      await worktree.writeContent(path, content, {
        mode,
        ...(mode !== entry.mode ? { raw: true } : {}),
        createParents: true,
        replaceInTheWay: true,
        attributes,
      });
      // `stash apply --index` stages again what was staged: the index entry takes the stat
      // of the file just written where the file holds its blob
      const staged = index.get(path);
      const stats = await worktree.getEntry(path);
      if (staged && stats && !stats.isDirectory) {
        if ((await worktree.computeHash(path)) === staged.objectId) {
          restaged.set(path, [
            { path, objectId: staged.objectId, mode: staged.mode, ...entryStatOf(stats) },
          ]);
        }
      }
    }
    // the reset --hard wrote a new index: no resolve-undo left
    this.staging.clearResolveUndo?.();
    await rewriteIndex(this.staging, restaged);
    // a file deleted in what was saved: `reset --hard` wrote it, `stash apply` removed it
    // again with the directories it leaves empty
    for (const path of head.keys()) {
      if (saved.has(path) || (await worktree.getEntry(path))) continue;
      await pruneEmptyParents(worktree, path);
    }
  }

  private context(worktree: Worktree | undefined) {
    return {
      workingCopy: this.workingCopy,
      worktree,
      staging: this.staging,
      blobs: this.blobs,
      trees: this.trees,
      commits: this.commits,
      refs: this.refsStore,
    };
  }

  /** MERGE_HEAD, MERGE_MSG and MERGE_MODE of a merge stopped before its commit. */
  private async writeMergeState(
    state: OperationState,
    srcId: ObjectId,
    message: string,
  ): Promise<void> {
    await state.setRef("MERGE_HEAD", srcId);
    await state.write("MERGE_MSG", message);
    await state.write("MERGE_MODE", this.fastForwardMode === FastForwardMode.NO_FF ? "no-ff" : "");
  }

  private strategyName(): string {
    switch (this.strategy) {
      case MergeStrategy.OURS:
        return "ours";
      case MergeStrategy.THEIRS:
        return "theirs";
      default:
        return "ort";
    }
  }

  private async storeCommit(tree: ObjectId, parents: ObjectId[], message: string) {
    const author = this.author ?? this.committer ?? defaultIdent();
    const committer = this.committer ?? author;
    const commit: Commit = { tree, parents, author, committer, message };
    return this.commits.store(commit);
  }

  private async updateHead(
    head: Awaited<ReturnType<typeof this.refsStore.get>>,
    id: ObjectId,
  ): Promise<void> {
    if (head && isSymbolicRef(head)) await this.refsStore.set(head.target, id);
    else await this.refsStore.set("HEAD", id);
  }

  /** How git's merge message names what is merged: `branch 'x'`, `tag 'v1'`, ... */
  private async describeMergeSource(name: string, id: ObjectId): Promise<string> {
    const strip = (prefix: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);
    if (name.startsWith("refs/heads/")) return `branch '${strip("refs/heads/")}'`;
    if (name.startsWith("refs/remotes/"))
      return `remote-tracking branch '${strip("refs/remotes/")}'`;
    if (name.startsWith("refs/tags/")) return `tag '${strip("refs/tags/")}'`;
    if (await this.refsStore.has(`refs/heads/${name}`)) return `branch '${name}'`;
    if (await this.refsStore.has(`refs/tags/${name}`)) return `tag '${name}'`;
    if (await this.refsStore.has(`refs/remotes/${name}`)) return `remote-tracking branch '${name}'`;
    return `commit '${name || id}'`;
  }

  /** git's default merge message: `Merge branch 'x'` (`into <branch>` off main/master). */
  private async defaultMessage(description: string): Promise<string> {
    const branch = await this.getCurrentBranch();
    const short = branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : "HEAD";
    const into = short === "main" || short === "master" ? "" : ` into ${short}`;
    return `Merge ${description}${into}\n`;
  }

  /**
   * Check if commitA is an ancestor of commitB.
   */
  private async isAncestor(commitA: ObjectId, commitB: ObjectId): Promise<boolean> {
    if (commitA === commitB) return true;
    const visited = new Set<ObjectId>();
    const queue: ObjectId[] = [commitB];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === commitA) return true;
      try {
        const commit = await this.commits.load(current);
        if (commit) {
          for (const parent of commit.parents) {
            if (!visited.has(parent)) queue.push(parent);
          }
        }
      } catch {
        // Commit not found - continue
      }
    }
    return false;
  }
}

/** A refused merge: git's message, nothing changed. */
function failed(message: string, paths: string[] = []): MergeResult {
  return {
    status: MergeStatus.FAILED,
    mergedCommits: [],
    message,
    ...(paths.length > 0 ? { failingPaths: failing(paths) } : {}),
  };
}

function failing(paths: string[]): Map<string, MergeFailureReason> {
  return new Map(paths.map((p) => [p, MergeFailureReason.DIRTY_WORKTREE]));
}

/** The content strategy as merge-ort's favor (`-X ours`, `-X theirs`, union). */
export function favorOf(
  strategy: ContentMergeStrategy | undefined,
): "ours" | "theirs" | "union" | undefined {
  switch (strategy) {
    case ContentMergeStrategy.OURS:
      return "ours";
    case ContentMergeStrategy.THEIRS:
      return "theirs";
    case ContentMergeStrategy.UNION:
      return "union";
    default:
      return undefined;
  }
}
