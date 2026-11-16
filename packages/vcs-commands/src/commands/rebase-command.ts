import { isSymbolicRef, type ObjectId, type PersonIdent } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  CommitNotFoundError,
  InvalidArgumentError,
  NoHeadError,
  NoRebaseInProgressError,
  UpstreamRequiredError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { RebaseResult, RebaseTodoLine } from "../results/rebase-result.js";
import { RebaseAction, RebaseStatus } from "../results/rebase-result.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { favorOf, UNMERGED_FILES_MESSAGE } from "./merge-command.js";
import { configBool, conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
  abbrev,
  conflictsComment,
  defaultIdent,
  FlatTreeCache,
  flatTree,
  indexChanges,
  OperationState,
  readIndex,
  storeFlatTreeOver,
  subjectOf,
  switchTrees,
} from "./merge-support.js";
import { ortMerge, ortResultEntries } from "./ort-merge.js";
import { patchId } from "./patch-id.js";
import { expandCommitId, expandCommitIds } from "./sequencer-pick.js";
import {
  applyAutostash,
  cleanupMessage,
  createAutostash,
  resetMerge,
} from "./sequencer-support.js";
import { worktreeModified } from "./worktree-overwrite-checks.js";

/**
 * Rebase operation types.
 */
export enum RebaseOperation {
  /** Start a new rebase */
  BEGIN = "begin",
  /** Continue after resolving conflicts */
  CONTINUE = "continue",
  /** Skip the current commit */
  SKIP = "skip",
  /** Abort and restore original state */
  ABORT = "abort",
  /** Process steps (for interactive rebase) */
  PROCESS_STEPS = "process-steps",
}

/**
 * Handler for interactive rebase.
 */
export interface InteractiveHandler {
  /**
   * Modify the steps before execution.
   * @param steps List of rebase steps to modify
   */
  prepareSteps(steps: RebaseTodoLine[]): void;

  /**
   * Modify commit message for reword/squash.
   * @param message Original message
   * @returns Modified message
   */
  modifyCommitMessage(message: string): string;
}

/** The state directory of git's merge backend. */
const DIR = "rebase-merge";

/** One line of the todo list. */
interface TodoItem {
  action: RebaseAction;
  id: ObjectId;
}

/** git's quoting of a value in `author-script` (`'...'`, a quote as `'\''`). */
const sq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Rebase the current branch onto another commit.
 *
 * Equivalent to `git rebase <upstream>` with git's merge backend: the commits HEAD has that
 * upstream has not (merges dropped) are picked one by one onto upstream by git's merge-ort,
 * the working tree and the index written as git writes them. A conflict stops the rebase
 * with git's markers (`<<<<<<< HEAD` / `>>>>>>> <abbrev> (<subject>)`), stages 1-3 and
 * git's state (`.git/rebase-merge/`, `REBASE_HEAD`, `MERGE_MSG`, `AUTO_MERGE`), so native
 * `git rebase --continue / --skip / --abort` resumes what we started, and we resume what
 * native git started. A rebase is refused on unstaged or staged changes, as git refuses it.
 *
 * @example
 * ```typescript
 * const result = await git.rebase().setUpstream(mainId).call();
 * if (result.status === RebaseStatus.STOPPED) {
 *   // resolve, `git add`, then
 *   await git.rebase().setOperation(RebaseOperation.CONTINUE).call();
 * }
 * ```
 */
export class RebaseCommand extends GitCommand<RebaseResult> {
  private operation = RebaseOperation.BEGIN;
  private upstreamCommit?: ObjectId;
  private upstreamCommitName?: string;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private preserveMerges = false;
  private interactiveHandler?: InteractiveHandler;
  private committer?: PersonIdent;
  private autoStash?: boolean;
  private reapplyCherryPicks = false;
  /** The flat trees the picks read (each pick's result is the next one's HEAD) */
  private flatTrees?: FlatTreeCache;
  /** Commit subjects, for the todo and done lines */
  private readonly subjects = new Map<ObjectId, string>();

  /**
   * Set the upstream commit to rebase onto.
   *
   * @param upstream Upstream commit ID
   */
  setUpstream(upstream: ObjectId): this {
    this.checkCallable();
    this.upstreamCommit = upstream;
    this.upstreamCommitName = upstream;
    return this;
  }

