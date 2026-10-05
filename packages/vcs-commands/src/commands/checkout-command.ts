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

import { FileMode, type ObjectId, type Ref } from "@statewalker/vcs-core";
import { UpdateStagingEntry } from "@statewalker/vcs-working-tree";

import {
  MissingArgumentError,
  NotADirectoryError,
  PathNotFoundInTreeError,
  PathNotInIndexError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";

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
}

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

    // Path checkout mode
    if (this.allPaths || this.paths.length > 0) {
      return this.checkoutPaths();
    }

    // Branch checkout mode
    return this.checkoutBranch();
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
        if (sourceTreeId) {
          // Checkout from commit tree
          await this.checkoutPathFromTree(path, sourceTreeId);
        } else {
          // Checkout from index
          await this.checkoutPathFromIndex(path);
        }
        updated.push(path);
      } catch {
        conflicts.push(path);
      }
    }

    return {
      status: conflicts.length > 0 ? CheckoutStatus.CONFLICTS : CheckoutStatus.OK,
      updated,
      removed: [],
      conflicts,
      ref: null,
    };
  }

  /**
   * Detect conflicts between staged changes and checkout target.
   *
   * Returns list of paths that have uncommitted staged changes.
   * Git prevents checkout when staged changes differ from HEAD,
   * as they would be lost during checkout.
   *
   * @param _targetTreeId Target tree to checkout (unused for now, checks HEAD vs staging)
   * @returns Array of conflicting paths
   */
  private async detectCheckoutConflicts(_targetTreeId?: ObjectId): Promise<string[]> {
    const conflicts: string[] = [];

    // Get current HEAD tree for comparison
    const headId = await this.resolveCommitId("HEAD");
    if (!headId) {
      // No HEAD commit yet (empty repository) - no conflicts possible
      return conflicts;
    }

    const headTreeId = await this.commits.getTree(headId);
    if (!headTreeId) {
      return conflicts;
    }

    // Collect HEAD tree entries
    const headEntries = new Map<string, { objectId: ObjectId; mode: number }>();
    await this.collectTreeEntries(headTreeId, "", headEntries);

    // Compare staging with HEAD
    for await (const entry of this.staging.entries()) {
      // Skip conflict stages (1-3) - only check stage 0
      if (entry.stage !== 0) continue;

      const headEntry = headEntries.get(entry.path);

      // Check if staged content differs from HEAD
      if (!headEntry || headEntry.objectId !== entry.objectId) {
        // Staged change differs from HEAD - this is an uncommitted change
        conflicts.push(entry.path);
      }
    }

    return conflicts;
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

    // Detect conflicts with staged changes before checkout
    if (!this.force && !this.orphan) {
      const conflicts = await this.detectCheckoutConflicts(targetTreeId);
      if (conflicts.length > 0) {
        return {
          status: CheckoutStatus.CONFLICTS,
          updated: [],
          removed: [],
          conflicts,
          ref: null,
        };
      }
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

    // Sync staging to match target tree AFTER updating HEAD
    const updated: string[] = [];
    const removed: string[] = [];

    if (targetTreeId) {
      // Use this.trees which is CommandTrees (has loadTree method for TreeStore compatibility)
      await this.staging.readTree(this.trees as any, targetTreeId);

      // Persist staging to .git/index so native git sees the correct state
      await this.staging.write();

      // Write files to working directory if not a bare repository
      if (this.hasFileWriteSupport()) {
        await this.writeTreeToWorkdir(targetTreeId, "");
      }
    }

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
   * Check if the store supports file writes (not a bare repository).
   *
   * A repository is considered "bare" if it doesn't have a worktree interface.
   */
  private hasFileWriteSupport(): boolean {
    return !!this.worktreeAccess;
  }

  /**
   * Write all files from a tree to the working directory.
   *
   * @param treeId The tree ID to checkout
   * @param basePath The base path prefix for entries in this tree
   */
  private async writeTreeToWorkdir(treeId: ObjectId, basePath: string): Promise<void> {
    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new Error("Worktree not available for file writes");
    }

    for await (const entry of this.trees.loadTree(treeId)) {
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
      const isDirectory = entry.mode === FileMode.TREE;

      if (isDirectory) {
        // Recursively process subdirectories
        await this.writeTreeToWorkdir(entry.id, relativePath);
      } else {
        // Ensure parent directory exists
        const lastSlash = relativePath.lastIndexOf("/");
        if (lastSlash > 0) {
          const parentDir = relativePath.substring(0, lastSlash);
          await worktree.mkdir(parentDir);
        }

        // Load blob content
        const chunks: Uint8Array[] = [];
        const blobContent = await this.blobs.load(entry.id);
        if (blobContent) {
          for await (const chunk of blobContent) {
            chunks.push(chunk);
          }
        }

        // Write file using worktree interface
        await worktree.writeContent(relativePath, chunks);
      }
    }
  }

  /**
   * Checkout a path from the staging index.
   */
  private async checkoutPathFromIndex(path: string): Promise<void> {
    // Find the entry in staging
    let found = false;
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
          found = true;
          break;
        }
        continue;
      }

      found = true;
      break;
    }

    if (!found) {
      throw new PathNotInIndexError(path);
    }
  }

  /**
   * Checkout a path from a tree.
   */
  private async checkoutPathFromTree(path: string, treeId: ObjectId): Promise<void> {
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
      }
    }
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
