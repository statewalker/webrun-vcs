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

import { isAbsoluteGitPath, parseCommonDir } from "../git-dir/index.js";
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
  /**
   * Remove a file or a directory with its contents. `addWorktree` uses it to drop the
   * transient `locked` file and, when it fails, what it created.
   */
  remove(path: string): Promise<unknown>;
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
    const root = this.hostRoot()?.base;
    const gitDirPath =
      root !== undefined && !gitDir.startsWith("/")
        ? `${root}/${gitDir.replace(/^\.\//, "")}`
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
    const content = await this.readText(`${gitDir}/commondir`);
    // only the line end is stripped (get_common_dir_noenv)
    const text = content === undefined ? undefined : parseCommonDir(content);
    if (!text) return gitDir;
    if (isAbsoluteGitPath(text)) return this.filesPath(text);
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
   * Where this FilesApi's root is on the host (`rootPath`, else its `rootDirectory`), without
   * trailing slashes (`""` for `/`); undefined when unknown. A Windows root (`C:\\Users\\x`, a
   * UNC `\\\\server\\share`) is written with forward slashes, as Git for Windows writes paths
   * (`C:/Users/x`).
   */
  private hostRoot(): { base: string; windows: boolean } | undefined {
    const root = this.setup.rootPath ?? (this.files as { rootDirectory?: unknown }).rootDirectory;
    if (typeof root !== "string" || root === "") return undefined;
    const windows = /^[A-Za-z]:/.test(root) || root.startsWith("\\");
    const slashed = windows ? root.replace(/\\/g, "/") : root;
    return { base: slashed.replace(/\/+$/, ""), windows };
  }

  /**
   * The path git writes for `path` (a path in this FilesApi): absolute on the host when the
   * FilesApi's root is known (`rootPath`, else its `rootDirectory`), as git writes a
   * worktree's real paths; else `path` itself.
   */
  private hostPath(path: string): string {
    const root = this.hostRoot();
    if (root === undefined) return path;
    const inner = path
      .split("/")
      .filter((p) => p !== "" && p !== ".")
      .join("/");
    return inner === "" ? root.base || "/" : `${root.base}/${inner}`;
  }

  /**
   * The path in this FilesApi an absolute host path names (an absolute `commondir`): the
   * part below the FilesApi's root on the host, as `FileWorktree` maps an absolute gitfile
   * target. Returned as written when the root is unknown or the path lies outside it: such a
   * repository is beyond what this FilesApi can name, and reading it fails as a missing one.
   */
  private filesPath(hostPath: string): string {
    const root = this.hostRoot();
    if (root === undefined) return hostPath;
    // `.` and `..` resolved, separators collapsed (a leading `//`, a UNC root, kept)
    const normalize = (path: string) => {
      const slashed = root.windows ? path.replace(/\\/g, "/") : path;
      const lead = /^\/*/.exec(slashed)?.[0] ?? "";
      const parts: string[] = [];
      for (const part of slashed.slice(lead.length).split("/")) {
        if (part === "..") parts.pop();
        else if (part !== "." && part !== "") parts.push(part);
      }
      return `${lead.length >= 2 && root.windows ? "//" : lead ? "/" : ""}${parts.join("/")}`;
    };
    const target = normalize(hostPath);
    const base = root.base === "" ? "" : normalize(root.base).replace(/\/$/, "");
    const same = (a: string, b: string) =>
      root.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (same(target, base)) return "/";
    const prefix = `${base}/`;
    if (!same(target.slice(0, prefix.length), prefix)) return hostPath;
    return `/${target.slice(prefix.length)}`;
  }

  /**
   * Create additional worktree for existing repository.
   *
   * Like `git worktree add --no-checkout`: the files are not checked out and no index is
   * written. The administrative directory holds what git writes there:
   * - `.git/worktrees/NAME/HEAD`: the worktree's branch or detached commit
   * - `.git/worktrees/NAME/commondir`: `../..`, the repository the worktree belongs to
   * - `.git/worktrees/NAME/gitdir`: the path back to the worktree's `.git` file
   * - `.git/worktrees/NAME/locked`: the lock reason, with `lock`
   * - the worktree's `.git` file: `gitdir: /path/to/main/.git/worktrees/NAME`
   *
   * NAME is the worktree directory's name, followed by 1, 2, ... when a worktree of that
   * name exists, as git numbers them. With a known host root the paths are absolute host
   * paths, as git writes them, so native git can use the worktree.
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
    const { branch, commit, force = false, lock } = options;

    // What HEAD names, checked before anything is written (git resolves the commit-ish and
    // refuses a missing branch before add_worktree creates a directory)
    let head: string;
    let createBranch: { ref: string; objectId: string } | undefined;
    if (commit) {
      head = commit; // detached HEAD
    } else if (branch) {
      const branchRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
      head = `ref: ${branchRef}`;
      if (!(await history.refs.get(branchRef))) {
        if (!force) {
          throw new Error(`Branch '${branch}' does not exist. Use force: true to create it.`);
        }
        // created pointing at the current HEAD (an unborn HEAD leaves the branch unborn)
        const headRef = await history.refs.resolve("HEAD");
        if (headRef?.objectId) createBranch = { ref: branchRef, objectId: headRef.objectId };
      }
    } else {
      // Default: detached HEAD at current commit
      const headRef = await history.refs.resolve("HEAD");
      if (!headRef?.objectId) throw new Error("Cannot add worktree: repository has no commits.");
      head = headRef.objectId;
    }

    // Extract worktree name from path; numbered when taken, as git's add_worktree does
    const baseName = worktreePath.split("/").filter(Boolean).pop() || "worktree";
    let worktreeName = baseName;
    for (let counter = 1; await this.files.exists(`${gitDir}/worktrees/${worktreeName}`); ) {
      worktreeName = `${baseName}${counter++}`;
    }
    const worktreeGitDir = `${gitDir}/worktrees/${worktreeName}`;

    // `git worktree add -b` creates the branch first; it stays when the worktree fails
    if (createBranch) await history.refs.set(createBranch.ref, createBranch.objectId);

    // On a failure from here on, what this call created goes (git's junk_git_dir and
    // junk_work_tree): the admin directory, and the worktree directory unless it existed
    const worktreeExisted = await this.files.exists(worktreePath);
    let created = false;
    try {
      // Create worktree directory
      await this.files.mkdir(worktreePath);
      created = true;

      // Create worktrees/NAME in main repo. Locked while it is set up, as git does: with
      // the reason `lock` gives, else "initializing", dropped at the end
      await this.files.mkdir(`${gitDir}/worktrees`);
      await this.files.mkdir(worktreeGitDir);
      const reason = lock === true ? "added with --lock" : lock || undefined;
      const kept = lock !== undefined && lock !== false;
      // git's write_file: a line end only when the text has none (an empty reason: empty file)
      const lockText = reason === undefined ? "" : reason.endsWith("\n") ? reason : `${reason}\n`;
      await this.files.write(
        `${worktreeGitDir}/locked`,
        encodeGitPath(kept ? lockText : "initializing\n"),
      );

      // Create .git file in worktree pointing to main repo's worktrees/NAME
      // (paths as their bytes: one that is no UTF-8 is written as it is, never as U+FFFD)
      const gitFile = `gitdir: ${this.hostPath(worktreeGitDir)}\n`;
      await this.files.write(`${worktreePath}/.git`, encodeGitPath(gitFile));

      // Create gitdir file in worktrees/NAME pointing back to worktree
      await this.files.write(
        `${worktreeGitDir}/gitdir`,
        encodeGitPath(`${this.hostPath(`${worktreePath}/.git`)}\n`),
      );

      // The repository the worktree belongs to, relative to worktrees/NAME (git writes `../..`)
      await this.files.write(`${worktreeGitDir}/commondir`, encodeGitPath("../..\n"));

      // Set up HEAD in worktrees/NAME. Written plainly, as git's `worktree add` writes the
      // new worktree's HEAD (write_file): worktrees/NAME was created just above and no other
      // writer knows it yet. Later HEAD updates go through that worktree's ref store (locked).
      await this.files.writeFile(`${worktreeGitDir}/HEAD`, `${head}\n`);

      // `git worktree add --lock [--reason]` leaves the lock in place
      if (!kept) await this.files.remove(`${worktreeGitDir}/locked`);
    } catch (error) {
      if (created) {
        await this.files.remove(worktreeGitDir).catch(() => undefined);
        if (!worktreeExisted) await this.files.remove(worktreePath).catch(() => undefined);
      }
      throw error;
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
