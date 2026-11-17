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
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  attributesIndexOf,
  entryStatOf,
  UpdateStagingEntry,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import {
  InvalidRefNameError,
  MissingArgumentError,
  NotADirectoryError,
  PathNotFoundInTreeError,
  PathNotInIndexError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  guessRemoteBranch,
  installTracking,
  planTracking,
  type TrackingPlan,
  TrackMode,
  trackableStart,
} from "./branch-tracking.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { OperationState } from "./merge-support.js";
import { reflogMessages } from "./reflog-messages.js";
import { removeBranchState } from "./sequencer-support.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";
import {
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";
import { refuseIfCheckedOut, shortBranchName } from "./worktree-support.js";

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
  | { kind: "orphan"; branch: string; targetId?: undefined; logName: string }
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
  private track = TrackMode.DEFAULT;
  private guess?: boolean;
  private protectUntracked = false;

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
   * Equivalent to `git checkout -b <name>`.
   *
   * @param createBranch Whether to create a new branch
   * @returns this for chaining
   */
  setCreateBranch(createBranch: boolean): this {
    this.checkCallable();
    this.createBranch = createBranch;
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
   * with `setCreateBranch` (`checkout -B`, as git 2.44 and later refuse it), is refused with
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
   * Execute the checkout command.
   *
   * @returns Result with status and affected files
   * @throws RefNotFoundError if target cannot be resolved
   */
  async call(): Promise<CheckoutResult> {
    this.checkCallable();
    this.setCallable(false);

    // path checkout, or branch checkout; one worktree batch, so the checks and the writes
    // share one reading of the ignore rules
    const run = () =>
      this.allPaths || this.paths.length > 0 ? this.checkoutPaths() : this.checkoutBranch();
    const worktree = this.worktreeAccess;
    return worktree?.batch ? worktree.batch(run) : run();
  }

  /**
   * Checkout paths from index or commit.
   */
  private async checkoutPaths(): Promise<CheckoutResult> {
    const updated: string[] = [];
    const conflicts: string[] = [];

    // Determine source tree
    let sourceTreeId: ObjectId | undefined;
    if (this.startPoint) {
      sourceTreeId = await this.resolveTreeId(this.startPoint);
      if (!sourceTreeId) {
        throw new RefNotFoundError(this.startPoint);
      }
    }

    // Get paths to checkout
    const pathsToCheckout = this.allPaths ? await this.getAllPaths(sourceTreeId) : this.paths;

    // Checkout each path
    for (const path of pathsToCheckout) {
      try {
        const entry = sourceTreeId
          ? // Checkout from commit tree
            await this.checkoutPathFromTree(path, sourceTreeId)
          : // Checkout from index
            await this.checkoutPathFromIndex(path);
        await this.writePathToWorktree(path, entry);
        updated.push(path);
      } catch {
        conflicts.push(path);
      }
    }
    if (updated.length > 0) await this.staging.write();

    return {
      status: conflicts.length > 0 ? CheckoutStatus.CONFLICTS : CheckoutStatus.OK,
      updated,
      removed: [],
      conflicts,
      ref: null,
    };
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
    const switchTo = await this.planSwitch();
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

    // Get target tree for conflict detection and checkout
    const targetTreeId = targetId ? await this.commits.getTree(targetId) : undefined;

    // git's two-way merge (unpack-trees `twoway_merge`, checkout without -f): a path HEAD
    // and the target agree on keeps its index entry and worktree file as they are (local
    // edits survive the switch); a path they differ on is switched only when the index and
    // the worktree still hold HEAD's version, else the checkout is refused, as are
    // untracked files in the way and an index with unmerged entries. With `setForce`, as
    // `git checkout -f`, the target's tree replaces index and worktree whatever they hold.
    const worktree = this.worktreeAccess;
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    const headTreeId = headId ? await this.commits.getTree(headId) : undefined;
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
    const keepAll = this.orphan && !this.orphanFromEmptyTree;
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
    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const paths = [...new Set([...head.keys(), ...target.keys()])].sort();
    for (const path of keepAll ? [] : paths) {
      const h = head.get(path);
      const t = target.get(path);
      if (!this.force && sameSide(h, t)) continue;
      const i = index.get(path);
      if (this.force) {
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
        (await worktreeDiffers(worktree, path, i, trust, this.staging.getUpdateTime()))
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
        writes: switched.filter((p) => target.has(p)),
        removes: new Set(switched.filter((p) => !target.has(p))),
        index,
        ...(await restoreCaseOptions(worktree, ignoreCase)),
      });
      untracked.push(...found.untracked);
      lostDirs.push(...found.lostDirs);
    }
    // a reset that protects untracked files (switch --discard-changes): unpack-trees'
    // own messages, one line per path
    if (worktree && this.force && this.protectUntracked) {
      const found = await findInTheWay(worktree, {
        writes: switched.filter((p) => target.has(p)),
        removes: new Set(switched.filter((p) => !target.has(p))),
        index,
        ...(await restoreCaseOptions(worktree, ignoreCase)),
      });
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
    if (worktree && (targetTreeId || switched.length > 0 || this.force)) {
      const plan = targetTreeId
        ? await planTreeRestore(this.trees, this.blobs, targetTreeId, CHECKOUT, {
            symlinks: true,
            ...(await restoreCaseOptions(worktree, ignoreCase)),
            windows: worktree.capabilities?.windowsPaths === true,
            reservedNames: worktree.capabilities?.reservedNames,
          })
        : undefined;
      for (const path of switched) {
        if (target.has(path)) continue;
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
        removed.push(path);
      }
      // a forced checkout also drops tracked files no tree holds any more
      if (this.force) {
        for (const path of index.keys()) {
          if (!target.has(path) && !switching.has(path)) {
            await worktree.remove(path);
            removed.push(path);
          }
        }
      }
      const only = plan && {
        ...plan,
        entries: plan.entries.filter((e) => switching.has(e.path)),
        gitlinks: plan.gitlinks.filter((e) => switching.has(e.path)),
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
      }
    }

    // The index (written with the worktree, as git's merge_working_tree, before any ref
    // moves): forced, the target's tree; else the switched paths take the target's
    // entries (with the stat of the files just written), every other path keeps its own.
    // git's switch writes a new index (unpack-trees): no resolve-undo records survive it
    this.staging.clearResolveUndo?.();
    if (targetTreeId && this.force) {
      await this.staging.readTree(this.trees as any, targetTreeId);
      await this.staging.write();
    } else if (this.force && !keepAll) {
      // forced onto the empty tree (switch --orphan --discard-changes): an empty index
      const editor = this.staging.createEditor();
      for (const path of index.keys()) editor.remove(path);
      await editor.finish();
      await this.staging.write();
    } else if (switched.length > 0) {
      const editor = this.staging.createEditor();
      for (const path of switched) {
        const t = target.get(path);
        if (!t) {
          editor.remove(path);
          continue;
        }
        const stats = worktree ? await worktree.getEntry(path) : undefined;
        editor.upsert({
          path,
          objectId: t.objectId,
          mode: t.mode,
          ...entryStatOf(stats ?? {}),
        });
      }
      await editor.finish();
      await this.staging.write();
    } else {
      await this.staging.write();
    }

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
    await removeBranchState(
      { commits: this.commits, refs: this.refsStore },
      new OperationState(this.workingCopy.checkout, this.refsStore),
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
    };
  }

  /**
   * Checkout a path from the staging index.
   */
  private async checkoutPathFromIndex(path: string): Promise<{ objectId: ObjectId; mode: number }> {
    // Find the entry in staging
    let found: { objectId: ObjectId; mode: number } | undefined;
    for await (const entry of this.staging.entries()) {
      if (entry.path !== path) continue;

      // Handle conflict stages
      if (entry.stage !== 0) {
        if (this.stage && entry.stage === this.stage) {
          // Replace with specified stage
          const editor = this.staging.createEditor();
          editor.add(
            new UpdateStagingEntry(path, entry.objectId, entry.mode, {
              size: entry.size,
              mtime: Date.now(),
            }),
          );
          await editor.finish();
          found = entry;
          break;
        }
        continue;
      }

      found = entry;
      break;
    }

    if (!found) {
      throw new PathNotInIndexError(path);
    }
    return found;
  }

  /**
   * Writes a checked-out path to the worktree (git's `checkout_entry` outside unpack-trees:
   * attributes read from the worktree first) and records the file's stat in its entry.
   */
  private async writePathToWorktree(
    path: string,
    entry: { objectId: ObjectId; mode: number },
  ): Promise<void> {
    const worktree = this.worktreeAccess;
    if (!worktree || entry.mode === FileMode.GITLINK || entry.mode === FileMode.TREE) return;
    const content = await this.blobs.load(entry.objectId);
    if (!content) throw new Error(`${CHECKOUT} cannot restore ${path}: blob missing`);
    const symlinks = worktreeModeTrust(this.workingCopy, worktree).symlinks;
    const mode = entry.mode === FileMode.SYMLINK && !symlinks ? FileMode.REGULAR_FILE : entry.mode;
    await worktree.writeContent(path, content, {
      mode,
      // a link written as a file holds its target as it is (never smudged)
      ...(mode !== entry.mode ? { raw: true } : {}),
      createParents: true,
    });
    const stats = await worktree.getEntry(path);
    const editor = this.staging.createEditor();
    editor.upsert({
      path,
      objectId: entry.objectId,
      mode: entry.mode,
      ...entryStatOf(stats ?? {}),
    });
    await editor.finish();
  }

  /**
   * Checkout a path from a tree.
   */
  private async checkoutPathFromTree(
    path: string,
    treeId: ObjectId,
  ): Promise<{ objectId: ObjectId; mode: number }> {
    // Navigate tree to find the entry
    const parts = path.split("/");
    let currentTreeId = treeId;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const entry = await this.trees.getEntry(currentTreeId, name);

      if (!entry) {
        throw new PathNotFoundInTreeError(path);
      }

      if (i < parts.length - 1) {
        if (entry.mode !== FileMode.TREE) {
          throw new NotADirectoryError(parts.slice(0, i + 1).join("/"));
        }
        currentTreeId = entry.id;
      } else {
        // Found the file - update staging
        const editor = this.staging.createEditor();
        editor.add(
          new UpdateStagingEntry(path, entry.id, entry.mode, {
            size: 0,
            mtime: Date.now(),
          }),
        );
        await editor.finish();
        return { objectId: entry.id, mode: entry.mode };
      }
    }
    throw new PathNotFoundInTreeError(path);
  }

  /**
   * Get all paths from staging or tree.
   */
  private async getAllPaths(sourceTreeId?: ObjectId): Promise<string[]> {
    const paths: string[] = [];

    if (sourceTreeId) {
      // Get all paths from tree
      await this.collectTreePaths(sourceTreeId, "", paths);
    } else {
      // Get all paths from staging
      for await (const entry of this.staging.entries()) {
        if (entry.stage === 0 && !paths.includes(entry.path)) {
          paths.push(entry.path);
        }
      }
    }

    return paths;
  }

  /**
   * Collect all paths from a tree recursively.
   */
  private async collectTreePaths(treeId: ObjectId, prefix: string, paths: string[]): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.collectTreePaths(entry.id, path, paths);
      } else {
        paths.push(path);
      }
    }
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
   * Resolve a revision (`HEAD~1`, a branch, a tag, `@{-1}`) to its commit's tree.
   */
  private async resolveTreeId(refName: string): Promise<ObjectId | undefined> {
    const commitId = await this.resolveCommitId(refName);
    if (!commitId) return undefined;
    return this.commits.getTree(commitId);
  }

  /**
   * Resolve a revision to a commit, as git's rev parsing does (`resolveRef`), or undefined.
   */
  private async resolveCommitId(refName: string): Promise<ObjectId | undefined> {
    try {
      const id = await this.resolveRef(refName);
      return (await this.commits.has(id)) ? id : undefined;
    } catch (error) {
      if (error instanceof RefNotFoundError) return undefined;
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
      if (this.orphan) return { kind: "orphan", branch: given, logName: given };
      // the start point as git's setup_branch_path names it: `-` and @{-N} expanded (the
      // reflog's "Created from feat", the branch tracked)
      const startArg = this.startPoint === "-" ? "@{-1}" : (this.startPoint ?? "HEAD");
      const startName = await this.expandPriorCheckout(startArg);
      const targetId = await this.resolveCommitId(startName);
      if (!targetId) throw new RefNotFoundError(this.startPoint ?? startName);
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
    const name = await this.expandPriorCheckout(arg);
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
    const targetId = await this.resolveCommitId(name);
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
