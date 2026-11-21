import {
  type Commit,
  EMPTY_TREE_ID,
  isSymbolicRef,
  listObjectsWithPrefix,
  type ObjectId,
  type PersonIdent,
  type RefLogOptions,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { isIndexUnborn, type Worktree } from "@statewalker/vcs-working-tree";

import {
  CommitNotFoundError,
  InvalidArgumentError,
  NoHeadError,
  NoRebaseInProgressError,
  RebaseTodoMissingError,
  RefNotFoundError,
  UpstreamRequiredError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  type ContentMergeStrategy,
  FastForwardMode,
  type MergeResult,
  MergeStatus,
  MergeStrategy,
} from "../results/merge-result.js";
import type { RebaseResult, RebaseTodoLine } from "../results/rebase-result.js";
import { RebaseAction, RebaseStatus } from "../results/rebase-result.js";
import { coreBool, createIdAbbreviator, worktreeModeTrust } from "./core-config.js";
import { createDescriber, type DescribeOptions } from "./git-describe.js";
import {
  type GitCommitHookRun,
  gitCommitAfterHooks,
  gitCommitMessageHooks,
  runPostCheckoutHook,
  sequencerPostCommit,
  sequencerPrepareMessage,
} from "./git-hooks.js";
import { hostEnvironmentOf, localTimezoneOffset } from "./git-ident.js";
import { favorOf, MergeCommand } from "./merge-command.js";
import { configBool, configValue, conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
  conflictsComment,
  FlatTreeCache,
  flatTree,
  indexChanges,
  OperationState,
  readIndex,
  refsWatched,
  storeFlatTreeOver,
  subjectOf,
  switchTrees,
  treeDelta,
} from "./merge-support.js";
import { CleanupMode, commentPrefixOf, stripspace } from "./message-cleanup.js";
import { copyNotesForAmend, copyNotesForRebase } from "./notes-support.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeBaseTree, mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { type PatchIdTrees, patchId } from "./patch-id.js";
import { formatCommitPretty, loadRefDecorations, type RefDecorations } from "./pretty-format.js";
import {
  addExecCommands,
  combinedMessage,
  commentLines,
  countTodoCommands,
  formatTodo,
  isFinalFixup,
  isFixup,
  isNoop,
  isPickLike,
  messageBody,
  parseTodo,
  peekCommand,
  rearrangeSquash,
  squashMessageForFixup,
  squashTexts,
  subjectLength,
  type TodoItem,
  takesCommit,
  todoHelp,
} from "./rebase-todo.js";
import { reflogMessages, updateHeadExpecting } from "./reflog-messages.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { expandCommitId } from "./sequencer-pick.js";
import {
  applyAutostash,
  cleanupMessage,
  createAutostash,
  moveHeadAsReset,
  removeBranchState,
  resetMerge,
} from "./sequencer-support.js";
import { appendSignoff, trailerConfigOf } from "./trailers.js";
import { worktreeModified } from "./worktree-overwrite-checks.js";
import { usesBranch } from "./worktree-support.js";

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
  /** `--edit-todo`: the rest of the todo list edited (the interactive handler's editTodo) */
  EDIT_TODO = "edit-todo",
}

/**
 * Handler for interactive rebase (`git rebase -i`): it plays the editors git runs.
 */
export interface InteractiveHandler {
  /**
   * The sequence editor: the todo list as git shows it in the editor (abbreviated ids, the
   * help after it), returned edited. Run before {@link prepareSteps}.
   */
  editTodo?(todo: string): string | Promise<string>;

  /**
   * Modify the steps before execution (the todo list's commands, comments left out).
   * @param steps List of rebase steps to modify
   */
  prepareSteps?(steps: RebaseTodoLine[]): void;

  /**
   * The commit message editor (`reword`, the end of a `squash` chain, `fixup -c`, `merge
   * -c`): the text git puts in the editor (the message, or the chain's `# This is a
   * combination of N commits.` text), returned edited; git then strips the comments.
   * Without it the text is kept (as with an editor that changes nothing).
   */
  modifyCommitMessage?(message: string): string;
}

/** What an `exec` command did (git runs it in a shell). */
export interface RebaseExecResult {
  /** The exit status (0: success; 127, command not found, counts as 1) */
  exitCode: number;
  /** What the command printed, put in the result's output */
  output?: string[];
}

/**
 * Runs the command of an `exec` todo line (`exec <command>`, `--exec <command>`): git runs it
 * with the shell in the worktree; a portable rebase leaves that to its host. The index and
 * the worktree are read again after it, as git reads them.
 */
export type RebaseExecHandler = (command: string) => RebaseExecResult | Promise<RebaseExecResult>;

/** `--empty`: what becomes of a commit that becomes empty when picked. */
export type RebaseEmptyMode = "drop" | "keep" | "stop";

/** One entry of `rebase-merge/update-refs`: the ref, its value at the start, the new one. */
interface UpdateRefRecord {
  ref: string;
  before: ObjectId;
  after: ObjectId;
}

/** What a pick (do_pick_commit) did. */
type PickOutcome =
  | { kind: "ok" }
  | { kind: "dropped" }
  | {
      kind: "conflicts";
      /** do_pick_commit's lines (`error: could not apply ...` and hints, git commit's refusal) */
      lines: string[];
      conflicts: string[];
      /** What error_with_patch writes to `rebase-merge/message` */
      message?: string;
    }
  | { kind: "reschedule"; result: RebaseResult & { reschedule?: boolean } };

const ZERO_ID = "0000000000000000000000000000000000000000";

/**
 * What a todo command came to: nothing (go on), `checkTodo` (go on, the list read again if
 * it changed), or a result that stops the rebase (`reschedule`: the command goes back).
 */
type StepOutcome =
  | (Partial<RebaseResult> & { reschedule?: boolean; checkTodo?: boolean })
  | undefined;

/** sequencer.c's staged_changes_advice (no `-S`). */
const STAGED_CHANGES_ADVICE = `error: you have staged changes in your working tree
If these changes are meant to be squashed into the previous commit, run:

  git commit --amend 

If they are meant to go into a new commit, run:

  git commit 

In both cases, once you're done, continue with:

  git rebase --continue`;

/** rebase-interactive.c's edit_todo_list_advice. */
const EDIT_TODO_ADVICE = [
  "You can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'.",
  "Or you can abort the rebase with 'git rebase --abort'.",
];

/** Tracked files checked at once against the worktree (stats and hashes in flight). */
const WORKTREE_CHECK_BATCH = 32;

