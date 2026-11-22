/**
 * CheckoutCommand - Switch branches or restore files.
 *
 * Implements JGit-compatible fluent API for `git checkout` command:
 * - Checkout branches, tags, or commits
 * - Create new branches on checkout (-b flag)
 * - Restore specific paths from index or commits
 * - Detached HEAD mode for commit checkout
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/CheckoutCommand.java
 *
 * @example
 * ```typescript
 * // Checkout existing branch
 * await git.checkout().setName("feature").call();
 *
 * // Create and checkout new branch
 * await git.checkout()
 *   .setCreateBranch(true)
 *   .setName("newbranch")
 *   .call();
 *
 * // Checkout paths from index
 * await git.checkout()
 *   .addPath("file.txt")
 *   .call();
 *
 * // Checkout paths from specific commit
 * await git.checkout()
 *   .setStartPoint("HEAD~1")
 *   .addPath("file.txt")
 *   .call();
 * ```
 */

import {
  FileMode,
  isSymbolicRef,
  isValidBranchName,
  type ObjectId,
  type Ref,
} from "@statewalker/vcs-core";
import { type ConflictStyle, parseGitBool } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  attributesIndexOf,
  cacheTreeOfTree,
  entryStatOf,
  isIndexUnborn,
  type StagingEntry,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import {
  IncompatibleOptionsError,
  InvalidArgumentError,
  InvalidRefNameError,
  MissingArgumentError,
  NoHeadError,
  NotACommitError,
  RefAlreadyExistsError,
  RefNotFoundError,
  SwitchRefusedError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { StashApplyStatus } from "../results/index.js";
import {
  type PatchCompatibility,
  type PatchOptions,
  type PatchResult,
  type PatchSelector,
  patchRevisionOf,
  pathPatchMode,
  runPatchSelection,
} from "./add-patch/index.js";
import {
  guessRemoteBranch,
  installTracking,
  planTracking,
  type TrackingPlan,
  TrackMode,
  trackableStart,
} from "./branch-tracking.js";
import { type CheckoutPathsOutcome, runPathCheckout } from "./checkout-paths.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { runPostCheckoutHook } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { OperationState, updateIndexCacheTree } from "./merge-support.js";
import { globalPathspecMagic, parsePathspecFile } from "./pathspec.js";
import { markIndexUpdate } from "./post-index-change.js";
import { reflogMessages } from "./reflog-messages.js";
import { checkFlaggedEntries, recordWrittenStat, restoreWorktreeHard } from "./reset-command.js";
import { removeBranchState } from "./sequencer-support.js";
import { pushSparseWarnings, SparseUnpack } from "./sparse-checkout-support.js";
import { StashApplyCommand } from "./stash-apply-command.js";
import { StashCreateCommand } from "./stash-create-command.js";
import { STASH_REF } from "./stash-list-command.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";
import {
  entryNotUptodate,
  findInTheWay,
  flaggedEntryDiffers,
  overwriteMessage,
  pruneEmptyParents,
} from "./worktree-overwrite-checks.js";
import { refuseIfCheckedOut, shortBranchName } from "./worktree-support.js";

/** git's `apply_save_autostash_oid` advice when the autostash conflicts. */
const AUTOSTASH_CONFLICT_ADVICE = [
  "Your local changes are stashed, however applying them",
  "resulted in conflicts.  You can either resolve the conflicts",
  'and then discard the stash with "git stash drop", or, if you',
  'do not want to resolve them now, run "git reset --hard" and',
  'apply the local changes later by running "git stash pop".',
].join("\n");

/**
 * The name git's `switch_branches` gives the target (`new_branch_info->name`), which
 * labels the autostash: the branch, the name as given for a detached HEAD, the start point
 * of a branch being created.
 */
function autostashLabel(plan: SwitchPlan): string {
  return plan.kind === "create" ? plan.startName : plan.logName;
}

/** Names a branch checkout in failure messages. */
const CHECKOUT = "checkout";

/**
 * Stage to check out for conflicting files.
 */
export enum CheckoutStage {
  /** Base stage (ancestor) */
  BASE = 1,
  /** Ours stage (current branch) */
  OURS = 2,
  /** Theirs stage (merged branch) */
  THEIRS = 3,
}

/**
 * Status of checkout operation.
 */
export enum CheckoutStatus {
  /** Checkout completed successfully */
  OK = "OK",
  /** Checkout had conflicts */
  CONFLICTS = "CONFLICTS",
  /** Some files couldn't be deleted */
  NONDELETED = "NONDELETED",
  /** Checkout not attempted */
  NOT_TRIED = "NOT_TRIED",
  /** Checkout failed with error */
  ERROR = "ERROR",
}

/**
 * Result of CheckoutCommand execution.
 */
export interface CheckoutResult {
  /** Status of the operation */
  readonly status: CheckoutStatus;

  /** Files that were updated */
  readonly updated: string[];

  /** Files that were removed */
  readonly removed: string[];

  /** Files that couldn't be checked out (conflicts) */
  readonly conflicts: string[];

  /** The ref that was checked out (null for path checkout) */
  readonly ref: Ref | null;

  /**
   * Why a checkout was refused, in git's words (`status` CONFLICTS): local changes or
   * untracked files the switch would overwrite, or an index with unmerged entries.
   */
  readonly message?: string;

  /**
   * What a branch switch printed on stderr while applying the sparse checkout's patterns,
   * line by line (the patterns' warnings, git's "The following paths are not up to date and
   * were left despite sparse patterns:" block), and git's "Autostash exists; creating a new
   * stash entry." lines when a stopped merge's autostash is kept on `refs/stash`; absent when
   * there was nothing to say.
   */
  readonly warnings?: string[];

  /**
   * git's exit status where `status` alone does not give it (OK: 0, CONFLICTS: 1): a path
   * checkout that could not write an entry exits 255
   */
  readonly exitCode?: number;

  /** With `setPatch`: what the hunk selection printed and applied */
  readonly patch?: PatchResult;
}

/** A tree or index entry, as the two-way merge compares them (index entries with stat). */
interface Side {
  objectId: ObjectId;
  mode: number;
  size?: number;
  mtime?: number;
  ctime?: number;
}

const sameSide = (a: Side | undefined, b: Side | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/**
 * How a new branch tracks its start point, decided before anything is written; the
 * refusals are thrown where git dies (`create_branch`): a start point `--track` cannot
 * track before the branch is created, ambiguous remotes after.
 */
interface CreateTracking {
  readonly plan?: TrackingPlan;
  readonly notABranch?: unknown;
  readonly ambiguous?: unknown;
}

/**
 * What a branch checkout switches to; `logName` names it in HEAD's reflog line. A
 * `stay` plan (`checkout HEAD`) checks the worktree out but leaves HEAD as it is.
 */
type SwitchPlan =
  | { kind: "branch"; branch: string; targetId: ObjectId; logName: string }
  | {
      kind: "create";
      branch: string;
      startName: string;
      targetId: ObjectId;
      logName: string;
      tracking: CreateTracking;
    }
  | {
      kind: "orphan";
      branch: string;
      targetId?: undefined;
      logName: string;
      /** `checkout --orphan <new> <start-point>`: the commit whose tree the switch merges to */
      startId?: ObjectId;
    }
  | { kind: "detach"; targetId: ObjectId; logName: string }
  | { kind: "stay"; targetId: ObjectId; logName: string };

/**
 * Command to checkout branches, commits, or paths.
 *
 * Based on JGit's CheckoutCommand. Supports both branch checkout
 * (switching HEAD) and path checkout (restoring files).
 */
export class CheckoutCommand extends GitCommand<CheckoutResult> {
  private name: string | undefined;
  private createBranch = false;
  private patch = false;
  private patchSelector?: PatchSelector;
  private patchOptions: PatchOptions = {};
  private patchCompatibility: PatchCompatibility = "2.56";
  private forceCreateBranch = false;
  private orphan = false;
  private force = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: JGit compatibility - will be used for branch reset
  private forceRefUpdate = false;
  private startPoint: string | undefined;
  private paths: string[] = [];
  private allPaths = false;
  private stage: CheckoutStage | undefined;
  private ignoreOtherWorktrees = false;
  private detach = false;
  private orphanFromEmptyTree = false;
  private onlyMergeOnSwitchingBranches = false;
  private track = TrackMode.DEFAULT;
  private guess?: boolean;
  private protectUntracked = false;
  private merge = false;
  private overlay?: boolean;
  private ignoreSkipWorktreeBits = false;
  private conflictStyle?: ConflictStyle;
  private quiet = false;
  private countCheckoutPaths = false;
  private pathspecFromFile: string[] = [];
  /** Whether `--pathspec-from-file` was given (an empty file included) */
  private pathspecFileGiven = false;
  /** Set by a `merge` checkout the two-way merge refused: what the autostash needs */
  private autostashSwitch?: { label: string; base: string };

  /**
   * Set the name of the branch or commit to check out.
   *
   * When checking out a branch, HEAD becomes a symbolic ref to that branch.
   * When checking out a commit/tag, HEAD becomes detached.
   *
   * @param name Branch name, tag name, or commit ID
   * @returns this for chaining
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Set whether to create a new branch.
   *
   * If true, a new branch with setName() will be created at setStartPoint()
   * (or HEAD if not specified) and checked out.
   *
   * Equivalent to `git checkout -b <name>`: refused when the branch exists
   * (`RefAlreadyExistsError`, "fatal: a branch named 'x' already exists"); use
   * {@link setForceCreateBranch} (`-B`) to reset an existing branch instead.
   *
   * @param createBranch Whether to create a new branch
   * @returns this for chaining
   */
  setCreateBranch(createBranch: boolean): this {
    this.checkCallable();
    this.createBranch = createBranch;
    if (!createBranch) this.forceCreateBranch = false;
    return this;
  }

  /**
   * Create the branch named by setName(), or reset it to the start point when it exists,
   * and check it out (git's `checkout -B <name> [<start-point>]`; "branch: Reset to
   * <start>" in its reflog). Implies {@link setCreateBranch}.
   *
   * @param force Whether to create or reset the branch
   * @returns this for chaining
   */
  setForceCreateBranch(force: boolean): this {
    this.checkCallable();
    this.forceCreateBranch = force;
    if (force) this.createBranch = true;
    return this;
  }

  /**
   * Set whether to create an orphan branch.
   *
   * An orphan branch has no parent commits. The index and working tree
   * are set to the start point, but no commit is made.
   *
   * Equivalent to `git checkout --orphan <name>`.
   *
   * @param orphan Whether to create orphan branch
   * @returns this for chaining
   */
  setOrphan(orphan: boolean): this {
    this.checkCallable();
    this.orphan = orphan;
    return this;
  }

  /**
   * Set whether to force checkout.
   *
   * If true, checkout will proceed even if there are local changes
   * that would be overwritten.
   *
   * Equivalent to `git checkout -f` or `git checkout --force`.
   *
   * @param force Whether to force checkout
   * @returns this for chaining
   */
  setForced(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Check out a branch even when another worktree has it checked out (git's
   * `--ignore-other-worktrees`). Without it such a checkout, and resetting such a branch
   * with `setForceCreateBranch` (`checkout -B`, as git 2.44 and later refuse it), is refused with
   * `BranchUsedByWorktreeError` ("'x' is already used by worktree at '<path>'"), where the
   * backend keeps linked worktrees (`WorkingCopy.worktrees`).
   *
   * @param ignore Whether to ignore other worktrees
   * @returns this for chaining
   */
  setIgnoreOtherWorktrees(ignore: boolean): this {
    this.checkCallable();
    this.ignoreOtherWorktrees = ignore;
    return this;
  }

  /**
   * Detach HEAD at the commit named by {@link setName} (`HEAD` when no name is set), even
   * when it names a branch (git's `checkout --detach [<commit>]`): HEAD's reflog reads
   * `checkout: moving from main to HEAD` (or the name as given).
   *
   * @param detach Whether to detach HEAD
   * @returns this for chaining
   */
  setDetach(detach: boolean): this {
    this.checkCallable();
    this.detach = detach;
    return this;
  }

  /**
   * How a branch created by the checkout tracks its start point (git's `--track`,
   * `--track=inherit`, `--no-track`); by default as `branch.autoSetupMerge` says, which
   * tracks a remote-tracking start point (`branch.<name>.remote`, `branch.<name>.merge`).
   *
   * @param mode Tracking mode
   * @returns this for chaining
   */
  setTrack(mode: TrackMode): this {
    this.checkCallable();
    this.track = mode;
    return this;
  }

  /**
   * Whether a name no ref has is taken for the one remote-tracking branch of that name
   * (git's `--guess`/`--no-guess`, default `checkout.guess`, true): `checkout dev` with
   * only `origin/dev` creates `dev` from it, tracking it. With several remotes having it,
   * `checkout.defaultRemote` picks one, else the checkout is refused (`'dev' matched
   * multiple (2) remote tracking branches`).
   *
   * @param guess Whether to guess
   * @returns this for chaining
   */
  setGuess(guess: boolean): this {
    this.checkCallable();
    this.guess = guess;
    return this;
  }

  /**
   * git's `only_merge_on_switching_branches` (`git switch`, and `git checkout -b <new>`
   * given exactly so): a switch that names no target (a new branch without a start point,
   * `--detach` without a commit) only moves HEAD, leaving the index and the worktree as
   * they are (no index write, no check of unmerged entries, an unborn index left unborn).
   * By default, as `git checkout` with any other arguments, such a switch still runs the
   * two-way merge from HEAD to HEAD (an unborn index is then checked out).
   *
   * @param only Whether only a switch to a named target merges
   * @returns this for chaining
   */
  setOnlyMergeOnSwitchingBranches(only: boolean): this {
    this.checkCallable();
    this.onlyMergeOnSwitchingBranches = only;
    return this;
  }

  /** Whether this switch skips merge_working_tree (see {@link setOnlyMergeOnSwitchingBranches}). */
  private skipsMergeWorkingTree(): boolean {
    if (!this.onlyMergeOnSwitchingBranches || this.orphan) return false;
    if (this.createBranch || this.forceCreateBranch) return this.startPoint === undefined;
    return this.detach && this.name === undefined;
  }

  /**
   * With {@link setOrphan}: the new branch starts from an empty index and worktree, the
   * tracked files removed as by a switch to an empty tree (git's `switch --orphan`; local
   * changes to tracked files refuse it, untracked files stay).
   *
   * @param empty Whether the orphan starts empty
   * @returns this for chaining
   */
  setOrphanFromEmptyTree(empty: boolean): this {
    this.checkCallable();
    this.orphanFromEmptyTree = empty;
    return this;
  }

  /**
   * With {@link setForced}: local changes are thrown away but untracked files in the way
   * still refuse the switch (git's `switch --discard-changes` without `-f`, a reset that
   * protects untracked files): `error: Untracked working tree file '<path>' would be
   * overwritten by merge.`
   *
   * @param protect Whether untracked files are kept
   * @returns this for chaining
   */
  setProtectUntracked(protect: boolean): this {
    this.checkCallable();
    this.protectUntracked = protect;
    return this;
  }

  /**
   * `-m` / `--merge` (git 2.55+): when local changes stand in the way of the switch, they
   * are carried over as git does it, through an autostash. The changes are stashed, the
   * switch made from a clean index and worktree, and the stash applied on top with the
   * conflict labels `<target>` (the new branch's side) and `local` (the changes). Clean,
   * the result is `OK` with message `Applied autostash.` (staged changes come back
   * unstaged, new files staged, as `git stash apply` leaves them). With conflicts the
   * switch is still made: status `CONFLICTS` with `ref` set (HEAD's new value), the
   * conflicted paths at stages 1-3 with conflict markers, the changes kept as `stash@{0}`
   * ("autostash while switching to '<target>'"), and git's advice as the message.
   *
   * @example
   * ```typescript
   * const result = await git.checkout().setName("feature").setMerge(true).call();
   * if (result.status === CheckoutStatus.CONFLICTS && result.ref) {
   *   // switched; resolve result.conflicts, then `git stash drop`
   * }
   * ```
   *
   * @param merge Whether to merge local changes into the switch
   * @returns this for chaining
   */
  setMerge(merge: boolean): this {
    this.checkCallable();
    this.merge = merge;
    return this;
  }

  /**
   * Set whether to force ref update.
   *
   * If true and the branch already exists, it will be reset to
   * the start point.
   *
   * @param forceRefUpdate Whether to force ref update
   * @returns this for chaining
   */
  setForceRefUpdate(forceRefUpdate: boolean): this {
    this.checkCallable();
    this.forceRefUpdate = forceRefUpdate;
    return this;
  }

  /**
   * Set the start point for branch creation or path checkout.
   *
   * For branch creation: the commit where the new branch starts.
   * For path checkout: the commit to restore files from (default: index).
   *
   * @param startPoint Commit ID, branch name, or tag name
   * @returns this for chaining
   */
  setStartPoint(startPoint: string): this {
    this.checkCallable();
    this.startPoint = startPoint;
    return this;
  }

  /**
   * Add a path to checkout.
   *
   * When paths are specified, this becomes a path checkout rather than
   * a branch checkout. Files are restored from index or setStartPoint().
   *
   * @param path Path to checkout
   * @returns this for chaining
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Set whether to checkout all paths.
   *
   * When true, all files in the index (or start point) are checked out.
   *
   * @param allPaths Whether to checkout all paths
   * @returns this for chaining
   */
  setAllPaths(allPaths: boolean): this {
    this.checkCallable();
    this.allPaths = allPaths;
    return this;
  }

  /**
   * Set the stage to checkout for conflicting files.
   *
   * Only applicable for path checkout from index when files have
   * conflicts (multiple stages).
   *
   * @param stage Stage to checkout (OURS, THEIRS, or BASE)
   * @returns this for chaining
   */
  setStage(stage: CheckoutStage): this {
    this.checkCallable();
    this.stage = stage;
    return this;
  }

  /**
   * `--overlay` / `--no-overlay` for a path checkout: in overlay mode (the default) entries
   * the tree-ish lacks are kept; without it, the paths the pathspec names that the
   * tree-ish lacks are removed from the index and the worktree.
   */
  setOverlay(overlay: boolean): this {
    this.checkCallable();
    this.overlay = overlay;
    return this;
  }

  /**
   * `--ignore-skip-worktree-bits`: a path checkout also checks out skip-worktree entries
   * (by default it passes over them, so an element naming only such entries matches
   * nothing).
   */
  setIgnoreSkipWorktreeBits(ignore: boolean): this {
    this.checkCallable();
    this.ignoreSkipWorktreeBits = ignore;
    return this;
  }

  /**
   * `--conflict=<style>` (`merge`, `diff3`, `zdiff3`): for a path checkout, implies
   * {@link setMerge}, the unmerged paths re-created with this conflict style.
   */
  setConflictStyle(style: ConflictStyle): this {
    this.checkCallable();
    this.conflictStyle = style;
    return this;
  }

  /** `-q`: a path checkout reports no counts and no "path is unmerged" warnings. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /**
   * Whether a path checkout reports what it did ("Updated 2 paths from the index",
   * "Recreated 1 merge conflict") in `warnings`, as `git checkout` does when its paths
   * follow no `--` (`count_checkout_paths`).
   */
  setCountCheckoutPaths(count: boolean): this {
    this.checkCallable();
    this.countCheckoutPaths = count;
    return this;
  }

  /**
   * `--pathspec-from-file`: the pathspec elements of `content`, one per line (C-quoted
   * lines unquoted), or NUL-separated with `nul` (`--pathspec-file-nul`).
   */
  setPathspecFromFile(content: string | Uint8Array, nul = false): this {
    this.checkCallable();
    this.pathspecFileGiven = true;
    try {
      this.pathspecFromFile = parsePathspecFile(content, nul);
    } catch (error) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        content,
        `fatal: ${(error as Error).message}`,
      );
    }
    return this;
  }

  /**
   * Execute the checkout command.
   *
   * @returns Result with status and affected files
   * @throws RefNotFoundError if target cannot be resolved
   */
  /**
   * `git checkout -p [<tree-ish>] [-- <paths>]`: the differences between the index (or the
   * tree-ish) and the worktree are offered hunk by hunk, as git's add-patch.c does; the
   * selected hunks are discarded from the worktree (from the index too with a tree-ish:
   * "Discard this hunk from index and worktree", or "Apply this hunk to index and worktree"
   * for another commit than HEAD). The prompts are answered by {@link setPatchSelector};
   * the result's `patch` carries git's transcript. No post-checkout hook runs.
   *
   * @example
   * ```typescript
   * const answers = ["y", "n"];
   * const { patch } = await git.checkout().setPatch(true).setStartPoint("HEAD")
   *   .setPatchSelector(() => answers.shift()).call();
   * ```
   */
  setPatch(patch: boolean): this {
    this.checkCallable();
    this.patch = patch;
    return this;
  }

  /** Answers the prompts of {@link setPatch}. */
  setPatchSelector(selector: PatchSelector): this {
    this.checkCallable();
    this.patchSelector = selector;
    return this;
  }

  /** `-U<n>`, `--inter-hunk-context=<n>` and `--no-auto-advance` of {@link setPatch}. */
  setPatchOptions(options: PatchOptions): this {
    this.checkCallable();
    this.patchOptions = { ...options };
    return this;
  }

  /**
   * The git version this checkout reproduces where they differ (default 2.56): the prompts
   * of {@link setPatch}, and {@link setMerge}'s refusal. Under 2.43 a `-m` switch the
   * two-way merge refuses dies with `fatal: cannot continue with staged changes in the
   * following files:` when the index differs from HEAD (an unborn index always does, with
   * HEAD's files as staged deletions), exit 128; 2.43's in-place merge of unstaged changes
   * is not reproduced (the switch then takes 2.56's autostash).
   */
  setCompatibility(version: PatchCompatibility): this {
    this.checkCallable();
    this.patchCompatibility = version;
    return this;
  }

  /** checkout_main's checks of `--pathspec-from-file` with `-p`. */
  private refusePathspecFileWithPatch(): void {
    if (!this.pathspecFileGiven) return;
    if (this.paths.length > 0) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        this.pathspecFromFile,
        "fatal: '--pathspec-from-file' and pathspec arguments cannot be used together",
      );
    }
    throw new IncompatibleOptionsError(
      ["--pathspec-from-file", "--patch"],
      "fatal: options '--pathspec-from-file' and '--patch' cannot be used together",
    );
  }

  /** `git checkout -p`: run_add_p(ADD_P_CHECKOUT, rev). */
  private async callPatch(): Promise<CheckoutResult> {
    if (this.overlay === true) {
      throw new InvalidArgumentError(
        "overlay",
        true,
        "fatal: options '-p' and '--overlay' cannot be used together",
      );
    }
    this.refusePathspecFileWithPatch();
    const { revision, diffRevision } = await patchRevisionOf(this.startPoint ?? this.name, {
      headId: async () => (await this.refsStore.resolve("HEAD"))?.objectId,
      resolve: (name) => this.resolveRevision(name),
      peelCommit: (id) => this.revisionResolver().peelToType(id, "commit"),
    });
    const patch = await runPatchSelection(this.workingCopy, {
      hookSource: this,
      ...this.patchOptions,
      mode: pathPatchMode(true, true, revision),
      selector: this.patchSelector,
      ...(diffRevision !== undefined ? { diffRevision } : {}),
      paths: [...this.pathspecFromFile, ...this.paths],
      compatibility: this.patchCompatibility,
    });
    return {
      status: CheckoutStatus.OK,
      updated: patch.applied,
      removed: [],
      conflicts: [],
      ref: null,
      patch,
    };
  }

  async call(): Promise<CheckoutResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();
    if (this.patch) return this.callPatch();

    // path checkout, or branch checkout; one worktree batch, so the checks and the writes
    // share one reading of the ignore rules
    const pathCheckout = this.allPaths || this.paths.length > 0 || this.pathspecFromFile.length > 0;
    const oldHead = this.hooks.enabled
      ? (await this.refsStore.resolve("HEAD"))?.objectId
      : undefined;
    const run = () => (pathCheckout ? this.checkoutPaths() : this.checkoutBranch());
    const worktree = this.worktreeAccess;
    let result = await (worktree?.batch ? worktree.batch(run) : run());
    const autostash = this.autostashSwitch;
    if (autostash) {
      const done = await this.switchWithAutostash(autostash.label, autostash.base);
      if (done) result = done;
    }
    return this.withPostCheckoutHook(result, oldHead, pathCheckout);
  }

  /**
   * The post-checkout hook after a switch (`<old> <new> 1`) or a path checkout (`<HEAD>
   * <HEAD> 0`) that went through; a non-zero exit becomes the result's `exitCode`, as git's
   * exit status.
   */
  private async withPostCheckoutHook(
    result: CheckoutResult,
    oldHead: ObjectId | undefined,
    pathCheckout: boolean,
  ): Promise<CheckoutResult> {
    if (!this.hooks.enabled || this.noPostCheckout) return result;
    if (result.status !== CheckoutStatus.OK && result.exitCode === undefined) return result;
    const newHead = (await this.refsStore.resolve("HEAD"))?.objectId;
    const code = await runPostCheckoutHook(
      this.hooks,
      pathCheckout ? newHead : oldHead,
      newHead,
      !pathCheckout,
    );
    // a switch exits 1 for a failing hook (`ret || writeout_error`), a path checkout with
    // the hook's code (`errs |= ...`)
    const exitCode = pathCheckout ? code : 1;
    return code !== 0 && result.exitCode === undefined ? { ...result, exitCode } : result;
  }

  /**
   * git 2.55+'s `checkout -m` / `switch -m` (`switch_branches` with `merge`): the local
   * changes are stashed (`git stash create "autostash while switching to '<target>'"`),
   * index and worktree reset to HEAD, the switch made, then the stash applied with the
   * labels git gives it (`<target>` for the new branch's side, `local` for the changes,
   * the branch left, or its abbreviated commit, for the base). A conflicting apply leaves
   * the conflicts in the index and worktree and keeps the changes as a stash entry
   * (`stash@{0}`, "autostash while switching to '<target>'"). Undefined when there was
   * nothing to stash (the refusal stands).
   */
  private async switchWithAutostash(
    label: string,
    base: string,
  ): Promise<CheckoutResult | undefined> {
    // create_autostash: nothing to stash in an unborn index (no unstaged changes without
    // entries, has_uncommitted_changes 0 by is_index_unborn), so the refusal stands
    if (await isIndexUnborn(this.staging)) return undefined;
    const message = `autostash while switching to '${label}'`;
    const stashId = await new StashCreateCommand(this._workingCopy)
      .setRef(null)
      .setMessage(message)
      .call();
    if (stashId === undefined) return undefined;
    // from here on the changes live only in the stash: whatever happens to the switch, the
    // stash is applied or stored (git applies it after merge_working_tree, failed or not)
    let switched: CheckoutResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      // create_autostash's reset_working_tree(HARD): index and worktree back to HEAD
      await this.resetHardToHead();
      // the switch again, now from a clean index and worktree
      switched = await this.copy().call();
    } catch (error) {
      failure = { error };
    }
    const applied = await this.applySaveAutostash(stashId, message, label, base);
    if (failure) {
      // git returns the switch's failure once the stash is applied or stored
      const { error } = failure;
      if (error instanceof Error) error.message = `${error.message}\n${applied.message}`;
      throw error;
    }
    if (!switched) throw new Error("unreachable: checkout without a result");
    if (switched.status !== CheckoutStatus.OK) {
      // the switch refused (untracked files in the way): HEAD stays, the changes are back
      return {
        ...switched,
        conflicts: [...switched.conflicts, ...applied.conflicts],
        message: [switched.message ?? "", applied.message].join("\n"),
      };
    }
    if (applied.conflicts.length > 0 || applied.conflicted) {
      return {
        status: CheckoutStatus.CONFLICTS,
        updated: switched.updated,
        removed: switched.removed,
        conflicts: applied.conflicts,
        ref: switched.ref,
        message: applied.message,
      };
    }
    return { ...switched, message: applied.message };
  }

  /**
   * git's `apply_save_autostash_oid`: the stash applied (`Applied autostash.`), else
   * stored as `stash@{0}` with `message`, with git's advice for a conflicting apply or
   * `error: could not apply autostash; your changes are safe in the stash`.
   */
  private async applySaveAutostash(
    stashId: ObjectId,
    message: string,
    ours: string,
    base: string,
  ): Promise<{ message: string; conflicts: string[]; conflicted: boolean }> {
    let status: StashApplyStatus = StashApplyStatus.FAILED;
    let conflicts: string[] = [];
    try {
      const apply = await new StashApplyCommand(this._workingCopy)
        .setStashRef(stashId)
        .setLabels({ ours, theirs: "local", base })
        .call();
      status = apply.status;
      conflicts = [...(apply.conflicts ?? [])].sort();
    } catch {
      // git's do_stash_apply: any other exit status is STASH_APPLY_ERROR
      status = StashApplyStatus.FAILED;
    }
    if (status === StashApplyStatus.OK) {
      return { message: "Applied autostash.", conflicts: [], conflicted: false };
    }
    // git stash store -m <message> -q <stash>
    await this.refsStore.batch([{ name: STASH_REF, new: stashId }], {
      ...this.reflogLine(message),
      createReflog: true,
    });
    if (status === StashApplyStatus.CONFLICTS) {
      return { message: AUTOSTASH_CONFLICT_ADVICE, conflicts, conflicted: true };
    }
    return {
      message: "error: could not apply autostash; your changes are safe in the stash",
      conflicts: [],
      conflicted: false,
    };
  }

  /**
   * `reset --hard` to HEAD without touching a ref (git's `reset_working_tree` with
   * `RESET_WORKING_TREE_HARD`, the oid HEAD's own): the index read from HEAD's tree, the
   * worktree rewritten from it, tracked files HEAD lacks deleted.
   */
  private async resetHardToHead(): Promise<void> {
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    if (!headId) throw new NoHeadError("could not determine HEAD revision");
    const treeId = await this.commits.getTree(headId);
    if (!treeId) throw new RefNotFoundError(headId, `unable to read tree (${headId})`);
    const trackedBefore = new Set<string>();
    for await (const entry of this.staging.entries()) trackedBefore.add(entry.path);
    const worktree = this.worktreeAccess;
    // in a sparse checkout, unpack-trees with its patterns
    const sparse = await SparseUnpack.start({
      workingCopy: this.workingCopy,
      worktree,
      staging: this.staging,
    });
    // unpack-trees' one-way merge: unchanged entries keep their flags, a skip-worktree file
    // the tree keeps is left alone
    const { keptOut } = await checkFlaggedEntries(
      {
        trees: this.trees,
        staging: this.staging,
        workingCopy: this.workingCopy,
        worktree,
      },
      treeId,
      sparse,
    );
    await this.staging.readTree(this.trees, treeId, { keepMatching: "flags" });
    // reset_head's prime_cache_tree: the index is HEAD's tree
    this.staging.setCacheTree?.(await cacheTreeOfTree(this.trees, treeId));
    markIndexUpdate(this.staging, { workdir: true });
    await this.staging.write();
    if (worktree) {
      const written = await restoreWorktreeHard(
        { trees: this.trees, blobs: this.blobs, workingCopy: this.workingCopy, worktree },
        treeId,
        trackedBefore,
        keptOut,
        sparse,
      );
      // check_updates: the entries written carry the stat of their new files
      await recordWrittenStat(this.staging, worktree, written);
      await this.staging.write();
      await sparse?.finish(
        { workingCopy: this.workingCopy, worktree, staging: this.staging, blobs: this.blobs },
        { written },
      );
    }
  }

  /**
   * The index a switch leaves, written as git's `merge_working_tree` writes it: with the
   * cache-tree updated (`cache_tree_update` with `WRITE_TREE_REPAIR`, as unpack-trees and
   * checkout do before the write).
   */
  private async writeSwitchedIndex(): Promise<void> {
    await updateIndexCacheTree(this.staging, this.trees);
    markIndexUpdate(this.staging, { workdir: true });
    await this.staging.write();
  }

  /** The switch an autostash switch makes again: its caller runs post-checkout once. */
  private noPostCheckout = false;
  private withoutPostCheckout(): this {
    this.noPostCheckout = true;
    return this;
  }

  /** This checkout's settings on a new command (without `merge`). */
  private copy(): CheckoutCommand {
    const copy = new CheckoutCommand(this._workingCopy)
      .shareHooksOf(this)
      .withoutPostCheckout()
      .setCreateBranch(this.createBranch)
      .setForceCreateBranch(this.forceCreateBranch)
      .setOrphan(this.orphan)
      .setIgnoreOtherWorktrees(this.ignoreOtherWorktrees)
      .setDetach(this.detach)
      .setTrack(this.track)
      .setOrphanFromEmptyTree(this.orphanFromEmptyTree)
      .setOnlyMergeOnSwitchingBranches(this.onlyMergeOnSwitchingBranches)
      .setProtectUntracked(this.protectUntracked);
    if (this.createBranch) copy.setCreateBranch(true);
    if (this.name !== undefined) copy.setName(this.name);
    if (this.startPoint !== undefined) copy.setStartPoint(this.startPoint);
    if (this.guess !== undefined) copy.setGuess(this.guess);
    if (this.hasReflogAction()) copy.setReflogAction(this.reflogAction("checkout"));
    return copy;
  }

  /**
   * git's `checkout [<tree-ish>] [--] <pathspec>...` (`checkout_paths`): see
   * {@link runPathCheckout}. An error git reports (an element that matched nothing, an
   * unmerged path) leaves the index and the worktree as they were: status `CONFLICTS`, the
   * elements or paths in `conflicts`, git's lines in `message`.
   */
  private async checkoutPaths(): Promise<CheckoutResult> {
    if (this.createBranch || this.forceCreateBranch || this.orphan) {
      throw new SwitchRefusedError(
        `fatal: Cannot update paths and switch to branch '${this.name ?? ""}' at the same time.`,
      );
    }
    if (this.detach) {
      throw new SwitchRefusedError(
        `fatal: git checkout: --detach does not take a path argument '${this.paths[0] ?? ""}'`,
      );
    }
    if (this.track !== TrackMode.DEFAULT) {
      throw new SwitchRefusedError("fatal: '--track' cannot be used with updating paths");
    }
    if (this.paths.length > 0 && this.pathspecFromFile.length > 0) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        this.pathspecFromFile,
        "fatal: '--pathspec-from-file' and pathspec arguments cannot be used together",
      );
    }
    const source = this.startPoint ?? this.name;
    const outcome = await runPathCheckout(this.pathCheckoutContext(), {
      command: "checkout",
      paths: [...this.pathspecFromFile, ...this.paths],
      allPaths: this.allPaths,
      ...(source !== undefined ? { source } : {}),
      ...(this.overlay !== undefined ? { overlay: this.overlay } : {}),
      ignoreSkipWorktree: this.ignoreSkipWorktreeBits,
      ...(this.stage !== undefined ? { stage: this.stage } : {}),
      merge: this.merge,
      ...(this.conflictStyle ? { conflictStyle: this.conflictStyle } : {}),
      force: this.force,
      quiet: this.quiet,
      countCheckoutPaths: this.countCheckoutPaths,
      globalMagic: this.globalPathspecMagic(),
    });
    return pathCheckoutResult(outcome);
  }

  /** What a path checkout reads and writes. */
  private pathCheckoutContext() {
    return {
      workingCopy: this.workingCopy,
      staging: this.staging,
      trees: this.trees,
      blobs: this.blobs,
      worktree: this.worktreeAccess,
      abbreviate: (id: ObjectId) => this.abbreviateObjectId(id),
      resolveTree: (rev: string) => this.resolveSourceTree(rev),
    };
  }

  /** git's `get_global_magic` from the host environment (`GIT_LITERAL_PATHSPECS`, ...). */
  private globalPathspecMagic() {
    try {
      return globalPathspecMagic(hostEnvironmentOf(this.workingCopy)?.pathspecs);
    } catch (error) {
      throw new InvalidArgumentError("path", this.paths, `fatal: ${(error as Error).message}`);
    }
  }

  /**
   * HEAD as git's checkout names the side it leaves: the branch (short name, also an unborn
   * one), else the full id of the detached HEAD, else `(invalid)`.
   */
  private async describeHeadForReflog(): Promise<string> {
    const head = await this.refsStore.get("HEAD");
    if (head && isSymbolicRef(head)) return shortBranchName(head.target);
    return head?.objectId ?? "(invalid)";
  }

  /** Whether an untracked (not ignored) file or link is at `path`. */
  private async untrackedFileAt(worktree: Worktree, path: string): Promise<boolean> {
    const entry = await worktree.getEntry(path);
    return !!entry && !entry.isDirectory && !(await worktree.isIgnored(path));
  }

  /**
   * Checkout a branch or commit.
   */
  private async checkoutBranch(): Promise<CheckoutResult> {
    // parse_branchname_arg and validate_new_branchname first, then checkout_branch's
    // option checks, then switch_branches' refusal of a non-commit
    let plan: SwitchPlan | SwitchRefusedError;
    try {
      plan = await this.planSwitch();
    } catch (error) {
      if (!(error instanceof SwitchRefusedError && NON_COMMIT_SWITCH.test(error.message))) {
        throw error;
      }
      plan = error;
    }
    if (this.merge && this.force) {
      throw new SwitchRefusedError("fatal: '-f' cannot be used with '-m'");
    }
    if (plan instanceof SwitchRefusedError) throw plan;
    const switchTo = plan;
    const { targetId } = switchTo;
    const branchName =
      switchTo.kind === "detach" || switchTo.kind === "stay" ? undefined : switchTo.branch;

    // git's die_if_checked_out: a branch another worktree has checked out is not switched to
    const worktrees = this.workingCopy.worktrees;
    if (worktrees && !this.ignoreOtherWorktrees && branchName !== undefined) {
      const ref = `refs/heads/${branchName}`;
      // (`checkout -B`: an existing branch is reset, so not one another worktree uses, git
      // 2.44+ die_if_switching_to_a_branch_in_use for new_branch_force)
      if (switchTo.kind === "create" || switchTo.kind === "branch") {
        await refuseIfCheckedOut(worktrees, ref, true);
      }
    }

    // git's switch_branches without a target name (`switch -c <new>` or `switch --detach`
    // without a start point, the bare `checkout -b <new>`: only_merge_on_switching_branches)
    // does not run merge_working_tree: index and worktree stay as they are, an unborn index
    // is not checked out
    if (this.skipsMergeWorkingTree()) return this.updateRefsForSwitch(switchTo, [], [], []);

    // Get target tree for conflict detection and checkout
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    const headTreeId = headId ? await this.commits.getTree(headId) : undefined;
    // git's initial checkout (`topts.initial_checkout = is_index_unborn(...)`): with no index
    // file and no entries, twoway_merge takes every path of the target as new
    // (merged_entry: written, untracked files in the way refused) instead of reading HEAD's
    // files as staged deletions. `checkout --orphan` merges HEAD into HEAD (the new branch
    // keeps its tree), which then checks HEAD's files out too.
    // `checkout --orphan <new> <start-point>` merges to the start point's tree as a switch to
    // that commit would.
    const unborn = !this.force && (await isIndexUnborn(this.staging));
    const orphanStart = switchTo.kind === "orphan" ? switchTo.startId : undefined;
    const orphanCheckout = unborn && this.orphan && !this.orphanFromEmptyTree;
    const targetTreeId = orphanStart
      ? await this.commits.getTree(orphanStart)
      : orphanCheckout
        ? headTreeId
        : targetId
          ? await this.commits.getTree(targetId)
          : undefined;
    // in a sparse checkout, unpack-trees with its patterns: a path that stays outside is
    // neither checked nor touched in the worktree (its index entry still switches)
    const sparse = await SparseUnpack.start({
      workingCopy: this.workingCopy,
      worktree: this.worktreeAccess,
      staging: this.staging,
    });
    const quiet = (path: string) => sparse?.leavesAlone(path) === true;
    const writes = (path: string) => !sparse || sparse.writes(path);

    // git's two-way merge (unpack-trees `twoway_merge`, checkout without -f): a path HEAD
    // and the target agree on keeps its index entry and worktree file as they are (local
    // edits survive the switch); a path they differ on is switched only when the index and
    // the worktree still hold HEAD's version, else the checkout is refused, as are
    // untracked files in the way and an index with unmerged entries. With `setForce`, as
    // `git checkout -f`, the target's tree replaces index and worktree whatever they hold.
    const worktree = this.worktreeAccess;
    const head = new Map<string, Side>();
    const target = new Map<string, Side>();
    if (headTreeId) await this.collectTreeEntries(headTreeId, "", head);
    if (targetTreeId) await this.collectTreeEntries(targetTreeId, "", target);
    const index = new Map<string, Side>();
    const unmerged = new Set<string>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) index.set(entry.path, entry);
      else unmerged.add(entry.path);
    }

    // (an orphan branch keeps index and worktree as they are, as git's checkout --orphan;
    // switch --orphan switches to the empty tree)
    const keepAll =
      this.orphan && !this.orphanFromEmptyTree && !orphanCheckout && orphanStart === undefined;
    if (!this.force && !keepAll && unmerged.size > 0) {
      return {
        status: CheckoutStatus.CONFLICTS,
        updated: [],
        removed: [],
        conflicts: [...unmerged].sort(),
        ref: null,
        message: "error: you need to resolve your current index first",
      };
    }

    // the paths the switch changes, and those it must refuse to touch
    const switched: string[] = [];
    const local: string[] = [];
    const untracked: string[] = [];
    const untrackedRemoved: string[] = [];
    const lostDirs: string[] = [];
    /** Case variants of index paths in directories files replace (see findInTheWay) */
    const caseVariants: string[] = [];
    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const initial = unborn && !keepAll;
    const paths = [...new Set([...head.keys(), ...target.keys()])].sort();
    for (const path of keepAll ? [] : paths) {
      const h = head.get(path);
      const t = target.get(path);
      if (initial && t) {
        switched.push(path);
        continue;
      }
      if (!this.force && sameSide(h, t)) continue;
      const i = index.get(path);
      if (this.force) {
        // oneway_merge leaves a skip-worktree entry the target keeps (and its file) alone, as
        // the sparse checkout does whatever stays outside it
        if ((i as { skipWorktree?: boolean } | undefined)?.skipWorktree && sameSide(i, t)) {
          continue;
        }
        if (quiet(path)) continue;
        if (!sameSide(i, t) || t) switched.push(path);
        continue;
      }
      if (sameSide(i, t)) {
        // kept; but a staged deletion the target also makes leaves the file untracked in
        // the worktree, and the switch would remove it (git refuses)
        if (h && !i && !t && worktree && (await this.untrackedFileAt(worktree, path))) {
          untrackedRemoved.push(path);
        }
        continue;
      }
      if (!sameSide(i, h)) {
        // staged changes (or a staged deletion) the switch would lose
        if (i !== undefined || t !== undefined) local.push(path);
        continue;
      }
      if (
        i !== undefined &&
        worktree &&
        !quiet(path) &&
        (await entryNotUptodate(worktree, path, i, trust, this.staging.getUpdateTime()))
      ) {
        local.push(path);
        continue;
      }
      switched.push(path);
    }

    // what stands where the switch writes (git's verify_absent, check_leading_path and
    // verify_clean_subdirectory): untracked files or links on the path or a leading
    // component, untracked files in a directory a file replaces
    if (worktree && !this.force) {
      const found = await findInTheWay(worktree, {
        writes: switched.filter((p) => target.has(p) && writes(p)),
        removes: new Set(switched.filter((p) => !target.has(p))),
        index,
        ...(await restoreCaseOptions(worktree, ignoreCase)),
        caseVariantsExpendable: true,
      });
      untracked.push(...found.untracked);
      lostDirs.push(...found.lostDirs);
      caseVariants.push(...(found.caseVariants ?? []));
    }
    // a reset that protects untracked files (switch --discard-changes): unpack-trees'
    // own messages, one line per path
    if (worktree && this.force && this.protectUntracked) {
      const found = await findInTheWay(worktree, {
        writes: switched.filter((p) => target.has(p) && writes(p)),
        removes: new Set(switched.filter((p) => !target.has(p))),
        index,
        ...(await restoreCaseOptions(worktree, ignoreCase)),
        caseVariantsExpendable: true,
      });
      caseVariants.push(...(found.caseVariants ?? []));
      const lines = [
        ...found.untracked.map((p) => ({
          p,
          line: `error: Untracked working tree file '${p}' would be overwritten by merge.`,
        })),
        ...found.lostDirs.map((p) => ({
          p,
          line: `error: Updating '${p}' would lose untracked files in it`,
        })),
      ].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
      if (lines.length > 0) {
        return {
          status: CheckoutStatus.CONFLICTS,
          updated: [],
          removed: [],
          conflicts: lines.map((l) => l.p),
          ref: null,
          message: lines.map((l) => l.line).join("\n"),
        };
      }
    }
    // a forced checkout is a one-way reset, but an entry whose flags cheat (assume-unchanged,
    // skip-worktree) is still checked: one the target changes or deletes over a changed file
    // is refused (verify_uptodate_1), as git's "Entry '<path>' not uptodate. Cannot merge."
    if (this.force && !keepAll && worktree) {
      const indexTime = this.staging.getUpdateTime();
      for (const [path, i] of index) {
        const e = i as StagingEntry;
        if (!e.assumeValid && !e.skipWorktree) continue;
        if (sameSide(i, target.get(path)) || quiet(path)) continue;
        if (await flaggedEntryDiffers(worktree, path, e, trust, indexTime)) {
          return {
            status: CheckoutStatus.CONFLICTS,
            updated: [],
            removed: [],
            conflicts: [path],
            ref: null,
            message: `error: Entry '${path}' not uptodate. Cannot merge.`,
          };
        }
      }
    }
    // git 2.55+ `checkout -m`: a two-way merge that fails (local changes, untracked files
    // in the way) falls back to an autostash, run by call() outside this worktree batch;
    // with nothing to stash the refusal stands
    const refused = local.length + untracked.length + untrackedRemoved.length + lostDirs.length;
    if (this.merge && headId && refused > 0 && this.patchCompatibility === "2.43") {
      // git 2.43's merge_working_tree: a failed two-way merge under `-m` dies when the index
      // holds changes against HEAD (repo_index_has_changes), an unborn index's missing
      // entries included (staged deletions of every HEAD file)
      const staged = [...new Set([...index.keys(), ...head.keys()])]
        .filter((p) => !sameSide(index.get(p), head.get(p)))
        .sort(compareGitPaths);
      if (staged.length > 0) {
        throw new SwitchRefusedError(
          `fatal: cannot continue with staged changes in the following files:\n${staged.join(" ")}`,
        );
      }
    }
    if (this.merge && headId && refused > 0) {
      const left = await this.getCurrentBranch();
      // the base's label: the branch left, else its commit uniquely abbreviated
      // (strbuf_add_unique_abbrev, DEFAULT_ABBREV)
      this.autostashSwitch = {
        label: autostashLabel(switchTo),
        base: left?.startsWith("refs/heads/")
          ? shortBranchName(left)
          : await this.abbreviateObjectId(headId),
      };
    }
    if (local.length + untracked.length + untrackedRemoved.length + lostDirs.length > 0) {
      const message = overwriteMessage("checkout", {
        local,
        lostDirs,
        untracked,
        untrackedRemoved,
      });
      return {
        status: CheckoutStatus.CONFLICTS,
        updated: [],
        removed: [],
        conflicts: [...local, ...lostDirs, ...untracked, ...untrackedRemoved],
        ref: null,
        message,
      };
    }

    // The worktree first, as git: the target tree is planned (paths verified, entries
    // checked not to collide) before anything is written; the switched paths the target
    // drops are removed, then its switched files, links and submodule directories written.
    const updated: string[] = [];
    const removed: string[] = [];
    const switching = new Set(switched);
    /** The paths whose files the switch wrote */
    const written = new Set<string>();
    if (worktree && (targetTreeId || switched.length > 0 || this.force)) {
      const plan = targetTreeId
        ? await planTreeRestore(this.trees, this.blobs, targetTreeId, CHECKOUT, {
            symlinks: true,
            ...(await restoreCaseOptions(worktree, ignoreCase)),
            windows: worktree.capabilities?.windowsPaths === true,
            reservedNames: worktree.capabilities?.reservedNames,
          })
        : undefined;
      if (sparse && !keepAll) {
        // apply_sparse_checkout before check_updates: the files leaving the checkout
        const unlink = await sparse.leaving(
          worktree,
          (p) => (this.force || switching.has(p) ? target.get(p) : index.get(p)),
          { reset: this.force, trust },
        );
        await sparse.unlink(worktree, unlink);
      }
      for (const path of switched) {
        if (target.has(path) || quiet(path)) continue;
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
        removed.push(path);
      }
      // core.ignorecase: what verify_clean_subdirectory took as tracked in a directory a
      // file replaces goes with the directory, as git's checkout_entry removes the subtree
      for (const path of caseVariants) {
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
      }
      // a forced checkout also drops tracked files no tree holds any more
      if (this.force) {
        for (const path of index.keys()) {
          if (!target.has(path) && !switching.has(path) && !quiet(path)) {
            await worktree.remove(path);
            removed.push(path);
          }
        }
      }
      // in a sparse checkout, only the paths in its patterns are written
      const only = plan && {
        ...plan,
        entries: plan.entries.filter((e) => switching.has(e.path) && writes(e.path)),
        gitlinks: plan.gitlinks.filter((e) => switching.has(e.path) && writes(e.path)),
      };
      // the attributes of the index the switch leaves (git's o->result): the target's
      // entries for the switched paths, the index's own for every other
      const result = new Map<string, ObjectId>();
      if (!this.force) for (const [path, entry] of index) result.set(path, entry.objectId);
      for (const path of this.force ? target.keys() : switched) {
        const t = target.get(path);
        if (t) result.set(path, t.objectId);
        else result.delete(path);
      }
      // everything in the way was checked above (or the checkout is forced): a file or link
      // where a directory goes, a clean directory where a file goes, are replaced
      if (only) {
        await writeTreeRestorePlan(worktree, this.blobs, only, CHECKOUT, {
          symlinks: worktreeModeTrust(this.workingCopy, worktree).symlinks,
          gitlinks: true,
          replaceInTheWay: true,
          // a forced checkout overwrites untracked files, as git's checkout -f
          ...(this.force && !this.protectUntracked ? { discardUntracked: true } : {}),
          attributes: { direction: "checkout", index: attributesIndexOf(result) },
        });
        updated.push(...only.entries.map((e) => e.path));
        for (const e of [...only.entries, ...only.gitlinks]) written.add(e.path);
      }
    }

    // The index (written with the worktree, as git's merge_working_tree, before any ref
    // moves): forced, the target's tree; else the switched paths take the target's
    // entries (with the stat of the files just written), every other path keeps its own.
    // git's switch writes a new index (unpack-trees): no resolve-undo records survive it
    this.staging.clearResolveUndo?.();
    if (targetTreeId && this.force) {
      // oneway_merge: an unchanged entry keeps its flags and stat, a changed one its
      // skip-worktree bit
      await this.staging.readTree(this.trees as any, targetTreeId, { keepMatching: "flags" });
      // check_updates: the entries written carry the stat of their new files
      if (worktree) await recordWrittenStat(this.staging, worktree, written);
      await this.writeSwitchedIndex();
    } else if (this.force && !keepAll) {
      // forced onto the empty tree (switch --orphan --discard-changes): an empty index
      const editor = this.staging.createEditor();
      for (const path of index.keys()) editor.remove(path);
      await editor.finish();
      await this.writeSwitchedIndex();
    } else if (switched.length > 0) {
      const editor = this.staging.createEditor();
      for (const path of switched) {
        const t = target.get(path);
        if (!t) {
          editor.remove(path);
          continue;
        }
        // the stat of a file written (an entry left outside the checkout has none)
        const stats = worktree && written.has(path) ? await worktree.getEntry(path) : undefined;
        // merged_entry: the replaced entry's skip-worktree bit migrates over
        const old = index.get(path) as { skipWorktree?: boolean } | undefined;
        editor.upsert({
          path,
          objectId: t.objectId,
          mode: t.mode,
          ...entryStatOf(stats ?? {}),
          ...(old?.skipWorktree ? { skipWorktree: true } : {}),
        });
      }
      await editor.finish();
      await this.writeSwitchedIndex();
    } else {
      await this.writeSwitchedIndex();
    }

    // the flags, and the entries coming back into the patterns (verify_absent_sparse; a
    // forced checkout overwrites what stands there, UNPACK_RESET_OVERWRITE_UNTRACKED)
    const sparseWarnings: string[] = [];
    if (sparse && !keepAll) {
      const outcome = await sparse.finish(
        {
          workingCopy: this.workingCopy,
          worktree: this.worktreeAccess,
          staging: this.staging,
          blobs: this.blobs,
        },
        { written, overwrite: this.force && !this.protectUntracked },
      );
      pushSparseWarnings(sparseWarnings, sparse, outcome, true);
    }

    return this.updateRefsForSwitch(switchTo, updated, removed, sparseWarnings);
  }

  /**
   * git's update_refs_for_switch after the index and worktree are switched (or left alone):
   * the new branch, HEAD and its reflog, remove_branch_state.
   */
  private async updateRefsForSwitch(
    switchTo: SwitchPlan,
    updated: string[],
    removed: string[],
    sparseWarnings: string[],
  ): Promise<CheckoutResult> {
    // HEAD's reflog line (git's update_refs_for_switch): "checkout: moving from <branch
    // left, or the detached HEAD's full id> to <the name as interpreted: `-` and @{-N}
    // expanded, the new branch's name>", read before anything moves
    const log = this.reflogLine(
      this.hasReflogAction()
        ? this.reflogAction("checkout")
        : reflogMessages.checkout(await this.describeHeadForReflog(), switchTo.logName),
    );

    if (switchTo.kind === "create") {
      // git's create_branch (after the worktree and the index, as update_refs_for_switch
      // does it): a start point --track cannot track dies before the branch is made;
      // "branch: Created from <start>", or "Reset to" an existing one; then its upstream
      // (ambiguous remotes die once the branch exists)
      const { tracking } = switchTo;
      if (tracking.notABranch !== undefined) throw tracking.notABranch;
      const branchRef = `refs/heads/${switchTo.branch}`;
      const message = (await this.refsStore.has(branchRef))
        ? reflogMessages.branchReset(switchTo.startName)
        : reflogMessages.branchCreated(switchTo.startName);
      await this.refsStore.set(branchRef, switchTo.targetId, this.reflogLine(message));
      if (tracking.ambiguous !== undefined) throw tracking.ambiguous;
      if (tracking.plan) await installTracking(this.workingCopy, switchTo.branch, tracking.plan);
    }

    if (switchTo.kind === "stay") {
      // `checkout HEAD`: git's update_refs_for_switch has nothing to do
    } else if (switchTo.kind === "detach") {
      // a commit, tag, remote-tracking branch or --detach: HEAD holds the commit itself
      await this.refsStore.set("HEAD", switchTo.targetId, log);
    } else {
      // a branch (an orphan's is unborn: git logs nothing for an unborn target)
      await this.refsStore.setSymbolic("HEAD", `refs/heads/${switchTo.branch}`, log);
    }
    // git's remove_branch_state: a merge, cherry-pick or revert stopped here is forgotten
    // (a merge's autostash kept on refs/stash, git's lines printed)
    sparseWarnings.push(
      ...(await removeBranchState(
        { commits: this.commits, refs: this.refsStore },
        new OperationState(this.workingCopy.checkout, this.refsStore),
      )),
    );

    // conditional includes on the branch (includeIf.onbranch:) follow the new HEAD
    const config = this._workingCopy.config as { refresh?: () => Promise<unknown> } | undefined;
    if (typeof config?.refresh === "function") await config.refresh();

    // Get the ref we checked out
    const ref = await this.refsStore.resolve("HEAD");

    return {
      status: CheckoutStatus.OK,
      updated,
      removed,
      conflicts: [],
      ref: ref ?? null,
      ...(sparseWarnings.length > 0 ? { warnings: sparseWarnings } : {}),
    };
  }

  /**
   * Collect tree entries into a map.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, { objectId: ObjectId; mode: number }>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        entries.set(path, { objectId: entry.id, mode: entry.mode });
      }
    }
  }

  /**
   * The object a revision names (`HEAD~1`, a branch, a tag, `@{-1}`, `-`) and its tree, as
   * git's `parse_tree_indirect` peels it: the tree undefined for an object that is no
   * tree-ish.
   *
   * @throws RefNotFoundError when it names nothing
   */
  private async resolveSourceTree(
    refName: string,
  ): Promise<{ id: ObjectId; tree: ObjectId | undefined }> {
    const id = await this.resolveRevision(refName === "-" ? "@{-1}" : refName);
    return { id, tree: await this.revisionResolver().peelToType(id, "tree") };
  }

  /**
   * Resolve a revision to a commit, as git's rev parsing does (`resolveRef`), or undefined
   * when it names nothing. One that names a tree, a blob or a missing object is refused as
   * git's checkout refuses it (see {@link nonCommitSwitchError}), named `given`.
   */
  private async resolveCommitId(
    refName: string,
    given: string = refName,
  ): Promise<ObjectId | undefined> {
    try {
      return await this.resolveRef(refName);
    } catch (error) {
      if (error instanceof RefNotFoundError) return undefined;
      if (error instanceof NotACommitError) throw nonCommitSwitchError(given, error);
      throw error;
    }
  }

  /**
   * What a branch checkout switches to (git's `parse_branchname_arg`): a new branch
   * (`-b`/`-B`, or a name guessed into a remote-tracking branch's local twin), an orphan,
   * an existing local branch, or a commit HEAD is detached at. `-` is `@{-1}`, and `@{-N}`
   * is the branch or commit it stands for, which also names the switch in the reflog.
   */
  private async planSwitch(): Promise<SwitchPlan> {
    const given = this.name ?? (this.detach ? "HEAD" : undefined);
    if (given === undefined) {
      throw new MissingArgumentError("name", "Branch name is required for checkout");
    }
    if (this.orphan || this.createBranch) {
      if (!isValidBranchName(given)) throw new InvalidRefNameError(given);
      if (this.orphan && this.startPoint === undefined) {
        // validate_new_branchname
        if (await this.refsStore.has(`refs/heads/${given}`)) {
          throw new RefAlreadyExistsError(
            `refs/heads/${given}`,
            `fatal: a branch named '${given}' already exists`,
          );
        }
        return { kind: "orphan", branch: given, logName: given };
      }
      // the start point as git's setup_branch_path names it: `-` and @{-N} expanded (the
      // reflog's "Created from feat", the branch tracked). git's parse_branchname_arg reads
      // it before validate_new_branchname looks at the branch: a start point that names
      // nothing dies first, one that names a tree after the branch check
      const startArg = this.startPoint === "-" ? "@{-1}" : (this.startPoint ?? "HEAD");
      const startName = await this.expandPriorCheckout(startArg);
      let targetId: ObjectId | undefined;
      let nonCommit: unknown;
      try {
        targetId = await this.resolveCommitId(startName, this.startPoint ?? startName);
      } catch (error) {
        if (!(error instanceof SwitchRefusedError)) throw error;
        nonCommit = error;
      }
      if (!targetId && nonCommit === undefined) {
        if (this.startPoint === undefined) throw new RefNotFoundError(startName);
        throw new RefNotFoundError(
          this.startPoint,
          `fatal: '${this.startPoint}' is not a commit and a branch '${given}' cannot be created from it`,
        );
      }
      // validate_new_branchname: `-b` refuses an existing branch, `-B` resets it
      if (
        (this.orphan || !this.forceCreateBranch) &&
        (await this.refsStore.has(`refs/heads/${given}`))
      ) {
        throw new RefAlreadyExistsError(
          `refs/heads/${given}`,
          `fatal: a branch named '${given}' already exists`,
        );
      }
      if (!targetId) throw nonCommit;
      // `checkout --orphan <new> <start-point>`: the index and worktree merge to the start
      // point's tree (switch_branches with the start point's commit), the new branch unborn
      if (this.orphan) return { kind: "orphan", branch: given, logName: given, startId: targetId };
      return {
        kind: "create",
        branch: given,
        startName,
        targetId,
        logName: given,
        tracking: await this.planCreateTracking(given, startName),
      };
    }
    // git's parse_branchname_arg: `-` is @{-1}; the name a remote-tracking branch is guessed
    // from is the argument itself, so `-` or @{-N} naming a deleted branch guesses nothing
    const arg = given === "-" ? "@{-1}" : given;
    const name = await this.interpretLocalBranch(await this.expandPriorCheckout(arg));
    if (!this.detach && (name === "HEAD" || name === "@")) {
      // `checkout HEAD`: the worktree is checked out, HEAD left as it is
      const headId = await this.resolveCommitId("HEAD");
      if (headId) return { kind: "stay", targetId: headId, logName: "HEAD" };
    }
    if (!this.detach && isValidBranchName(name)) {
      const branch = await this.refsStore.resolve(`refs/heads/${name}`);
      if (branch?.objectId) {
        return { kind: "branch", branch: name, targetId: branch.objectId, logName: name };
      }
    }
    const targetId = await this.resolveCommitId(name, given);
    if (targetId) return { kind: "detach", targetId, logName: name };
    // git's dwim of a name no ref has into the remote-tracking branch of that name
    const config = RemoteConfigStore.from(this.workingCopy);
    const guess = this.guess ?? parseGitBool(config.value("checkout.guess")) ?? true;
    if (!this.detach && guess && isValidBranchName(arg)) {
      const remote = await guessRemoteBranch(this.workingCopy, this.refsStore, arg);
      const remoteId = remote ? await this.resolveCommitId(remote) : undefined;
      if (remote && remoteId) {
        return {
          kind: "create",
          branch: arg,
          startName: remote,
          targetId: remoteId,
          logName: arg,
          tracking: await this.planCreateTracking(arg, remote),
        };
      }
    }
    throw new RefNotFoundError(given);
  }

  /**
   * How the new branch `branch` tracks `startName` (git's dwim_branch_start and
   * setup_tracking), decided before the switch writes anything; the refusals are kept for
   * the point git dies at.
   */
  private async planCreateTracking(branch: string, startName: string): Promise<CreateTracking> {
    let startRef: string | undefined;
    try {
      startRef = await trackableStart(this.workingCopy, this.refsStore, startName, this.track);
    } catch (error) {
      return { notABranch: error };
    }
    if (startRef === undefined) return {};
    try {
      return { plan: planTracking(this.workingCopy, branch, startRef, this.track) };
    } catch (error) {
      return { ambiguous: error };
    }
  }

  /**
   * Collect object IDs from a tree recursively.
   */
  private async collectTreeObjectIds(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, ObjectId>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.collectTreeObjectIds(entry.id, path, entries);
      } else {
        entries.set(path, entry.id);
      }
    }
  }
}

