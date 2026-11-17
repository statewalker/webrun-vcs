import {
  type Commit,
  EMPTY_TREE_ID,
  isSymbolicRef,
  type ObjectId,
  type PersonIdent,
  type RefLogOptions,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  CommitNotFoundError,
  InvalidArgumentError,
  NoHeadError,
  NoRebaseInProgressError,
  RebaseTodoMissingError,
  UpstreamRequiredError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { RebaseResult, RebaseTodoLine } from "../results/rebase-result.js";
import { RebaseAction, RebaseStatus } from "../results/rebase-result.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { localTimezoneOffset } from "./git-ident.js";
import { favorOf, UNMERGED_FILES_MESSAGE } from "./merge-command.js";
import { configBool, conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
  abbrev,
  conflictsComment,
  FlatTreeCache,
  flatTree,
  indexChanges,
  OperationState,
  readIndex,
  storeFlatTreeOver,
  subjectOf,
  switchTrees,
  treeDelta,
} from "./merge-support.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { type PatchIdTrees, patchId } from "./patch-id.js";
import { reflogMessages } from "./reflog-messages.js";
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

/** Tracked files checked at once against the worktree (stats and hashes in flight). */
const WORKTREE_CHECK_BATCH = 32;

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
  /** `--committer-date-is-author-date` (kept in `rebase-merge/cdate_is_adate`) */
  private committerDateIsAuthorDate = false;
  /** `--ignore-date` / `--reset-author-date` (kept in `rebase-merge/ignore_date`) */
  private ignoreDate = false;
  private autoStash?: boolean;
  private reapplyCherryPicks = false;
  /** The commits read by the walks that make the todo list */
  private loadedCommits = new Map<ObjectId, Commit>();
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

  /**
   * The committer of the rebased commits (default: resolved as git resolves it,
   * `GIT_COMMITTER_*`, `committer.*`, `user.*`). The picks keep their authors.
   */
  setCommitter(committer: PersonIdent): this {
    this.checkCallable();
    this.committer = committer;
    return this;
  }

  /**
   * `--committer-date-is-author-date`: each rebased commit's committer date is its author
   * date. Like git, it implies `--force-rebase`: a branch already on its upstream is
   * rebased all the same.
   */
  setCommitterDateIsAuthorDate(value: boolean): this {
    this.checkCallable();
    this.committerDateIsAuthorDate = value;
    return this;
  }

  /**
   * `--ignore-date` (`--reset-author-date`): each rebased commit's author date is the
   * current time (git's `ignore_author_date`: the clock, not `GIT_AUTHOR_DATE`). Implies
   * `--force-rebase`, as in git.
   */
  setIgnoreDate(value: boolean): this {
    this.checkCallable();
    this.ignoreDate = value;
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

    // HEAD already contains upstream: nothing to do (unless forced, as the date options do)
    const forced = this.committerDateIsAuthorDate || this.ignoreDate;
    if (!forced && (await this.isAncestor(onto, headId))) {
      const branch = headName.replace(/^refs\/heads\//, "");
      output.push(`Current branch ${branch} is up to date.`);
      await unstash();
      return { status: RebaseStatus.UP_TO_DATE, newHead: headId, output };
    }

    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const ontoTreeId = await this.commits.getTree(onto);
    const ontoTree = await flatTree(this.trees, ontoTreeId);
    // nothing of HEAD's to replay: HEAD moves to upstream
    if (await this.isAncestor(headId, onto)) {
      const refused = await switchTrees(this.context(worktree), headTree, ontoTree, {
        action: "checkout",
        operation: "rebase",
        targetTree: ontoTreeId,
      });
      if (refused) {
        await unstash();
        return { status: RebaseStatus.FAILED, message: refused.message, output };
      }
      await state.setRef("ORIG_HEAD", headId);
      // as git's rebase: HEAD detached at upstream ("(start)"), then the branch moved
      await this.refsStore.set("HEAD", onto, this.startLog());
      await this.finishBranch(headName, onto, onto);
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
      targetTree: ontoTreeId,
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
    if (this.committerDateIsAuthorDate) await state.write(`${DIR}/cdate_is_adate`, "");
    if (this.ignoreDate) await state.write(`${DIR}/ignore_date`, "");
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
    await this.refsStore.set("HEAD", onto, this.startLog());
    return this.processTodo(state, worktree, output);
  }

  /** Picks what is left in `git-rebase-todo`, then finishes the rebase. */
  private async processTodo(
    state: OperationState,
    worktree: Worktree | undefined,
    output: string[] = [],
  ): Promise<RebaseResult> {
    // git's read_populate_todo: a todo that cannot be read is an error, not an empty list
    if (state.supported && (await state.read(`${DIR}/git-rebase-todo`)) === undefined) {
      throw new RebaseTodoMissingError(`${DIR}/git-rebase-todo`);
    }
    let todo = await this.readTodoFile(state, "git-rebase-todo");
    // git's read_populate_todo: the commands done so far and the total (`end`)
    let doneCount = countCommands((await state.read(`${DIR}/done`)) ?? "");
    if (todo.length > 0) await state.write(`${DIR}/end`, `${doneCount + todo.length}\n`);
    while (todo.length > 0) {
      const item = todo[0];
      const rest = todo.slice(1);
      const line = await this.todoText([item]);
      // git's save_todo: the rest written to `git-rebase-todo` first (a lock file renamed
      // into place), then the command appended to `done` (O_APPEND); a crash between the
      // two loses the `done` line, never the todo
      await state.write(`${DIR}/git-rebase-todo`, await this.todoText(rest));
      await state.append(`${DIR}/done`, line);
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
    const onto = (await state.read(`${DIR}/onto`))?.trim() ?? newHead;
    await this.finishBranch(headName, newHead, onto);
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
    const parentId = commit.parents[0];
    const parentTreeId = parentId ? await this.commits.getTree(parentId) : undefined;
    const subject = subjectOf(commit.message);
    const label = `${abbrev(item.id)} (${subject})`;
    const baseLabel = parentId ? `parent of ${label}` : "(empty tree)";
    // the trees as merge-ort reads them: what all three hold alike is never read
    const merge = await mergeStoredTrees(
      this.context(worktree),
      storedBase(parentTreeId, baseLabel, () => flats.get(parentTreeId)),
      headTreeId,
      commit.tree,
      {
        oursLabel: "HEAD",
        theirsLabel: label,
        baseLabel,
        style: conflictStyleOf(this.workingCopy),
        favor: favorOf(this.contentStrategy),
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
        ...ortConfigOptions(this.workingCopy, worktree),
      },
      (id) => flats.get(id),
    );
    const target = await ortResultEntries(this.blobs, merge);
    // only the directories the pick changes are stored again
    const treeId = await storeFlatTreeOver(this.trees, headTreeId, merge.ours, target);
    const conflicts = [...merge.conflicts.values()];
    // only the paths HEAD and the result differ on are switched
    const delta = await treeDelta(this.trees, headTreeId, treeId);
    const refused = await switchTrees(this.context(worktree), delta.from, delta.to, {
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
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort(compareGitPaths);
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
    if (treeId === headTreeId && commit.tree !== (parentTreeId ?? EMPTY_TREE_ID)) {
      // a pick that became empty is dropped (git's drop_redundant_commits), and with it the
      // pick's state; a commit that was empty from the start is kept (allow_empty)
      await state.removeRef("AUTO_MERGE");
      output.push(`dropping ${item.id} ${subject} -- patch contents already upstream`);
      return undefined;
    }
    let message = commit.message;
    if (item.action === RebaseAction.REWORD && this.interactiveHandler) {
      message = this.interactiveHandler.modifyCommitMessage(message);
    }
    const newId = await this.commitOnto(state, headId, treeId, commit.author, message, item.action);
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
          this.resolveAuthor();
        const text =
          (await state.read("MERGE_MSG")) ??
          (await state.read(`${DIR}/message`)) ??
          commit?.message ??
          "";
        const newId = await this.commitOnto(
          state,
          headId,
          treeId,
          author,
          cleanupMessage(text),
          "continue",
        );
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
    await this.finishBranch(headName, origHead, undefined, true);
    const autostash = (await state.read(`${DIR}/autostash`))?.trim();
    await state.removeRef("REBASE_HEAD", "AUTO_MERGE");
    await state.remove("MERGE_MSG", DIR);
    const output = autostash ? await applyAutostash(this.context(worktree), autostash) : [];
    return { status: RebaseStatus.ABORTED, newHead: origHead, output };
  }

  /**
   * git's `require_clean_work_tree(<action>)` on this command's working copy, without
   * rebasing: the refusal (`cannot <action>: You have unstaged changes.` ...), or undefined
   * when the tree is clean or HEAD is unborn. `git pull --rebase` checks it before fetching,
   * as `pull with rebase`.
   */
  async checkCleanWorkTree(action = "rebase"): Promise<RebaseResult | undefined> {
    const headId = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (!headId) return undefined;
    return this.uncleanWorktree(headId, this.worktreeAccess, action);
  }

  /** Refuses as git's require_clean_work_tree: unstaged, then staged changes. */
  private async uncleanWorktree(
    headId: ObjectId,
    worktree: Worktree | undefined,
    action = "rebase",
  ): Promise<RebaseResult | undefined> {
    const { index, unmerged } = await readIndex(this.staging);
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const staged = indexChanges(index, headTree);
    const unstaged: string[] = [...unmerged];
    if (worktree) {
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      const indexTime = this.staging.getUpdateTime();
      // every tracked file is checked (git's refresh_index); several at a time, as git's
      // preload-index stats in parallel, the results kept in index order
      const entries = [...index];
      for (let k = 0; k < entries.length; k += WORKTREE_CHECK_BATCH) {
        const batch = entries.slice(k, k + WORKTREE_CHECK_BATCH);
        const modified = await Promise.all(
          batch.map(([path, entry]) => worktreeModified(worktree, path, entry, trust, indexTime)),
        );
        // a deleted file is an unstaged change too
        batch.forEach(([path], j) => {
          if (modified[j]) unstaged.push(path);
        });
      }
    }
    if (staged.length === 0 && unstaged.length === 0) return undefined;
    const lines = [`error: cannot ${action}: You have unstaged changes.`];
    if (unstaged.length === 0)
      lines[0] = `error: cannot ${action}: Your index contains uncommitted changes.`;
    else if (staged.length > 0)
      lines.push("error: additionally, your index contains uncommitted changes.");
    lines.push("error: Please commit or stash them.");
    return {
      status: RebaseStatus.UNCOMMITTED_CHANGES,
      uncommittedChanges: [...new Set([...unstaged, ...staged])].sort(),
      message: lines.join("\n"),
    };
  }

  /** A commit made on the detached HEAD, logged `rebase (<step>): <subject>`. */
  private async commitOnto(
    state: OperationState,
    parent: ObjectId,
    tree: ObjectId,
    picked: PersonIdent,
    message: string,
    step: string,
  ): Promise<ObjectId> {
    // git's try_to_commit: reset_ident_date() first, so each pick is committed (and its
    // reflog line written) at its own time
    this.resetClock();
    // the pick keeps its author; the committer is resolved as git's git_committer_info
    let author = picked;
    let committer = this.committer ?? this.resolveCommitter();
    // git's try_to_commit: --ignore-date dates the author now (the clock, local offset),
    // --committer-date-is-author-date gives the committer the author's date
    if (await state.exists(`${DIR}/ignore_date`)) {
      const now = this.clock();
      author = { ...author, timestamp: now, tzOffset: localTimezoneOffset(now) };
    }
    if (await state.exists(`${DIR}/cdate_is_adate`)) {
      committer = { ...committer, timestamp: author.timestamp, tzOffset: author.tzOffset };
    }
    const id = await this.commits.store({ tree, parents: [parent], author, committer, message });
    const action = reflogMessages.rebaseStep(this.reflogAction("rebase"), step);
    await this.refsStore.set(
      "HEAD",
      id,
      this.reflogLine(reflogMessages.pick(action, message), this.committer),
    );
    return id;
  }

  /** HEAD detached at upstream: `rebase (start): checkout <upstream as given>`. */
  private startLog(): RefLogOptions {
    const onto = this.upstreamCommitName ?? this.upstreamCommit ?? "";
    return this.reflogLine(
      reflogMessages.rebaseStart(this.reflogAction("rebase"), onto),
      this.committer,
    );
  }

  private async rewritten(state: OperationState, from: ObjectId, to: ObjectId): Promise<void> {
    // appended, as git's record_in_rewritten
    await state.append(`${DIR}/rewritten-list`, `${from} ${to}\n`);
  }

  /**
   * The branch rebased moves to `id` and HEAD is attached to it again, logged as git's
   * move_to_original_branch: `rebase (finish): <branch> onto <onto>` for the branch,
   * `rebase (finish): returning to <branch>` for HEAD; an abort logs both
   * `rebase (abort): returning to <branch>`. A detached rebase leaves HEAD where it is.
   */
  private async finishBranch(
    headName: string,
    id: ObjectId,
    onto: ObjectId | undefined,
    abort = false,
  ): Promise<void> {
    const action = this.reflogAction("rebase");
    if (headName.startsWith("refs/")) {
      const headLog = this.reflogLine(
        abort
          ? reflogMessages.rebaseAbort(action, headName)
          : reflogMessages.rebaseFinishHead(action, headName),
        this.committer,
      );
      const branchLog = abort
        ? headLog
        : this.reflogLine(
            reflogMessages.rebaseFinishBranch(action, headName, onto ?? id),
            this.committer,
          );
      await this.refsStore.set(headName, id, branchLog);
      await this.refsStore.setSymbolic("HEAD", headName, headLog);
    } else {
      // git's abort of a detached rebase: HEAD back at orig-head ("rebase (abort): returning
      // to <id>"); a finished one stays where the picks left it
      const log = abort
        ? this.reflogLine(reflogMessages.rebaseAbort(action, id), this.committer)
        : undefined;
      await this.refsStore.set("HEAD", id, log);
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
    const walk = [upstream];
    while (walk.length > 0) {
      const id = walk.pop() as ObjectId;
      if (upstreamCommits.has(id)) continue;
      upstreamCommits.add(id);
      walk.push(...((await this.loadCommit(id))?.parents ?? []));
    }
    const parents = new Map<ObjectId, ObjectId[]>();
    const stack = [head];
    while (stack.length > 0) {
      const id = stack.pop() as ObjectId;
      if (parents.has(id) || upstreamCommits.has(id)) continue;
      const commit = await this.loadCommit(id);
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
   * change nothing never match). As git's cherry_pick_list and patch-ids.c: upstream's side
   * ends at the merge bases (not HEAD's whole history), every commit gets the cheap id of
   * its diff's headers, and the full patch-id is computed only where those collide.
   */
  private async appliedUpstream(
    head: ObjectId,
    upstream: ObjectId,
    range: ObjectId[],
  ): Promise<Set<ObjectId>> {
    const skipped = new Set<ObjectId>();
    const left = await this.onlyReachableFrom(upstream, head);
    if (left.length === 0 || range.length === 0) return skipped;
    // each tree read once: a commit's tree is its child's parent tree
    const treeEntries = new Map<ObjectId, TreeEntry[]>();
    const trees: PatchIdTrees = {
      loadTree: async function* (this: void, id: ObjectId) {
        let entries = treeEntries.get(id);
        if (!entries) {
          entries = [];
          for await (const e of loadTree(id)) entries.push(e);
          treeEntries.set(id, entries);
        }
        yield* entries;
      },
    };
    const loadTree = (id: ObjectId) => this.trees.loadTree(id);
    const patchIdOf = async (id: ObjectId, headerOnly: boolean) => {
      const commit = await this.loadCommit(id);
      if (!commit || commit.parents.length > 1) return undefined;
      const parentTree = commit.parents[0]
        ? (await this.loadCommit(commit.parents[0]))?.tree
        : undefined;
      return patchId(trees, this.blobs, parentTree, commit.tree, { headerOnly });
    };
    const full = new Map<ObjectId, string | undefined>();
    const fullOf = async (id: ObjectId) => {
      if (!full.has(id)) full.set(id, await patchIdOf(id, false));
      return full.get(id);
    };
    // HEAD's side by header id
    const byHeader = new Map<string, ObjectId[]>();
    for (const id of range) {
      const header = await patchIdOf(id, true);
      if (!header) continue;
      const list = byHeader.get(header) ?? [];
      list.push(id);
      byHeader.set(header, list);
    }
    if (byHeader.size === 0) return skipped;
    for (const id of left) {
      const header = await patchIdOf(id, true);
      const candidates = header ? byHeader.get(header) : undefined;
      if (!candidates) continue;
      const mine = await fullOf(id);
      if (!mine) continue;
      for (const c of candidates) {
        if (!skipped.has(c) && (await fullOf(c)) === mine) skipped.add(c);
      }
    }
    return skipped;
  }

  /**
   * The commits reachable from `tip` and not from `other` (`other..tip`), merges left out,
   * without walking `other`'s whole history: revision.c's limit_list, newest commit first,
   * what `other` reaches painted uninteresting, done once every commit still queued is
   * uninteresting (and a few more, git's slop against clock skew).
   */
  private async onlyReachableFrom(tip: ObjectId, other: ObjectId): Promise<ObjectId[]> {
    interface Node {
      id: ObjectId;
      time: number;
      parents?: ObjectId[];
      uninteresting: boolean;
      queued: boolean;
    }
    const nodes = new Map<ObjectId, Node>();
    const queue: Node[] = [];
    /** The interesting commits still queued */
    let interesting = 0;
    const push = async (id: ObjectId, uninteresting: boolean) => {
      const known = nodes.get(id);
      if (known) {
        if (uninteresting) markUninteresting(known);
        return;
      }
      const commit = await this.loadCommit(id);
      if (!commit) return;
      const node: Node = { id, time: commit.committer.timestamp, uninteresting, queued: true };
      nodes.set(id, node);
      if (!uninteresting) interesting++;
      // newest first, ties in the order queued (commit_list_insert_by_date)
      let k = queue.length;
      while (k > 0 && queue[k - 1].time < node.time) k--;
      queue.splice(k, 0, node);
    };
    // mark_parents_uninteresting: through the commits already walked
    const markUninteresting = (start: Node) => {
      const stack = [start];
      while (stack.length > 0) {
        const n = stack.pop() as Node;
        if (n.uninteresting && n !== start) continue;
        if (!n.uninteresting && n.queued) interesting--;
        n.uninteresting = true;
        for (const p of n.parents ?? []) {
          const pn = nodes.get(p);
          if (pn && !pn.uninteresting) stack.push(pn);
        }
      }
    };
    await push(other, true);
    await push(tip, false);
    const out: Node[] = [];
    let slop = 5;
    while (queue.length > 0) {
      const node = queue.shift() as Node;
      node.queued = false;
      if (!node.uninteresting) interesting--;
      node.parents = (await this.loadCommit(node.id))?.parents ?? [];
      if (node.uninteresting) markUninteresting(node);
      else out.push(node);
      for (const p of node.parents) await push(p, node.uninteresting);
      if (interesting === 0) {
        if (--slop <= 0) break;
      } else slop = 5;
    }
    return out.filter((n) => !n.uninteresting && (n.parents?.length ?? 0) <= 1).map((n) => n.id);
  }

  /** A commit, read once for the walks that pick the todo list. */
  private async loadCommit(id: ObjectId): Promise<Commit | undefined> {
    let commit = this.loadedCommits.get(id);
    if (!commit) {
      commit = await this.commits.load(id);
      if (commit) this.loadedCommits.set(id, commit);
    }
    return commit;
  }

  private async isAncestor(a: ObjectId, b: ObjectId): Promise<boolean> {
    // the store's walk: commit-graph generations cut it short
    return this.commits.isAncestor(a, b);
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
