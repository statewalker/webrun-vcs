import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { DEFAULT_BIG_FILE_THRESHOLD, FileMode, isSymbolicRef } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  attributesIndexOf,
  type ContentAttributesContext,
  cacheTreeOfTree,
  entryStatOf,
  type IndexEntryOptions,
  invalidateCacheTreePath,
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
  flatTree,
  indexChanges,
  indexChangesFromTree,
  OperationState,
  readIndex,
  rewriteIndex,
  storeFlatTree,
  storeFlatTreeOver,
  switchTrees,
  treeDelta,
  writeIndexAsTree,
} from "./merge-support.js";
import {
  type CleanupMode,
  cleanupWith,
  commitCleanupMode,
  commitMessageFromOption,
} from "./message-cleanup.js";
import { octopusMerge } from "./octopus-merge.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeBaseTree, mergeStoredTrees } from "./ort-recursive.js";
import { reflogMessages, updateHead } from "./reflog-messages.js";
import {
  applyAutostash,
  cleanupMessage,
  createAutostash,
  resetMerge,
  saveAutostash,
  squashMessage,
} from "./sequencer-support.js";
import { WorkingCopyStashProvider } from "./stash-working-tree.js";
import {
  type CheckedEntry,
  pruneEmptyParents,
  worktreeModified,
} from "./worktree-overwrite-checks.js";

/** What `git merge` is asked to do. */
export enum MergeOperation {
  /** Merge the included commit (`git merge <commit>`) */
  MERGE = "merge",
  /** Give up the merge in progress (`git merge --abort`) */
  ABORT = "abort",
  /** Commit the resolved merge in progress (`git merge --continue`) */
  CONTINUE = "continue",
}

