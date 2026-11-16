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

import { FileMode, isValidBranchName, type ObjectId, type Ref } from "@statewalker/vcs-core";
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
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { OperationState } from "./merge-support.js";
import { removeBranchState } from "./sequencer-support.js";
import { planTreeRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

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

  /** Whether an untracked (not ignored) file or link is at `path`. */
  private async untrackedFileAt(worktree: Worktree, path: string): Promise<boolean> {
    const entry = await worktree.getEntry(path);
    return !!entry && !entry.isDirectory && !(await worktree.isIgnored(path));
  }

  /**
   * Checkout a branch or commit.
   */
  private async checkoutBranch(): Promise<CheckoutResult> {
    if (!this.name) {
      throw new MissingArgumentError("name", "Branch name is required for checkout");
    }

    // Create branch if requested
    if (this.createBranch) {
      if (!isValidBranchName(this.name)) {
        throw new InvalidRefNameError(this.name);
      }
      const startPointId = this.startPoint
        ? await this.resolveCommitId(this.startPoint)
        : await this.resolveCommitId("HEAD");

      if (!startPointId) {
        throw new RefNotFoundError(this.startPoint ?? "HEAD");
      }

      await this.refsStore.set(`refs/heads/${this.name}`, startPointId);
    }

    // Resolve target
    const targetId = await this.resolveCommitId(this.name);
    if (!targetId && !this.orphan) {
      throw new RefNotFoundError(this.name);
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
    const headId = await this.resolveCommitId("HEAD");
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

    if (!this.force && !this.orphan && unmerged.size > 0) {
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
    // (an orphan branch keeps index and worktree as they are, as git's --orphan)
    for (const path of this.orphan ? [] : paths) {
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
      if (i !== undefined && worktree && (await worktreeDiffers(worktree, path, i, trust))) {
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
        ignoreCase,
      });
      untracked.push(...found.untracked);
      lostDirs.push(...found.lostDirs);
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
    if (targetTreeId && worktree) {
      const plan = await planTreeRestore(this.trees, this.blobs, targetTreeId, CHECKOUT, {
        symlinks: true,
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
        windows: worktree.capabilities?.windowsPaths === true,
        reservedNames: worktree.capabilities?.reservedNames,
      });
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
      const only = {
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
      await writeTreeRestorePlan(worktree, this.blobs, only, CHECKOUT, {
        symlinks: worktreeModeTrust(this.workingCopy, worktree).symlinks,
        gitlinks: true,
        replaceInTheWay: true,
        // a forced checkout overwrites untracked files, as git's checkout -f
        ...(this.force ? { discardUntracked: true } : {}),
        attributes: { direction: "checkout", index: attributesIndexOf(result) },
      });
      updated.push(...only.entries.map((e) => e.path));
    }

    // Determine if we should use symbolic ref (branch) or detached HEAD (commit/tag)
    // Check if it's a local branch
    const isLocalBranch = await this.refsStore.has(`refs/heads/${this.name}`);

    // Decide whether to create symbolic ref or detached HEAD
    if (this.orphan) {
      // Orphan branch: symbolic ref to a branch that doesn't exist yet
      await this.refsStore.setSymbolic("HEAD", `refs/heads/${this.name}`);
    } else if (isLocalBranch) {
      // Local branch exists: use symbolic ref to the branch
      await this.refsStore.setSymbolic("HEAD", `refs/heads/${this.name}`);
    } else if (targetId) {
      // Not a local branch but resolves to a commit: detached HEAD
      // This handles: commit IDs, tags, remote branches, etc.
      await this.refsStore.set("HEAD", targetId);
    }
    // git's remove_branch_state: a merge, cherry-pick or revert stopped here is forgotten
    await removeBranchState(
      { commits: this.commits, refs: this.refsStore },
      new OperationState(this.workingCopy.checkout, this.refsStore),
    );

    // The index: forced, the target's tree; else the switched paths take the target's
    // entries (with the stat of the files just written), every other path keeps its own.
    // git's switch writes a new index (unpack-trees): no resolve-undo records survive it
    this.staging.clearResolveUndo?.();
    if (targetTreeId && this.force) {
      await this.staging.readTree(this.trees as any, targetTreeId);
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
   * Resolve a ref to a tree ID.
   */
  private async resolveTreeId(refName: string): Promise<ObjectId | undefined> {
    const commitId = await this.resolveCommitId(refName);
    if (!commitId) return undefined;
    return this.commits.getTree(commitId);
  }

  /**
   * Resolve a ref to a commit ID.
   */
  private async resolveCommitId(refName: string): Promise<ObjectId | undefined> {
    // Try as branch
    let ref = await this.refsStore.resolve(`refs/heads/${refName}`);
    if (ref?.objectId) return ref.objectId;

    // Try as tag
    ref = await this.refsStore.resolve(`refs/tags/${refName}`);
    if (ref?.objectId) return ref.objectId;

    // Try as direct ref (HEAD, etc.)
    ref = await this.refsStore.resolve(refName);
    if (ref?.objectId) return ref.objectId;

    // Try as commit ID
    if (await this.commits.has(refName)) {
      return refName;
    }

    return undefined;
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