/** The state directory of git's merge backend. */
const DIR = "rebase-merge";

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
  /** `--signoff` (kept in `rebase-merge/signoff`) */
  private signoff = false;
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
  /** `--exec <command>` (each run after every pick) */
  private execCommands: string[] = [];
  /** Runs the `exec` commands */
  private execHandler?: RebaseExecHandler;
  /** `--[no-]reschedule-failed-exec` (undefined: rebase.rescheduleFailedExec) */
  private rescheduleFailedExec?: boolean;
  /** `--empty=drop|keep|stop` (undefined: git's default for the kind of rebase) */
  private emptyMode?: RebaseEmptyMode;
  /** `--[no-]keep-empty`: commits empty from the start are picked (default) */
  private keepEmpty = true;
  /** `--[no-]update-refs` (undefined: rebase.updateRefs) */
  private updateRefs?: boolean;
  /** `--[no-]autosquash` (undefined: rebase.autoSquash with an interactive rebase) */
  private autosquash?: boolean;
  /** `--root`: every commit of the branch rebased (onto the upstream given, else a new root) */
  private root = false;
  private noVerify = false;

  /** `--no-verify`: the pre-rebase hook does not run. */
  setNoVerify(noVerify: boolean): this {
    this.checkCallable();
    this.noVerify = noVerify;
    return this;
  }
  /** The command after the one running (git's peek_command), for record_in_rewritten */
  private nextCommand?: RebaseAction;

  /**
   * Set the upstream to rebase onto: a commit id or any revision (`main`, `HEAD~2`,
   * `v1.0`), resolved to a commit when the rebase starts (git's `lookup_commit_reference`
   * of `<upstream>`; "fatal: invalid upstream '<name>'" when it names none). The name given
   * is kept for the reflog and the messages (`checkout main`).
   *
   * @param upstream Upstream commit ID or revision
   */
  setUpstream(upstream: ObjectId | string): this {
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
    this.upstreamCommit = await this.resolveUpstream(upstream);
    this.upstreamCommitName = upstream;
    return this;
  }

  /**
   * builtin/rebase.c's `lookup_commit_reference_by_name(options.upstream_name)`: the commit
   * an upstream names, or git's "fatal: invalid upstream '<name>'" (exit 128).
   */
  private async resolveUpstream(name: string): Promise<ObjectId> {
    const fatal = (n: string) => `fatal: invalid upstream '${n}'`;
    try {
      return await this.resolveRef(name, fatal);
    } catch (error) {
      if (error instanceof RefNotFoundError) {
        throw new RefNotFoundError(name, fatal(name)).withExitCode(128);
      }
      throw error;
    }
  }

  /**
   * Set the upstream name for messages.
   *
   * @param name Display name for upstream
   */
  setUpstreamName(name: string): this {
    this.checkCallable();
    if (this.upstreamCommit === undefined) {
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

  /**
   * `--signoff`: each rebased commit gets git's `Signed-off-by: <committer>` trailer
   * (append_signoff: added unless the message's trailer block already ends with it), its
   * message cleaned up as git's `--signoff` commits clean it (whitespace). Like git, it
   * implies `--force-rebase`; the recreated merges are not signed off (git commits them
   * without `--signoff`).
   */
  setSignoff(value: boolean): this {
    this.checkCallable();
    this.signoff = value;
    return this;
  }

  /**
   * `--exec <command>` (`-x`): an `exec <command>` line after each pick (after its fixup and
   * squash chain) and each merge; implies an interactive list (no fast-forward shortcut) and
   * `--empty=keep` unless given. The commands run through {@link setExecHandler}.
   */
  setExec(commands: string[]): this {
    this.checkCallable();
    this.execCommands = [...commands];
    return this;
  }

  /**
   * Runs the `exec` commands (git runs them with the shell). Without one an `exec` fails as a
   * command not found does.
   */
  setExecHandler(handler: RebaseExecHandler): this {
    this.checkCallable();
    this.execHandler = handler;
    return this;
  }

  /**
   * `--reschedule-failed-exec`: an `exec` that fails goes back to the todo list's head, so
   * `--continue` runs it again (kept in `rebase-merge/reschedule-failed-exec`); default
   * `rebase.rescheduleFailedExec`, false.
   */
  setRescheduleFailedExec(value: boolean): this {
    this.checkCallable();
    this.rescheduleFailedExec = value;
    return this;
  }

  /**
   * `--empty=drop|keep|stop`: a pick that becomes empty (its change already in HEAD) is
   * dropped (`drop_redundant_commits`), kept as an empty commit (`keep_redundant_commits`) or
   * stops the rebase (git commit's "The previous cherry-pick is now empty"). git 2.5x's
   * default: `stop` for an interactive rebase, `keep` with `--exec`, else `drop`.
   */
  setEmpty(mode: RebaseEmptyMode): this {
    this.checkCallable();
    this.emptyMode = mode;
    return this;
  }

  /**
   * `--keep-empty` (default) / `--no-keep-empty`: commits that are empty from the start are
   * picked (` # empty` in the todo list) or left out.
   */
  setKeepEmpty(value: boolean): this {
    this.checkCallable();
    this.keepEmpty = value;
    return this;
  }

  /**
   * `--update-refs`: the other branches that point at rebased commits move with them
   * (`update-ref <ref>` lines, `rebase-merge/update-refs`, written at the end); branches
   * checked out in other worktrees are left alone. Default `rebase.updateRefs`.
   */
  setUpdateRefs(value: boolean): this {
    this.checkCallable();
    this.updateRefs = value;
    return this;
  }

  /**
   * `--autosquash`: `fixup! `, `amend! ` and `squash! ` commits moved after the commit they
   * name, as `fixup`, `fixup -C` and `squash`. Default: `rebase.autoSquash` for an
   * interactive rebase.
   */
  setAutosquash(value: boolean): this {
    this.checkCallable();
    this.autosquash = value;
    return this;
  }

  /**
   * `--root`: all the commits of the branch are rebased, its root commit too. With an
   * upstream set ({@link setUpstream}) that is `--root --onto <upstream>`; without one the
   * commits go onto a new root (git's squash_onto, a commit of the empty tree kept in
   * `rebase-merge/squash-onto`), so an unchanged list keeps the history as it is.
   */
  setRoot(value: boolean): this {
    this.checkCallable();
    this.root = value;
    return this;
  }

  async call(): Promise<RebaseResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();
    const worktree = this.worktreeAccess;
    const run = () => this.run(worktree);
    return worktree?.batch ? worktree.batch(run) : run();
  }

  private async run(worktree: Worktree | undefined): Promise<RebaseResult> {
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    // git's rebase_config, read before anything else (any operation): a rebase.rebaseMerges
    // that is neither a boolean nor a cousins mode dies
    for (const value of RemoteConfigStore.from(this.workingCopy).values("rebase.rebaseMerges")) {
      if (
        parseGitBool(value) === undefined &&
        value !== "rebase-cousins" &&
        value !== "no-rebase-cousins"
      ) {
        return {
          status: RebaseStatus.FAILED,
          message: `fatal: Unknown rebase-merges mode: ${value}`,
        };
      }
    }
    switch (this.operation) {
      case RebaseOperation.ABORT:
        return this.abort(state, worktree);
      case RebaseOperation.CONTINUE:
        return this.continueRebase(state, worktree);
      case RebaseOperation.SKIP:
        return this.skip(state, worktree);
      case RebaseOperation.EDIT_TODO:
        return this.editTodo(state);
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
    if (this.upstreamCommit === undefined && !this.root) {
      throw new UpstreamRequiredError("Upstream commit is required for rebase BEGIN operation");
    }
    // the upstream as given (setUpstream takes a name too) peeled to the commit it names
    // before anything is written, so HEAD is never set to a name ("main\n" in .git/HEAD)
    // an empty name too: "fatal: invalid upstream ''"
    if (this.upstreamCommit !== undefined) {
      this.upstreamCommit = await this.resolveUpstream(this.upstreamCommit);
    }
    if (await this.inProgress(state)) {
      return {
        status: RebaseStatus.FAILED,
        message:
          "fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.",
      };
    }
    // check_exec_cmd
    for (const command of this.execCommands) {
      if (command.includes("\n")) {
        return {
          status: RebaseStatus.FAILED,
          message: "error: exec commands cannot contain newlines",
        };
      }
      if (command === "")
        return { status: RebaseStatus.FAILED, message: "error: empty exec command" };
    }
    const headResolved = await this.refsStore.resolve("HEAD");
    if (!headResolved?.objectId) throw new NoHeadError("HEAD cannot be resolved");
    const headId = headResolved.objectId;
    const headRef = await this.refsStore.get("HEAD");
    const headName = headRef && isSymbolicRef(headRef) ? headRef.target : "detached HEAD";
    // --root without --onto: the commits go onto git's squash_onto, a commit of the empty
    // tree with no parent (their root is then a root again)
    let squashOnto: ObjectId | undefined;
    if (!this.upstreamCommit) {
      squashOnto = await this.createSquashOnto();
      this.upstreamCommitName = squashOnto;
    }
    const onto = (this.upstreamCommit ?? squashOnto) as ObjectId;

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

    // builtin/rebase.c's options as cmd_rebase settles them
    const config = this.workingCopy;
    const interactive = this.interactiveHandler !== undefined;
    const execs = this.execCommands;
    const autosquash =
      this.autosquash ?? (interactive && configBool(config, "rebase.autoSquash", false));
    const updateRefs = this.updateRefs ?? configBool(config, "rebase.updateRefs", false);
    const emptyMode: RebaseEmptyMode =
      this.emptyMode ?? (interactive ? "stop" : execs.length > 0 ? "keep" : "drop");
    const reschedule =
      this.rescheduleFailedExec ?? configBool(config, "rebase.rescheduleFailedExec", false);
    const abbreviate = configBool(config, "rebase.abbreviateCommands", false);
    const comment = commentPrefixOf(config);

    // git's can_fast_forward: HEAD already on upstream with a linear history since, nothing
    // to do (unless forced, as the date options and --signoff do); an interactive rebase,
    // --exec and --autosquash never take the shortcut (allow_preemptive_ff)
    const forced = this.committerDateIsAuthorDate || this.ignoreDate || this.signoff;
    const preemptive = !interactive && execs.length === 0 && this.autosquash !== true;
    if (preemptive && !this.root && (await this.canFastForward(onto, headId))) {
      const upToDate = headName.startsWith("refs/")
        ? `Current branch ${headName.replace(/^refs\/heads\//, "")} is up to date`
        : "HEAD is up to date";
      if (!forced) {
        output.push(`${upToDate}.`);
        // finish_rebase: what an earlier rebase left removed
        await state.removeRef("REBASE_HEAD", "AUTO_MERGE");
        await unstash();
        return { status: RebaseStatus.UP_TO_DATE, newHead: headId, output };
      }
      output.push(`${upToDate}, rebase forced.`);
    }

    // the pre-rebase hook, told the upstream as given (`--root` with --root), may refuse
    if (!this.noVerify) {
      const upstreamArg =
        this.root && !this.upstreamCommit ? "--root" : (this.upstreamCommitName ?? onto);
      const pre = await this.hooks.run("pre-rebase", { args: [upstreamArg] });
      if (pre && pre.exitCode !== 0) {
        await unstash();
        return {
          status: RebaseStatus.FAILED,
          // 2.43 dies (exit 128), 2.5x returns an error (exit 1)
          message: `${this.hooks.compatibility === "2.43" ? "fatal" : "error"}: The pre-rebase hook refused to rebase.`,
          output,
        };
      }
    }

    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    const ontoTreeId = await this.commits.getTree(onto);
    const ontoTree = await flatTree(this.trees, ontoTreeId);
    // HEAD moved to upstream with nothing replayed: HEAD detached at upstream ("(start)"),
    // then the branch moved, as git's rebase does for an empty (noop) todo
    const moveToOnto = async (status: RebaseStatus): Promise<RebaseResult> => {
      const refused = await switchTrees(this.context(worktree), headTree, ontoTree, {
        action: "checkout",
        operation: "rebase",
        targetTree: ontoTreeId,
      });
      if (refused) {
        await unstash();
        // the merge backend's checkout_onto, a fast-forward included
        return {
          status: RebaseStatus.FAILED,
          message: `${refused.message}\nerror: could not detach HEAD`,
          output,
        };
      }
      await state.setRef("ORIG_HEAD", headId);
      await this.refsStore.set("HEAD", onto, this.startLog());
      await runPostCheckoutHook(this.hooks, headId, onto, true);
      await this.finishBranch(headName, onto, onto);
      await unstash();
      return { status, newHead: onto, output };
    };
    // nothing of HEAD's to replay: HEAD moves to upstream
    if (await this.isAncestor(headId, onto)) return moveToOnto(RebaseStatus.FAST_FORWARD);

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
    // only merges since upstream (dropped without --rebase-merges): git's todo is a `noop`,
    // and the branch still moves to upstream
    if (range.length === 0) return moveToOnto(RebaseStatus.OK);
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
    // sequencer_make_script: a commit empty from the start says so (` # empty`), or is left
    // out with --no-keep-empty
    let script = "";
    if (rebaseMerges) {
      script = await this.makeScriptWithMerges(
        headId,
        onto,
        range,
        skipped,
        rebaseCousins,
        this.keepEmpty,
      );
    } else {
      for (const id of ids) {
        const empty = await this.originallyEmpty(id);
        if (empty && !this.keepEmpty) continue;
        script += `pick ${id} ${await this.instructionText(id)}${empty ? ` ${comment} empty` : ""}\n`;
      }
    }
    let items = parseTodo(script, comment).items;
    // complete_action: a list with nothing is a `noop`, then --update-refs, --autosquash
    // and --exec rework it before it is edited
    if (items.length === 0) items = [{ action: RebaseAction.NOOP, id: "", rest: "" }];
    // load_ref_decorations' warnings, printed while the todo list is made
    output.push(...this.decorationWarnings.splice(0));

    // init_basic_state / write_basic_state
    await state.write(`${DIR}/head-name`, `${headName}\n`);
    await state.write(`${DIR}/onto`, `${onto}\n`);
    await state.write(`${DIR}/orig-head`, `${headId}\n`);
    if (this.signoff) await state.write(`${DIR}/signoff`, "--signoff\n");
    if (emptyMode === "drop") await state.write(`${DIR}/drop_redundant_commits`, "");
    if (emptyMode === "keep") await state.write(`${DIR}/keep_redundant_commits`, "");
    if (this.committerDateIsAuthorDate) await state.write(`${DIR}/cdate_is_adate`, "");
    if (this.ignoreDate) await state.write(`${DIR}/ignore_date`, "");
    await state.write(
      `${DIR}/${reschedule ? "reschedule-failed-exec" : "no-reschedule-failed-exec"}`,
      "",
    );
    await state.write(`${DIR}/interactive`, "");
    if (autostash) await state.write(`${DIR}/autostash`, `${autostash}\n`);
    if (squashOnto) await state.write(`${DIR}/squash-onto`, `${squashOnto}\n`);

    if (updateRefs) items = await this.addUpdateRefCommands(state, items, comment);
    // the list's commits abbreviated once (the rearrangements below keep the same commits):
    // for the editor, and to read the names back without a look at the store
    const shorts = await this.shortIds(items);
    if (autosquash) {
      const rearranged = await rearrangeSquash(
        items,
        async (id) => subjectOf((await this.loadCommit(id))?.message ?? ""),
        (name) => this.autosquashTarget(name, shorts),
      );
      if (!rearranged) {
        await state.remove(DIR);
        await unstash();
        return {
          status: RebaseStatus.FAILED,
          message: "error: the script was already rearranged.",
          output,
        };
      }
      items = rearranged;
    }
    if (execs.length > 0) items = addExecCommands(items, execs);

    // edit_todo_list: the list (abbreviated ids, git's help) in the editor, the backup with
    // the full ids
    const missingCheck = this.missingCommitsCheckLevel(output);
    const commandTotal = countTodoCommands(items);
    const shortOnto = await this.abbreviateObjectId(onto);
    const help = todoHelp(
      commandTotal,
      comment,
      {
        shortRevisions: this.root
          ? await this.abbreviateObjectId(headId)
          : `${shortOnto}..${await this.abbreviateObjectId(headId)}`,
        shortOnto,
      },
      missingCheck === "error",
    );
    const editorText = `${formatTodo(items, { abbreviate, idOf: (id) => shorts.get(id) ?? id })}${help}`;
    await state.write(`${DIR}/git-rebase-todo`, editorText);
    await state.write(
      `${DIR}/git-rebase-todo.backup`,
      `${formatTodo(items, { abbreviate })}${help}`,
    );
    let edited: string;
    try {
      edited = await this.runSequenceEditor(editorText, shorts);
    } catch (error) {
      // complete_action's -2 (launch_sequence_editor failed): the autostash applied, the
      // state removed, HEAD where it was
      await state.remove(DIR);
      await unstash();
      return { status: RebaseStatus.FAILED, message: sequenceEditorFailure(error), output };
    }
    await state.write(`${DIR}/git-rebase-todo`, edited);
    const strippedTodo = stripspace(edited, comment);
    if (strippedTodo === "") {
      // an empty list aborts the rebase (complete_action's "nothing to do")
      await state.remove(DIR);
      await unstash();
      return { status: RebaseStatus.FAILED, message: "error: nothing to do", output };
    }
    // HEAD detached at upstream, the rebase left for `--edit-todo` (complete_action's -4)
    const fixTodo = async (lines: string[]): Promise<RebaseResult> => {
      const refused = await switchTrees(this.context(worktree), headTree, ontoTree, {
        action: "checkout",
        operation: "rebase",
        targetTree: ontoTreeId,
      });
      if (!refused) {
        await state.setRef("ORIG_HEAD", headId);
        await this.refsStore.set("HEAD", onto, this.startLog());
      }
      return { status: RebaseStatus.FAILED, message: lines.join("\n"), output };
    };
    const parsed = await this.resolveTodo(parseTodo(strippedTodo, comment).items, {
      known: shorts,
    });
    output.push(...parsed.warnings);
    if (parsed.errors.length > 0) return fixTodo([...parsed.errors, ...EDIT_TODO_ADVICE]);
    const missing = await this.missingCommits(items, parsed.items, missingCheck);
    if (missing.length > 0) {
      if (missingCheck === "error") {
        await state.write(`${DIR}/dropped`, "");
        return fixTodo(missing);
      }
      output.push(...missing);
    }
    await this.filterUpdateRefs(state, parsed.items);
    // the ids expanded, the list written again as git writes it
    let todo = parsed.items.map(({ line: _, ...item }) => item as TodoItem);

    // git's skip_unnecessary_picks (allow_ff): the first picks whose parent is where the
    // rebase starts are done already, HEAD starts at the last of them; the noops and drops
    // among and before them go to `done` with them
    let start = onto;
    let skippedPicks = 0;
    if (!forced) {
      for (; skippedPicks < todo.length; skippedPicks++) {
        const item = todo[skippedPicks] as TodoItem;
        if (isNoop(item)) continue;
        if (item.action !== RebaseAction.PICK) break;
        const parents = (await this.loadCommit(item.id))?.parents ?? [];
        if (parents.length !== 1 || parents[0] !== start) break;
        start = item.id;
      }
    }
    await state.write(`${DIR}/done`, formatTodo(todo.slice(0, skippedPicks)));
    todo = todo.slice(skippedPicks);
    // a fixup after the picks skipped: the base waits in rewritten-pending
    if (skippedPicks > 0 && isFixup(peekCommand(todo, 0))) {
      await state.append(`${DIR}/rewritten-pending`, `${start}\n`);
    }
    await state.write(`${DIR}/git-rebase-todo`, formatTodo(todo, { abbreviate }));
    const startTreeId = start === onto ? ontoTreeId : await this.commits.getTree(start);
    const startTree = start === onto ? ontoTree : await flatTree(this.trees, startTreeId);
    // detach HEAD at upstream, the worktree switched to it (as git's checkout of onto)
    const refused = await switchTrees(this.context(worktree), headTree, startTree, {
      action: "checkout",
      operation: "rebase",
      targetTree: startTreeId,
    });
    if (refused) {
      await state.remove(DIR);
      await unstash();
      return {
        status: RebaseStatus.FAILED,
        message: `${refused.message}\nerror: could not detach HEAD`,
        output,
      };
    }
    const commands = countTodoCommands(parsed.items);
    await state.write(`${DIR}/end`, `${commands}\n`);
    await state.write(`${DIR}/msgnum`, "0\n");
    // checkout_onto's reset_head: ORIG_HEAD expecting its old value, then HEAD detached
    // expecting the commit it left (as the reference-transaction hook sees both); an
    // ORIG_HEAD it cannot write is reported (as reset reports it) and HEAD moves all the same
    output.push(
      ...(await moveHeadAsReset(
        this.refsStore,
        state,
        headId,
        start,
        this.startLog(),
        "rebase: updating ORIG_HEAD",
        { detach: true },
      )),
    );
    // checkout_onto's post-checkout hook: the HEAD left, the commit the picks start from
    await runPostCheckoutHook(this.hooks, headId, start, true);
    // pick_commits runs the list as expanded (full command names), not as written
    return this.processTodo(state, worktree, output, todo);
  }

  /** Picks what is left in `git-rebase-todo`, then finishes the rebase (git's pick_commits). */
  private async processTodo(
    state: OperationState,
    worktree: Worktree | undefined,
    output: string[] = [],
    /** The list in memory (complete_action's), else read from `git-rebase-todo` */
    items?: TodoItem[],
  ): Promise<RebaseResult> {
    // git's read_populate_todo: a todo that cannot be read is an error, not an empty list
    if (state.supported && (await state.read(`${DIR}/git-rebase-todo`)) === undefined) {
      throw new RebaseTodoMissingError(`${DIR}/git-rebase-todo`);
    }
    const loaded = items ? { items, errors: [] } : await this.loadTodo(state);
    if (loaded.errors.length > 0) {
      return {
        status: RebaseStatus.FAILED,
        message: [...loaded.errors, "error: please fix this using 'git rebase --edit-todo'."].join(
          "\n",
        ),
        output,
      };
    }
    let todo = loaded.items;
    // pick_commits: what a stop left
    await state.remove(`${DIR}/message`, `${DIR}/stopped-sha`, `${DIR}/amend`, `${DIR}/patch`);
    // the commands done so far (`end`, the total, was written as the list was read)
    let doneCount = countCommands((await state.read(`${DIR}/done`)) ?? "");
    while (todo.length > 0) {
      const item = todo[0] as TodoItem;
      const rest = todo.slice(1);
      const line = formatTodo([item], { verbatim: true });
      // git's save_todo: the rest written to `git-rebase-todo` first (a lock file renamed
      // into place), then the command appended to `done` (O_APPEND); a crash between the
      // two loses the `done` line, never the todo
      const restText = formatTodo(rest, { verbatim: true });
      await state.write(`${DIR}/git-rebase-todo`, restText);
      await state.append(`${DIR}/done`, line);
      if (item.action !== RebaseAction.COMMENT || item.invalid) {
        doneCount++;
        await state.write(`${DIR}/msgnum`, `${doneCount}\n`);
      }
      // what the previous command left (pick_commits unlinks it before each one)
      await state.remove(`${DIR}/message`, `${DIR}/stopped-sha`);
      await state.remove(`${DIR}/author-script`, "MERGE_HEAD");
      // deleted whether they exist or not (git 2.5x's reference-transaction hook hears both)
      await state.deleteRef("AUTO_MERGE", "REBASE_HEAD");
      if (item.action === RebaseAction.BREAK) {
        // stopped_at_head
        return { status: RebaseStatus.STOPPED, message: await this.stoppedAtHead(), output };
      }
      this.nextCommand = peekCommand(rest, 0);
      const outcome = await this.runTodoCommand(state, worktree, todo, output);
      if (outcome?.reschedule) {
        // git's "It has been rescheduled": the command goes back to the todo's head (it
        // stays in `done`), so `--continue` runs it again
        await state.write(`${DIR}/git-rebase-todo`, formatTodo(todo, { verbatim: true }));
        if (item.id && takesCommit(item)) await state.setRef("REBASE_HEAD", item.id);
        const { reschedule: _, checkTodo: __, ...result } = outcome;
        return {
          ...result,
          status: result.status ?? RebaseStatus.FAILED,
          message: `${result.message ?? ""}\n${rescheduledAdvice(line.replace(/\n$/, ""))}`,
          output,
        };
      }
      if (outcome && outcome.status !== undefined) {
        const { reschedule: _, checkTodo: __, ...result } = outcome;
        return { ...result, status: outcome.status, output };
      }
      todo = rest;
      // reread_todo_if_changed: an exec (or an edited message) may have rewritten the list
      if (outcome?.checkTodo) {
        const now = (await state.read(`${DIR}/git-rebase-todo`)) ?? "";
        if (now !== restText) {
          const reread = await this.loadTodo(state);
          if (reread.errors.length > 0) {
            return {
              status: RebaseStatus.FAILED,
              message: [
                ...reread.errors,
                "error: please fix this using 'git rebase --edit-todo'.",
              ].join("\n"),
              output,
            };
          }
          todo = reread.items;
          await this.writeTotal(state, todo);
        }
      }
    }
    // done: the branch takes the new commits, HEAD attached to it again
    const headName = (await state.read(`${DIR}/head-name`))?.trim() ?? "detached HEAD";
    const newHead = await this.resolveHead();
    const onto = (await state.read(`${DIR}/onto`))?.trim() ?? newHead;
    const origHead = (await state.read(`${DIR}/orig-head`))?.trim();
    await this.finishBranch(headName, newHead, onto, false, origHead || undefined);
    await this.flushRewrittenPending(state);
    // `git notes copy --for-rewrite=rebase` fed rewritten-list
    const rewritten = await state.read(`${DIR}/rewritten-list`);
    if (rewritten) {
      await copyNotesForRebase(this.notesContext(), rewritten);
      // the post-rewrite hook told "rebase", rewritten-list on its stdin
      await this.hooks.run("post-rewrite", { args: ["rebase"], stdin: rewritten });
    }
    const autostash = (await state.read(`${DIR}/autostash`))?.trim();
    if (autostash) output.push(...(await applyAutostash(this.context(worktree), autostash)));
    await this.doUpdateRefs(state, output);
    await this.deleteRewrittenRefs(state);
    await state.remove(DIR);
    return { status: RebaseStatus.OK, newHead, output };
  }

  /** git's commit_tree of the empty tree with no parent and no message (squash_onto). */
  private async createSquashOnto(): Promise<ObjectId> {
    this.resetClock();
    const tree = await this.trees.storeTree([]);
    return this.commits.store({
      tree,
      parents: [],
      author: this.resolveAuthor(),
      committer: this.committer ?? this.resolveCommitter(),
      message: "",
    });
  }

  /** stopped_at_head: `Stopped at <abbrev> (<subject>)` (a `break`; get_message's label). */
  private async stoppedAtHead(): Promise<string> {
    const head = await this.resolveHead().catch(() => undefined);
    const commit = head ? await this.commits.load(head).catch(() => undefined) : undefined;
    if (!head || !commit) return "Stopped at HEAD";
    return `Stopped at ${await this.abbreviateObjectId(head)} (${subjectOf(commit.message)})`;
  }

  /**
   * git's record_in_rewritten: the commit waits in `rewritten-pending` while a fixup or
   * squash follows; otherwise the pending commits map to HEAD (`rewritten-list`).
   */
  private async recordInRewritten(
    state: OperationState,
    id: ObjectId,
    next: RebaseAction | undefined,
  ): Promise<void> {
    await state.append(`${DIR}/rewritten-pending`, `${id}\n`);
    if (!isFixup(next)) await this.flushRewrittenPending(state);
  }

  /** git's flush_rewritten_pending: each pending commit mapped to HEAD. */
  private async flushRewrittenPending(state: OperationState): Promise<void> {
    const pending = await state.read(`${DIR}/rewritten-pending`);
    if (!pending) return;
    const head = await this.resolveHead();
    let out = "";
    for (const line of pending.split("\n")) {
      if (line !== "") out += `${line} ${head}\n`;
    }
    await state.append(`${DIR}/rewritten-list`, out);
    await state.remove(`${DIR}/rewritten-pending`);
  }

  /**
   * pick_one_commit: a pick-like command run (do_pick_commit) and what follows from its
   * outcome: `edit` stops, the commit recorded as rewritten, a conflict stops.
   */
  private async pickOne(
    state: OperationState,
    worktree: Worktree | undefined,
    todo: TodoItem[],
    output: string[],
  ): Promise<StepOutcome> {
    const item = todo[0] as TodoItem;
    const finalFixup = isFinalFixup(todo);
    const outcome = await this.pick(state, worktree, item, output, finalFixup);
    if (outcome.kind === "reschedule") return outcome.result;
    const rest = item.rest ?? (await this.instructionText(item.id));
    if (item.action === RebaseAction.EDIT) {
      const conflicts = outcome.kind === "conflicts";
      const lines: string[] = conflicts ? [...outcome.lines] : [];
      if (!conflicts) {
        lines.push(`Stopped at ${await this.abbreviateObjectId(item.id)}...  ${rest}`);
      }
      lines.push(
        ...(await this.errorWithPatch(state, item.id, rest, {
          exitCode: conflicts ? 1 : 0,
          toAmend: outcome.kind === "ok",
          ...(conflicts ? { message: outcome.message } : {}),
          // the picked message (do_pick_commit's, --signoff's trailer appended)
          signoff: !conflicts && (await state.exists(`${DIR}/signoff`)),
        })),
      );
      return {
        status: conflicts ? RebaseStatus.STOPPED : RebaseStatus.EDIT,
        newHead: await this.resolveHead(),
        currentCommit: item.id,
        ...(conflicts ? { conflicts: outcome.conflicts } : {}),
        message: lines.join("\n"),
      };
    }
    if (outcome.kind === "ok") {
      await this.recordInRewritten(state, item.id, this.nextCommand);
      return undefined;
    }
    if (outcome.kind === "dropped") {
      if (finalFixup) await this.flushRewrittenPending(state);
      return undefined;
    }
    if (isFixup(item.action)) {
      // error_failed_squash: the chain's message for --continue, the commit to amend
      const squash = (await state.read(`${DIR}/message-squash`)) ?? "";
      await state.write(`${DIR}/message`, squash);
      await state.write("MERGE_MSG", squash);
      return {
        status: RebaseStatus.STOPPED,
        currentCommit: item.id,
        conflicts: outcome.conflicts,
        message: [
          ...outcome.lines,
          ...(await this.errorWithPatch(state, item.id, rest, { exitCode: 1, toAmend: true })),
        ].join("\n"),
      };
    }
    // a reword already fast-forwarded, or about to make a root commit (HEAD on git's
    // squash_onto), amends
    const head = await this.resolveHead();
    const squashOnto = (await state.read(`${DIR}/squash-onto`))?.trim();
    const toAmend =
      item.action === RebaseAction.REWORD &&
      (head === item.id || (squashOnto !== undefined && head === squashOnto));
    return {
      status: RebaseStatus.STOPPED,
      currentCommit: item.id,
      conflicts: outcome.conflicts,
      message: [
        ...outcome.lines,
        ...(await this.errorWithPatch(state, item.id, rest, {
          exitCode: 1,
          toAmend,
          ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        })),
      ].join("\n"),
    };
  }

  /**
   * git's error_with_patch: the message for `--continue`, make_patch's `stopped-sha`,
   * `REBASE_HEAD` and `patch`, and either the commit to amend (`amend`, "You can amend the
   * commit now") or `Could not apply <abbrev>... <rest>`; the lines printed.
   */
  private async errorWithPatch(
    state: OperationState,
    id: ObjectId,
    rest: string,
    options: { exitCode: number; toAmend: boolean; message?: string; signoff?: boolean },
  ): Promise<string[]> {
    if (options.message !== undefined && !(await state.exists(`${DIR}/message`))) {
      await state.write(`${DIR}/message`, options.message);
    }
    // make_patch
    await state.write(`${DIR}/stopped-sha`, `${id}\n`);
    await state.setRef("REBASE_HEAD", id);
    await state.write(`${DIR}/patch`, "");
    if (!(await state.exists(`${DIR}/message`))) {
      const commit = await this.commits.load(id);
      const body = messageBody(commit?.message ?? "");
      await state.write(
        `${DIR}/message`,
        options.signoff
          ? appendSignoff(body, this.signoffLine(), trailerConfigOf(this.workingCopy))
          : `${body}\n`,
      );
    }
    if (options.toAmend) {
      await state.write(`${DIR}/amend`, `${await this.resolveHead()}\n`);
      return [
        "You can amend the commit now, with",
        "",
        "  git commit --amend ",
        "",
        "Once you are satisfied with your changes, run",
        "",
        "  git rebase --continue",
      ];
    }
    if (options.exitCode)
      return [`Could not apply ${await this.abbreviateObjectId(id)}... ${rest}`];
    return [];
  }

  /**
   * do_pick_commit: one commit picked onto HEAD (fast-forwarded where its parent is HEAD),
   * a fixup or squash melded into HEAD, a reword amended; what came of it.
   */
  private async pick(
    state: OperationState,
    worktree: Worktree | undefined,
    item: TodoItem,
    output: string[],
    finalFixup: boolean,
  ): Promise<PickOutcome> {
    const commit = await this.commits.load(item.id);
    if (!commit) throw new CommitNotFoundError(item.id);
    const headId = await this.resolveHead();
    const signoff = await state.exists(`${DIR}/signoff`);
    const fixup = isFixup(item.action);
    // on git's squash_onto (--root, `reset [new root]`) the pick makes a root commit
    const squashOnto = (await state.read(`${DIR}/squash-onto`))?.trim();
    const unborn = squashOnto !== undefined && headId === squashOnto;
    if (unborn && fixup) {
      return {
        kind: "reschedule",
        result: {
          status: RebaseStatus.FAILED,
          message: "error: cannot fixup root commit",
          reschedule: true,
        },
      };
    }
    // git's allow_ff (no --force-rebase): a commit whose parent is HEAD is kept as it is
    if (
      !fixup &&
      (commit.parents.length === 0 ? unborn : commit.parents[0] === headId) &&
      !signoff &&
      (await this.allowFastForward(state))
    ) {
      await this.writeAuthorScript(state, commit.author);
      const refused = await this.fastForward(state, worktree, headId, item.id);
      if (refused) return { kind: "reschedule", result: refused };
      if (item.action === RebaseAction.REWORD) {
        try {
          await this.rewordHead(state);
        } catch (error) {
          // fast_forward_edit's git commit failed: a stop with HEAD to amend
          return editorFailure(error);
        }
      }
      return { kind: "ok" };
    }
    // the trees read once: a pick's result is the next one's HEAD, a commit the next one's
    // parent; what is written and staged is only what the pick changes
    this.flatTrees ??= new FlatTreeCache(this.trees);
    const flats = this.flatTrees;
    const headTreeId = await this.commits.getTree(headId);
    const parentId = commit.parents[0];
    const parentTreeId = parentId ? await this.commits.getTree(parentId) : undefined;
    const subject = subjectOf(commit.message);
    // do_pick_commit: the message from its subject on; --signoff appends the committer's
    // sign-off (not for a fixup or squash), before the merge (MERGE_MSG has it)
    const body = messageBody(commit.message);
    const pickedMessage =
      signoff && !fixup
        ? appendSignoff(body, this.signoffLine(), trailerConfigOf(this.workingCopy))
        : body;
    let messageFile: "squash" | "fixup" | "edit" | undefined;
    if (fixup) {
      await this.updateSquashMessages(state, item, commit.message);
      if (!finalFixup) messageFile = "squash";
      else if (await state.exists(`${DIR}/message-fixup`)) messageFile = "fixup";
      else {
        await state.write("SQUASH_MSG", (await state.read(`${DIR}/message-squash`)) ?? "");
        await state.remove("MERGE_MSG");
        messageFile = "edit";
      }
    }
    await this.writeAuthorScript(state, commit.author);
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
      await state.setRef("REBASE_HEAD", item.id);
      return {
        kind: "reschedule",
        result: {
          status: RebaseStatus.FAILED,
          currentCommit: item.id,
          message: refused.message,
          reschedule: true,
        },
      };
    }
    // the sequencer shows merge-ort's messages of a rebase only when the pick conflicts
    if (conflicts.length > 0 || !merge.clean) output.push(...merge.messages);
    await state.setRef("AUTO_MERGE", treeId);
    const merged = pickedMessage.endsWith("\n") ? pickedMessage : `${pickedMessage}\n`;
    if (conflicts.length > 0 || !merge.clean) {
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort(compareGitPaths);
      await state.write("MERGE_MSG", `${merged}${conflictsComment(paths, true)}`);
      if (!fixup) {
        // do_pick_commit writes CHERRY_PICK_HEAD after a conflicted merge too; the rebase
        // stopping there deletes it again (REBASE_HEAD names the commit instead)
        await state.writeAndDeleteRef("CHERRY_PICK_HEAD", item.id);
      }
      return {
        kind: "conflicts",
        conflicts: [...new Set(merge.conflicts.keys())].sort(),
        // git 2.43 writes the message and a blank line (2.5x the conflict list after it)
        message: `${merged}\n`,
        lines: [
          `error: could not apply ${short}... ${subject}`,
          "hint: Resolve all conflicts manually, mark them as resolved with",
          'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
          'hint: You can instead skip this commit: run "git rebase --skip".',
          'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".',
        ],
      };
    }
    await state.write("MERGE_MSG", pickedMessage);
    // allow_empty: a commit that was empty from the start is kept; one that became empty is
    // dropped (drop_redundant_commits), kept (keep_redundant_commits) or stops the rebase
    let allowEmpty = false;
    if (treeId === headTreeId) {
      if (commit.tree === (parentTreeId ?? EMPTY_TREE_ID)) allowEmpty = true;
      else if (await state.exists(`${DIR}/keep_redundant_commits`)) allowEmpty = true;
      else if (await state.exists(`${DIR}/drop_redundant_commits`)) {
        await state.removeRef("AUTO_MERGE");
        await state.remove("MERGE_MSG");
        output.push(`dropping ${item.id} ${subject} -- patch contents already upstream`);
        // do_pick_commit: a dropped final fixup still ends the chain (its files removed)
        if (finalFixup) await this.endFixupChain(state);
        return { kind: "dropped" };
      }
    }
    if (fixup) {
      // try_to_commit with AMEND_MSG: HEAD's parents and author, the chain's message
      // verbatim; the last of a chain with a squash is edited (git commit -e)
      const head = await this.commits.load(headId);
      if (!head) throw new NoHeadError("HEAD cannot be resolved");
      // without ALLOW_EMPTY an amend whose tree is that of HEAD's first parent (the empty
      // tree for a root) is left to git commit, which refuses it: the chain stops
      // (error_failed_squash), HEAD to amend
      if (!allowEmpty && head.parents.length <= 1) {
        const parentTree = head.parents[0]
          ? await this.commits.getTree(head.parents[0])
          : EMPTY_TREE_ID;
        if (parentTree === treeId) {
          // do_commit: REBASE_HEAD written before git commit runs
          await state.setRef("REBASE_HEAD", item.id);
          return {
            kind: "conflicts",
            conflicts: [],
            lines: [
              "You asked to amend the most recent commit, but doing so would make",
              "it empty. You can repeat your command with --allow-empty, or you can",
              'remove the commit entirely with "git reset HEAD^".',
            ],
          };
        }
      }
      let message: string;
      if (messageFile === "edit") {
        // do_commit hands it to git commit: REBASE_HEAD first, git commit drops AUTO_MERGE
        // once it has committed (an editor that fails stops the chain as a conflict does)
        await state.setRef("REBASE_HEAD", item.id);
        try {
          message = this.editMessage((await state.read("SQUASH_MSG")) ?? "");
        } catch (error) {
          return editorFailure(error);
        }
        await state.removeRef("AUTO_MERGE");
      } else {
        message =
          (await state.read(
            messageFile === "fixup" ? `${DIR}/message-fixup` : `${DIR}/message-squash`,
          )) ?? "";
        if (signoff) message = stripspace(message);
      }
      await this.amendHead(state, treeId, message, item.action, messageFile === "edit");
      // try_to_commit removes MERGE_MSG; git commit (the edited end of a chain) SQUASH_MSG too
      await state.remove("MERGE_MSG");
      if (messageFile === "edit") await state.remove("SQUASH_MSG");
    } else {
      if (treeId === headTreeId && !allowEmpty) {
        // try_to_commit refuses the empty commit; git commit says why
        await state.setRef("CHERRY_PICK_HEAD", item.id);
        return {
          kind: "conflicts",
          conflicts: [],
          message: pickedMessage,
          lines: [
            "The previous cherry-pick is now empty, possibly due to conflict resolution.",
            "If you wish to commit it anyway, use:",
            "",
            "    git commit --allow-empty",
            "",
            "Otherwise, please use 'git rebase --skip'",
          ],
        };
      }
      // try_to_commit: a signed-off message is cleaned up as whitespace (else verbatim)
      const message = signoff ? stripspace(pickedMessage) : pickedMessage;
      // do_pick_commit writes CHERRY_PICK_HEAD for the commit to come; do_commit deletes it
      // once try_to_commit made it
      await state.withRefDuring("CHERRY_PICK_HEAD", item.id, () =>
        this.commitOnto(state, unborn ? [] : [headId], treeId, commit.author, message, item.action),
      );
      // do_commit: the commit made, MERGE_MSG removed
      await state.remove("MERGE_MSG");
      if (item.action === RebaseAction.REWORD) {
        try {
          await this.rewordHead(state);
        } catch (error) {
          // git commit --amend -e failed (the editor): the pick stays, the rebase stops
          return { ...editorFailure(error), message: pickedMessage };
        }
      }
    }
    if (finalFixup) await this.endFixupChain(state);
    return { kind: "ok" };
  }

  /** do_pick_commit after a final fixup: the chain's files removed. */
  private async endFixupChain(state: OperationState): Promise<void> {
    await state.remove(`${DIR}/message-fixup`, `${DIR}/message-squash`, `${DIR}/current-fixups`);
  }

  /** The commit message editor: the interactive handler, else the text as it is. */
  private editMessage(text: string): string {
    const edited = this.interactiveHandler?.modifyCommitMessage
      ? this.interactiveHandler.modifyCommitMessage(text)
      : text;
    // git commit -e: the comments stripped (commit.cleanup aside)
    return cleanupMessage(edited, commentPrefixOf(this.workingCopy));
  }

  /**
   * A reword (git commit --amend -e after the pick): HEAD committed again with its message
   * edited, logged `rebase (reword): <subject>`.
   */
  private async rewordHead(state: OperationState): Promise<void> {
    const head = await this.commits.load(await this.resolveHead());
    if (!head) return;
    if (this.hooks.enabled) {
      // run_git_commit(EDIT_MSG | VERIFY_MSG | AMEND_MSG): git commit --amend -e, its hooks
      await state.removeRef("AUTO_MERGE");
      await this.amendHead(state, head.tree, head.message, RebaseAction.REWORD, true, {
        verify: true,
        editor: true,
        hookArgs: ["commit", "HEAD"],
        env: { GIT_REFLOG_ACTION: this.stepAction(RebaseAction.REWORD) },
      });
      await state.remove("SQUASH_MSG");
      return;
    }
    const message = this.editMessage(head.message);
    // git commit --amend: the merge state it removes
    await state.removeRef("AUTO_MERGE");
    await this.amendHead(state, head.tree, message, RebaseAction.REWORD, true);
    await state.remove("SQUASH_MSG");
  }

  /** The reflog action of a rebase step (`rebase (reword)`), git's GIT_REFLOG_ACTION for it. */
  private stepAction(step: string): string {
    return reflogMessages.rebaseStep(this.reflogAction("rebase"), step);
  }

  /** The editor of a `git commit -e` run (the interactive handler; comments kept). */
  private modifyMessage(text: string): string {
    return this.interactiveHandler?.modifyCommitMessage
      ? this.interactiveHandler.modifyCommitMessage(text)
      : text;
  }

  /**
   * HEAD replaced by a commit of `tree` with HEAD's parents and author (an amend), its notes
   * carried over (`notes.rewriteRef`). `byGitCommit`: git runs `git commit --amend` for it,
   * whose notes commit takes the amended author (git exports it), not the environment's.
   */
  private async amendHead(
    state: OperationState,
    tree: ObjectId,
    message: string,
    step: string,
    byGitCommit = false,
    /** `git commit` run with hooks: `message` is its template, edited and checked by them */
    gitCommit?: GitCommitHookRun,
  ): Promise<ObjectId> {
    const headId = await this.resolveHead();
    const head = await this.commits.load(headId);
    if (!head) throw new NoHeadError("HEAD cannot be resolved");
    const id = await this.commitOnto(
      state,
      head.parents,
      tree,
      head.author,
      message,
      step,
      gitCommit,
    );
    // commit_post_rewrite of the amend (git commit --amend, try_to_commit's AMEND_MSG)
    await copyNotesForAmend(this.notesContext(), headId, id, byGitCommit ? head.author : undefined);
    // ... and git commit's post-rewrite hook, told "amend"
    if (gitCommit) await gitCommitAfterHooks(this.hooks, gitCommit, { from: headId, to: id });
    return id;
  }

  /**
   * sequencer.c's update_squash_messages: the chain's message in `message-squash` (`# This
   * is a combination of N commits.`, each message after its header, a fixup's commented
   * out), `message-fixup` for a chain of fixups only (the first commit's message, or a
   * `fixup -C` commit's), the chain in `current-fixups`.
   */
  private async updateSquashMessages(
    state: OperationState,
    item: TodoItem,
    message: string,
  ): Promise<void> {
    const comment = commentPrefixOf(this.workingCopy);
    const currentFixups = (await state.read(`${DIR}/current-fixups`)) ?? "";
    let count = currentFixups === "" ? 0 : currentFixups.split("\n").length;
    const seenSquash = currentFixups.startsWith("squash") || currentFixups.includes("\nsquash");
    const fixupFlag =
      item.action === RebaseAction.FIXUP &&
      (item.replaceMessage === true || item.editMessage === true);
    let buf: string;
    if (count > 0) {
      const squash = await state.read(`${DIR}/message-squash`);
      if (!squash)
        throw new InvalidArgumentError("todo", item.id, `could not read '${DIR}/message-squash'`);
      const eol = !squash.startsWith(comment)
        ? 0
        : squash.indexOf("\n") < 0
          ? squash.length
          : squash.indexOf("\n");
      buf = `${comment} ${combinedMessage(count + 2)}${squash.slice(eol)}`;
      if (fixupFlag && !seenSquash) buf = squashMessageForFixup(buf, comment);
    } else {
      const head = await this.commits.load(await this.resolveHead());
      const headBody = messageBody(head?.message ?? "");
      if (item.action === RebaseAction.FIXUP && !fixupFlag) {
        await state.write(`${DIR}/message-fixup`, headBody);
      }
      buf = `${comment} ${combinedMessage(2)}\n${comment} ${fixupFlag ? squashTexts.skipFirstMessage : squashTexts.firstMessage}\n\n`;
      buf = fixupFlag ? commentLines(buf, headBody, comment) : buf + headBody;
    }
    const body = messageBody(message);
    if (item.action === RebaseAction.SQUASH || fixupFlag) {
      // append_squash_message
      let commented = 0;
      if (
        body.startsWith("amend!") ||
        ((item.action === RebaseAction.SQUASH || seenSquash) &&
          (body.startsWith("squash!") || body.startsWith("fixup!")))
      ) {
        commented = subjectLength(body);
      }
      buf += `\n${comment} ${squashTexts.nthMessage(++count + 1)}\n\n`;
      buf = commentLines(buf, body.slice(0, commented), comment);
      const fixupOff = buf.length;
      buf += body.slice(commented);
      if (fixupFlag && !seenSquash) {
        // the message replaced: --signoff's trailer appended (append_squash_message)
        if (await state.exists(`${DIR}/signoff`)) {
          buf = appendSignoff(buf, this.signoffLine(), trailerConfigOf(this.workingCopy));
        }
        if (
          item.replaceMessage &&
          ((await state.exists(`${DIR}/message-fixup`)) ||
            !(await state.exists(`${DIR}/message-squash`)))
        ) {
          await state.write(
            `${DIR}/message-fixup`,
            buf.slice(fixupOff).replace(/^([ \t\r]*\n)+/, ""),
          );
        } else await state.remove(`${DIR}/message-fixup`);
      } else await state.remove(`${DIR}/message-fixup`);
    } else {
      buf += `\n${comment} ${squashTexts.skipNthMessage(++count + 1)}\n\n`;
      buf = commentLines(buf, body, comment);
    }
    await state.write(`${DIR}/message-squash`, buf);
    const flag = fixupFlag && item.editMessage ? " -c" : "";
    await state.write(
      `${DIR}/current-fixups`,
      `${currentFixups}${currentFixups ? "\n" : ""}${item.action}${flag} ${item.id}`,
    );
  }

  /** One todo command run: a pick, or a `label`, `reset`, `merge`; a result when it stops. */
  private async runTodoCommand(
    state: OperationState,
    worktree: Worktree | undefined,
    todo: TodoItem[],
    output: string[],
  ): Promise<StepOutcome> {
    const item = todo[0] as TodoItem;
    if (isNoop(item)) return undefined;
    switch (item.action) {
      case RebaseAction.LABEL:
        return this.label(state, item.rest ?? "");
      case RebaseAction.RESET:
        return this.reset(state, worktree, item.rest ?? "");
      case RebaseAction.MERGE: {
        const outcome = await this.merge(state, worktree, item, output);
        if (outcome?.reschedule) return outcome;
        // record_in_rewritten after do_merge (conflicted or not)
        if (item.id) await this.recordInRewritten(state, item.id, this.nextCommand);
        return outcome;
      }
      case RebaseAction.EXEC:
        return this.exec(state, worktree, item.rest ?? "", output);
      case RebaseAction.UPDATE_REF:
        await this.updateRefRecord(state, item.rest ?? "");
        return undefined;
      default:
        return this.pickOne(state, worktree, todo, output);
    }
  }

  /**
   * git's do_exec: `Executing: <command>`, the command run by the exec handler, the index
   * read again; a failure, or changes left in the index or worktree, stop the rebase (with
   * `--reschedule-failed-exec` the exec goes back to the todo list).
   */
  private async exec(
    state: OperationState,
    worktree: Worktree | undefined,
    command: string,
    output: string[],
  ): Promise<StepOutcome> {
    output.push(`Executing: ${command}`);
    let status: number;
    if (this.execHandler) {
      const result = await this.execHandler(command);
      status = result.exitCode;
      output.push(...(result.output ?? []));
    } else {
      output.push(`${command}: no exec handler to run it`);
      status = 127;
    }
    // force re-reading of the index
    await this.staging.read?.();
    const head = await this.resolveHead();
    const dirty = await this.uncleanWorktree(head, worktree, "rebase", false);
    const lines: string[] = dirty ? (dirty.message ?? "").split("\n") : [];
    if (status !== 0) {
      lines.push(
        `warning: execution failed: ${command}`,
        ...(dirty ? ["and made changes to the index and/or the working tree."] : []),
        "You can fix the problem, and then run",
        "",
        "  git rebase --continue",
        "",
      );
    } else if (dirty) {
      lines.push(
        `warning: execution succeeded: ${command}`,
        "but left changes to the index and/or the working tree.",
        "Commit or stash your changes, and then run",
        "",
        "  git rebase --continue",
        "",
      );
      status = 1;
    }
    if (status === 0) return { checkTodo: true };
    return {
      status: RebaseStatus.STOPPED,
      message: lines.join("\n"),
      ...((await state.exists(`${DIR}/reschedule-failed-exec`)) ? { reschedule: true } : {}),
    };
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
    // the label ends at the first blank (a `reset <label> # <oneline>` line); `[new root]`
    // is git's squash_onto (made when the rebase has none yet)
    const newRoot = arg.startsWith("[new root]");
    const end = arg.search(/[ \t\n\r]/);
    const name = newRoot ? "[new root]" : end < 0 ? arg : arg.slice(0, end);
    let found: { id: ObjectId; name: string } | undefined;
    if (newRoot) {
      let id = (await state.read(`${DIR}/squash-onto`))?.trim();
      if (!id) {
        id = await this.createSquashOnto();
        await state.write(`${DIR}/squash-onto`, id);
      }
      found = { id, name };
    } else found = await this.lookupLabel(state, name);
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
    const original = item.id ? await this.commits.load(item.id) : undefined;
    const headId = await this.resolveHead();
    // a merge onto a `[new root]`: a fast-forward to the merge head
    const squashOnto = (await state.read(`${DIR}/squash-onto`))?.trim();
    if (squashOnto && headId === squashOnto) {
      if (heads.length > 1) {
        return {
          status: RebaseStatus.FAILED,
          message: "error: octopus merge cannot be executed on top of a [new root]",
          reschedule: true,
        };
      }
      return this.fastForward(state, worktree, headId, (heads[0] as { id: ObjectId }).id);
    }
    const forced = !(await this.allowFastForward(state));
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
          : `Merge ${heads.length > 1 ? "branches" : "branch"} '${arg.slice(0, mergeArgEnd).replace(/^[ \t\n]+/, "")}'`;
    }
    await this.writeAuthorScript(state, author);
    await state.write("MERGE_MSG", message);
    if (heads.length > 1) {
      return this.octopus(state, item, heads, author, message, output);
    }
    const head = heads[0] as { id: ObjectId; name: string };
    const bases = await revisionMergeBases(this.commits, headId, head.id);
    if (bases[0] === head.id) {
      // the head is already in HEAD: nothing to merge
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
      // record_in_rewritten (pick_commits) runs before the stop: the merge maps to HEAD
      if (item.id) {
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
    // git commit -n -F MERGE_MSG --cleanup=verbatim (whitespace with --signoff, which the
    // merge does not get): the merge committed, its state removed
    const committed = (await state.exists(`${DIR}/signoff`)) ? stripspace(message) : message;
    const newId = await this.commitOnto(
      state,
      [headId, head.id],
      treeId,
      author,
      committed,
      "merge",
    );
    // (git commit removes SQUASH_MSG too; the octopus' git merge leaves it)
    await state.remove("MERGE_MSG", "MERGE_HEAD", "MERGE_MODE", "SQUASH_MSG");
    await state.removeRef("AUTO_MERGE");
    if (item.editMessage) await this.amendMergeMessage(state, newId);
    return undefined;
  }

  /**
   * do_merge of several heads: git runs `git merge -s octopus --no-ff --no-edit -F MERGE_MSG
   * <heads>` with the author of `author-script`; our merge runs it (git-merge-octopus, its
   * messages, ORIG_HEAD, the reflog line `merge <heads>: Merge made by the 'octopus'
   * strategy.`). Merged, the merge maps to its commit; already up to date, to HEAD; with
   * conflicts left (the last head's) or given up ("Should not be doing an octopus."), the
   * rebase stops there as at a conflicting merge (never rescheduled), the merge mapped to
   * HEAD.
   */
  private async octopus(
    state: OperationState,
    item: TodoItem,
    heads: { id: ObjectId; name: string }[],
    picked: PersonIdent,
    message: string,
    output: string[],
  ): Promise<(RebaseResult & { reschedule?: boolean }) | undefined> {
    // the dates as the sequencer passes them to the merge (GIT_AUTHOR_DATE=, and
    // GIT_COMMITTER_DATE= the author's date or the clock)
    this.resetClock();
    let author = picked;
    let committer = this.committer ?? this.resolveCommitter();
    if (await state.exists(`${DIR}/ignore_date`)) {
      const now = this.clock();
      author = { ...author, timestamp: now, tzOffset: localTimezoneOffset(now) };
    }
    if (await state.exists(`${DIR}/cdate_is_adate`)) {
      committer = { ...committer, timestamp: author.timestamp, tzOffset: author.tzOffset };
    }
    const command = new MergeCommand(this._workingCopy)
      .setInProcess(true)
      .setFastForwardMode(FastForwardMode.NO_FF)
      .setMessage(message)
      .setAuthor(author)
      .setCommitter(committer);
    // `merge -c`: --edit, the message cleaned up as an edited one
    if (item.editMessage) command.setCleanupMode(CleanupMode.STRIP);
    // the merge inherits pull's GIT_REFLOG_ACTION, not the rebase's own action
    if (this.hasReflogAction()) command.setReflogAction(this.reflogAction("rebase"));
    for (const head of heads) command.include(head.id);
    let result: MergeResult;
    try {
      result = await command.call();
    } catch (error) {
      result = {
        status: MergeStatus.FAILED,
        mergedCommits: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    output.push(...(result.output ?? []));
    if (result.status === MergeStatus.MERGED || result.status === MergeStatus.ALREADY_UP_TO_DATE) {
      // remove_merge_branch_state
      await state.remove("MERGE_MSG", "MERGE_HEAD", "MERGE_MODE");
      await state.removeRef("AUTO_MERGE");
      return undefined;
    }
    // error_with_patch, after record_in_rewritten
    await state.write(`${DIR}/message`, message);
    if (item.id) {
      await state.write(`${DIR}/stopped-sha`, `${item.id}\n`);
      await state.setRef("REBASE_HEAD", item.id);
      await state.write(`${DIR}/patch`, "");
    }
    const arg = item.rest ?? "";
    const stop = item.id
      ? `Could not apply ${await this.abbreviateObjectId(item.id)}... ${arg}`
      : `Could not merge ${arg}`;
    return {
      status: RebaseStatus.STOPPED,
      ...(item.id ? { currentCommit: item.id } : {}),
      conflicts: result.conflicts ?? [],
      message: result.message ? `${result.message}\n${stop}` : stop,
    };
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
    // git commit --amend: SQUASH_MSG removed with the merge state, the notes carried over
    await state.remove("SQUASH_MSG");
    await copyNotesForAmend(this.notesContext(), id, newId, commit.author);
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

  /**
   * git's allow_ff as read_populate_opts leaves it: off with --force-rebase, which the date
   * options and --signoff imply (`cdate_is_adate`, `ignore_date`, `signoff` in the state).
   */
  private async allowFastForward(state: OperationState): Promise<boolean> {
    for (const name of ["cdate_is_adate", "ignore_date", "signoff"]) {
      if (await state.exists(`${DIR}/${name}`)) return false;
    }
    return true;
  }

  /** append_signoff's `Signed-off-by: <committer name> <email>` line. */
  private signoffLine(): string {
    const committer = this.committer ?? this.resolveCommitter();
    return `Signed-off-by: ${committer.name} <${committer.email}>\n`;
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
    keepEmpty = true,
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
      if (empty && !keepEmpty) continue;
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

  /** git's `author-script` of the commit being picked. */
  private async writeAuthorScript(state: OperationState, author: PersonIdent): Promise<void> {
    await state.write(
      `${DIR}/author-script`,
      `GIT_AUTHOR_NAME=${sq(author.name)}\nGIT_AUTHOR_EMAIL=${sq(author.email)}\nGIT_AUTHOR_DATE=${sq(`@${author.timestamp} ${author.tzOffset}`)}\n`,
    );
  }

  /** read_populate_todo's todo_list_write_total_nr: `end`, the commands done and to do. */
  private async writeTotal(state: OperationState, todo: TodoItem[]): Promise<void> {
    const done = countCommands((await state.read(`${DIR}/done`)) ?? "");
    await state.write(`${DIR}/end`, `${done + countTodoCommands(todo)}\n`);
  }

  /** `git rebase --continue`: what is staged committed (commit_staged_changes), the rest picked. */
  private async continueRebase(
    state: OperationState,
    worktree: Worktree | undefined,
  ): Promise<RebaseResult> {
    if (!(await this.inProgress(state))) throw new NoRebaseInProgressError();
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length > 0) {
      // builtin/rebase.c: refresh_index's `<path>: needs merge`, then has_unstaged_changes
      return {
        status: RebaseStatus.STOPPED,
        conflicts: unmerged,
        message: [
          ...[...new Set(unmerged)].map((path) => `${path}: needs merge`),
          "You must edit all merge conflicts and then",
          "mark them as resolved using git add",
        ].join("\n"),
      };
    }
    // builtin/rebase.c: unstaged changes refused before the sequencer reads anything
    if (worktree) {
      const unclean = await this.uncleanWorktree(
        await this.resolveHead(),
        worktree,
        "rebase",
        false,
        true,
      );
      if (unclean) {
        return {
          status: RebaseStatus.FAILED,
          message:
            "You must edit all merge conflicts and then\nmark them as resolved using git add",
        };
      }
    }
    return this.resume(state, worktree);
  }

  /** sequencer_continue for `--continue` and `--skip`: the stop settled, the rest picked. */
  private async resume(
    state: OperationState,
    worktree: Worktree | undefined,
    output: string[] = [],
  ): Promise<RebaseResult> {
    const loaded = await this.loadTodo(state);
    if (loaded.errors.length > 0) {
      return {
        status: RebaseStatus.FAILED,
        message: [...loaded.errors, "error: please fix this using 'git rebase --edit-todo'."].join(
          "\n",
        ),
      };
    }
    // read_populate_todo writes the total before anything may refuse to go on
    await this.writeTotal(state, loaded.items);
    if (await state.exists(`${DIR}/dropped`)) {
      // todo_list_check_against_backup: commits still dropped by mistake
      const backup = await this.resolveTodo(
        parseTodo(
          (await state.read(`${DIR}/git-rebase-todo.backup`)) ?? "",
          commentPrefixOf(this.workingCopy),
        ).items,
      );
      const level = this.missingCommitsCheckLevel(output);
      const missing = await this.missingCommits(backup.items, loaded.items, level);
      if (missing.length > 0 && level === "error") {
        return { status: RebaseStatus.FAILED, message: missing.join("\n"), output };
      }
      output.push(...missing);
      await state.remove(`${DIR}/dropped`);
    }
    const refusal = await this.commitStagedChanges(state, loaded.items);
    if (refusal) return { ...refusal, output };
    // sequencer_continue: the stopped commit maps to HEAD, committed or not
    const stopped = (await state.read(`${DIR}/stopped-sha`))?.trim();
    if (stopped && /^[0-9a-f]{40,64}$/.test(stopped)) {
      await this.recordInRewritten(state, stopped, peekCommand(loaded.items, 0));
    }
    return this.processTodo(state, worktree, output);
  }

  /**
   * sequencer.c's commit_staged_changes: unstaged changes refuse; staged ones are committed
   * with `rebase-merge/message` (a new commit, or HEAD amended where the stop asked for it:
   * `amend`), after a failed fixup or squash the chain's bookkeeping put right.
   */
  private async commitStagedChanges(
    state: OperationState,
    todo: TodoItem[],
  ): Promise<RebaseResult | undefined> {
    // (its has_unstaged_changes refusal cannot happen: `--continue` refused them before the
    // list was read, `--skip` reset them)
    const headId = await this.resolveHead();
    const headCommit = await this.commits.load(headId);
    const treeId = await this.staging.writeTree(this.trees);
    const isClean = headCommit?.tree === treeId;
    if (!isClean && !(await state.exists(`${DIR}/message`))) {
      return { status: RebaseStatus.FAILED, message: STAGED_CHANGES_ADVICE };
    }
    let amend = false;
    let finalFixup = false;
    let edit = true;
    let currentFixups = (await state.read(`${DIR}/current-fixups`)) ?? "";
    let fixupCount = currentFixups === "" ? 0 : currentFixups.split("\n").length;
    const amendFile = (await state.read(`${DIR}/amend`))?.trim();
    if (amendFile !== undefined) {
      if (!/^[0-9a-f]{40,64}$/.test(amendFile)) {
        return { status: RebaseStatus.FAILED, message: `error: invalid contents: '${DIR}/amend'` };
      }
      if (!isClean && headId !== amendFile) {
        return {
          status: RebaseStatus.FAILED,
          message:
            "error: \nYou have uncommitted changes in your working tree. Please, commit them\nfirst and then run 'git rebase --continue' again.",
        };
      }
      const next = peekCommand(todo, 0);
      if (!isClean || fixupCount === 0) {
        // not the final fixup
      } else if (headId !== amendFile || !(await state.exists(`${DIR}/stopped-sha`))) {
        // a final fixup or squash done by hand
        if (!isFixup(next)) {
          await state.remove(
            `${DIR}/message-fixup`,
            `${DIR}/message-squash`,
            `${DIR}/current-fixups`,
          );
          currentFixups = "";
          fixupCount = 0;
        }
      } else {
        // a fixup/squash of a chain skipped: it is taken off the chain
        fixupCount--;
        const cut = currentFixups.lastIndexOf("\n");
        currentFixups = cut < 0 ? "" : currentFixups.slice(0, cut);
        await state.write(`${DIR}/current-fixups`, currentFixups);
        const seenSquash = currentFixups.startsWith("squash") || currentFixups.includes("\nsquash");
        const seenEdit =
          currentFixups.startsWith("fixup -c") || currentFixups.includes("\nfixup -c");
        if (fixupCount > 0 && !isFixup(next)) {
          finalFixup = true;
          // only fixups: the message cleaned up, no editor
          if (!seenSquash && !seenEdit) edit = false;
        } else if (isFixup(next)) {
          await state.write(`${DIR}/message-squash`, messageBody(headCommit?.message ?? ""));
        }
      }
      amend = true;
    }
    if (isClean) {
      await state.removeRef("CHERRY_PICK_HEAD");
      await state.remove("MERGE_MSG");
      if (!finalFixup) return undefined;
    }
    // run_git_commit: `rebase-merge/message` (HEAD's own message for a final fixup), edited
    // (git commit -e: comments stripped) or cleaned up (--cleanup=strip)
    const comment = commentPrefixOf(this.workingCopy);
    let message: string;
    // with hooks: git commit -n (-F rebase-merge/message) -e, the template edited between
    // its hooks (commit_staged_changes: EDIT_MSG without VERIFY_MSG)
    let gitCommit: GitCommitHookRun | undefined;
    try {
      if (this.hooks.enabled) {
        gitCommit = {
          verify: false,
          editor: !finalFixup || edit,
          hookArgs: finalFixup ? (amend ? ["commit", "HEAD"] : []) : ["message"],
          env: { GIT_REFLOG_ACTION: this.stepAction("continue") },
        };
        message = finalFixup
          ? (headCommit?.message ?? "")
          : ((await state.read(`${DIR}/message`)) ?? (await state.read("MERGE_MSG")) ?? "");
      } else if (finalFixup) {
        const own = headCommit?.message ?? "";
        message = edit ? this.editMessage(own) : cleanupMessage(own, comment);
      } else {
        message = this.editMessage(
          (await state.read(`${DIR}/message`)) ?? (await state.read("MERGE_MSG")) ?? "",
        );
      }
      if (gitCommit) {
        const run = gitCommit;
        if (amend) await this.amendHead(state, treeId, message, "continue", true, run);
        else {
          const mergeHeads = ((await state.read("MERGE_HEAD")) ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => /^[0-9a-f]{40,64}$/.test(line));
          const author =
            parseAuthorScript((await state.read(`${DIR}/author-script`)) ?? "") ??
            this.resolveAuthor();
          // git commit, a child with GIT_REFLOG_ACTION: its HEAD update and its cleanup
          // (sequencer_post_commit_cleanup: CHERRY_PICK_HEAD when there, AUTO_MERGE)
          await this.withRefTransactionEnv(run.env ?? {}, async () => {
            await this.commitOnto(
              state,
              [headId, ...mergeHeads],
              treeId,
              author,
              message,
              "continue",
              run,
            );
            await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD");
            await state.deleteRef("AUTO_MERGE");
          });
          await gitCommitAfterHooks(this.hooks, run);
        }
      }
    } catch (error) {
      // git commit failed on its editor: nothing committed, the stop stays as it is
      return {
        status: RebaseStatus.FAILED,
        message: [...editorFailure(error).lines, "error: could not commit staged changes."].join(
          "\n",
        ),
      };
    }
    if (gitCommit) {
      // committed above, with git commit's hooks
    } else if (amend) await this.amendHead(state, treeId, message, "continue", true);
    else {
      // a stopped merge: its other parents (git commit reads MERGE_HEAD, one per line: an
      // octopus has several)
      const mergeHeads = ((await state.read("MERGE_HEAD")) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f]{40,64}$/.test(line));
      const author =
        parseAuthorScript((await state.read(`${DIR}/author-script`)) ?? "") ?? this.resolveAuthor();
      await this.commitOnto(state, [headId, ...mergeHeads], treeId, author, message, "continue");
    }
    // git commit's cleanup (SQUASH_MSG of a final squash too), then commit_staged_changes'
    await state.remove(`${DIR}/amend`, "MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "SQUASH_MSG");
    await state.removeRef("CHERRY_PICK_HEAD");
    // commit_staged_changes deletes AUTO_MERGE once git commit is done, whether it exists
    await state.deleteRef("AUTO_MERGE");
    if (finalFixup) await state.remove(`${DIR}/message-fixup`, `${DIR}/message-squash`);
    if (fixupCount > 0) await state.remove(`${DIR}/current-fixups`);
    return undefined;
  }

  /** `git rebase --skip`: the stopped pick dropped (`reset --hard`), then as `--continue`. */
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
    // remove_branch_state (REBASE_HEAD stays: the next command removes it, so a skip of the
    // last one leaves it, as git does); AUTO_MERGE deleted twice, as git's hook hears it
    await removeBranchState(this.context(worktree), state);
    return this.resume(state, worktree);
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
    // remove_branch_state, then finish_rebase's unconditional deletions of REBASE_HEAD and
    // AUTO_MERGE (git 2.5x's reference-transaction hook hears each)
    await removeBranchState(this.context(worktree), state);
    await state.deleteRef("REBASE_HEAD", "AUTO_MERGE");
    await this.deleteRewrittenRefs(state);
    await state.remove("MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "SQUASH_MSG", DIR);
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
    /** "Please commit or stash them." after the refusal */
    hint = true,
    /** git's has_unstaged_changes: staged changes do not count */
    unstagedOnly = false,
  ): Promise<RebaseResult | undefined> {
    const { index, unmerged } = await readIndex(this.staging);
    const headTree = await flatTree(this.trees, await this.commits.getTree(headId));
    // has_uncommitted_changes: an unborn index (no index file) has none
    const staged = (await isIndexUnborn(this.staging)) ? [] : indexChanges(index, headTree);
    const unstaged: string[] = [...unmerged];
    if (worktree) {
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      const indexTime = this.staging.getUpdateTime();
      // every tracked file is checked (git's refresh_index); several at a time, as git's
      // preload-index stats in parallel, the results kept in index order
      // diff-files passes over a skip-worktree entry, and an assume-unchanged one matches
      // whatever its file holds (ie_match_stat honours CE_VALID)
      const entries = [...index].filter(([, e]) => {
        const flags = e as { assumeValid?: boolean; skipWorktree?: boolean };
        return !flags.assumeValid && !flags.skipWorktree;
      });
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
    if (unstagedOnly && unstaged.length === 0) return undefined;
    if (staged.length === 0 && unstaged.length === 0) return undefined;
    const lines = [`error: cannot ${action}: You have unstaged changes.`];
    if (unstaged.length === 0)
      lines[0] = `error: cannot ${action}: Your index contains uncommitted changes.`;
    else if (staged.length > 0)
      lines.push("error: additionally, your index contains uncommitted changes.");
    if (hint) lines.push("error: Please commit or stash them.");
    return {
      status: RebaseStatus.UNCOMMITTED_CHANGES,
      uncommittedChanges: [...new Set([...unstaged, ...staged])].sort(),
      message: lines.join("\n"),
    };
  }

  /** A commit made on the detached HEAD, logged `rebase (<step>): <subject>`. */
  private async commitOnto(
    state: OperationState,
    parents: ObjectId[],
    tree: ObjectId,
    picked: PersonIdent,
    message: string,
    step: string,
    /**
     * A `git commit` run (sequencer.c `run_git_commit`) with its hooks, `message` its
     * template: post-commit is left to the caller (post-rewrite follows it for an amend)
     */
    gitCommit?: GitCommitHookRun,
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
    const hooked = gitCommit
      ? cleanupMessage(
          await gitCommitMessageHooks(this.hooks, state, message, gitCommit, (text) =>
            gitCommit.editor ? this.modifyMessage(text) : text,
          ),
          commentPrefixOf(this.workingCopy),
        )
      : await sequencerPrepareMessage(this.hooks, state, message);
    const id = await this.commits.store({
      tree,
      parents,
      author,
      committer,
      message: hooked,
    });
    const action = reflogMessages.rebaseStep(this.reflogAction("rebase"), step);
    const log = this.reflogLine(reflogMessages.pick(action, hooked), this.committer);
    const refs = this.refsStore;
    if (refsWatched(refs)) {
      // update_head_with_reflog: HEAD expecting the commit it is at (detached while
      // rebasing), as the reference-transaction hook hears it
      const current = (await refs.resolve("HEAD").catch(() => undefined))?.objectId;
      await updateHeadExpecting(refs, id, current, log);
    } else {
      // no hook to hear an old value: one batch through HEAD to its branch, unchecked
      await updateHeadExpecting(refs, id, undefined, log);
    }
    if (!gitCommit) await sequencerPostCommit(this.hooks);
    return id;
  }

  /**
   * `name` set to `id` as git's `refs_update_ref(..., name, id, old, REF_NO_DEREF)`: one
   * transaction expecting `old` (unchecked when undefined), as the reference-transaction hook
   * sees it; a store that cannot batch the ref sets it plainly.
   */
  private async setRefExpecting(
    name: string,
    id: ObjectId,
    old: ObjectId | undefined,
    log: RefLogOptions | undefined,
  ): Promise<void> {
    if (old === undefined) {
      await this.refsStore.set(name, id, log);
      return;
    }
    const result = await this.refsStore.batch([{ name, old, new: id, noDeref: true }], log);
    if (result.ok) return;
    if (result.rejected.every((r) => r.reason === "unsupported" || r.reason === "invalid-name")) {
      await this.refsStore.set(name, id, log);
      return;
    }
    throw new Error(
      `cannot lock ref '${name}': ${result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ")}`,
    );
  }

  /** HEAD detached at upstream: `rebase (start): checkout <upstream as given>`. */
  private startLog(): RefLogOptions {
    const onto = this.upstreamCommitName ?? this.upstreamCommit ?? "";
    return this.reflogLine(
      reflogMessages.rebaseStart(this.reflogAction("rebase"), onto),
      this.committer,
    );
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
    /** The value the branch is expected at (pick_commits' `orig-head`), shown to the hook */
    old?: ObjectId,
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
      await this.setRefExpecting(headName, id, old, branchLog);
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

  /** `git-rebase-todo` read and its names resolved (read_populate_todo). */
  private async loadTodo(state: OperationState): Promise<{ items: TodoItem[]; errors: string[] }> {
    const fixupOkay = await state.exists(`${DIR}/done`);
    const parsed = parseTodo(
      (await state.read(`${DIR}/git-rebase-todo`)) ?? "",
      commentPrefixOf(this.workingCopy),
      fixupOkay,
    );
    return this.resolveTodo(parsed.items, { fixupOkay });
  }

  /**
   * The commit names of parsed todo items resolved (git's repo_get_oid in parse_insn_line),
   * the lines git refuses made invalid: names that resolve to no commit, merges where a pick
   * cannot take one; then todo_list_parse_insn_buffer's check of a fixup with no commit
   * before it (a line that failed is none). The errors in line order.
   */
  private async resolveTodo(
    items: TodoItem[],
    options: {
      /**
       * The abbreviations of the commits the list was made of (as written for the editor): a
       * name that starts with one of them is that commit, without a look at the store
       */
      known?: Map<ObjectId, string>;
      /** `rebase-merge/done` exists: a fixup or squash may start the list */
      fixupOkay?: boolean;
    } = {},
  ): Promise<{ items: TodoItem[]; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const { objects: resolved, warnings } = await this.resolveObjectNames(
      items.filter(takesCommit).map((item) => item.id),
      options.known,
    );
    let fixupOkay = options.fixupOkay ?? false;
    for (const [k, item] of items.entries()) {
      // parseTodo's check of a fixup made again below, once the names are resolved
      if (!item.invalid) delete item.errors;
      if (takesCommit(item)) {
        const name = item.id;
        const named = resolved.get(name);
        const fail = (lines: string[]) => {
          item.errors = [...lines, `error: invalid line ${k + 1}: ${item.line ?? ""}`];
          item.invalid = true;
          item.rest = item.line ?? "";
          item.action = RebaseAction.COMMENT;
          item.id = "";
        };
        // lookup_commit_reference: tags peeled; another object refused with git's line
        const peeled = named?.commit
          ? { id: named.id, type: "commit" }
          : named
            ? await this.revisionResolver().peelTags(named.id)
            : undefined;
        const id = peeled?.type === "commit" ? peeled.id : undefined;
        if (!named) fail([`error: could not parse '${name}'`]);
        else if (!id) {
          fail(peeled?.type ? [`error: object ${named.id} is a ${peeled.type}, not a commit`] : []);
        } else {
          item.id = id;
          const parents = (await this.loadCommit(id))?.parents ?? [];
          if (parents.length > 1 && isPickLike(item.action)) fail(mergeCommitErrors(item.action));
        }
      }
      if (fixupOkay) {
        // nothing to check
      } else if (isFixup(item.action) && !item.invalid) {
        item.errors = [`error: cannot '${item.action}' without a previous commit`];
      } else if (!isNoop(item)) fixupOkay = true;
      if (item.errors) errors.push(...item.errors);
    }
    return { items, errors, warnings };
  }

  /** Commit names resolved at once (see {@link resolveObjectNames}), tags peeled. */
  private async resolveCommitNames(
    names: string[],
    known?: Map<ObjectId, string>,
  ): Promise<Map<string, ObjectId | undefined>> {
    const { objects } = await this.resolveObjectNames(names, known);
    const out = new Map<string, ObjectId | undefined>();
    for (const [name, named] of objects) {
      out.set(name, !named ? undefined : named.commit ? named.id : await this.commitOf(named.id));
    }
    return out;
  }

  /**
   * The objects todo names stand for, resolved at once as git's repo_get_oid (get_oid_1)
   * resolves each: a full id the store holds is that object; a ref by git's rules
   * (get_oid_basic) before an abbreviation, with git's `warning: refname '<name>' is
   * ambiguous.` when the abbreviation names one object as well (the refs listed once, a
   * ref looked up only for a name some ref could have); an abbreviation as long as one of
   * `known` that starts the same is that commit (unique in the store, as it was written);
   * the other abbreviations looked up in the store together (one listing of its ids where
   * it cannot list by prefix), a prefix of several objects refused as git's get_short_oid
   * refuses it (unless core.disambiguate tells them apart). `commit` marks the ids known to
   * be commits.
   */
  private async resolveObjectNames(
    names: string[],
    known?: Map<ObjectId, string>,
  ): Promise<{
    objects: Map<string, { id: ObjectId; commit?: boolean } | undefined>;
    warnings: string[];
  }> {
    const objects = new Map<string, { id: ObjectId; commit?: boolean } | undefined>();
    const warnings: string[] = [];
    const pending: string[] = [];
    const viaRef: string[] = [];
    let refNames: Set<string> | undefined | null = null;
    for (const name of new Set(names)) {
      if (!/^[0-9a-f]{4,39}$/i.test(name)) {
        objects.set(name, await this.objectNamed(name));
        continue;
      }
      if (refNames === null) refNames = await this.refShortNames();
      if (!refNames || refNames.has(name)) {
        const ids = await this.refsNamed(name, false);
        if (ids[0]) {
          objects.set(name, { id: ids[0] });
          if (ids.length > 1) warnings.push(`warning: refname '${name}' is ambiguous.`);
          else viaRef.push(name);
          continue;
        }
      }
      const fast = known ? knownPrefix(name.toLowerCase(), known) : undefined;
      if (fast) objects.set(name, { id: fast, commit: true });
      else pending.push(name);
    }
    if (pending.length === 0 && viaRef.length === 0) return { objects, warnings };
    const candidates = await this.objectsWithPrefixes(
      [...pending, ...viaRef].map((name) => name.toLowerCase()),
    );
    // get_oid_basic: a ref that an abbreviation of one object (get_short_oid, quietly, no
    // hint) shares
    for (const name of viaRef) {
      if (candidates?.get(name.toLowerCase())?.length === 1) {
        warnings.push(`warning: refname '${name}' is ambiguous.`);
      }
    }
    for (const name of pending) {
      const found = candidates?.get(name.toLowerCase());
      if (!found) {
        const id = await this.commitNamed(name);
        objects.set(name, id ? { id, commit: true } : undefined);
      } else if (found.length === 0) objects.set(name, undefined);
      else if (found.length === 1) objects.set(name, { id: found[0] as ObjectId });
      else {
        // ambiguous: only core.disambiguate can pick one (the revision resolver applies it)
        const id = await this.resolveRevision(name).catch(() => undefined);
        objects.set(name, id ? { id } : undefined);
      }
    }
    return { objects, warnings };
  }

  /**
   * A name that is no abbreviation, as get_oid_basic resolves it: a full id the store holds
   * (of any object), else a ref by git's rules; undefined if neither.
   */
  private async objectNamed(name: string): Promise<{ id: ObjectId; commit?: boolean } | undefined> {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(name)) {
      const id = name.toLowerCase();
      if (await this.commits.has(id).catch(() => false)) return { id, commit: true };
      if (await this.revisionResolver().objectType(id)) return { id };
    }
    const ids = await this.refsNamed(name, true);
    return ids[0] ? { id: ids[0] } : undefined;
  }

  /**
   * The objects of the refs a name stands for by git's ref_rev_parse_rules (as written,
   * under refs/, a tag, a branch, a remote, a remote's HEAD), in that order; the name as
   * written only with `asWritten` (a lowercase abbreviation is no root ref).
   */
  private async refsNamed(name: string, asWritten: boolean): Promise<ObjectId[]> {
    const out: ObjectId[] = [];
    const candidates = [
      ...(asWritten ? [name] : []),
      `refs/${name}`,
      `refs/tags/${name}`,
      `refs/heads/${name}`,
      `refs/remotes/${name}`,
      `refs/remotes/${name}/HEAD`,
    ];
    for (const candidate of candidates) {
      const ref = await this.refsStore.resolve(candidate).catch(() => undefined);
      if (ref?.objectId) out.push(ref.objectId);
    }
    return out;
  }

  /**
   * The names refs/ refs answer to under git's rules (each without `refs/`, `refs/tags/`,
   * `refs/heads/`, `refs/remotes/`, and a remote's `HEAD`), from one listing; undefined
   * where the refs cannot be listed.
   */
  private async refShortNames(): Promise<Set<string> | undefined> {
    const names = new Set<string>();
    try {
      for await (const entry of this.refsStore.list("refs/")) {
        const full = entry.name;
        names.add(full.slice("refs/".length));
        for (const prefix of ["refs/tags/", "refs/heads/", "refs/remotes/"]) {
          if (full.startsWith(prefix)) names.add(full.slice(prefix.length));
        }
        if (full.startsWith("refs/remotes/") && full.endsWith("/HEAD")) {
          names.add(full.slice("refs/remotes/".length, -"/HEAD".length));
        }
      }
    } catch {
      return undefined;
    }
    return names;
  }

  /** The commit an object is (a tag peeled, as lookup_commit_reference), else undefined. */
  private async commitOf(id: ObjectId): Promise<ObjectId | undefined> {
    const peeled = await this.peelToCommit(id);
    return (await this.commits.has(peeled).catch(() => false)) ? peeled : undefined;
  }

  /**
   * The stored ids starting with each lowercase prefix: by prefix where the store can list
   * so, else one listing of every id for all of them; undefined without an object store.
   */
  private async objectsWithPrefixes(
    prefixes: string[],
  ): Promise<Map<string, ObjectId[]> | undefined> {
    const objects = this.workingCopy.history?.objects;
    if (!objects) return undefined;
    const found = new Map(prefixes.map((prefix) => [prefix, new Set<ObjectId>()]));
    try {
      if (objects.listPrefix) {
        for (const [prefix, ids] of found) {
          for await (const id of listObjectsWithPrefix(objects, prefix)) ids.add(id);
        }
      } else {
        const lengths = [...new Set(prefixes.map((prefix) => prefix.length))];
        for await (const id of objects.list()) {
          for (const length of lengths) found.get(id.slice(0, length))?.add(id);
        }
      }
    } catch {
      return undefined;
    }
    return new Map([...found].map(([prefix, ids]) => [prefix, [...ids]]));
  }

  /** A commit by name: an id (abbreviated), a ref, a branch, a tag; undefined if none. */
  private async commitNamed(name: string): Promise<ObjectId | undefined> {
    if (/^[0-9a-f]{4,64}$/i.test(name)) {
      try {
        return await expandCommitId(
          {
            commits: this.commits,
            refs: this.refsStore,
            state: new OperationState(this.workingCopy.checkout, this.refsStore),
          },
          name.toLowerCase(),
        );
      } catch {
        // not an abbreviation of one commit: maybe a ref
      }
    }
    return this.refNamed(name);
  }

  /** A commit by ref name (as given, under refs/, a tag, a branch); undefined if none. */
  private async refNamed(name: string): Promise<ObjectId | undefined> {
    for (const candidate of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`]) {
      const ref = await this.refsStore.resolve(candidate).catch(() => undefined);
      if (ref?.objectId) {
        const id = await this.peelToCommit(ref.objectId);
        if (await this.commits.has(id).catch(() => false)) return id;
      }
    }
    return undefined;
  }

  /**
   * An `--autosquash` target that is one word (todo_list_rearrange_squash's
   * lookup_commit_reference_by_name, whose commit counts only when it is in the list): the
   * list's own commits matched by id first; a hex word no commit of the list starts with can
   * only name one of them as a ref.
   */
  private async autosquashTarget(
    name: string,
    known: Map<ObjectId, string>,
  ): Promise<ObjectId | undefined> {
    if (!/^[0-9a-f]{4,64}$/i.test(name)) return this.commitNamed(name);
    const lower = name.toLowerCase();
    if (lower.length >= 40) return known.has(lower) ? lower : this.refNamed(name);
    const fast = knownPrefix(lower, known);
    if (fast) return fast;
    for (const id of known.keys()) {
      // lookup_commit_reference_by_name: an abbreviation read as a committish
      if (id.startsWith(lower)) return this.commitNamed(name);
    }
    return this.refNamed(name);
  }

  /** is_original_commit_empty: the commit changes nothing against its parent (or none). */
  private async originallyEmpty(id: ObjectId): Promise<boolean> {
    const commit = await this.loadCommit(id);
    if (!commit) return false;
    const parentTree = commit.parents[0]
      ? (await this.loadCommit(commit.parents[0]))?.tree
      : EMPTY_TREE_ID;
    return commit.tree === parentTree;
  }

  /** rebase.missingCommitsCheck (ignore, warn, error; anything else warned about). */
  private missingCommitsCheckLevel(output: string[]): "ignore" | "warn" | "error" {
    const value = configValue(this.workingCopy, "rebase.missingCommitsCheck");
    if (value === undefined || value.toLowerCase() === "ignore") return "ignore";
    if (value.toLowerCase() === "warn") return "warn";
    if (value.toLowerCase() === "error") return "error";
    output.push(
      `warning: unrecognized setting ${value} for option rebase.missingCommitsCheck. Ignoring.`,
    );
    return "ignore";
  }

  /**
   * rebase-interactive.c's todo_list_check: the commits of the list before editing that the
   * edited one dropped (newer to older), with git's warning; nothing when none or ignored.
   */
  private async missingCommits(
    before: TodoItem[],
    after: TodoItem[],
    level: "ignore" | "warn" | "error",
  ): Promise<string[]> {
    if (level === "ignore") return [];
    const seen = new Set<ObjectId>();
    for (const item of after) if (takesCommit(item)) seen.add(item.id);
    const missing: string[] = [];
    for (let i = before.length - 1; i >= 0; i--) {
      const item = before[i] as TodoItem;
      if (!takesCommit(item) || seen.has(item.id)) continue;
      missing.push(` - ${await this.abbreviateObjectId(item.id)} ${item.rest ?? ""}`);
      seen.add(item.id);
    }
    if (missing.length === 0) return [];
    return [
      "Warning: some commits may have been dropped accidentally.",
      "Dropped commits (newer to older):",
      ...missing,
      'To avoid this message, use "drop" to explicitly remove a commit.',
      "",
      "Use 'git config rebase.missingCommitsCheck' to change the level of warnings.",
      "The possible behaviours are: ignore, warn, error.",
      "",
      ...EDIT_TODO_ADVICE,
    ];
  }

  /** The abbreviated ids of the list's commits (TODO_LIST_SHORTEN_IDS), in one batch. */
  private async shortIds(items: TodoItem[]): Promise<Map<ObjectId, string>> {
    const ids = [...new Set(items.filter(takesCommit).map((item) => item.id))];
    const lengths = await this.idAbbreviator().lengths(ids);
    return new Map(ids.map((id) => [id, id.slice(0, lengths.get(id) ?? 7)]));
  }

  /**
   * launch_sequence_editor: the interactive handler edits the list (editTodo, then the
   * steps of prepareSteps); without one the list is kept.
   */
  private async runSequenceEditor(
    text: string,
    /** The abbreviations the list was written with (see {@link resolveCommitNames}) */
    known?: Map<ObjectId, string>,
  ): Promise<string> {
    const handler = this.interactiveHandler;
    let out = text;
    if (handler?.editTodo) out = await handler.editTodo(out);
    if (handler?.prepareSteps) {
      const comment = commentPrefixOf(this.workingCopy);
      const items = parseTodo(stripspace(out, comment), comment).items.filter(
        (item) => item.action !== RebaseAction.COMMENT,
      );
      const ids = await this.resolveCommitNames(
        items.filter(takesCommit).map((item) => item.id),
        known,
      );
      const steps: RebaseTodoLine[] = [];
      for (const item of items) {
        if (takesCommit(item)) {
          const id = ids.get(item.id);
          steps.push({
            action: item.action,
            commit: item.id,
            shortMessage: subjectOf((id ? await this.loadCommit(id) : undefined)?.message ?? ""),
            ...(item.replaceMessage ? { fixupFlag: "C" as const } : {}),
            ...(item.editMessage && item.action === RebaseAction.FIXUP
              ? { fixupFlag: "c" as const }
              : {}),
          });
        } else
          steps.push({
            action: item.action,
            commit: "",
            shortMessage: "",
            argument: item.rest ?? "",
          });
      }
      try {
        handler.prepareSteps(steps);
      } catch (error) {
        throw new HandlerFailure("prepareSteps", error);
      }
      out = "";
      for (const step of steps) {
        if (step.action === RebaseAction.COMMENT) continue;
        if (!step.commit) {
          out += `${step.action}${step.argument ? ` ${step.argument}` : ""}\n`;
          continue;
        }
        const original = items.find(
          (item) =>
            takesCommit(item) &&
            (item.id.startsWith(step.commit) || step.commit.startsWith(item.id)),
        );
        const flag = step.fixupFlag ? ` -${step.fixupFlag}` : "";
        const rest = original?.rest ?? (step.shortMessage ? `# ${step.shortMessage}` : "");
        out += `${step.action}${flag} ${step.commit}${rest ? ` ${rest}` : ""}\n`;
      }
    }
    return out;
  }

  /**
   * `git rebase --edit-todo` (edit_todo_file): the rest of the list edited by the
   * interactive handler (git's help for an ongoing rebase after it), checked as git checks
   * it, written back with the full ids.
   */
  private async editTodo(state: OperationState): Promise<RebaseResult> {
    if (!(await this.inProgress(state))) throw new NoRebaseInProgressError();
    const comment = commentPrefixOf(this.workingCopy);
    const abbreviate = configBool(this.workingCopy, "rebase.abbreviateCommands", false);
    const output: string[] = [];
    const current = stripspace((await state.read(`${DIR}/git-rebase-todo`)) ?? "", comment);
    const fixupOkay = await state.exists(`${DIR}/done`);
    const old = await this.resolveTodo(parseTodo(current, comment, fixupOkay).items, {
      fixupOkay,
    });
    const incorrect = old.errors.length > 0 || (await state.exists(`${DIR}/dropped`));
    const level = this.missingCommitsCheckLevel(output);
    const help = todoHelp(countTodoCommands(old.items), comment, undefined, level === "error");
    const shorts = await this.shortIds(old.items);
    const text = `${formatTodo(old.items, { abbreviate, idOf: (id) => shorts.get(id) ?? id })}${help}`;
    await state.write(`${DIR}/git-rebase-todo`, text);
    if (!incorrect) {
      await state.write(
        `${DIR}/git-rebase-todo.backup`,
        `${formatTodo(old.items, { abbreviate })}${help}`,
      );
    }
    let edited: string;
    try {
      edited = await this.runSequenceEditor(text, shorts);
    } catch (error) {
      // edit_todo_list's -2: the list stays as written for the editor
      return { status: RebaseStatus.FAILED, message: sequenceEditorFailure(error), output };
    }
    await state.write(`${DIR}/git-rebase-todo`, edited);
    // the names read back against the list as it was before the edit
    const parsed = await this.resolveTodo(
      parseTodo(stripspace(edited, comment), comment, fixupOkay).items,
      { known: shorts, fixupOkay },
    );
    output.push(...parsed.warnings);
    if (parsed.errors.length > 0) {
      return {
        status: RebaseStatus.FAILED,
        message: [...parsed.errors, ...EDIT_TODO_ADVICE].join("\n"),
        output,
      };
    }
    let reference = old.items;
    if (incorrect) {
      reference = (
        await this.resolveTodo(
          parseTodo((await state.read(`${DIR}/git-rebase-todo.backup`)) ?? "", comment).items,
        )
      ).items;
    }
    const missing = await this.missingCommits(reference, parsed.items, level);
    if (missing.length > 0 && level === "error") {
      await state.write(`${DIR}/dropped`, "");
      return { status: RebaseStatus.FAILED, message: missing.join("\n"), output };
    }
    output.push(...missing);
    // edit_todo_list unlinks it only when `incorrect` is positive: the list read before the
    // edit parsed (todo_list_parse_insn_buffer's -1 or'ed with the file's 1 stays negative)
    if (incorrect && old.errors.length === 0) await state.remove(`${DIR}/dropped`);
    await this.filterUpdateRefs(state, parsed.items);
    await state.write(
      `${DIR}/git-rebase-todo`,
      formatTodo(
        parsed.items.map(({ line: _, ...item }) => item as TodoItem),
        { abbreviate },
      ),
    );
    return { status: RebaseStatus.OK, output };
  }

  /** `rebase-merge/update-refs`: ref, its value at the start, the value to give it. */
  private async readUpdateRefs(state: OperationState): Promise<UpdateRefRecord[]> {
    const lines = ((await state.read(`${DIR}/update-refs`)) ?? "").split("\n");
    const out: UpdateRefRecord[] = [];
    for (let k = 0; k + 2 < lines.length; k += 3) {
      out.push({
        ref: lines[k] as string,
        before: lines[k + 1] as string,
        after: lines[k + 2] as string,
      });
    }
    return out;
  }

  /** write_update_refs_state: the records sorted by ref; no file when there are none. */
  private async writeUpdateRefs(state: OperationState, records: UpdateRefRecord[]): Promise<void> {
    if (records.length === 0) {
      await state.remove(`${DIR}/update-refs`);
      return;
    }
    const sorted = [...records].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    await state.write(
      `${DIR}/update-refs`,
      sorted.map((r) => `${r.ref}\n${r.before}\n${r.after}\n`).join(""),
    );
  }

  /**
   * todo_list_add_update_ref_commands (`--update-refs`): after each command with a commit,
   * an `update-ref <branch>` for each other branch at that commit (the last in name order
   * first, as git's decorations list them); a branch checked out in another worktree gets a
   * comment instead. The records written to `rebase-merge/update-refs`.
   */
  private async addUpdateRefCommands(
    state: OperationState,
    items: TodoItem[],
    comment: string,
  ): Promise<TodoItem[]> {
    const headRef = await this.refsStore.get("HEAD");
    const current = headRef && isSymbolicRef(headRef) ? headRef.target : undefined;
    const branches = new Map<ObjectId, string[]>();
    const names: string[] = [];
    for await (const ref of this.refsStore.list("refs/heads/")) {
      if (ref.name.startsWith("refs/heads/")) names.push(ref.name);
    }
    names.sort();
    const values = new Map<string, ObjectId>();
    for (const name of names) {
      const value = (await this.refsStore.resolve(name).catch(() => undefined))?.objectId;
      if (!value) continue;
      values.set(name, value);
      const id = await this.peelToCommit(value);
      branches.set(id, [name, ...(branches.get(id) ?? [])]);
    }
    const checkedOut = new Map<string, string>();
    const worktrees = this.workingCopy.worktrees;
    if (worktrees) {
      for (const wt of await worktrees.list().catch(() => [])) {
        for (const name of names) {
          if (!checkedOut.has(name) && usesBranch(wt, name)) checkedOut.set(name, wt.path);
        }
      }
    }
    const records: UpdateRefRecord[] = [];
    const out: TodoItem[] = [];
    for (const item of items) {
      out.push(item);
      if (!item.id || item.action === RebaseAction.COMMENT) continue;
      for (const name of branches.get(item.id) ?? []) {
        if (name === current) continue;
        const path = checkedOut.get(name);
        if (path !== undefined) {
          out.push({
            action: RebaseAction.COMMENT,
            id: "",
            rest: `${comment} Ref ${name} checked out at '${path}'`,
            blankAfter: true,
          });
        } else {
          out.push({ action: RebaseAction.UPDATE_REF, id: "", rest: name, blankAfter: true });
          if (!records.some((r) => r.ref === name)) {
            records.push({ ref: name, before: values.get(name) ?? ZERO_ID, after: ZERO_ID });
          }
        }
      }
    }
    await this.writeUpdateRefs(state, records);
    return out;
  }

  /**
   * todo_list_filter_update_refs: the records of refs the edited list no longer updates (and
   * not updated yet) dropped, the refs it newly names added.
   */
  private async filterUpdateRefs(state: OperationState, items: TodoItem[]): Promise<void> {
    const records = await this.readUpdateRefs(state);
    const named = items
      .filter((item) => item.action === RebaseAction.UPDATE_REF && !item.invalid)
      .map((item) => item.rest ?? "");
    let updated = false;
    const kept = records.filter((r) => {
      const keep = r.after !== ZERO_ID || named.includes(r.ref);
      if (!keep) updated = true;
      return keep;
    });
    for (const ref of named) {
      if (!kept.some((r) => r.ref === ref)) {
        const value = (await this.refsStore.resolve(ref).catch(() => undefined))?.objectId;
        kept.push({ ref, before: value ?? ZERO_ID, after: ZERO_ID });
        updated = true;
      }
    }
    if (updated) await this.writeUpdateRefs(state, kept);
  }

  /** do_update_ref: the ref's record takes HEAD. */
  private async updateRefRecord(state: OperationState, ref: string): Promise<void> {
    const records = await this.readUpdateRefs(state);
    const head = await this.resolveHead();
    for (const record of records) {
      if (record.ref === ref) {
        record.after = head;
        break;
      }
    }
    await this.writeUpdateRefs(state, records);
  }

  /**
   * do_update_refs: each recorded ref moved to its new value if it still has its old one
   * (`rewritten during rebase`), with git's `Updated the following refs with --update-refs:`.
   */
  private async doUpdateRefs(state: OperationState, output: string[]): Promise<void> {
    const records = await this.readUpdateRefs(state);
    const updated: string[] = [];
    const failed: string[] = [];
    for (const record of records) {
      const value = (await this.refsStore.resolve(record.ref).catch(() => undefined))?.objectId;
      if ((value ?? ZERO_ID) !== record.before || record.after === ZERO_ID) {
        failed.push(record.ref);
        continue;
      }
      await this.refsStore.set(
        record.ref,
        record.after,
        this.reflogLine("rewritten during rebase", this.committer),
      );
      updated.push(record.ref);
    }
    if (updated.length + failed.length === 0) return;
    output.push("Updated the following refs with --update-refs:", ...updated.map((r) => `\t${r}`));
    if (failed.length > 0) {
      output.push(
        "Failed to update the following refs with --update-refs:",
        ...failed.map((r) => `\t${r}`),
      );
    }
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

  /**
   * builtin/rebase.c's can_fast_forward for `git rebase <upstream>` (onto the upstream, no
   * fork point, no --keep-base): HEAD and upstream have one merge base, upstream itself, and
   * the first-parent line from HEAD down to it has no merge (is_linear_history). Upstream
   * in HEAD's history is that one merge base.
   */
  private async canFastForward(onto: ObjectId, head: ObjectId): Promise<boolean> {
    if (!(await this.isAncestor(onto, head))) return false;
    let id: ObjectId | undefined = head;
    while (id !== undefined && id !== onto) {
      const parents: ObjectId[] = (await this.loadCommit(id))?.parents ?? [];
      if (parents.length > 1) return false;
      id = parents[0];
    }
    return true;
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
    "hint:",
    `hint:     ${line}`,
    "hint:",
    "hint: It has been rescheduled; To edit the command before continuing, please",
    "hint: edit the todo list first:",
    "hint:",
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

/** check_merge_commit_insn: a merge where a pick-like command cannot take one. */
function mergeCommitErrors(action: RebaseAction): string[] {
  switch (action) {
    case RebaseAction.PICK:
      return [
        "error: 'pick' does not accept merge commits",
        "hint: 'pick' does not take a merge commit. If you wanted to",
        "hint: replay the merge, use 'merge -C' on the commit.",
        'hint: Disable this message with "git config set advice.rebaseTodoError false"',
      ];
    case RebaseAction.REWORD:
      return [
        "error: 'reword' does not accept merge commits",
        "hint: 'reword' does not take a merge commit. If you wanted to",
        "hint: replay the merge and reword the commit message, use",
        "hint: 'merge -c' on the commit",
        'hint: Disable this message with "git config set advice.rebaseTodoError false"',
      ];
    case RebaseAction.EDIT:
      return [
        "error: 'edit' does not accept merge commits",
        "hint: 'edit' does not take a merge commit. If you wanted to",
        "hint: replay the merge, use 'merge -C' on the commit, and then",
        "hint: 'break' to give the control back to you so that you can",
        "hint: do 'git commit --amend && git rebase --continue'.",
        'hint: Disable this message with "git config set advice.rebaseTodoError false"',
      ];
    default:
      return ["error: cannot squash merge commit into another commit"];
  }
}

/**
 * A message editor (the interactive handler's modifyCommitMessage) that threw, as git commit
 * failing on its editor: the pick counts as conflicted (do_pick_commit's `res = !!res`).
 */
function editorFailure(error: unknown): Extract<PickOutcome, { kind: "conflicts" }> {
  return {
    kind: "conflicts",
    conflicts: [],
    // git commit's line after the editor's
    lines: [
      editorProblem("modifyCommitMessage", error),
      "Please supply the message using either -m or -F option.",
    ],
  };
}

/** launch_sequence_editor failing (the interactive handler's editTodo or prepareSteps threw). */
function sequenceEditorFailure(error: unknown): string {
  return error instanceof HandlerFailure
    ? editorProblem(error.editor, error.reason)
    : editorProblem("editTodo", error);
}

/**
 * editor.c's `there was a problem with the editor '<editor>'`: the editor named by the
 * interactive handler's method that threw, its reason after.
 */
function editorProblem(editor: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `error: there was a problem with the editor '${editor}': ${reason}`;
}

/** An interactive handler's method that threw, named. */
class HandlerFailure extends Error {
  constructor(
    readonly editor: string,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

/**
 * The commit of `known` whose abbreviation `prefix` extends (at least as long as it, so no
 * other stored object starts with it), else undefined.
 */
function knownPrefix(prefix: string, known: Map<ObjectId, string>): ObjectId | undefined {
  for (const [id, short] of known) {
    if (prefix.length >= short.length && id.startsWith(prefix)) return id;
  }
  return undefined;
}