  /**
   * Set the upstream by branch name.
   *
   * @param upstream Branch name to rebase onto
   */
  async setUpstreamBranch(upstream: string): Promise<this> {
    this.checkCallable();
    this.upstreamCommit = await this.resolveRef(upstream);
    this.upstreamCommitName = upstream;
    return this;
  }

  /**
   * Set the upstream name for messages.
   *
   * @param name Display name for upstream
   */
  setUpstreamName(name: string): this {
    this.checkCallable();
    if (!this.upstreamCommit) {
      throw new InvalidArgumentError(
        "upstreamName",
        name,
        "setUpstreamName must be called after setUpstream",
      );
    }
    this.upstreamCommitName = name;
    return this;
  }

  /** The upstream's name (the branch given, else its id). */
  getUpstreamName(): string | undefined {
    return this.upstreamCommitName;
  }

  /**
   * Set the operation to perform.
   *
   * @param operation Rebase operation
   */
  setOperation(operation: RebaseOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /**
   * Get the current operation.
   */
  getOperation(): RebaseOperation {
    return this.operation;
  }

  /**
   * Set the merge strategy (only git's merge-ort is run; kept for compatibility).
   *
   * @param strategy Merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Get the merge strategy.
   */
  getStrategy(): MergeStrategy {
    return this.strategy;
  }

  /**
   * Set content merge strategy for conflicts (`-X ours`, `-X theirs`).
   *
   * @param strategy Content merge strategy
   */
  setContentMergeStrategy(strategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = strategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Set whether to preserve merge commits (not supported: merges are dropped, as git's
   * default rebase drops them).
   *
   * @param preserve Whether to preserve merges
   */
  setPreserveMerges(preserve: boolean): this {
    this.checkCallable();
    this.preserveMerges = preserve;
    return this;
  }

  /**
   * Get whether merges are preserved.
   */
  getPreserveMerges(): boolean {
    return this.preserveMerges;
  }

  /**
   * Enable interactive mode with handler.
   *
   * @param handler Interactive handler
   */
  runInteractively(handler: InteractiveHandler): this {
    this.checkCallable();
    this.interactiveHandler = handler;
    return this;
  }

  /**
   * Pick commits whose change upstream already has (`--reapply-cherry-picks`); by default
   * (`--no-reapply-cherry-picks`) they are left out, with git's "skipped previously applied
   * commit" warnings, as their patch-id is found upstream.
   */
  setReapplyCherryPicks(reapply: boolean): this {
    this.checkCallable();
    this.reapplyCherryPicks = reapply;
    return this;
  }

  /**
   * Stash local changes away for the rebase and apply them after it (`--autostash`;
   * default `rebase.autoStash`, false).
   */
  setAutoStash(autoStash: boolean): this {
    this.checkCallable();
    this.autoStash = autoStash;
    return this;
  }

  /** The committer of the rebased commits (default `Unknown`, now). */
  setCommitter(committer: PersonIdent): this {
    this.checkCallable();
    this.committer = committer;
    return this;
  }

  async call(): Promise<RebaseResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktree = this.worktreeAccess;
    const run = () => this.run(worktree);
    return worktree?.batch ? worktree.batch(run) : run();
  }

  private async run(worktree: Worktree | undefined): Promise<RebaseResult> {
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    switch (this.operation) {
      case RebaseOperation.ABORT:
        return this.abort(state, worktree);
      case RebaseOperation.CONTINUE:
        return this.continueRebase(state, worktree);
      case RebaseOperation.SKIP:
        return this.skip(state, worktree);
      default:
        return this.begin(state, worktree);
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

  private async inProgress(state: OperationState): Promise<boolean> {
    return (
      (await state.read(`${DIR}/head-name`)) !== undefined ||
      (await state.read(`${DIR}/onto`)) !== undefined ||
      (await state.listDir(DIR)).length > 0
    );
  }

  private async begin(
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<RebaseResult> {
    if (!this.upstreamCommit) {
      throw new UpstreamRequiredError("Upstream commit is required for rebase BEGIN operation");
    }
    if (await this.inProgress(state)) {
      return {
        status: RebaseStatus.FAILED,
        message:
          "fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.",
      };
    }
    const headResolved = await this.refsStore.resolve("HEAD");
    if (!headResolved?.objectId) throw new NoHeadError("HEAD cannot be resolved");
    const headId = headResolved.objectId;
    const headRef = await this.refsStore.get("HEAD");
    const headName = headRef && isSymbolicRef(headRef) ? headRef.target : "detached HEAD";
    const onto = this.upstreamCommit;

    // git's require_clean_work_tree: no unstaged, no staged changes, unless they are
    // stashed away for the rebase (rebase.autoStash) and applied again after it
    const output: string[] = [];
    let autostash: ObjectId | undefined;
    const refusal = await this.uncleanWorktree(headId, worktree);
    if (refusal) {
      if (!(this.autoStash ?? configBool(this.workingCopy, "rebase.autoStash", false))) {
        return refusal;
      }
      if (!state.supported) {
        // the stash could be kept nowhere: refused rather than stranded
        throw new InvalidArgumentError(
          "autoStash",
          true,
          "rebase --autostash needs a checkout that keeps state files (rebase-merge/autostash)",
        );
      }
      autostash = await createAutostash(this.context(worktree), headId);
      if (autostash) output.push(`Created autostash: ${abbrev(autostash)}`);
    }
    const unstash = async () => {
      if (autostash) output.push(...(await applyAutostash(this.context(worktree), autostash)));
    };

    // HEAD already contains upstream: nothing to do
    if (await this.isAncestor(onto, headId)) {
      const branch = headName.replace(/^refs\/heads\//, "");
      output.push(`Current branch ${branch} is up to date.`);
      await unstash();
      return { status: RebaseStatus.UP_TO_DATE, newHead: headId, output };
    }

    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const ontoTree = await flatTree(this.trees, await this.commits.getTree(onto));
    // nothing of HEAD's to replay: HEAD moves to upstream
    if (await this.isAncestor(headId, onto)) {
      const refused = await switchTrees(this.context(worktree), headTree, ontoTree, {
        action: "checkout",
        operation: "rebase",
      });
      if (refused) {
        await unstash();
        return { status: RebaseStatus.FAILED, message: refused.message, output };
      }
      await state.setRef("ORIG_HEAD", headId);
      await this.finishBranch(headName, onto);
      await unstash();
      return { status: RebaseStatus.FAST_FORWARD, newHead: onto, output };
    }

    // the commits to pick: HEAD's, not upstream's, merges dropped, oldest first
    const range = await this.commitsToRebase(headId, onto);
    if (range.length === 0) {
      await unstash();
      return { status: RebaseStatus.UP_TO_DATE, newHead: headId, output };
    }
    // commits whose change upstream has already (`--cherry-mark`): left out, with git's
    // warnings (`make_script`), unless --reapply-cherry-picks
    const skipped = this.reapplyCherryPicks
      ? new Set<ObjectId>()
      : await this.appliedUpstream(headId, onto, range);
    const ids = range.filter((id) => !skipped.has(id));
    if (skipped.size > 0) {
      for (const id of range) {
        if (skipped.has(id))
          output.push(`warning: skipped previously applied commit ${abbrev(id)}`);
      }
      if (configBool(this.workingCopy, "advice.skippedCherryPicks", true)) {
        output.push(
          "hint: use --reapply-cherry-picks to include skipped commits",
          'hint: Disable this message with "git config set advice.skippedCherryPicks false"',
        );
      }
    }
    const steps: RebaseTodoLine[] = [];
    for (const id of ids) {
      const commit = await this.commits.load(id);
      steps.push({
        action: RebaseAction.PICK,
        commit: abbrev(id),
        shortMessage: subjectOf(commit?.message ?? ""),
      });
    }
    this.interactiveHandler?.prepareSteps(steps);
    const todo: TodoItem[] = [];
    for (const step of steps) {
      if (step.action === RebaseAction.COMMENT) continue;
      const id = ids.find((c) => c.startsWith(step.commit));
      if (!id) throw new CommitNotFoundError(step.commit);
      todo.push({ action: step.action, id });
    }

    // detach HEAD at upstream, the worktree switched to it (as git's checkout of onto)
    const refused = await switchTrees(this.context(worktree), headTree, ontoTree, {
      action: "checkout",
      operation: "rebase",
    });
    if (refused) {
      await unstash();
      return {
        status: RebaseStatus.FAILED,
        message: `${refused.message}\nerror: could not detach HEAD`,
        output,
      };
    }
    await state.setRef("ORIG_HEAD", headId);
    await state.write(`${DIR}/head-name`, `${headName}\n`);
    await state.write(`${DIR}/onto`, `${onto}\n`);
    await state.write(`${DIR}/orig-head`, `${headId}\n`);
    await state.write(`${DIR}/interactive`, "");
    await state.write(`${DIR}/drop_redundant_commits`, "");
    await state.write(`${DIR}/no-reschedule-failed-exec`, "");
    await state.write(`${DIR}/end`, `${todo.length}\n`);
    await state.write(`${DIR}/msgnum`, "0\n");
    await state.write(`${DIR}/done`, "");
    const todoText = await this.todoText(todo);
    await state.write(
      `${DIR}/git-rebase-todo.backup`,
      `${todoText}\n# Rebase ${abbrev(onto)}..${abbrev(headId)} onto ${abbrev(onto)} (${todo.length} command${todo.length === 1 ? "" : "s"})\n`,
    );
    await state.write(`${DIR}/git-rebase-todo`, todoText);
    if (autostash) await state.write(`${DIR}/autostash`, `${autostash}\n`);
    await this.refsStore.set("HEAD", onto);
    return this.processTodo(state, worktree, output);
  }

  /** Picks what is left in `git-rebase-todo`, then finishes the rebase. */
  private async processTodo(
    state: OperationState,
    worktree: Worktree | undefined,
    output: string[] = [],
  ): Promise<RebaseResult> {
    let todo = await this.readTodoFile(state, "git-rebase-todo");
    // git's read_populate_todo: the commands done so far and the total (`end`)
    let doneCount = countCommands((await state.read(`${DIR}/done`)) ?? "");
    if (todo.length > 0) await state.write(`${DIR}/end`, `${doneCount + todo.length}\n`);
    while (todo.length > 0) {
      const item = todo[0];
      const rest = todo.slice(1);
      const line = await this.todoText([item]);
      const done = (await state.read(`${DIR}/done`)) ?? "";
      await state.write(`${DIR}/done`, `${done}${line}`);
      await state.write(`${DIR}/git-rebase-todo`, await this.todoText(rest));
      doneCount++;
      await state.write(`${DIR}/msgnum`, `${doneCount}\n`);
      // what the previous command left (pick_commits unlinks it before each one)
      await state.remove(`${DIR}/message`, `${DIR}/stopped-sha`);
      await state.removeRef("AUTO_MERGE", "REBASE_HEAD");
      const outcome = await this.pick(state, worktree, item, output);
      if (outcome?.reschedule) {
        // git's "It has been rescheduled": the command goes back to the todo's head (it
        // stays in `done`), so `--continue` runs it again
        await state.write(`${DIR}/git-rebase-todo`, await this.todoText(todo));
        const { reschedule: _, ...result } = outcome;
        return {
          ...result,
          message: `${result.message ?? ""}\n${rescheduledAdvice(line.replace(/\n$/, ""))}`,
          output,
        };
      }
      if (outcome) return { ...outcome, output };
      todo = rest;
    }
    // done: the branch takes the new commits, HEAD attached to it again
    const headName = (await state.read(`${DIR}/head-name`))?.trim() ?? "detached HEAD";
    const newHead = await this.resolveHead();
    await this.finishBranch(headName, newHead);
    const autostash = (await state.read(`${DIR}/autostash`))?.trim();
    await state.remove(DIR);
    if (autostash) output.push(...(await applyAutostash(this.context(worktree), autostash)));
    return { status: RebaseStatus.OK, newHead, output };
  }

  /** One commit picked onto HEAD; a result when the rebase stops there. */
  private async pick(
    state: OperationState,
    worktree: Worktree | undefined,
    item: TodoItem,
    output: string[],
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    const commit = await this.commits.load(item.id);
    if (!commit) throw new CommitNotFoundError(item.id);
    const headId = await this.resolveHead();
    // the trees read once: a pick's result is the next one's HEAD, a commit the next one's
    // parent; what is written and staged is only what the pick changes
    this.flatTrees ??= new FlatTreeCache(this.trees);
    const flats = this.flatTrees;
    const headTreeId = await this.commits.getTree(headId);
    const headTree = await flats.get(headTreeId);
    const parentId = commit.parents[0];
    const parentTree = await flats.get(parentId ? await this.commits.getTree(parentId) : undefined);
    const subject = subjectOf(commit.message);
    const label = `${abbrev(item.id)} (${subject})`;
    const merge = await ortMerge(this.blobs, parentTree, headTree, await flats.get(commit.tree), {
      oursLabel: "HEAD",
      theirsLabel: label,
      baseLabel: parentId ? `parent of ${label}` : "(empty tree)",
      style: conflictStyleOf(this.workingCopy),
      favor: favorOf(this.contentStrategy),
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      ...ortConfigOptions(this.workingCopy, worktree),
    });
    const target = await ortResultEntries(this.blobs, merge);
    const treeId = await storeFlatTreeOver(this.trees, headTreeId, headTree, target);
    flats.put(treeId, target);
    const conflicts = [...merge.conflicts.values()];
    const refused = await switchTrees(this.context(worktree), headTree, target, {
      action: "merge",
      operation: "rebase",
      conflicts,
      targetTree: treeId,
    });
    if (refused) {
      // nothing written: the pick is rescheduled (git keeps the author and REBASE_HEAD)
      await this.writeAuthorScript(state, commit.author);
      await state.setRef("REBASE_HEAD", item.id);
      return {
        status: RebaseStatus.FAILED,
        currentCommit: item.id,
        message: refused.message,
        reschedule: true,
      };
    }
    // the sequencer shows merge-ort's messages of a rebase only when the pick conflicts
    if (conflicts.length > 0 || !merge.clean) output.push(...merge.messages);
    await state.setRef("AUTO_MERGE", treeId);
    if (conflicts.length > 0 || !merge.clean) {
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort();
      const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
      await this.stopAt(state, item.id, commit.message, commit.author);
      await state.setRef("REBASE_HEAD", item.id);
      await state.write("MERGE_MSG", `${message}${conflictsComment(paths, true)}`);
      return {
        status: RebaseStatus.STOPPED,
        currentCommit: item.id,
        conflicts: [...new Set(merge.conflicts.keys())].sort(),
        message: [
          `error: could not apply ${abbrev(item.id)}... ${subject}`,
          "hint: Resolve all conflicts manually, mark them as resolved with",
          'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
          'hint: You can instead skip this commit: run "git rebase --skip".',
          'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".',
          `Could not apply ${abbrev(item.id)}... ${subject}`,
        ].join("\n"),
      };
    }
    if (treeId === headTreeId) {
      // a pick that changes nothing is dropped (git's drop_redundant_commits)
      return undefined;
    }
    let message = commit.message;
    if (item.action === RebaseAction.REWORD && this.interactiveHandler) {
      message = this.interactiveHandler.modifyCommitMessage(message);
    }
    const newId = await this.commitOnto(headId, treeId, commit.author, message);
    await this.rewritten(state, item.id, newId);
    if (item.action === RebaseAction.EDIT) {
      return { status: RebaseStatus.EDIT, newHead: newId, currentCommit: item.id };
    }
    return undefined;
  }

  /** The files git writes where a pick stops. */
  private async stopAt(
    state: OperationState,
    id: ObjectId,
    message: string,
    author: PersonIdent,
  ): Promise<void> {
    await state.write(`${DIR}/stopped-sha`, `${id}\n`);
    // git 2.43 writes the message and a blank line (2.5x the conflict list after it)
    await state.write(`${DIR}/message`, `${message.endsWith("\n") ? message : `${message}\n`}\n`);
    await this.writeAuthorScript(state, author);
  }

  /** git's `author-script` of the commit being picked. */
  private async writeAuthorScript(state: OperationState, author: PersonIdent): Promise<void> {
    await state.write(
      `${DIR}/author-script`,
      `GIT_AUTHOR_NAME=${sq(author.name)}\nGIT_AUTHOR_EMAIL=${sq(author.email)}\nGIT_AUTHOR_DATE=${sq(`@${author.timestamp} ${author.tzOffset}`)}\n`,
    );
  }

  /** `git rebase --continue`: the resolved pick committed, the rest picked. */
  private async continueRebase(
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<RebaseResult> {
    if (!(await this.inProgress(state))) throw new NoRebaseInProgressError();
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length > 0) {
      return {
        status: RebaseStatus.STOPPED,
        conflicts: unmerged,
        message: UNMERGED_FILES_MESSAGE("Committing"),
      };
    }
    const stopped =
      (await state.ref("REBASE_HEAD")) ?? (await state.read(`${DIR}/stopped-sha`))?.trim();
    if (stopped) {
      const id = await expandCommitId(
        { commits: this.commits, refs: this.refsStore, state },
        stopped,
      );
      const headId = await this.resolveHead();
      const treeId = await this.staging.writeTree(this.trees);
      const headCommit = await this.commits.load(headId);
      if (headCommit && headCommit.tree !== treeId) {
        const commit = await this.commits.load(id);
        const author =
          parseAuthorScript((await state.read(`${DIR}/author-script`)) ?? "") ??
          commit?.author ??
          defaultIdent();
        const text =
          (await state.read("MERGE_MSG")) ??
          (await state.read(`${DIR}/message`)) ??
          commit?.message ??
          "";
        const newId = await this.commitOnto(headId, treeId, author, cleanupMessage(text));
        await this.rewritten(state, id, newId);
        await state.removeRef("AUTO_MERGE");
      }
    }
    await state.removeRef("REBASE_HEAD");
    await state.remove(
      "MERGE_MSG",
      `${DIR}/stopped-sha`,
      `${DIR}/message`,
      `${DIR}/author-script`,
      `${DIR}/patch`,
    );
    return this.processTodo(state, worktree);
  }

  /** `git rebase --skip`: the stopped pick dropped (`reset --hard`), the rest picked. */
  private async skip(state: OperationState, worktree: Worktree | undefined): Promise<RebaseResult> {
    if (!(await this.inProgress(state))) throw new NoRebaseInProgressError();
    const headId = await this.resolveHead();
    const refused = await resetMerge(this.context(worktree), headId, "HEAD", { hard: true });
    if (refused) {
      return {
        status: RebaseStatus.FAILED,
        message: `${refused.message.replace(/\nfatal: .*$/, "")}\nfatal: could not discard worktree changes`,
      };
    }
    await state.removeRef("REBASE_HEAD");
    await state.remove(
      "MERGE_MSG",
      `${DIR}/stopped-sha`,
      `${DIR}/message`,
      `${DIR}/author-script`,
      `${DIR}/patch`,
    );
    return this.processTodo(state, worktree);
  }

  /** `git rebase --abort`: back to the original branch and commit (`reset --hard`). */
  private async abort(
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<RebaseResult> {
    if (!(await this.inProgress(state))) return { status: RebaseStatus.ABORTED };
    const origHead = (await state.read(`${DIR}/orig-head`))?.trim();
    const headName = (await state.read(`${DIR}/head-name`))?.trim() ?? "detached HEAD";
    if (!origHead)
      return { status: RebaseStatus.FAILED, message: "fatal: could not read orig-head" };
    const refused = await resetMerge(this.context(worktree), origHead, origHead, { hard: true });
    if (refused) {
      return {
        status: RebaseStatus.FAILED,
        message: `${refused.message.replace(/\nfatal: .*$/, "")}\nfatal: could not move back to ${origHead}`,
      };
    }
    await this.finishBranch(headName, origHead);
    const autostash = (await state.read(`${DIR}/autostash`))?.trim();
    await state.removeRef("REBASE_HEAD", "AUTO_MERGE");
    await state.remove("MERGE_MSG", DIR);
    const output = autostash ? await applyAutostash(this.context(worktree), autostash) : [];
    return { status: RebaseStatus.ABORTED, newHead: origHead, output };
  }

  /** Refuses as git's require_clean_work_tree: unstaged, then staged changes. */
  private async uncleanWorktree(
    headId: ObjectId,
    worktree: Worktree | undefined,
  ): Promise<RebaseResult | undefined> {
    const { index, unmerged } = await readIndex(this.staging);
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const staged = indexChanges(index, headTree);
    const unstaged: string[] = [...unmerged];
    if (worktree) {
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      for (const [path, entry] of index) {
        // a deleted file is an unstaged change too
        if (await worktreeModified(worktree, path, entry, trust)) unstaged.push(path);
      }
    }
    if (staged.length === 0 && unstaged.length === 0) return undefined;
    const lines = ["error: cannot rebase: You have unstaged changes."];
    if (unstaged.length === 0)
      lines[0] = "error: cannot rebase: Your index contains uncommitted changes.";
    else if (staged.length > 0)
      lines.push("error: additionally, your index contains uncommitted changes.");
    lines.push("error: Please commit or stash them.");
    return {
      status: RebaseStatus.UNCOMMITTED_CHANGES,
      uncommittedChanges: [...new Set([...unstaged, ...staged])].sort(),
      message: lines.join("\n"),
    };
  }

  private async commitOnto(
    parent: ObjectId,
    tree: ObjectId,
    author: PersonIdent,
    message: string,
  ): Promise<ObjectId> {
    const committer = this.committer ?? defaultIdent();
    const id = await this.commits.store({ tree, parents: [parent], author, committer, message });
    await this.refsStore.set("HEAD", id);
    return id;
  }

  private async rewritten(state: OperationState, from: ObjectId, to: ObjectId): Promise<void> {
    const list = (await state.read(`${DIR}/rewritten-list`)) ?? "";
    await state.write(`${DIR}/rewritten-list`, `${list}${from} ${to}\n`);
  }

  /** The branch rebased moves to `id` and HEAD is attached to it again. */
  private async finishBranch(headName: string, id: ObjectId): Promise<void> {
    if (headName.startsWith("refs/")) {
      await this.refsStore.set(headName, id);
      await this.refsStore.setSymbolic("HEAD", headName);
    } else {
      await this.refsStore.set("HEAD", id);
    }
  }

  private async todoText(todo: TodoItem[]): Promise<string> {
    let out = "";
    for (const item of todo) {
      let subject = this.subjects.get(item.id);
      if (subject === undefined) {
        subject = subjectOf((await this.commits.load(item.id))?.message ?? "");
        this.subjects.set(item.id, subject);
      }
      out += `${item.action} ${item.id} ${subject}\n`;
    }
    return out;
  }

  private async readTodoFile(state: OperationState, name: string): Promise<TodoItem[]> {
    const text = (await state.read(`${DIR}/${name}`)) ?? "";
    const actions: Record<string, RebaseAction> = {
      p: RebaseAction.PICK,
      pick: RebaseAction.PICK,
      r: RebaseAction.REWORD,
      reword: RebaseAction.REWORD,
      e: RebaseAction.EDIT,
      edit: RebaseAction.EDIT,
      s: RebaseAction.SQUASH,
      squash: RebaseAction.SQUASH,
      f: RebaseAction.FIXUP,
      fixup: RebaseAction.FIXUP,
    };
    const lines: { action: RebaseAction; id: string }[] = [];
    for (const line of text.split("\n")) {
      const match = /^(\w+)\s+([0-9a-f]{4,64})/.exec(line.trim());
      if (!match || !actions[match[1]]) continue;
      lines.push({ action: actions[match[1]], id: match[2] });
    }
    const ids = await expandCommitIds(
      { commits: this.commits, refs: this.refsStore, state },
      lines.map((l) => l.id),
    );
    return lines.map((l, k) => ({ action: l.action, id: ids[k] }));
  }

  /**
   * The commits of `head` not in `upstream`, merges dropped, oldest first: git's
   * `rev-list --reverse --topo-order --no-merges upstream..head` as its todo list is made
   * (`sort_in_topological_order` in graph order: a commit once all its children are out,
   * the last parent's line first, then reversed).
   */
  private async commitsToRebase(head: ObjectId, upstream: ObjectId): Promise<ObjectId[]> {
    const upstreamCommits = new Set<ObjectId>();
    for await (const commitId of this.commits.walkAncestry([upstream])) {
      upstreamCommits.add(commitId);
    }
    const parents = new Map<ObjectId, ObjectId[]>();
    const stack = [head];
    while (stack.length > 0) {
      const id = stack.pop() as ObjectId;
      if (parents.has(id) || upstreamCommits.has(id)) continue;
      const commit = await this.commits.load(id);
      if (!commit) continue;
      parents.set(id, commit.parents);
      stack.push(...commit.parents);
    }
    // the indegree within the range (1 + the children there), as git counts it
    const indegree = new Map<ObjectId, number>();
    for (const id of parents.keys()) indegree.set(id, 1);
    for (const list of parents.values()) {
      for (const p of list) {
        const d = indegree.get(p);
        if (d) indegree.set(p, d + 1);
      }
    }
    const order: ObjectId[] = [];
    const queue: ObjectId[] = [...parents.keys()].filter((id) => indegree.get(id) === 1);
    // graph order: the queue is a stack, the tips taken in the walk's order
    queue.reverse();
    while (queue.length > 0) {
      const id = queue.pop() as ObjectId;
      for (const p of parents.get(id) ?? []) {
        const d = indegree.get(p);
        if (!d) continue;
        indegree.set(p, d - 1);
        if (d - 1 === 1) queue.push(p);
      }
      indegree.set(id, 0);
      order.push(id);
    }
    return order.reverse().filter((id) => (parents.get(id)?.length ?? 0) <= 1);
  }

  /**
   * The commits of `range` (HEAD's side of `upstream...head`) whose patch-id one of
   * upstream's side has: git's `--cherry-mark` of the todo list (merges and commits that
   * change nothing never match).
   */
  private async appliedUpstream(
    head: ObjectId,
    upstream: ObjectId,
    range: ObjectId[],
  ): Promise<Set<ObjectId>> {
    const skipped = new Set<ObjectId>();
    const headSide = new Set<ObjectId>();
    for await (const id of this.commits.walkAncestry([head])) headSide.add(id);
    // upstream's side: reachable from upstream, not from HEAD
    const left: ObjectId[] = [];
    const seen = new Set<ObjectId>();
    const stack = [upstream];
    while (stack.length > 0) {
      const id = stack.pop() as ObjectId;
      if (seen.has(id) || headSide.has(id)) continue;
      seen.add(id);
      const commit = await this.commits.load(id);
      if (!commit) continue;
      left.push(id);
      stack.push(...commit.parents);
    }
    if (left.length === 0) return skipped;
    const idOf = async (id: ObjectId) => {
      const commit = await this.commits.load(id);
      if (!commit || commit.parents.length > 1) return undefined;
      const parentTree = commit.parents[0]
        ? await this.commits.getTree(commit.parents[0])
        : undefined;
      return patchId(this.trees, this.blobs, parentTree, commit.tree);
    };
    const upstreamIds = new Set<string>();
    for (const id of left) {
      const p = await idOf(id);
      if (p) upstreamIds.add(p);
    }
    for (const id of range) {
      const p = await idOf(id);
      if (p && upstreamIds.has(p)) skipped.add(id);
    }
    return skipped;
  }

  private async isAncestor(a: ObjectId, b: ObjectId): Promise<boolean> {
    if (a === b) return true;
    for await (const commitId of this.commits.walkAncestry([b])) {
      if (commitId === a) return true;
    }
    return false;
  }
}

/** The commands in a todo or done list (comments and blank lines not counted). */
function countCommands(text: string): number {
  return text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;
}

/** git's advice where a todo command could not run and was put back (`rescheduled_advice`). */
function rescheduledAdvice(line: string): string {
  return [
    "hint: Could not execute the todo command",
    "hint: ",
    `hint:     ${line}`,
    "hint: ",
    "hint: It has been rescheduled; To edit the command before continuing, please",
    "hint: edit the todo list first:",
    "hint: ",
    "hint:     git rebase --edit-todo",
    "hint:     git rebase --continue",
  ].join("\n");
}

/** The author of git's `author-script` (`GIT_AUTHOR_NAME='...'`, ...). */
function parseAuthorScript(text: string): PersonIdent | undefined {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^(GIT_AUTHOR_\w+)='(.*)'$/.exec(line);
    if (match) values[match[1]] = match[2].replaceAll("'\\''", "'");
  }
  const date = /^@?(\d+)\s+([+-]\d{4})$/.exec(values.GIT_AUTHOR_DATE ?? "");
  if (!values.GIT_AUTHOR_NAME || !date) return undefined;
  return {
    name: values.GIT_AUTHOR_NAME,
    email: values.GIT_AUTHOR_EMAIL ?? "",
    timestamp: Number(date[1]),
    tzOffset: date[2],
  };
}