/** A path checkout's outcome as a {@link CheckoutResult}. */
export function pathCheckoutResult(outcome: CheckoutPathsOutcome): CheckoutResult {
  return {
    status: outcome.ok ? CheckoutStatus.OK : CheckoutStatus.CONFLICTS,
    updated: outcome.updated,
    removed: outcome.removed,
    conflicts: outcome.conflicts,
    ref: null,
    ...(outcome.errors.length > 0 ? { message: outcome.errors.join("\n") } : {}),
    ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
  };
}

/** The refusals of {@link nonCommitSwitchError}. */
const NON_COMMIT_SWITCH = /^fatal: (Cannot switch branch to a non-commit|unable to read tree) /;

/**
 * git's checkout of a revision that names no commit (`switch_branches`, 2.56): a tree is
 * `fatal: Cannot switch branch to a non-commit '<given>'`, a blob or a missing object
 * `fatal: unable to read tree (<id>)` (git 2.43 said `fatal: reference is not a tree:
 * <given>` there).
 */
export function nonCommitSwitchError(given: string, error: NotACommitError): SwitchRefusedError {
  return new SwitchRefusedError(
    error.objectType === "tree"
      ? `fatal: Cannot switch branch to a non-commit '${given}'`
      : `fatal: unable to read tree (${error.objectId})`,
  );
}