/** git's refusal of a merge of histories with no common commit. */
export const UNRELATED_HISTORIES_MESSAGE = "fatal: refusing to merge unrelated histories";

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
  private cleanupMode?: CleanupMode;
  private bigFileThreshold = DEFAULT_BIG_FILE_THRESHOLD;
  private operation = MergeOperation.MERGE;
  private author?: PersonIdent;
  private committer?: PersonIdent;
  private autoStash?: boolean;
  private renormalize?: boolean;
  private allowUnrelated = false;

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
   * Set the merge commit message (default git's: `Merge branch 'feature'`), as git's
   * `merge -m` takes it: cleaned up as a commit message (`whitespace`, which ends the last
   * line, unless {@link setCleanupMode} or `commit.cleanup` says otherwise; `verbatim`
   * stores it as given, without a newline added, unlike `commit -m`).
   *
   * @param message Commit message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * How the merge commit's message is cleaned up (git's `merge --cleanup=<mode>`; default
   * `commit.cleanup`, else `whitespace`, as without an editor).
   */
  setCleanupMode(mode: CleanupMode): this {
    this.checkCallable();
    this.cleanupMode = mode;
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

  /**
   * Merge histories that share no commit (`--allow-unrelated-histories`): refused by
   * default with git's "refusing to merge unrelated histories". A two-head merge then
   * merges against the empty tree.
   */
  setAllowUnrelatedHistories(allow: boolean): this {
    this.checkCallable();
    this.allowUnrelated = allow;
    return this;
  }

  /**
   * The author of the merge commit (default: resolved as git resolves it, from
   * `GIT_AUTHOR_*`, `author.*`, `user.*`).
   */
  setAuthor(author: PersonIdent): this {
    this.checkCallable();
    this.author = author;
    return this;
  }

  /**
   * The committer of the merge commit (default: resolved as git resolves it, from
   * `GIT_COMMITTER_*`, `committer.*`, `user.*`).
   */
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

    // git refuses --squash with --no-ff before it looks at the heads
    if (this.squash && this.fastForwardMode === FastForwardMode.NO_FF) {
      throw new InvalidArgumentError(
        "squash",
        true,
        "fatal: options '--squash' and '--no-ff.' cannot be used together",
      );
    }

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
      if (remotes.length === 0) {
        await state.setRef("ORIG_HEAD", headId);
        return {
          status: MergeStatus.ALREADY_UP_TO_DATE,
          newHead: headId,
          mergedCommits: named.map((n) => n.id),
          output: [this.squash ? "Already up to date. (nothing to squash)" : "Already up to date."],
        };
      }
      if (remotes.length > 1) {
        // git has no strategy `theirs`: refused before anything is written
        if (this.strategy === MergeStrategy.THEIRS) {
          return failed(
            "Could not find merge strategy 'theirs'.\nAvailable strategies are: octopus ours recursive resolve subtree.",
          );
        }
        // the message names the heads left (fmt-merge-msg of the reduced heads)
        const message = this.message ?? (await this.octopusMessage(remotes));
        await state.setRef("ORIG_HEAD", headId);
        const ids = remotes.map((r) => r.id);
        if (!this.allowUnrelated && (await this.octopusBases(headId, ids)).length === 0) {
          throw new NoMergeBaseError([headId, ...ids], UNRELATED_HISTORIES_MESSAGE);
        }
        if (this.ffMode() === FastForwardMode.FF_ONLY) {
          throw new NotFastForwardError("fatal: Not possible to fast-forward, aborting.");
        }
        return this.withAutostash(state, worktree, headId, () =>
          this.doOctopus(headId, head, remotes, headSubsumed, message, state, worktree),
        );
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
    const fastForward = canFastForward && this.ffMode() !== FastForwardMode.NO_FF;

    // git refuses unrelated histories before anything is stashed or written
    const mergeBases = fastForward ? [] : await this.commits.findMergeBase(headId, srcId);
    if (!fastForward && mergeBases.length === 0 && !this.allowUnrelated) {
      throw new NoMergeBaseError([headId, srcId], UNRELATED_HISTORIES_MESSAGE);
    }
    if (!fastForward && this.ffMode() === FastForwardMode.FF_ONLY) {
      throw new NotFastForwardError("fatal: Not possible to fast-forward, aborting.");
    }

    return this.withAutostash(state, worktree, headId, () =>
      fastForward
        ? this.doFastForward(headId, srcId, head, state, worktree)
        : this.doMerge(headId, srcId, srcRef, head, state, worktree, mergeBases),
    );
  }

  /**
   * git's fast-forward setting as the strategy leaves it: `ours` (NO_FAST_FORWARD) always
   * makes a merge commit, whatever was asked.
   */
  private ffMode(): FastForwardMode {
    return this.strategy === MergeStrategy.OURS ? FastForwardMode.NO_FF : this.fastForwardMode;
  }

  /** git's get_octopus_merge_bases: the merge bases of HEAD and every head, folded. */
  private async octopusBases(headId: ObjectId, heads: ObjectId[]): Promise<ObjectId[]> {
    let bases = [headId];
    for (const head of heads) {
      const next = new Set<ObjectId>();
      for (const base of bases) {
        for (const id of await this.commits.findMergeBase(base, head)) next.add(id);
      }
      bases = [...next];
      if (bases.length === 0) break;
    }
    return bases;
  }

  /**
   * The merge between git's `create_autostash_ref` and `apply_autostash_ref`
   * (`merge.autoStash`): local changes stashed away first, applied again once the merge is
   * done, kept in MERGE_AUTOSTASH while it stops for the user.
   */
  private async withAutostash(
    state: OperationState,
    worktree: Worktree | undefined,
    headId: ObjectId,
    merge: () => Promise<MergeResult>,
  ): Promise<MergeResult> {
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
      result = await merge();
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
    } else if (created.length > 0) {
      output.push("When finished, apply stashed changes with `git stash pop`");
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
    const srcTreeId = await this.commits.getTree(srcId);
    const srcTree = await flatTree(this.trees, srcTreeId);
    const refused = await switchTrees(this.context(worktree), headTree, srcTree, {
      action: "merge",
      operation: "merge",
      targetTree: srcTreeId,
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
    await this.updateHead(head, srcId, "Fast-forward");
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
    // no merge base (unrelated histories allowed): merge-ort merges against the empty tree
    const baseId = mergeBases[0] as ObjectId | undefined;
    const headCommit = await this.commits.load(headId);
    const srcCommit = await this.commits.load(srcId);
    if (!headCommit || !srcCommit) {
      throw new RefNotFoundError(headId, "Failed to load commits for merge");
    }
    const { index } = await readIndex(this.staging);

    const mergeName = await this.describeMergeSource(srcName, srcId);
    const output: string[] = [];
    let target: Map<string, { objectId: ObjectId; mode: number }>;
    let merge: Awaited<ReturnType<typeof mergeStoredTrees>> | undefined;
    if (this.strategy === MergeStrategy.OURS) {
      target = await flatTree(this.trees, headCommit.tree);
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
      merge = await mergeStoredTrees(
        { trees: this.trees, blobs: this.blobs },
        base,
        headCommit.tree,
        srcCommit.tree,
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
    // only the directories the merge changes are stored again
    const treeId = merge
      ? await storeFlatTreeOver(this.trees, headCommit.tree, merge.ours, target)
      : await storeFlatTree(this.trees, target);
    // merge-ort records its result tree (AUTO_MERGE) whether or not it can be written
    if (merge) await state.setRef("AUTO_MERGE", treeId);

    // merge-ort's sanity check: the index must match HEAD (merge-ort-wrappers' unclean())
    const staged = await indexChangesFromTree(index, this.trees, headCommit.tree);
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
    // only the paths HEAD and the result differ on are switched
    const delta = await treeDelta(this.trees, headCommit.tree, treeId);
    const refused = await switchTrees(this.context(worktree), delta.from, delta.to, {
      action: "merge",
      operation: "merge",
      conflicts,
      targetTree: treeId,
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
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort(compareGitPaths);
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

    const newCommitId = await this.storeCommit(treeId, [headId, srcId], this.cleanup(message));
    await this.updateHead(head, newCommitId, reflogMessages.mergeMade(this.strategyName()));
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
   * A merge of several heads: git-merge-octopus (the heads merged one after the other) or,
   * with strategy `ours`, git-merge-ours (HEAD's tree); written when it merged or left
   * conflicts with the last head, nothing written when it gave up. As git's merge for any
   * strategy: committed, or stopped before the commit (`--no-commit`), or squashed
   * (`SQUASH_MSG`, HEAD left alone).
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
    const mergedCommits = [headId, ...remotes.map((r) => r.id)];
    const remoteIds = remotes.map((r) => r.id);
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const { index } = await readIndex(this.staging);
    const staged = indexChanges(index, headTree);
    const strategy = this.strategy === MergeStrategy.OURS ? "ours" : "octopus";
    // git restores the state it saved (reset --hard, stash apply): AUTO_MERGE as for ort
    const giveUp = async (lines: string[], output: string[] = []): Promise<MergeResult> => {
      const tree = (await this.commits.getTree(headId)) as ObjectId;
      await this.restoreStateQuirk(state, tree, worktree);
      return {
        status: MergeStatus.FAILED,
        newHead: headId,
        mergedCommits,
        message: [...lines, `Merge with strategy ${strategy} failed.`].join("\n"),
        output,
      };
    };
    // git-merge-resolve and merge-ort handle two heads only
    if (this.strategy === MergeStrategy.RESOLVE) {
      const tree = (await this.commits.getTree(headId)) as ObjectId;
      await this.restoreStateQuirk(state, tree, worktree);
      return failed("Merge with strategy resolve failed.");
    }
    let outcome: Awaited<ReturnType<typeof octopusMerge>>;
    if (this.strategy === MergeStrategy.OURS) {
      // git-merge-ours: refuses an index that differs from HEAD, else HEAD's tree
      if (staged.length > 0) return giveUp([]);
      outcome = {
        status: 0,
        output: [],
        errors: [],
        index: headTree,
        worktree: new Map(),
        conflicts: [],
        steps: [],
      };
    } else {
      outcome = await octopusMerge(
        {
          commits: this.commits,
          trees: this.trees,
          blobs: this.blobs,
          style: conflictStyleOf(this.workingCopy),
        },
        headId,
        remotes,
        staged,
      );
    }
    const output = [...outcome.output];
    if (outcome.status === 2) return giveUp(outcome.errors, output);
    const target = new Map(outcome.index);
    for (const [path, entry] of outcome.worktree) target.set(path, entry);
    const refused = await switchTrees(this.context(worktree), headTree, target, {
      action: "merge",
      operation: "merge",
      conflicts: outcome.conflicts,
    });
    if (refused) {
      // the script stopped at the first head whose read-tree met the local change
      const stop = outcome.steps.find((s) => refused.paths.some((p) => s.paths.has(p)));
      return giveUp([refused.message], stop ? output.slice(0, stop.output) : output);
    }
    const writeState = async (text: string) => {
      await state.write("MERGE_HEAD", remoteIds.map((id) => `${id}\n`).join(""));
      await state.write("MERGE_MSG", text);
      await state.write("MERGE_MODE", this.ffMode() === FastForwardMode.NO_FF ? "no-ff" : "");
    };
    if (outcome.status === 1) {
      const paths = [...new Set(outcome.conflicts.map((c) => c.stagePath))].sort(compareGitPaths);
      if (this.squash) {
        await state.write("SQUASH_MSG", await squashMessage(this.commits, headId, remoteIds));
        await state.write("MERGE_MSG", conflictsComment(paths, true));
        output.push("Squash commit -- not updating HEAD");
      } else {
        const text = message.endsWith("\n") ? message : `${message}\n`;
        await writeState(`${text}${conflictsComment(paths, true)}`);
      }
      output.push("Automatic merge failed; fix conflicts and then commit the result.");
      return {
        status: MergeStatus.CONFLICTING,
        mergedCommits,
        conflicts: paths,
        // what git-merge-one-file printed on stderr (`ERROR: content conflict in f`, ...)
        ...(outcome.errors.length > 0 ? { message: outcome.errors.join("\n") } : {}),
        output,
      };
    }
    if (this.squash) {
      await state.write("SQUASH_MSG", await squashMessage(this.commits, headId, remoteIds));
      output.push(
        "Squash commit -- not updating HEAD",
        "Automatic merge went well; stopped before committing as requested",
      );
      return { status: MergeStatus.MERGED_SQUASHED, newHead: headId, mergedCommits, output };
    }
    if (!this.commit) {
      await writeState(message);
      output.push("Automatic merge went well; stopped before committing as requested");
      return { status: MergeStatus.MERGED_NOT_COMMITTED, newHead: headId, mergedCommits, output };
    }
    const treeId = await storeFlatTree(this.trees, outcome.index);
    // finish_automerge: HEAD a parent unless the heads contain it, or with --no-ff
    const keepHead = !headSubsumed || this.ffMode() === FastForwardMode.NO_FF;
    const parents = [...(keepHead ? [headId] : []), ...remoteIds];
    const newCommitId = await this.storeCommit(treeId, parents, this.cleanup(message));
    await this.updateHead(head, newCommitId, reflogMessages.mergeMade(strategy));
    output.push(`Merge made by the '${strategy}' strategy.`);
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
    // a message given is `git commit -m`'s; MERGE_MSG is taken as an editor leaves it
    const message =
      this.message !== undefined
        ? commitMessageFromOption(this.message, this.cleanupMode, this.workingCopy)
        : cleanupMessage((await state.read("MERGE_MSG")) ?? `Merge commit '${mergeHead}'\n`);
    const newCommitId = await this.storeCommit(treeId, [headId, ...heads], message);
    // `git merge --continue` is `git commit`: "commit (merge): <subject>"
    await this.updateHead(head, newCommitId, undefined, reflogMessages.commit("merge", message));
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
    // `git reset --merge` moves HEAD where it is: "reset: moving to HEAD" (git's merge sets
    // GIT_REFLOG_ACTION only after the abort, so a caller's action reads "<action>: updating HEAD")
    const message = this.hasReflogAction()
      ? `${this.reflogAction("merge")}: updating HEAD`
      : reflogMessages.reset("HEAD");
    await updateHead(this.refsStore, headId, this.reflogLine(message));
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
    // save_state's `stash create`, then the reset. The stash writes the index's tree first
    // (write_index_as_tree, the index file written with its cache-tree), and fails before
    // the reset where it cannot save the worktree (an intent-to-add entry)
    let savedTree: ObjectId | undefined;
    let indexTree: ObjectId | undefined;
    if (await provider.hasLocalChanges()) {
      indexTree = await writeIndexAsTree(this.staging, this.trees);
      savedTree = await provider.getWorkingTree();
    }
    // nothing saved: the reset alone, which leaves the index exactly HEAD (read-tree's
    // prime_cache_tree: a fully valid cache-tree)
    await this.resetAssumeUnchanged(worktree, savedTree ? undefined : headTree);
    if (!savedTree) return;
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
    if (this.staging.setCacheTree && indexTree) {
      // `stash apply --index` of staged changes ends reading the index's tree (fully valid);
      // with none, HEAD's cache-tree (the reset) has the paths the apply wrote invalid
      const staged = indexTree !== headTree;
      const cacheTree = await cacheTreeOfTree(this.trees, staged ? indexTree : headTree);
      if (!staged) {
        const differs = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
          a?.objectId !== b?.objectId || a?.mode !== b?.mode;
        for (const path of new Set([...saved.keys(), ...head.keys()])) {
          if (differs(saved.get(path), head.get(path))) invalidateCacheTreePath(cacheTree, path);
        }
      }
      this.staging.setCacheTree(cacheTree);
    }
    await rewriteIndex(this.staging, restaged);
    // a file deleted in what was saved: `reset --hard` wrote it, `stash apply` removed it
    // again with the directories it leaves empty
    for (const path of head.keys()) {
      if (saved.has(path) || (await worktree.getEntry(path))) continue;
      await pruneEmptyParents(worktree, path);
    }
  }

  /**
   * restore_state's `reset --hard` over a file the index marks assume-unchanged: `stash
   * create` did not save its change (the flag hides it), and the reset writes it again from
   * the index when it no longer matches (oneway_merge compares with CE_MATCH_IGNORE_VALID),
   * so the local change is lost, as in git. The entry keeps its flag and takes the new stat.
   * With `cacheTree` (the index is that tree's), the index is written with its cache-tree.
   */
  private async resetAssumeUnchanged(worktree: Worktree, cacheTree?: ObjectId): Promise<void> {
    const marked: IndexEntryOptions[] = [];
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0 && entry.assumeValid && entry.mode !== FileMode.GITLINK) {
        marked.push(entry);
      }
    }
    if (marked.length === 0 && !cacheTree) return;
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    const { index } = await readIndex(this.staging);
    const attributes: ContentAttributesContext = {
      direction: "checkout",
      index: attributesIndexOf([...index].map(([p, e]) => [p, e.objectId] as const)),
    };
    const rewritten = new Map<string, IndexEntryOptions[]>();
    for (const entry of marked) {
      if (!(await worktreeModified(worktree, entry.path, entry, trust, indexTime))) continue;
      const content = await this.blobs.load(entry.objectId);
      if (!content) continue;
      const mode =
        entry.mode === FileMode.SYMLINK && !trust.symlinks ? FileMode.REGULAR_FILE : entry.mode;
      await worktree.writeContent(entry.path, content, {
        mode,
        ...(mode !== entry.mode ? { raw: true } : {}),
        createParents: true,
        replaceInTheWay: true,
        attributes,
      });
      const stats = await worktree.getEntry(entry.path);
      rewritten.set(entry.path, [
        {
          ...entry,
          ...(stats && !stats.isDirectory ? entryStatOf(stats) : {}),
        },
      ]);
    }
    if (cacheTree && this.staging.setCacheTree) {
      this.staging.setCacheTree(await cacheTreeOfTree(this.trees, cacheTree));
    } else if (rewritten.size === 0) {
      return;
    }
    await rewriteIndex(this.staging, rewritten);
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
    await state.write("MERGE_MODE", this.ffMode() === FastForwardMode.NO_FF ? "no-ff" : "");
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

  /** git's `cleanup_message` of a merge commit's message (prepare_to_commit, no editor). */
  private cleanup(message: string): string {
    const mode = commitCleanupMode(this.workingCopy, this.cleanupMode);
    return cleanupWith(this.workingCopy, message, mode);
  }

  private async storeCommit(tree: ObjectId, parents: ObjectId[], message: string) {
    // git's merge commit: the author and the committer as git resolves them (GIT_AUTHOR_* /
    // GIT_COMMITTER_*, author.* / committer.*, user.*), unless given
    const author = this.author ?? this.resolveAuthor(this.committer);
    const committer = this.committer ?? this.resolveCommitter(author);
    const commit: Commit = { tree, parents, author, committer, message };
    return this.commits.store(commit);
  }

  /**
   * HEAD (its branch, when attached) moved to `id`, logged as git's merge logs it:
   * `<action>: <outcome>`, the action being `merge <names as given>` (`pull` for a pull);
   * or with `message` as it is.
   */
  private async updateHead(
    head: Awaited<ReturnType<typeof this.refsStore.get>>,
    id: ObjectId,
    outcome: string | undefined,
    message?: string,
  ): Promise<void> {
    const action = this.reflogAction(reflogMessages.mergeAction(this.includes));
    const log = this.reflogLine(
      message ?? reflogMessages.merge(action, outcome ?? ""),
      this.committer,
    );
    if (head && isSymbolicRef(head)) await this.refsStore.set(head.target, id, log);
    else await this.refsStore.set("HEAD", id, log);
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
