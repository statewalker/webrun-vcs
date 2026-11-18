/**
 * Factory for creating file-based working copies.
 *
 * Provides methods to open existing or create new working copies,
 * and to add additional worktrees to an existing repository.
 */

import type { FilesApi, History } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath, parseGitBool } from "@statewalker/vcs-utils/encoding";
import { normalizePath } from "@statewalker/vcs-utils/files";
import type {
  AddWorktreeOptions,
  Checkout,
  ContentFilterSetup,
  WorkingCopy,
  WorkingCopyFactory,
  WorkingCopyOptions,
  Worktree,
} from "@statewalker/vcs-working-tree";

import {
  HostPaths,
  hostRootOf,
  isAbsoluteGitPath,
  parseCommonDir,
  sanitizeRefnameComponent,
} from "../git-dir/index.js";
import { openGitLinkedWorktrees } from "../linked-worktrees/index.js";
import { createGitStashStore } from "./stash-store.files.js";
import { GitWorkingCopy, type WorkingCopyFilesApi } from "./working-copy.files.js";
import {
  type ConfigFilesApi,
  createWorkingCopyConfig,
  type GitConfigOptions,
} from "./working-copy-config.files.js";

const ZERO_ID = "0000000000000000000000000000000000000000";

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
  /**
   * The FilesApi the repository is in, naming the same paths as the factory's files. With
   * it the working copies the factory opens get `worktrees` (`openGitLinkedWorktrees`), and
   * `addWorktree` returns the new worktree's own working copy: HEAD, index, pseudo refs and
   * HEAD reflog in `.git/worktrees/<id>`, branches shared (`createWorktreeRefs`). Without
   * it `addWorktree`'s working copy is built from `createCheckout(worktreeGitDir)` and the
   * history's refs, so its HEAD is whatever those refs hold: give `files`, or make those
   * the worktree's own.
   */
  files?: FilesApi;
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
    const root = this.paths().root;
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

    // 4. Create config
    const config = await this.openConfig(repositoryPath);

    // 5. Create stash store (refs/stash in the history's ref store, under its locks)
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
      coreAbbrev: () => config.get("core.abbrev"),
    });

    // 6. The repository's worktrees, when the context gives its FilesApi
    const worktrees = context.files
      ? await this.linkedWorktrees(context, repositoryPath)
      : undefined;

    return new GitWorkingCopy({
      history: context.history,
      checkout,
      worktree,
      stash,
      config,
      files: this.files,
      ...this.setup,
      gitDir: repositoryPath,
      ...(worktrees ? { worktrees } : {}),
    });
  }

  /** The worktrees seen from `gitDir`, over the context's FilesApi with this factory's root. */
  private linkedWorktrees(context: GitWorkingCopyContext, gitDir: string) {
    const { rootPath: _root, ...setup } = this.setup;
    return openGitLinkedWorktrees({
      ...setup,
      files: context.files as FilesApi,
      gitDir,
      history: context.history,
      // the paths this factory writes: an unknown root stays unknown ("")
      rootPath: hostRootOf(this.files, this.setup.rootPath) ?? "",
    });
  }

  /** Where this FilesApi's root is on the host (`rootPath`, else its `rootDirectory`). */
  private paths(): HostPaths {
    return new HostPaths(hostRootOf(this.files, this.setup.rootPath));
  }

  /** The path in this FilesApi an absolute host path names (an absolute `commondir`). */
  private filesPath(hostPath: string): string {
    return this.paths().filesPath(hostPath);
  }

  /**
   * Whether a new worktree's HEAD is logged (core.logAllRefUpdates; by default yes, also in
   * a bare repository, as git runs in a linked worktree as in a non-bare one), and the
   * identity of a line written now: `user.name` and `user.email`, else the default.
   */
  private async reflogSettings(gitDir: string): Promise<{ log: boolean; ident: string }> {
    const config = await this.openConfig(gitDir, gitDir);
    const setting = config.get("core.logAllRefUpdates");
    const always = typeof setting === "string" && setting.toLowerCase() === "always";
    const log = always || (parseGitBool(setting) ?? true);
    const name = config.get("user.name");
    const email = config.get("user.email");
    const who = `${typeof name === "string" ? name : "webrun-vcs"} <${typeof email === "string" ? email : "vcs@localhost"}>`;
    return { log, ident: `${who} ${Math.floor(Date.now() / 1000)} +0000` };
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
   * - `.git/worktrees/NAME/logs/HEAD`: the line git's `update-ref` / `symbolic-ref` log for
   *   the new HEAD (zero id to the commit, no message), when HEAD resolves to a commit and
   *   `core.logAllRefUpdates` is not false
   * - the worktree's `.git` file: `gitdir: /path/to/main/.git/worktrees/NAME`
   *
   * NAME is the worktree directory's name as a ref component (git's
   * `sanitize_refname_component`: `a b` gives `a-b`, `.x` gives `-x`), followed by 1, 2, ... when a worktree of that
   * name exists, as git numbers them. With a known host root the paths are absolute host
   * paths, as git writes them, so native git can use the worktree.
   *
   * The working copy returned is the new worktree's own (its HEAD, index and reflog) when
   * the context gives its FilesApi (`GitWorkingCopyContext.files`).
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

    // The path's last component, made a ref component as git does
    // (sanitize_refname_component); numbered when taken, as git's add_worktree does
    const lastComponent = worktreePath.split("/").filter(Boolean).pop() || "worktree";
    const baseName = sanitizeRefnameComponent(lastComponent);
    if (baseName === "" || baseName.includes("/")) {
      throw new Error(`invalid path '${worktreePath}'`);
    }
    let worktreeName = baseName;
    for (let counter = 1; await this.files.exists(`${gitDir}/worktrees/${worktreeName}`); ) {
      worktreeName = `${baseName}${counter++}`;
    }
    const worktreeGitDir = `${gitDir}/worktrees/${worktreeName}`;
    const paths = this.paths();
    // the paths git writes: host paths with a known root; else the FilesApi paths, made
    // absolute (a relative one would be read back as relative to the admin directory)
    const written = (path: string) => (paths.known ? paths.hostPath(path) : normalizePath(path));

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
      const gitFile = `gitdir: ${written(worktreeGitDir)}\n`;
      await this.files.write(`${worktreePath}/.git`, encodeGitPath(gitFile));

      // Create gitdir file in worktrees/NAME pointing back to worktree
      await this.files.write(
        `${worktreeGitDir}/gitdir`,
        encodeGitPath(`${written(`${worktreePath}/.git`)}\n`),
      );

      // The repository the worktree belongs to, relative to worktrees/NAME (git writes `../..`)
      await this.files.write(`${worktreeGitDir}/commondir`, encodeGitPath("../..\n"));

      // git's update-ref / symbolic-ref of the new HEAD log it: no message, from the zero id
      const headId = head.startsWith("ref: ")
        ? (await history.refs.resolve(head.slice(5)))?.objectId
        : head;
      const reflog = await this.reflogSettings(gitDir);
      if (headId && reflog.log) {
        const line = `${ZERO_ID} ${headId} ${options.ident ?? reflog.ident}\n`;
        await this.files.write(`${worktreeGitDir}/logs/HEAD`, new TextEncoder().encode(line));
      }

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

    // The new worktree's own working copy (its HEAD and index), with the repository's worktrees
    const context = await this.createContext(gitDir, {});
    if (context.files) {
      return (await this.linkedWorktrees(context, worktreeGitDir)).openCurrent();
    }

    // Create checkout interface for the new worktree
    const checkout = await context.createCheckout(worktreeGitDir);

    // Create working tree interface
    const worktree = context.createWorktree(worktreePath);

    // Create config: the repository's, with this worktree's config.worktree
    const config = await this.openConfig(worktreeGitDir, gitDir);

    // Create stash store (the main repository's refs/stash, as git shares it across worktrees)
    const stash = createGitStashStore({
      history: context.history,
      staging: checkout.staging,
      worktree: worktree,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
      coreAbbrev: () => config.get("core.abbrev"),
    });

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
