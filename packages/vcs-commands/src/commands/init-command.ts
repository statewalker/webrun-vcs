import {
  createInMemoryFilesApi,
  createMemoryHistory,
  type FilesApi,
  type History,
  type PosixFilesApi,
} from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesHistoryFromFiles,
  FileStagingStore,
  probeCaseFolding,
  resolveLinkedGitDir,
} from "@statewalker/vcs-store-files";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils";
import {
  createMemoryCheckout,
  type GitHostEnvironment,
  type Staging,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { Git } from "../git.js";
import type { InitResult } from "../results/init-result.js";

/**
 * Command to initialize a new Git repository.
 *
 * Based on JGit's InitCommand pattern. This command creates a new
 * Git repository with the specified configuration.
 *
 * Note: Unlike other commands, InitCommand does not extend GitCommand
 * because it creates a new repository rather than operating on an existing one.
 *
 * @example
 * ```typescript
 * // Initialize in-memory repository
 * const result = await new InitCommand().call();
 * const git = result.git;
 *
 * // Initialize file-based repository
 * import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
 * const files = createNodeFilesApi({ fs, rootDir: "/path/to/project" });
 * const result = await new InitCommand()
 *   .setFilesApi(files)
 *   .setDirectory(".git")
 *   .call();
 *
 * // Initialize bare repository
 * const result = await new InitCommand()
 *   .setBare(true)
 *   .setInitialBranch("main")
 *   .call();
 *
 * // Initialize with custom staging store and worktree support
 * const result = await new InitCommand()
 *   .setFilesApi(files)
 *   .setStagingStore(new FileStagingStore(files, ".git/index"))
 *   .setWorktree(true)
 *   .call();
 * ```
 */
export class InitCommand {
  private files?: FilesApi;
  private directory?: string;
  private gitDir?: string;
  private bare = false;
  private initialBranch = "main";
  private stagingStore?: Staging;
  private worktreeEnabled = false;
  private worktreeStore?: Worktree;
  private environment?: GitHostEnvironment;
  private callable = true;

  /**
   * Set the FilesApi implementation for storage.
   *
   * If not set, an in-memory FilesApi will be used.
   *
   * @param files The FilesApi to use for repository storage
   * @returns this for method chaining
   */
  setFilesApi(files: FilesApi): this {
    this.checkCallable();
    this.files = files;
    return this;
  }

  /**
   * Set the working directory for the repository.
   *
   * For non-bare repositories, this is the parent of the .git directory.
   * If gitDir is not explicitly set, it will be `${directory}/.git`.
   *
   * @param directory The working directory path
   * @returns this for method chaining
   */
  setDirectory(directory: string): this {
    this.checkCallable();
    this.directory = directory;
    return this;
  }

  /**
   * Set the git directory path.
   *
   * For non-bare repositories, this is typically `.git` inside the working directory.
   * For bare repositories, this is the repository root.
   *
   * @param gitDir The .git directory path
   * @returns this for method chaining
   */
  setGitDir(gitDir: string): this {
    this.checkCallable();
    this.gitDir = gitDir;
    return this;
  }

  /**
   * Set whether to create a bare repository.
   *
   * Bare repositories have no working tree and are typically used
   * as central repositories for pushing/pulling.
   *
   * @param bare True for bare repository, false for normal
   * @returns this for method chaining
   */
  setBare(bare: boolean): this {
    this.checkCallable();
    this.bare = bare;
    return this;
  }

  /**
   * Set the initial branch name.
   *
   * This is the branch that HEAD will point to after initialization.
   * Defaults to "main".
   *
   * @param branch The initial branch name
   * @returns this for method chaining
   */
  setInitialBranch(branch: string): this {
    this.checkCallable();
    this.initialBranch = branch;
    return this;
  }

  /**
   * Set a custom staging store.
   *
   * If not set, a MemoryStagingStore will be used.
   * Use FileStagingStore for native git compatibility.
   *
   * @param stagingStore The staging store to use
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * // For native git compatibility
   * const fileStaging = new FileStagingStore(files, ".git/index");
   * await fileStaging.read(); // Load existing index if present
   *
   * const result = await new InitCommand()
   *   .setFilesApi(files)
   *   .setStagingStore(fileStaging)
   *   .call();
   * ```
   */
  setStagingStore(stagingStore: Staging): this {
    this.checkCallable();
    this.stagingStore = stagingStore;
    return this;
  }

  /**
   * Enable worktree support for porcelain commands like git.add().
   *
   * When enabled, creates a WorktreeStore from the FilesApi that allows
   * commands like AddCommand to iterate and read files from the working tree.
   *
   * Ignored for bare repositories.
   *
   * @param enabled True to enable worktree support
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * const result = await new InitCommand()
   *   .setFilesApi(files)
   *   .setWorktree(true)
   *   .call();
   *
   * // Now git.add() works
   * await result.git.add().addFilepattern("src/").call();
   * ```
   */
  setWorktree(enabled: boolean): this {
    this.checkCallable();
    this.worktreeEnabled = enabled;
    return this;
  }

  /**
   * Set the user's environment (`createNodeGitHostEnvironment` on Node): the repository then
   * reads the system and global config files too, as git does, for its commit-graph settings
   * (`core.commitGraph`, `commitGraph.*`, `gc.writeCommitGraph`), and the commands run on the
   * result for identities and global excludes. Without it only the repository's config is read.
   *
   * @param environment The host's environment
   * @returns this for method chaining
   */
  setEnvironment(environment: GitHostEnvironment): this {
    this.checkCallable();
    this.environment = environment;
    return this;
  }

  /**
   * Set a custom worktree store.
   *
   * Alternative to setWorktree(true) when you need custom worktree configuration.
   *
   * @param worktree The worktree store to use
   * @returns this for method chaining
   */
  setWorktreeStore(worktree: Worktree): this {
    this.checkCallable();
    this.worktreeStore = worktree;
    this.worktreeEnabled = true;
    return this;
  }

  /**
   * Execute the init command and create a new repository.
   *
   * @returns InitResult containing the Git facade, store, and repository
   * @throws Error if the command has already been called
   */
  async call(): Promise<InitResult> {
    this.checkCallable();
    this.setCallable(false);

    // Use in-memory FilesApi if none provided
    const files = this.files ?? createInMemoryFilesApi();

    // Determine git directory
    const gitDir = this.resolveGitDir();

    // Create the history (repository). With a FilesApi it lives in `gitDir` on those files,
    // in git's layout, so it survives a reload and native git can read it; like `git init`
    // on an existing repository, a second init keeps its HEAD, config and objects. Without
    // one it stays in memory.
    let history: History;
    let staging: Staging;
    if (this.files) {
      const dir = gitDir.replace(/\/+$/, "") || ".";
      // a `.git` the user linked elsewhere is followed (resolved through the FilesApi)
      const repoFiles = await resolveLinkedGitDir(files, dir);
      const isFile = async (path: string) => (await repoFiles.stats(path))?.kind === "file";
      const hasHead = await isFile(`${dir}/HEAD`);
      // A repository with a config but no HEAD (damaged or half-made) is opened, not
      // re-created: creating rewrites the config, and its remotes and settings with it.
      const fresh = !hasHead && !(await isFile(`${dir}/config`));
      const open = (create: boolean) =>
        createGitFilesHistoryFromFiles({
          files: repoFiles,
          gitDir,
          create,
          defaultBranch: this.initialBranch,
          ...(this.environment ? { environment: this.environment } : {}),
        });
      if (fresh && this.bare && dir !== ".") {
        // The directory layout writes `core.bare = true` only for a gitDir of "."; set it
        // before opening, so what reads the config (reflog defaults) sees a bare repository.
        await open(true);
        await markBare(repoFiles, `${dir}/config`);
        history = await open(false);
      } else {
        history = await open(fresh);
      }
      await history.initialize();
      if (fresh) {
        // git init's probe: a filesystem that folds case or Unicode composition
        const folding = await probeCaseFolding(repoFiles as PosixFilesApi, dir);
        if (folding.ignoreCase)
          await setCoreValue(repoFiles, `${dir}/config`, "ignorecase", "true");
        if (folding.precomposeUnicode) {
          await setCoreValue(repoFiles, `${dir}/config`, "precomposeunicode", "true");
        }
      }
      if (!hasHead && !fresh) {
        await history.refs.setSymbolic("HEAD", `refs/heads/${this.initialBranch}`);
      }
      // The index lives in the repository too: a reopened repository keeps what was staged
      // (its last commit's files), so the next commit does not drop them.
      if (this.stagingStore) {
        staging = this.stagingStore;
      } else if (this.bare) {
        staging = new MemoryStagingStore();
      } else {
        const fileStaging = new FileStagingStore(repoFiles, `${dir}/index`);
        await fileStaging.read();
        staging = fileStaging;
      }
    } else {
      history = createMemoryHistory();
      await history.initialize();
      // Set initial branch by creating symbolic ref for HEAD
      await history.refs.setSymbolic("HEAD", `refs/heads/${this.initialBranch}`);
      staging = this.stagingStore ?? new MemoryStagingStore();
    }

    // Create worktree if enabled and not bare
    let worktree: Worktree | undefined;
    if (this.worktreeEnabled && !this.bare) {
      worktree =
        this.worktreeStore ??
        createFileWorktree({
          files,
          // the worktree is the directory asked for (git init <dir>), the FilesApi's root
          // without one
          rootPath: (this.directory ?? "").replace(/\/+$/, ""),
          blobs: history.blobs,
          trees: history.trees,
          gitDir,
          ...(this.environment ? { environment: this.environment } : {}),
        });
    }

    // Wrap the staging area in a Checkout so `workingCopy.checkout.staging`
    // resolves (matching the WorkingCopy interface). A freshly-init'd repo has
    // no HEAD/stash/in-progress operation yet, so those default to unborn/empty.
    // The Checkout shares the same `staging` instance as the legacy top-level
    // `staging` field, so edits are visible through either path.
    const checkout = createMemoryCheckout({ staging });

    // Create WorkingCopy from components
    // Note: Staging/Worktree implementations may be partial
    // Full implementations are provided at runtime by workspace integration
    // Use type assertion since init creates a minimal working copy
    const workingCopy = {
      history,
      staging: staging as unknown as Staging,
      worktree: worktree as unknown as Worktree,
      stash: {} as never, // Stash not available for newly init'd repos
      // Config not set for newly init'd repos; the host's environment, when given, is read
      // from it by the commands (identities, dates)
      config: (this.environment ? { environment: this.environment } : {}) as never,
      checkout,
      async getHead() {
        const ref = await history.refs.resolve("HEAD");
        return ref?.objectId;
      },
      async getCurrentBranch() {
        const ref = await history.refs.get("HEAD");
        if (ref && "target" in ref) {
          return ref.target.replace("refs/heads/", "");
        }
        return undefined;
      },
      async setHead() {
        // No-op for init command
      },
      async isDetachedHead() {
        return false;
      },
      async getMergeState() {
        return undefined;
      },
      async getRebaseState() {
        return undefined;
      },
      async getCherryPickState() {
        return undefined;
      },
      async getRevertState() {
        return undefined;
      },
      async hasOperationInProgress() {
        return false;
      },
      async getStatus() {
        // Return a minimal RepositoryStatus compatible object
        return {
          files: [],
          staged: [],
          unstaged: [],
          untracked: [],
          isClean: true,
          hasStaged: false,
          hasUnstaged: false,
          hasUntracked: false,
          hasConflicts: false,
        };
      },
    } as unknown as WorkingCopy;

    // Create Git facade
    const git = Git.fromWorkingCopy(workingCopy);

    return {
      git,
      workingCopy,
      repository: history,
      initialBranch: this.initialBranch,
      bare: this.bare,
      gitDir,
    };
  }

  /**
   * Resolve the git directory path based on configuration.
   */
  private resolveGitDir(): string {
    // If gitDir is explicitly set, use it
    if (this.gitDir !== undefined) {
      return this.gitDir;
    }

    // If directory is set, derive gitDir
    if (this.directory !== undefined) {
      if (this.bare) {
        // Bare repositories: the directory IS the git directory
        return this.directory;
      } else {
        // Normal repositories: .git inside the directory
        return `${this.directory}/.git`;
      }
    }

    // Default to .git
    return ".git";
  }

  /**
   * Check if the command is still callable.
   * @throws Error if the command has already been executed
   */
  private checkCallable(): void {
    if (!this.callable) {
      throw new Error("InitCommand can only be called once");
    }
  }

  /**
   * Set the callable state.
   */
  private setCallable(value: boolean): void {
    this.callable = value;
  }
}

/** Sets `core.bare = true` in a config file written by the git directory layout. */
async function markBare(files: FilesApi, configPath: string): Promise<void> {
  await setCoreValue(files, configPath, "bare", "true");
}

/** Sets `core.<key>` in the fresh config `init` wrote (one `[core]` section). */
async function setCoreValue(
  files: FilesApi,
  configPath: string,
  key: string,
  value: string,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(configPath)) chunks.push(chunk);
  const text = decodeGitPath(concatChunks(chunks));
  const existing = new RegExp(`^(\\s*${key}\\s*=\\s*)\\S+`, "mi");
  const updated = existing.test(text)
    ? text.replace(existing, `$1${value}`)
    : text.replace(/^\[core\]\s*$/m, `[core]\n\t${key} = ${value}`);
  await files.write(configPath, [encodeGitPath(updated)]);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
