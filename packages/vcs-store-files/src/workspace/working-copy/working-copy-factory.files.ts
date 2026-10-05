/**
 * Factory for creating file-based working copies.
 *
 * Provides methods to open existing or create new working copies,
 * and to add additional worktrees to an existing repository.
 */

import type { History } from "@statewalker/vcs-core";
import type {
  AddWorktreeOptions,
  Checkout,
  WorkingCopy,
  WorkingCopyFactory,
  WorkingCopyOptions,
  Worktree,
} from "@statewalker/vcs-working-tree";

import { createGitStashStore, type StashFilesApi } from "./stash-store.files.js";
import { GitWorkingCopy, type WorkingCopyFilesApi } from "./working-copy.files.js";
import { type ConfigFilesApi, createWorkingCopyConfig } from "./working-copy-config.files.js";

/**
 * Combined files API for all working copy operations
 */
export interface WorkingCopyFactoryFilesApi
  extends WorkingCopyFilesApi,
    StashFilesApi,
    ConfigFilesApi {
  /** Create a directory (and parents if needed) */
  mkdir(path: string): Promise<void>;
  /** Write content to a file */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Context required to create a GitWorkingCopy.
 *
 * This allows the factory to be used with different storage backends
 * for the repository, staging, worktree, and checkout components.
 */
export interface GitWorkingCopyContext {
  /** The history interface */
  history: History;
  /** Factory function to create the checkout interface */
  createCheckout: (gitDir: string) => Promise<Checkout>;
  /** Factory function to create the worktree interface */
  createWorktree: (worktreePath: string) => Worktree;
}

/**
 * Git-compatible WorkingCopyFactory implementation.
 */
export class GitWorkingCopyFactory implements WorkingCopyFactory {
  constructor(
    private readonly files: WorkingCopyFactoryFilesApi,
    private readonly createContext: (
      repositoryPath: string,
      options: WorkingCopyOptions,
    ) => Promise<GitWorkingCopyContext>,
  ) {}

  /**
   * Open or create a working copy at the given path.
   */
  async openWorkingCopy(
    worktreePath: string,
    repositoryPath: string,
    options: WorkingCopyOptions = {},
  ): Promise<WorkingCopy> {
    // 1. Get context (history, checkout, worktree factories)
    const context = await this.createContext(repositoryPath, options);

    // 2. Create checkout interface
    const checkout = await context.createCheckout(repositoryPath);

    // 3. Create working tree interface
    const worktree = context.createWorktree(worktreePath);

    // 4. Create stash store
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      files: this.files,
      gitDir: repositoryPath,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
    });

    // 5. Create config
    const config = await createWorkingCopyConfig(this.files, repositoryPath);

    return new GitWorkingCopy({
      history: context.history,
      checkout,
      worktree,
      stash,
      config,
      files: this.files,
      gitDir: repositoryPath,
    });
  }

  /**
   * Create additional worktree for existing repository.
   *
   * Similar to `git worktree add`.
   *
   * Git Worktree Structure:
   * - Main repo .git/worktrees/NAME/ contains:
   *   - HEAD: Current branch/commit for this worktree
   *   - index: Staging area
   *   - gitdir: Path back to worktree's .git file
   *   - config: Per-worktree config (optional)
   * - Worktree .git is a file containing:
   *   gitdir: /path/to/main/.git/worktrees/NAME
   *
   * @param history History interface
   * @param gitDir Path to the main .git directory
   * @param worktreePath Path for new working directory
   * @param options Worktree options
   */
  async addWorktree(
    history: History,
    gitDir: string,
    worktreePath: string,
    options: AddWorktreeOptions = {},
  ): Promise<WorkingCopy> {
    const { branch, commit, force = false } = options;

    // Extract worktree name from path
    const worktreeName = worktreePath.split("/").pop() || "worktree";
    const worktreeGitDir = `${gitDir}/worktrees/${worktreeName}`;

    // Create worktree directory
    await this.files.mkdir(worktreePath);

    // Create worktrees directory in main repo
    await this.files.mkdir(`${gitDir}/worktrees`);
    await this.files.mkdir(worktreeGitDir);

    // Create .git file in worktree pointing to main repo's worktrees/NAME
    const gitFile = `gitdir: ${worktreeGitDir}\n`;
    await this.files.writeFile(`${worktreePath}/.git`, gitFile);

    // Create gitdir file in worktrees/NAME pointing back to worktree
    await this.files.writeFile(`${worktreeGitDir}/gitdir`, `${worktreePath}/.git\n`);

    // Set up HEAD in worktrees/NAME
    if (commit) {
      // Detached HEAD
      await this.files.writeFile(`${worktreeGitDir}/HEAD`, `${commit}\n`);
    } else if (branch) {
      // Create branch if it doesn't exist (when force is true) or use existing
      const branchRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
      await this.files.writeFile(`${worktreeGitDir}/HEAD`, `ref: ${branchRef}\n`);

      // If branch doesn't exist, create it pointing to current HEAD
      const existingRef = await history.refs.get(branchRef);
      if (!existingRef && force) {
        const headRef = await history.refs.resolve("HEAD");
        if (headRef?.objectId) {
          await history.refs.set(branchRef, headRef.objectId);
        }
      } else if (!existingRef && !force) {
        throw new Error(`Branch '${branch}' does not exist. Use force: true to create it.`);
      }
    } else {
      // Default: detached HEAD at current commit
      const headRef = await history.refs.resolve("HEAD");
      if (headRef?.objectId) {
        await this.files.writeFile(`${worktreeGitDir}/HEAD`, `${headRef.objectId}\n`);
      } else {
        throw new Error("Cannot add worktree: repository has no commits.");
      }
    }

    // Create the working copy using the worktree-specific git directory
    const context = await this.createContext(gitDir, {});

    // Create checkout interface for the new worktree
    const checkout = await context.createCheckout(worktreeGitDir);

    // Create working tree interface
    const worktree = context.createWorktree(worktreePath);

    // Create stash store (uses main repo's stash)
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      files: this.files,
      gitDir: worktreeGitDir,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
    });

    // Create config
    const config = await createWorkingCopyConfig(this.files, worktreeGitDir);

    return new GitWorkingCopy({
      history: context.history,
      checkout,
      worktree,
      stash,
      config,
      files: this.files,
      gitDir: worktreeGitDir,
    });
  }
}

/**
 * Create a GitWorkingCopyFactory instance.
 *
 * @param files File system API
 * @param createContext Function to create repository context
 */
export function createGitWorkingCopyFactory(
  files: WorkingCopyFactoryFilesApi,
  createContext: (
    repositoryPath: string,
    options: WorkingCopyOptions,
  ) => Promise<GitWorkingCopyContext>,
): WorkingCopyFactory {
  return new GitWorkingCopyFactory(files, createContext);
}
