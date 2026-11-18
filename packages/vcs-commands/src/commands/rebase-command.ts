import {
  type Commit,
  EMPTY_TREE_ID,
  isSymbolicRef,
  type ObjectId,
  type PersonIdent,
  type RefLogOptions,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
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
import { coreBool, createIdAbbreviator, worktreeModeTrust } from "./core-config.js";
import { createDescriber, type DescribeOptions } from "./git-describe.js";
import { hostEnvironmentOf, localTimezoneOffset } from "./git-ident.js";
import { favorOf, UNMERGED_FILES_MESSAGE } from "./merge-command.js";
import { configBool, configValue, conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
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
import { commentPrefixOf, stripspace } from "./message-cleanup.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeBaseTree, mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { type PatchIdTrees, patchId } from "./patch-id.js";
import { formatCommitPretty, loadRefDecorations, type RefDecorations } from "./pretty-format.js";
import { reflogMessages } from "./reflog-messages.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { expandCommitId, expandCommitIds } from "./sequencer-pick.js";
import {
  applyAutostash,
  cleanupMessage,
  createAutostash,
  resetMerge,
} from "./sequencer-support.js";
import { trailerConfigOf } from "./trailers.js";
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
  /** The commit picked, or the original merge of a `merge -C` (none for the other commands) */
  id: ObjectId;
  /**
   * The line's text after the id (`# <subject>`, as `rebase.instructionFormat` made it, or as
   * the todo file has it): written back unchanged, and what `Could not apply` names. The
   * argument of `label`, `reset` and `merge` (`<label> # <oneline>`), the
   * whole line of a comment (a blank line is one)
   */
  rest?: string;
  /** `merge -c`: the message edited (`-C`: kept) */
  editMessage?: boolean;
}

/** The commands that carry no commit. */
const NO_COMMIT_ACTIONS = new Set<RebaseAction>([
  RebaseAction.COMMENT,
  RebaseAction.LABEL,
  RebaseAction.RESET,
]);

/** sequencer.c's GIT_MAX_LABEL_LENGTH (NAME_MAX - ".lock" - 16) */
const MAX_LABEL_LENGTH = 255 - 5 - 16;

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
 * With {@link RebaseCommand.setRebaseMerges} (`--rebase-merges`) the merges are kept: git's
 * todo list of `label`, `reset` and `merge -C` commands, run as git's sequencer runs them.
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
  /** `--rebase-merges` (undefined: `rebase.rebaseMerges`) */
  private rebaseMerges?: boolean;
  /** `--rebase-merges=rebase-cousins` */
  private rebaseCousins = false;
  /** The commits read by the walks that make the todo list */
  private loadedCommits = new Map<ObjectId, Commit>();
  /** The flat trees the picks read (each pick's result is the next one's HEAD) */
  private flatTrees?: FlatTreeCache;
  /** Commit subjects, for the todo and done lines */
  private readonly subjects = new Map<ObjectId, string>();
  /** The refs' decorations, for `%d` in rebase.instructionFormat (loaded once) */
  private decorations?: RefDecorations;
  /** What loading the decorations printed (`warning: invalid replace ref <name>`) */
  private decorationWarnings: string[] = [];

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
    this.upstreamCommit = await this.resolveRef(upstream, (n) => `fatal: invalid upstream '${n}'`);
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
   * `--rebase-merges[=rebase-cousins|no-rebase-cousins]`: the branch's merges are kept. The
   * todo list (git's make_script_with_merges) labels each side branch's tip (`label`),
   * starts each branch from where it forked (`reset`), and recreates each merge with its
   * original message (`merge -C <merge> <label> # <oneline>`); a side branch that forked
   * off below the merge base stays on its fork point unless `rebase-cousins`. `false`
   * (`--no-rebase-merges`) drops the merges; default `rebase.rebaseMerges`.
   */
  setRebaseMerges(mode: boolean | "rebase-cousins" | "no-rebase-cousins"): this {
    this.checkCallable();
    this.rebaseMerges = mode !== false;
    this.rebaseCousins = mode === "rebase-cousins";
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
      if (autostash) {
        output.push(`Created autostash: ${await this.abbreviateObjectId(autostash)}`);
      }
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

    // `--rebase-merges` (else `rebase.rebaseMerges`, a boolean or a cousins mode)
    let rebaseMerges = this.rebaseMerges;
    let rebaseCousins = this.rebaseCousins;
    if (rebaseMerges === undefined) {
      const value = configValue(this.workingCopy, "rebase.rebaseMerges");
      if (value !== undefined) {
        const bool = parseGitBool(value);
        rebaseMerges = bool ?? true;
        rebaseCousins = bool === undefined && value === "rebase-cousins";
      }
    }
    // the commits to pick: HEAD's, not upstream's, merges dropped (kept with
    // --rebase-merges), oldest first
    const range = await this.commitsToRebase(headId, onto, !!rebaseMerges);
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
          output.push(
            `warning: skipped previously applied commit ${await this.abbreviateObjectId(id)}`,
          );
      }
      if (configBool(this.workingCopy, "advice.skippedCherryPicks", true)) {
        output.push(
          "hint: use --reapply-cherry-picks to include skipped commits",
          'hint: Disable this message with "git config set advice.skippedCherryPicks false"',
        );
      }
    }
    let todo: TodoItem[] = [];
    let generated: string | undefined;
    if (rebaseMerges) {
      generated = await this.makeScriptWithMerges(headId, onto, range, skipped, rebaseCousins);
      // the list as the (non-interactive) editing leaves it: comments dropped, blanks collapsed
      todo = parseTodoText(stripspace(generated, commentPrefixOf(this.workingCopy)));
      if (todo.some((item) => item.action === RebaseAction.RESET && item.rest === "[new root]")) {
        throw new InvalidArgumentError(
          "rebaseMerges",
          true,
          "rebase --rebase-merges of a history with a root commit in the range ([new root]) is not supported",
        );
      }
    }
    const steps: RebaseTodoLine[] = [];
    for (const id of rebaseMerges ? [] : ids) {
      const commit = await this.commits.load(id);
      steps.push({
        action: RebaseAction.PICK,
        commit: await this.abbreviateObjectId(id),
        shortMessage: subjectOf(commit?.message ?? ""),
      });
    }
    if (!rebaseMerges) this.interactiveHandler?.prepareSteps(steps);
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
    const commands = todo.filter((item) => item.action !== RebaseAction.COMMENT).length;
    await state.write(`${DIR}/end`, `${commands}\n`);
    await state.write(`${DIR}/msgnum`, "0\n");
    await state.write(`${DIR}/done`, "");
    const todoText = await this.todoText(todo);
    // load_ref_decorations' warnings, printed while the todo list is made
    output.push(...this.decorationWarnings.splice(0));
    await state.write(
      `${DIR}/git-rebase-todo.backup`,
      `${generated ?? todoText}\n# Rebase ${await this.abbreviateObjectId(onto)}..${await this.abbreviateObjectId(headId)} onto ${await this.abbreviateObjectId(onto)} (${commands} command${commands === 1 ? "" : "s"})\n`,
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
    const commandCount = (items: TodoItem[]) =>
      items.filter((i) => i.action !== RebaseAction.COMMENT).length;
    if (commandCount(todo) > 0) {
      await state.write(`${DIR}/end`, `${doneCount + commandCount(todo)}\n`);
    }
    while (todo.length > 0) {
      const item = todo[0];
      const rest = todo.slice(1);
      const line = await this.todoText([item]);
      // git's save_todo: the rest written to `git-rebase-todo` first (a lock file renamed
      // into place), then the command appended to `done` (O_APPEND); a crash between the
      // two loses the `done` line, never the todo
      await state.write(`${DIR}/git-rebase-todo`, await this.todoText(rest));
      await state.append(`${DIR}/done`, line);
      if (item.action !== RebaseAction.COMMENT) {
        doneCount++;
        await state.write(`${DIR}/msgnum`, `${doneCount}\n`);
      }
      // what the previous command left (pick_commits unlinks it before each one)
      await state.remove(`${DIR}/message`, `${DIR}/stopped-sha`);
      await state.remove(`${DIR}/author-script`, "MERGE_HEAD");
      await state.removeRef("AUTO_MERGE", "REBASE_HEAD");
      const outcome = await this.runTodoCommand(state, worktree, item, output);
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
    await this.deleteRewrittenRefs(state);
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
    // git's allow_ff (no --force-rebase): a commit whose parent is HEAD is kept as it is
    if (
      (item.action === RebaseAction.PICK || item.action === RebaseAction.EDIT) &&
      commit.parents[0] === headId &&
      !(await state.exists(`${DIR}/cdate_is_adate`)) &&
      !(await state.exists(`${DIR}/ignore_date`))
    ) {
      await this.writeAuthorScript(state, commit.author);
      const refused = await this.fastForward(state, worktree, headId, item.id);
      if (refused) return refused;
      await this.rewritten(state, item.id, item.id);
      if (item.action === RebaseAction.EDIT) {
        return { status: RebaseStatus.EDIT, newHead: item.id, currentCommit: item.id };
      }
      return undefined;
    }
    // the trees read once: a pick's result is the next one's HEAD, a commit the next one's
    // parent; what is written and staged is only what the pick changes
    this.flatTrees ??= new FlatTreeCache(this.trees);
    const flats = this.flatTrees;
    const headTreeId = await this.commits.getTree(headId);
    const parentId = commit.parents[0];
    const parentTreeId = parentId ? await this.commits.getTree(parentId) : undefined;
    const subject = subjectOf(commit.message);
    // short_commit_name: repo_find_unique_abbrev with DEFAULT_ABBREV
    const short = await this.abbreviateObjectId(item.id);
    const label = `${short} (${subject})`;
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
          `error: could not apply ${short}... ${subject}`,
          "hint: Resolve all conflicts manually, mark them as resolved with",
          'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
          'hint: You can instead skip this commit: run "git rebase --skip".',
          'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".',
          // the todo line's rest (`# <subject>`, or as `rebase.instructionFormat` made it)
          `Could not apply ${short}... ${item.rest ?? (await this.instructionText(item.id))}`,
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

  /** One todo command run: a pick, or a `label`, `reset`, `merge`; a result when it stops. */
  private async runTodoCommand(
    state: OperationState,
    worktree: Worktree | undefined,
    item: TodoItem,
    output: string[],
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    switch (item.action) {
      case RebaseAction.COMMENT:
        return undefined;
      case RebaseAction.LABEL:
        return this.label(state, item.rest ?? "");
      case RebaseAction.RESET:
        return this.reset(state, worktree, item.rest ?? "");
      case RebaseAction.MERGE:
        return this.merge(state, worktree, item, output);
      default:
        return this.pick(state, worktree, item, output);
    }
  }

  /** git's do_label: `refs/rewritten/<name>` at HEAD, listed in `refs-to-delete`. */
  private async label(
    state: OperationState,
    name: string,
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    if (name === "#") {
      return {
        status: RebaseStatus.FAILED,
        message: `error: illegal label name: '${name}'`,
        reschedule: true,
      };
    }
    const head = await this.resolveHead();
    await this.refsStore.set(`refs/rewritten/${name}`, head);
    await state.append(`${DIR}/refs-to-delete`, `refs/rewritten/${name}\n`);
    return undefined;
  }

  /**
   * sequencer.c's lookup_label: `refs/rewritten/<label>`, else the label as a commit-ish;
   * the name the merge's conflict markers show (the ref, or the name as written).
   */
  private async lookupLabel(
    state: OperationState,
    label: string,
  ): Promise<{ id: ObjectId; name: string } | undefined> {
    const rewritten = `refs/rewritten/${label}`;
    const ref = await this.refsStore.resolve(rewritten).catch(() => undefined);
    if (ref?.objectId) return { id: ref.objectId, name: rewritten };
    const named = await this.refsStore.resolve(label).catch(() => undefined);
    if (named?.objectId) return { id: await this.peelToCommit(named.objectId), name: label };
    for (const prefix of ["refs/tags/", "refs/heads/", "refs/remotes/"]) {
      const r = await this.refsStore.resolve(`${prefix}${label}`).catch(() => undefined);
      if (r?.objectId) return { id: await this.peelToCommit(r.objectId), name: label };
    }
    if (/^[0-9a-f]{4,64}$/i.test(label)) {
      try {
        const id = await expandCommitId(
          { commits: this.commits, refs: this.refsStore, state },
          label.toLowerCase(),
        );
        if (id) return { id, name: label };
      } catch {
        // not an abbreviation of one commit
      }
    }
    return undefined;
  }

  /** An annotated tag peeled to what it tags. */
  private async peelToCommit(id: ObjectId): Promise<ObjectId> {
    let current = id;
    for (
      let depth = 0;
      depth < 32 && this.tagsStore && (await this.tagsStore.has(current));
      depth++
    ) {
      const tag = await this.tagsStore.load(current);
      if (!tag) break;
      current = tag.object;
    }
    return current;
  }

  /** git's do_reset: HEAD, the index and the worktree moved to a label's commit. */
  private async reset(
    state: OperationState,
    worktree: Worktree | undefined,
    arg: string,
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    // the label ends at the first blank (a `reset <label> # <oneline>` line)
    const end = arg.search(/[ \t\n\r]/);
    const name = end < 0 ? arg : arg.slice(0, end);
    const found = await this.lookupLabel(state, name);
    if (!found) {
      return {
        status: RebaseStatus.FAILED,
        message: `error: could not resolve '${name}'`,
        reschedule: true,
      };
    }
    const headId = await this.resolveHead();
    const headTree = await this.commits.getTree(headId);
    const targetTree = await this.commits.getTree(found.id);
    const delta = await treeDelta(this.trees, headTree, targetTree);
    const refused = await switchTrees(this.context(worktree), delta.from, delta.to, {
      action: "checkout",
      operation: "reset",
      targetTree,
    });
    if (refused) {
      return { status: RebaseStatus.FAILED, message: refused.message, reschedule: true };
    }
    await this.refsStore.set(
      "HEAD",
      found.id,
      this.reflogLine(
        `${reflogMessages.rebaseStep(this.reflogAction("rebase"), "reset")}: '${name}'`,
        this.committer,
      ),
    );
    return undefined;
  }

  /**
   * git's do_merge for one merge head: the original merge (`-C <commit>`) recreated on HEAD
   * with its message and author, merge-ort merging the label's commit; a fast-forward to the
   * original when HEAD and the heads are its parents; nothing when the head is already in
   * HEAD. A conflict stops as a pick does (`Could not apply <abbrev>... <label> # <oneline>`).
   */
  private async merge(
    state: OperationState,
    worktree: Worktree | undefined,
    item: TodoItem,
    output: string[],
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    const arg = item.rest ?? "";
    // the merge heads, up to a `#` that starts the oneline
    const heads: { id: ObjectId; name: string }[] = [];
    let mergeArgEnd = arg.length;
    let oneline: string | undefined;
    let p = 0;
    for (;;) {
      while (p < arg.length && /[ \t\n]/.test(arg[p] as string)) p++;
      if (p >= arg.length) break;
      if (arg[p] === "#" && (p + 1 >= arg.length || /[ \t\n\r]/.test(arg[p + 1] as string))) {
        p++;
        while (p < arg.length && /[ \t\n]/.test(arg[p] as string)) p++;
        oneline = arg.slice(p);
        break;
      }
      let k = p;
      while (k < arg.length && !/[ \t\n]/.test(arg[k] as string)) k++;
      const label = arg.slice(p, k);
      const found = await this.lookupLabel(state, label);
      if (!found) {
        return {
          status: RebaseStatus.FAILED,
          message: `error: could not resolve '${label}'\nerror: unable to parse '${label}'`,
          reschedule: true,
        };
      }
      heads.push(found);
      p = k;
      mergeArgEnd = k;
    }
    if (heads.length === 0) {
      return { status: RebaseStatus.FAILED, message: `error: nothing to merge: '${arg}'` };
    }
    if (heads.length > 1) {
      throw new InvalidArgumentError(
        "merge",
        arg,
        "rebase --rebase-merges: an octopus merge (several merge heads) is not supported",
      );
    }
    const original = item.id ? await this.commits.load(item.id) : undefined;
    const headId = await this.resolveHead();
    const forced =
      (await state.exists(`${DIR}/cdate_is_adate`)) || (await state.exists(`${DIR}/ignore_date`));
    // HEAD the original's first parent, the heads its other parents: the original is kept
    if (
      !forced &&
      original &&
      original.parents[0] === headId &&
      original.parents.length === heads.length + 1 &&
      heads.every((h, k) => original.parents[k + 1] === h.id)
    ) {
      const refused = await this.fastForward(state, worktree, headId, item.id);
      if (refused) return refused;
      await this.rewritten(state, item.id, item.id);
      if (item.editMessage) await this.amendMergeMessage(state, item.id);
      return undefined;
    }
    let message: string;
    let author: PersonIdent;
    if (original) {
      // find_commit_subject: the message from its first non-blank line
      message = original.message.replace(/^([ \t\r]*\n)+/, "");
      author = original.author;
    } else {
      author = this.resolveAuthor();
      message =
        oneline !== undefined
          ? oneline
          : `Merge branch '${arg.slice(0, mergeArgEnd).replace(/^[ \t\n]+/, "")}'`;
    }
    await this.writeAuthorScript(state, author);
    await state.write("MERGE_MSG", message);
    const head = heads[0] as { id: ObjectId; name: string };
    const bases = await revisionMergeBases(this.commits, headId, head.id);
    if (bases[0] === head.id) {
      // the head is already in HEAD: nothing to merge
      if (item.id) await this.rewritten(state, item.id, headId);
      return undefined;
    }
    await state.write("MERGE_HEAD", head.id);
    await state.write("MERGE_MODE", "no-ff");
    const headCommitTree = await this.commits.getTree(headId);
    const headTree = await this.commits.getTree(head.id);
    const common = {
      style: conflictStyleOf(this.workingCopy),
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      ...ortConfigOptions(this.workingCopy, worktree),
    };
    const base = await mergeBaseTree(
      {
        commits: this.commits,
        trees: this.trees,
        blobs: this.blobs,
        abbreviate: (id) => this.abbreviateObjectId(id),
      },
      headId,
      head.id,
      bases,
      common,
    );
    const merge = await mergeStoredTrees(
      { trees: this.trees, blobs: this.blobs },
      base,
      headCommitTree,
      headTree,
      {
        ...common,
        oursLabel: "HEAD",
        theirsLabel: head.name,
        baseLabel: base.label,
        favor: favorOf(this.contentStrategy),
      },
    );
    const target = await ortResultEntries(this.blobs, merge);
    const treeId = await storeFlatTreeOver(this.trees, headCommitTree, merge.ours, target);
    const conflicts = [...merge.conflicts.values()];
    const delta = await treeDelta(this.trees, headCommitTree, treeId);
    const refused = await switchTrees(this.context(worktree), delta.from, delta.to, {
      action: "merge",
      operation: "merge",
      conflicts,
      targetTree: treeId,
    });
    if (refused) {
      // could not even attempt to merge: rescheduled
      await state.remove("MERGE_MSG", "MERGE_HEAD", "MERGE_MODE");
      if (item.id) await state.setRef("REBASE_HEAD", item.id);
      return {
        status: RebaseStatus.FAILED,
        currentCommit: item.id || undefined,
        message: `${refused.message}\nerror: could not even attempt to merge '${arg.slice(0, mergeArgEnd)}'`,
        reschedule: true,
      };
    }
    if (conflicts.length > 0 || !merge.clean) {
      output.push(...merge.messages);
      await state.setRef("AUTO_MERGE", treeId);
      // the message as it is (do_merge appends no conflict list), also for --continue
      await state.write(`${DIR}/message`, message);
      // record_in_rewritten runs before the stop: the merge maps to HEAD as it is
      if (item.id) {
        await this.rewritten(state, item.id, headId);
        await state.write(`${DIR}/stopped-sha`, `${item.id}\n`);
        await state.setRef("REBASE_HEAD", item.id);
        await state.write(`${DIR}/patch`, "");
      }
      const short = item.id ? await this.abbreviateObjectId(item.id) : "";
      return {
        status: RebaseStatus.STOPPED,
        ...(item.id ? { currentCommit: item.id } : {}),
        conflicts: [...new Set(merge.conflicts.keys())].sort(),
        message: item.id ? `Could not apply ${short}... ${arg}` : `Could not merge ${arg}`,
      };
    }
    // git commit -n -F MERGE_MSG --cleanup=verbatim: the merge committed, its state removed
    const newId = await this.commitOnto(state, headId, treeId, author, message, "merge", [head.id]);
    await state.remove("MERGE_MSG", "MERGE_HEAD", "MERGE_MODE");
    await state.removeRef("AUTO_MERGE");
    if (item.id) await this.rewritten(state, item.id, newId);
    if (item.editMessage) await this.amendMergeMessage(state, newId);
    return undefined;
  }

  /**
   * `merge -c` without an editor to run (git's `commit --amend -e` with a no-op editor): the
   * merge committed again with its message cleaned up as an edited one (`strip`).
   */
  private async amendMergeMessage(state: OperationState, id: ObjectId): Promise<void> {
    const commit = await this.commits.load(id);
    if (!commit) return;
    const message = cleanupMessage(commit.message, commentPrefixOf(this.workingCopy));
    this.resetClock();
    let committer = this.committer ?? this.resolveCommitter();
    if (await state.exists(`${DIR}/cdate_is_adate`)) {
      committer = {
        ...committer,
        timestamp: commit.author.timestamp,
        tzOffset: commit.author.tzOffset,
      };
    }
    const newId = await this.commits.store({
      tree: commit.tree,
      parents: commit.parents,
      author: commit.author,
      committer,
      message,
    });
    const action = reflogMessages.rebaseStep(this.reflogAction("rebase"), "merge");
    await this.refsStore.set(
      "HEAD",
      newId,
      this.reflogLine(reflogMessages.pick(action, message), this.committer),
    );
  }

  /**
   * git's fast_forward_to: the worktree switched to `to` (refused as a merge would be) and
   * HEAD moved there, logged `rebase: fast-forward`; the refusal reschedules the command.
   */
  private async fastForward(
    state: OperationState,
    worktree: Worktree | undefined,
    from: ObjectId,
    to: ObjectId,
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    const delta = await treeDelta(
      this.trees,
      await this.commits.getTree(from),
      await this.commits.getTree(to),
    );
    const refused = await switchTrees(this.context(worktree), delta.from, delta.to, {
      action: "merge",
      operation: "rebase",
      targetTree: await this.commits.getTree(to),
    });
    if (refused) {
      await state.setRef("REBASE_HEAD", to);
      return {
        status: RebaseStatus.FAILED,
        currentCommit: to,
        message: refused.message,
        reschedule: true,
      };
    }
    await this.refsStore.set(
      "HEAD",
      to,
      this.reflogLine(`${this.reflogAction("rebase")}: fast-forward`, this.committer),
    );
    return undefined;
  }

  /** The labels' refs (`refs-to-delete`) removed, as git's sequencer_remove_state does. */
  private async deleteRewrittenRefs(state: OperationState): Promise<void> {
    const text = (await state.read(`${DIR}/refs-to-delete`)) ?? "";
    for (const name of text.split("\n")) {
      if (!name.startsWith("refs/rewritten/")) continue;
      if (await this.refsStore.has(name).catch(() => false)) await this.refsStore.delete(name);
    }
  }

  /**
   * git's make_script_with_merges: the todo list of `--rebase-merges` for `range` (the
   * commits to rebase, oldest first): each side branch picked from where it forked
   * (`reset`), its tip labeled, each merge recreated (`merge -C`), branch points labeled,
   * the branches in the order their merges name them, HEAD's last.
   */
  private async makeScriptWithMerges(
    headId: ObjectId,
    upstream: ObjectId,
    range: ObjectId[],
    skipped: Set<ObjectId>,
    rebaseCousins: boolean,
  ): Promise<string> {
    const comment = commentPrefixOf(this.workingCopy);
    const maxLength =
      Number.parseInt(configValue(this.workingCopy, "rebase.maxLabelLength") ?? "", 10) ||
      MAX_LABEL_LENGTH;
    const commit2label = new Map<ObjectId, string>();
    const labels = new Set<string>();
    // the first merge base is the bottom of `upstream...HEAD`: labeled "onto"
    const bases = await revisionMergeBases(this.commits, upstream, headId);
    if (bases[0]) {
      commit2label.set(bases[0], "onto");
      labels.add("onto");
    }
    const encoder = new TextEncoder();
    const labelOid = async (oid: ObjectId, wanted?: string): Promise<string> => {
      const known = commit2label.get(oid);
      if (known !== undefined) return known;
      let label: string;
      if (wanted === undefined) {
        label = await this.abbreviateObjectId(oid);
        if (labels.has(label)) {
          // lengthened until no label has it, else the whole id
          const start = label.length + 1;
          label = oid;
          for (let i = start; i < oid.length; i++) {
            if (!labels.has(oid.slice(0, i))) {
              label = oid.slice(0, i);
              break;
            }
          }
        }
      } else {
        // alphanumerics and other characters than ASCII kept, the rest a single dash
        let buf = "";
        let bytes = 0;
        for (const ch of wanted) {
          if (bytes + 1 >= maxLength) break;
          if (/^[A-Za-z0-9]$/.test(ch)) {
            buf += ch;
            bytes++;
          } else if ((ch.codePointAt(0) as number) >= 0x80) {
            const n = encoder.encode(ch).length;
            if (bytes + n > maxLength) break;
            buf += ch;
            bytes += n;
          } else if (buf.length > 0 && !buf.endsWith("-")) {
            buf += "-";
            bytes++;
          }
        }
        if (buf === "") buf = `rev-${await this.abbreviateObjectId(oid)}`;
        if (
          (buf.length === 40 && /^[0-9a-fA-F]{40}$/.test(buf)) ||
          buf === "#" ||
          labels.has(buf)
        ) {
          let i = 2;
          while (labels.has(`${buf}-${i}`)) i++;
          buf = `${buf}-${i}`;
        }
        label = buf;
      }
      labels.add(label);
      commit2label.set(oid, label);
      return label;
    };
    // the branch each commit is decorated by (load_branch_decorations: refs/heads/ only,
    // the last name in order is the one get_name_decoration gives)
    const branchOf = new Map<ObjectId, string>();
    const heads: { name: string; objectId?: ObjectId; target?: string }[] = [];
    for await (const ref of this.refsStore.list("refs/heads/")) {
      if (ref.name.startsWith("refs/heads/")) heads.push(ref);
    }
    heads.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ref of heads) {
      const value =
        ref.objectId && ref.target === undefined
          ? ref.objectId
          : (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (value) branchOf.set(await this.peelToCommit(value), ref.name.slice("refs/heads/".length));
    }

    const interesting = new Set(range);
    const commit2todo = new Map<ObjectId, string>();
    const tips: ObjectId[] = [];
    // first phase: the onelines, the tips of merged branches labeled
    for (const id of range) {
      const commit = await this.loadCommit(id);
      if (!commit) throw new CommitNotFoundError(id);
      const parentTree = commit.parents[0]
        ? (await this.loadCommit(commit.parents[0]))?.tree
        : EMPTY_TREE_ID;
      const empty = commit.tree === parentTree;
      if (!empty && skipped.has(id)) continue;
      const oneline = await this.instructionText(id);
      const toMerge = commit.parents.slice(1);
      if (toMerge.length === 0) {
        commit2todo.set(id, `pick ${id} ${oneline}${empty ? ` ${comment} empty` : ""}`);
        continue;
      }
      // a label from the message: `Merge branch 'x'`, `Merge pull request #1 from x`
      let fromMessage = oneline;
      const quoted = /^# Merge [^']*'([^']*)'/.exec(oneline);
      if (quoted) fromMessage = quoted[1] as string;
      else if (oneline.startsWith("# Merge pull request ")) {
        const at = oneline.indexOf(" from ", "# Merge pull request ".length);
        if (at >= 0) fromMessage = oneline.slice(at + " from ".length);
      }
      let line = `merge -C ${id}`;
      for (const parent of toMerge) {
        const label = branchOf.get(parent) ?? fromMessage;
        if (!interesting.has(parent)) {
          line += ` ${await labelOid(parent)}`;
          continue;
        }
        tips.push(parent);
        line += ` ${await labelOid(parent, label)}`;
      }
      commit2todo.set(id, `${line} ${oneline}`);
    }
    // second phase: branch points (commits with several children) labeled, HEAD a tip
    const childSeen = new Set<ObjectId>();
    for (const [k, id] of range.entries()) {
      for (const parent of (await this.loadCommit(id))?.parents ?? []) {
        if (!interesting.has(parent)) continue;
        if (childSeen.has(parent)) await labelOid(parent, "branch-point");
        else childSeen.add(parent);
      }
      if (k === range.length - 1) tips.push(id);
    }
    // third phase: each tip's branch, walking first parents down to what is shown
    let out = "label onto\n";
    const shown = new Set<ObjectId>();
    for (const tip of tips) {
      if (shown.has(tip)) continue;
      const tipLabel = commit2label.get(tip);
      out += tipLabel !== undefined ? `\n${comment} Branch ${tipLabel}\n` : "\n";
      const list: ObjectId[] = [];
      let commit: ObjectId | undefined = tip;
      while (commit !== undefined && interesting.has(commit) && !shown.has(commit)) {
        list.unshift(commit);
        const parents: ObjectId[] = (await this.loadCommit(commit))?.parents ?? [];
        commit = parents[0];
      }
      if (commit === undefined) out += `reset ${rebaseCousins ? "onto" : "[new root]"}\n`;
      else {
        let to = commit2label.get(commit);
        if (to === undefined && !rebaseCousins) to = await labelOid(commit);
        if (to === undefined || to === "onto") out += "reset onto\n";
        else out += `reset ${to} ${await this.instructionText(commit)}\n`;
      }
      for (const id of list) {
        const todo = commit2todo.get(id);
        if (todo !== undefined) out += `${todo}\n`;
        const label = commit2label.get(id);
        if (label !== undefined) out += `label ${label}\n`;
        shown.add(id);
      }
    }
    return out;
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
      // a stopped merge: its other parent (git commit reads MERGE_HEAD)
      const mergeHead = (await state.read("MERGE_HEAD"))?.trim();
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
        await this.commitOnto(
          state,
          headId,
          treeId,
          author,
          cleanupMessage(text, commentPrefixOf(this.workingCopy)),
          "continue",
          mergeHead && /^[0-9a-f]{40,64}$/.test(mergeHead) ? [mergeHead] : [],
        );
        await state.removeRef("AUTO_MERGE");
      }
      // sequencer_continue: the stopped commit maps to HEAD, committed or not
      if (await state.exists(`${DIR}/stopped-sha`)) {
        await this.rewritten(state, id, await this.resolveHead());
      }
    }
    // REBASE_HEAD stays until the next command runs (pick_commits deletes it), so a
    // continue of the last command leaves it behind, as git does
    await state.remove(
      "MERGE_HEAD",
      "MERGE_MODE",
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
      "MERGE_HEAD",
      "MERGE_MODE",
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
    await this.deleteRewrittenRefs(state);
    await state.remove("MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", DIR);
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
    otherParents: ObjectId[] = [],
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
    const id = await this.commits.store({
      tree,
      parents: [parent, ...otherParents],
      author,
      committer,
      message,
    });
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
      if (item.action === RebaseAction.COMMENT) {
        out += `${item.rest ?? ""}\n`;
        continue;
      }
      if (NO_COMMIT_ACTIONS.has(item.action)) {
        out += `${item.action}${item.rest ? ` ${item.rest}` : ""}\n`;
        continue;
      }
      if (item.action === RebaseAction.MERGE) {
        const id = item.id ? ` ${item.editMessage ? "-c" : "-C"} ${item.id}` : "";
        out += `merge${id}${item.rest ? ` ${item.rest}` : ""}\n`;
        continue;
      }
      item.rest ??= await this.instructionText(item.id);
      out += `${item.action} ${item.id}${item.rest ? ` ${item.rest}` : ""}\n`;
    }
    return out;
  }

  /**
   * The text after a pick's id, as git 2.5x's sequencer_make_script writes it: the commit
   * through `rebase.instructionFormat` (default `# %s`; a format that does not start with
   * `#` gets `# ` before it), `%h` unabbreviated (its pretty context has abbrev 0), trailing
   * blanks dropped.
   */
  private async instructionText(id: ObjectId): Promise<string> {
    let format = configValue(this.workingCopy, "rebase.instructionFormat") ?? "";
    if (format === "") format = "# %s";
    if (!format.startsWith("#")) format = `# ${format}`;
    if (format === "# %s") {
      let subject = this.subjects.get(id);
      if (subject === undefined) {
        subject = subjectOf((await this.commits.load(id))?.message ?? "");
        this.subjects.set(id, subject);
      }
      return `# ${subject}`;
    }
    const commit = await this.commits.load(id);
    if (!commit) return format;
    // %d and friends: the refs decorate the commits (load_ref_decorations, no filter)
    if (this.decorations === undefined && /%[-+ ]?(?:[dD]|\(decorate)/.test(format)) {
      this.decorations = await this.refDecorations();
    }
    // the list goes through the todo editing's stripspace: no trailing blanks
    const text = await formatCommitPretty(format, commit, id, {
      now: this.clock(),
      ...(this.decorations ? { decorations: this.decorations } : {}),
      ...(format.includes("%(trailers") ? { trailers: trailerConfigOf(this.workingCopy) } : {}),
      ...(format.includes("%(describe") ? { describe: this.describer() } : {}),
    });
    return text.replace(/[ \t]+$/, "");
  }

  /** `%(describe)` of rebase.instructionFormat: git describe over this repository's tags. */
  private describer(): (id: ObjectId, options: DescribeOptions) => Promise<string> {
    const abbreviator = createIdAbbreviator(this._workingCopy);
    const tags = this.tagsStore;
    return createDescriber({
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      commits: this.commits,
      abbreviate: async (id, length) => {
        if (length === 0) return id;
        const lengths = await abbreviator.lengths([id], length);
        return id.slice(0, lengths.get(id) ?? 7);
      },
    });
  }

  /**
   * The decorations git's sequencer shows for `%d` (load_ref_decorations without a filter):
   * every ref, HEAD, the grafted and shallow commits, the objects replace refs replace.
   */
  private async refDecorations(): Promise<RefDecorations> {
    const replacements = await this.objectReplacements();
    const shallow = (await this.refsStore.getShallow?.().catch(() => undefined)) ?? [];
    const environment = hostEnvironmentOf(this._workingCopy);
    const objects = this._workingCopy.history?.objects;
    const tags = this.tagsStore;
    return loadRefDecorations({
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      ...(environment?.replaceRefBase !== undefined
        ? { replaceRefBase: environment.replaceRefBase }
        : {}),
      useReplaceRefs: this.useReplaceRefs(),
      grafted: new Set([...(replacements?.grafts.keys() ?? []), ...shallow]),
      ...(objects ? { hasObject: (id: ObjectId) => objects.has(id) } : {}),
      onWarning: (message) => this.decorationWarnings.push(message),
    });
  }

  private async readTodoFile(state: OperationState, name: string): Promise<TodoItem[]> {
    const items = parseTodoText(
      (await state.read(`${DIR}/${name}`)) ?? "",
      commentPrefixOf(this.workingCopy),
    );
    const withIds = items.filter((item) => item.id !== "");
    const ids = await expandCommitIds(
      { commits: this.commits, refs: this.refsStore, state },
      withIds.map((item) => item.id),
    );
    withIds.forEach((item, k) => {
      item.id = ids[k] as ObjectId;
    });
    return items;
  }

  /**
   * The commits of `head` not in `upstream`, merges dropped, oldest first: git's
   * `rev-list --reverse --topo-order --no-merges upstream..head` as its todo list is made
   * (`sort_in_topological_order` in graph order: a commit once all its children are out,
   * the last parent's line first, then reversed).
   */
  private async commitsToRebase(
    head: ObjectId,
    upstream: ObjectId,
    keepMerges = false,
  ): Promise<ObjectId[]> {
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
    order.reverse();
    return keepMerges ? order : order.filter((id) => (parents.get(id)?.length ?? 0) <= 1);
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

/** The todo commands git parses (parse_insn_line), by name and by abbreviation. */
const TODO_COMMANDS: Record<string, RebaseAction> = {
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
  l: RebaseAction.LABEL,
  label: RebaseAction.LABEL,
  t: RebaseAction.RESET,
  reset: RebaseAction.RESET,
  m: RebaseAction.MERGE,
  merge: RebaseAction.MERGE,
};

/**
 * A todo list's lines as git's parse_insn_line reads them: a blank or comment line kept as
 * a comment, a pick (its id, the rest of the line as written), `label`/`reset` with their
 * argument, `merge [-C|-c <id>] <rest>`. Lines of commands this does not run are left out.
 * The ids are as written (abbreviated ones still to expand).
 */
function parseTodoText(text: string, comment = "#"): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("\r") || line.startsWith(comment)) {
      items.push({ action: RebaseAction.COMMENT, id: "", rest: raw });
      continue;
    }
    const word = /^(\S+)(?:[ \t]+(.*))?$/.exec(line);
    const action = word ? TODO_COMMANDS[word[1] as string] : undefined;
    if (!word || !action) continue;
    const arg = word[2] ?? "";
    if (action === RebaseAction.LABEL || action === RebaseAction.RESET) {
      if (arg !== "") items.push({ action, id: "", rest: arg });
      continue;
    }
    if (action === RebaseAction.MERGE) {
      const flag = /^-([Cc])[ \t]+([0-9a-fA-F]{4,64})(?:[ \t]+(.*))?$/.exec(arg);
      if (flag) {
        items.push({
          action,
          id: (flag[2] as string).toLowerCase(),
          rest: flag[3] ?? "",
          ...(flag[1] === "c" ? { editMessage: true } : {}),
        });
      } else if (arg !== "") items.push({ action, id: "", rest: arg });
      continue;
    }
    // the rest of the line kept as written (trailing blanks included), as git's parse_insn_line
    const pick = /^([0-9a-f]{4,64})(?:[ \t]+(.*))?$/.exec(arg);
    if (!pick) continue;
    items.push({ action, id: pick[1] as string, rest: pick[2] ?? "" });
  }
  return items;
}
