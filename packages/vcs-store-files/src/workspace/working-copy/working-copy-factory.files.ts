/**
 * Factory for creating file-based working copies.
 *
 * Provides methods to open existing or create new working copies,
 * and to add additional worktrees to an existing repository.
 */

import type { History } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type {
  AddWorktreeOptions,
  Checkout,
  ContentFilterSetup,
  WorkingCopy,
  WorkingCopyFactory,
  WorkingCopyOptions,
  Worktree,
} from "@statewalker/vcs-working-tree";

import { createGitStashStore } from "./stash-store.files.js";
import { GitWorkingCopy, type WorkingCopyFilesApi } from "./working-copy.files.js";
import {
  type ConfigFilesApi,
  createWorkingCopyConfig,
  type GitConfigOptions,
} from "./working-copy-config.files.js";

/**
 * Combined files API for all working copy operations
 */
export interface WorkingCopyFactoryFilesApi extends WorkingCopyFilesApi, ConfigFilesApi {
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
 * What a host adds to the working copies a factory opens: the user's environment (global
 * configuration and attributes) and its filter drivers. Opt-in: without it only the
 * repository's own files are read.
 */
export interface GitWorkingCopyFactorySetup
  extends Pick<GitConfigOptions, "environment">,
    Omit<ContentFilterSetup, "environment"> {
  /**
   * Where the FilesApi's root is on the host (an absolute path on Node), so that
   * `includeIf.gitdir:` matches the git directory's real path. Default: the FilesApi's
   * `rootDirectory`, when it has one.
   */
  rootPath?: string;
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
    private readonly setup: GitWorkingCopyFactorySetup = {},
  ) {}

  /**
   * The configuration of the git directory `gitDir` as git reads it: for a linked worktree
   * (`.git/worktrees/<name>`, which has a `commondir`) the repository's `config` with the
   * worktree's own `config.worktree` (when `extensions.worktreeConfig` is set); `HEAD` (for
   * `includeIf.onbranch:`) and the directory `includeIf.gitdir:` matches are the worktree's.
   */
  private async openConfig(gitDir: string, commonDir?: string) {
    const common = commonDir ?? (await this.commonDirOf(gitDir));
    const root = this.setup.rootPath ?? (this.files as { rootDirectory?: unknown }).rootDirectory;
    const gitDirPath =
      typeof root === "string" && root !== "" && !gitDir.startsWith("/")
        ? `${root.replace(/\/+$/, "")}/${gitDir.replace(/^\.\//, "")}`
        : gitDir;
    const options: GitConfigOptions = {
      ...(this.setup.environment ? { environment: this.setup.environment } : {}),
      gitDirPath,
    };
    if (common !== gitDir) {
      options.worktreeConfigPath = `${gitDir}/config.worktree`;
      options.readHead = async () => {
        const head = await this.readText(`${gitDir}/HEAD`);
        const text = head?.trim();
        return text?.startsWith("ref: ") ? text.slice(5).trim() : undefined;
      };
    }
    return createWorkingCopyConfig(this.files, common, undefined, options);
  }

  private async readText(path: string): Promise<string | undefined> {
    const content = await this.files.read(path).catch(() => undefined);
    // `commondir` and HEAD as their bytes (a path that is no UTF-8 keeps them)
    return content ? decodeGitPath(content) : undefined;
  }

  /** git's `commondir`: the repository a linked worktree's git directory belongs to. */
  private async commonDirOf(gitDir: string): Promise<string> {
    const text = (await this.readText(`${gitDir}/commondir`))?.trim();
    if (!text) return gitDir;
    if (text.startsWith("/")) return text;
    // relative to the worktree's git directory
    const parts = gitDir.split("/").filter((p) => p !== "" && p !== ".");
    for (const part of text.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== "." && part !== "") parts.push(part);
    }
    return `${gitDir.startsWith("/") ? "/" : ""}${parts.join("/")}`;
  }

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

    // 4. Create stash store (refs/stash in the history's ref store, under its locks)
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
    });

    // 5. Create config
    const config = await this.openConfig(repositoryPath);

    return new GitWorkingCopy({
      history: context.history,
      checkout,
      worktree,
      stash,
      config,
      files: this.files,
      ...this.setup,
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
    // (paths as their bytes: one that is no UTF-8 is written as it is, never as U+FFFD)
    const gitFile = `gitdir: ${worktreeGitDir}\n`;
    await this.files.write(`${worktreePath}/.git`, encodeGitPath(gitFile));

    // Create gitdir file in worktrees/NAME pointing back to worktree
    await this.files.write(`${worktreeGitDir}/gitdir`, encodeGitPath(`${worktreePath}/.git\n`));

    // Set up HEAD in worktrees/NAME. Written plainly, as git's `worktree add` writes the
    // new worktree's HEAD (write_file): worktrees/NAME was created just above and no other
    // writer knows it yet. Later HEAD updates go through that worktree's ref store (locked).
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

    // Create stash store (the main repository's refs/stash, as git shares it across worktrees)
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
    });

    // Create config: the repository's, with this worktree's config.worktree
    const config = await this.openConfig(worktreeGitDir, gitDir);

    return new GitWorkingCopy({
      history: context.history,
      checkout,
      worktree,
      stash,
      config,
      files: this.files,
      ...this.setup,
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
  setup: GitWorkingCopyFactorySetup = {},
): WorkingCopyFactory {
  return new GitWorkingCopyFactory(files, createContext, setup);
}
