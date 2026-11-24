import {
  createInMemoryFilesApi,
  createMemoryHistory,
  type FilesApi,
  type History,
  type PosixFilesApi,
  readFile,
} from "@statewalker/vcs-core";
import {
  configFilesApiOf,
  createFileWorktree,
  createGitFilesHistoryFromFiles,
  createWorkingCopyConfig,
  FileStagingStore,
  HostPaths,
  hostPathOf,
  hostRootOf,
  isAbsoluteGitPath,
  parseGitfile,
  probeCaseFolding,
  readProtectedConfig,
  readRepositoryFormat,
  resolveLinkedGitDir,
  setConfigMultivarText,
} from "@statewalker/vcs-store-files";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import {
  decodeGitPath,
  encodeGitPath,
  type ObjectFormat,
  objectFormatByName,
  SHA1_OBJECT_FORMAT,
} from "@statewalker/vcs-utils";
import {
  adjustSharedPerm,
  dirname,
  joinPath,
  normalizePath,
  PERM_GROUP,
  parseSharedRepository,
  sharedRepositoryConfigValue,
  sharedRepositoryOf,
  withSharedPerm,
} from "@statewalker/vcs-utils/files";
import {
  createMemoryCheckout,
  type GitHostEnvironment,
  type Staging,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { Git } from "../git.js";
import type { InitResult } from "../results/init-result.js";
import {
  defaultInitialBranch,
  defaultRefFormat,
  InvalidInitialBranchError,
  isValidBranchName,
} from "./default-branch.js";

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
  /** `--initial-branch`; undefined: git's default (see {@link defaultInitialBranch}) */
  private initialBranch?: string;
  private stagingStore?: Staging;
  private worktreeEnabled = false;
  private worktreeStore?: Worktree;
  private environment?: GitHostEnvironment;
  /** `--object-format`; undefined: `$GIT_DEFAULT_HASH`, `init.defaultObjectFormat`, else sha1 */
  private objectFormatName?: string;
  /** `--ref-format`; undefined: git's default (see {@link defaultRefFormat}) */
  private refFormat?: string;
  /** `--separate-git-dir`: the repository's place, `.git` then a gitfile naming it */
  private separateGitDir?: string;
  /** `--template`: the directory copied into the repository ("" copies none) */
  private template?: { path: string; files?: FilesApi };
  /** `--shared` as git_config_perm reads it; undefined: core.sharedRepository decides */
  private shared?: number;
  private callable = true;

  /**
   * Put the repository at `path` (`git init --separate-git-dir <path>`, a path of the
   * FilesApi) and write a gitfile in its place (`<directory>/.git`: `gitdir: <path>`, the
   * path as the host names it: under the FilesApi's `rootDirectory`, its links resolved
   * through `GitHostEnvironment.realPath`). An existing repository there (a `.git`
   * directory, or the one a `.git` gitfile names) is moved to `path` first, as git's
   * re-init moves it, and its linked worktrees are pointed at the new place. Refused for a
   * bare repository (`InitOptionsError`).
   *
   * @param path The git directory's place
   * @returns this for method chaining
   */
  setSeparateGitDir(path: string): this {
    this.checkCallable();
    this.separateGitDir = path;
    return this;
  }

  /**
   * Copy the templates of `path` into the repository (`git init --template=<path>`): every
   * file, directory and symbolic link not starting with `.`, an existing file never
   * replaced (a template `config` included), executables made executable (hooks). `path`
   * is a directory of `files` (default: the command's FilesApi); "" copies nothing. Without
   * it, `$GIT_TEMPLATE_DIR` (`GitHostEnvironment.templateDir`) then `init.templateDir`
   * from the system or global configuration (or `git -c`), read through
   * `GitHostEnvironment.hostFilesOf`; ours has no built-in templates.
   *
   * @param path The template directory, or "" for none
   * @param files The storage holding it
   * @returns this for method chaining
   */
  setTemplate(path: string, files?: FilesApi): this {
    this.checkCallable();
    this.template = files ? { path, files } : { path };
    return this;
  }

  /**
   * Make the repository shared (`git init --shared[=<permissions>]`): true or no value is
   * `group`; a string is what git accepts (`false`/`umask`, `true`/`group`, `all`/`world`/
   * `everybody`, an octal mode such as `0640`). Written as `core.sharedRepository` (with
   * `receive.denyNonFastforwards`), and the files and directories created get git's modes
   * (`adjust_shared_perm`) where the FilesApi keeps modes. Without it,
   * `core.sharedRepository` from the configuration (the template's included) decides.
   *
   * @throws SharedRepositoryModeError for an octal mode without owner read and write
   * @returns this for method chaining
   */
  setShared(permissions: string | boolean = true): this {
    this.checkCallable();
    this.shared =
      permissions === true
        ? PERM_GROUP
        : permissions === false
          ? 0
          : parseSharedRepository(permissions);
    return this;
  }

  /**
   * Set the object format of the new repository (`git init --object-format=<format>`):
   * `sha1` (git's default) or `sha256`. Without it, `$GIT_DEFAULT_HASH`
   * (`GitHostEnvironment.defaultHash`), then `init.defaultObjectFormat` from the system or
   * global configuration (or `git -c`), else SHA-1. A name git does not know fails the call
   * (`UnknownHashAlgorithmError`), and so does re-initialising an existing repository with
   * another format (`ReinitializeHashError`); an existing repository keeps its own otherwise.
   *
   * @param format `sha1` or `sha256`
   * @returns this for method chaining
   */
  setObjectFormat(format: string): this {
    this.checkCallable();
    this.objectFormatName = format;
    return this;
  }

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
   * This is the branch that HEAD will point to after initialization. Without it, git's
   * default: `init.defaultBranch` from the system or global configuration (or `git -c`),
   * else `master`, or `main` with `GitHostEnvironment.breakingChanges` (git 3.0).
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
   * Set the ref storage format of a new repository (`git init --ref-format`): `files` (loose
   * refs and packed-refs) or `reftable` (`.git/reftable`). Without it, git's default:
   * `$GIT_DEFAULT_REF_FORMAT`, `init.defaultRefFormat`, else `files`, or `reftable` with
   * `GitHostEnvironment.breakingChanges` (git 3.0). An existing repository keeps its format.
   *
   * @param format "files" or "reftable"
   * @returns this for method chaining
   */
  setRefFormat(format: "files" | "reftable" | string): this {
    this.checkCallable();
    this.refFormat = format;
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

    // git's -b / init.defaultBranch / built-in default (repo_default_branch_name), worked out
    // only for a repository without HEAD (create_reference_database runs only then): an
    // existing repository keeps its HEAD, ignores -b with a warning and checks no name
    let initialBranch = "";
    let hints: string[] | undefined;
    const warnings: string[] = [];
    const chooseBranch = async () => {
      if (this.initialBranch !== undefined && !isValidBranchName(this.initialBranch)) {
        throw new InvalidInitialBranchError(this.initialBranch);
      }
      const chosen =
        this.initialBranch !== undefined
          ? { name: this.initialBranch }
          : await defaultInitialBranch(this.environment);
      initialBranch = chosen.name;
      hints = chosen.hint;
    };

    // an explicit --object-format git does not know dies before anything is written
    const explicitFormat =
      this.objectFormatName === undefined ? undefined : knownHashAlgorithm(this.objectFormatName);
    let objectFormat: ObjectFormat = SHA1_OBJECT_FORMAT;

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
    let resultGitDir = gitDir;
    // the worktree's top: the directory asked for, or the main worktree when
    // --separate-git-dir was given inside a linked one
    let worktreeRoot = (this.directory ?? "").replace(/\/+$/, "");
    let reinitialized = false;
    let shared = 0;
    if (this.files) {
      if (this.separateGitDir !== undefined && this.bare) {
        throw new InitOptionsError(
          "fatal: options '--separate-git-dir' and '--bare' cannot be used together",
        );
      }
      // cmd_init_db's paths: the git directory, or with --separate-git-dir the gitfile's place
      // and the directory it names (an existing repository moved there first, as
      // separate_git_dir renames it); a `.git` gitfile names the repository re-initialised
      let dir = gitDir.replace(/\/+$/, "") || ".";
      if (this.separateGitDir !== undefined) {
        const real = this.separateGitDir.replace(/\/+$/, "") || ".";
        const { worktreeTop } = await this.separateGitDirectory(files, dir, real, warnings);
        if (worktreeTop !== undefined) worktreeRoot = worktreeTop;
        dir = real;
      } else if (!this.bare) {
        // re-init through a gitfile: the repository it names, a linked worktree's common
        // directory (templates, config, objects and refs live there)
        const linked = await gitfileTargetOf(files, dir);
        if (linked !== undefined) {
          if (!linked.reachable) {
            throw new InitOptionsError(
              `fatal: the repository '${linked.path}' the gitfile '${dir}' names lies outside the storage`,
            );
          }
          dir = (await commonDirectoryOf(files, linked.path)) ?? linked.path;
        }
      }
      // a relative path stays relative (gitfile targets come back rooted)
      resultGitDir = gitDir.startsWith("/") ? dir : dir.replace(/^\/+/, "") || ".";
      // a `.git` the user linked elsewhere is followed (resolved through the FilesApi)
      const repoFiles = await resolveLinkedGitDir(files, dir);
      const isFile = async (path: string) => (await repoFiles.stats(path))?.kind === "file";
      const hasHead = await isFile(`${dir}/HEAD`);
      // A repository with a config but no HEAD (damaged or half-made) is opened, not
      // re-created: creating rewrites the config, and its remotes and settings with it.
      const hadConfig = await isFile(`${dir}/config`);
      const fresh = !hasHead && !hadConfig;
      reinitialized = hasHead;
      if (fresh) {
        objectFormat = explicitFormat ?? (await this.defaultObjectFormat(warnings));
      } else {
        // validate_hash_algorithm: an existing repository keeps its format, and refuses
        // another one asked for explicitly (git 2.5x ignores $GIT_DEFAULT_HASH there)
        objectFormat = (await readRepositoryFormat(repoFiles, dir)).objectFormat;
        if (explicitFormat && explicitFormat.name !== objectFormat.name) {
          throw new ReinitializeHashError();
        }
      }
      if (!hasHead) await chooseBranch();
      else if (this.initialBranch !== undefined) {
        warnings.push(`warning: re-init: ignored --initial-branch=${this.initialBranch}`);
      }
      // the ref storage of a repository created here (an existing one keeps its own)
      const refFormat = fresh
        ? await defaultRefFormat(this.environment, this.refFormat)
        : undefined;
      if (refFormat) warnings.push(...refFormat.warnings);

      // core.sharedRepository: --shared, else the configuration (the repository's own when it
      // exists); what init creates gets git's modes (adjust_shared_perm)
      shared = this.shared ?? (await this.configuredShared(repoFiles, dir));
      const sharedFiles = withSharedPerm(repoFiles, () => shared, dir);
      // safe_create_dir(git_dir, 0): made under the umask, adjusted below
      await repoFiles.mkdir(dir);
      // copy_templates: the template's config may set core.sharedRepository, read after it
      await this.copyTemplates(sharedFiles, dir, warnings);
      shared = this.shared ?? (await this.configuredShared(repoFiles, dir));
      if (shared) await adjustSharedPerm(repoFiles, dir, shared);

      // the config, set as create_default_files and init_db set it
      const configPath = `${dir}/config`;
      const configExisted = await isFile(configPath);
      const readText = async () =>
        configExisted || (await isFile(configPath))
          ? decodeGitPath(await readFile(repoFiles, configPath))
          : undefined;
      const fullConfig = await createWorkingCopyConfig(
        configFilesApiOf(repoFiles, { readOnly: "init reads the configuration only" }),
        dir,
        undefined,
        this.environment ? { environment: this.environment } : {},
      );
      let text = await readText();
      const set = (key: string, value: string) => {
        const result = setConfigMultivarText(text, configPath, key, value);
        if (result.text !== undefined) text = result.text;
      };
      const refStorage = fresh ? (refFormat?.format ?? "files") : undefined;
      if (fresh && objectFormat.name !== "sha1") set("extensions.objectformat", objectFormat.name);
      if (refStorage === "reftable") set("extensions.refstorage", "reftable");
      const v1 =
        (fresh && (objectFormat.name !== "sha1" || refStorage === "reftable")) ||
        (!fresh && /^\s*\[\s*extensions\s*\]/im.test(text ?? ""));
      set("core.repositoryformatversion", v1 ? "1" : "0");
      set("core.filemode", "true");
      set("core.bare", this.bare ? "true" : "false");
      // a template's (or the user's) core.logAllRefUpdates is kept
      if (!this.bare && fullConfig.get("core.logAllRefUpdates") === undefined) {
        set("core.logallrefupdates", "true");
      }
      const writeConfig = async () => {
        const bytes = encodeGitPath(text ?? "");
        // a new config is created as a tempfile (adjusted); a rewrite keeps the file's mode
        if (configExisted) await repoFiles.write(configPath, [bytes]);
        else await sharedFiles.write(configPath, [bytes]);
      };
      await writeConfig();
      if (fresh) {
        // git init's probe: a filesystem that folds case or Unicode composition
        const folding = await probeCaseFolding(repoFiles as PosixFilesApi, dir);
        if (folding.ignoreCase) set("core.ignorecase", "true");
        if (folding.precomposeUnicode) set("core.precomposeunicode", "true");
      }
      const sharedValue = sharedRepositoryConfigValue(shared);
      if (sharedValue !== undefined) {
        set("core.sharedrepository", sharedValue);
        set("receive.denyNonFastforwards", "true");
      }
      await writeConfig();

      const open = (create: boolean) =>
        createGitFilesHistoryFromFiles({
          files: sharedFiles,
          gitDir: dir,
          create,
          writeConfig: false,
          defaultBranch: initialBranch,
          ...(create ? { objectFormat } : {}),
          ...(create && refFormat ? { refFormat: refFormat.format } : {}),
          ...(this.environment ? { environment: this.environment } : {}),
        });
      history = await open(fresh);
      await history.initialize();
      // files_ref_store_create_on_disk: refs (adjusted even when it exists), refs/heads and
      // refs/tags made where missing
      if (!fresh && (await readRepositoryFormat(repoFiles, dir)).refStorage === "files") {
        await sharedFiles.mkdir(`${dir}/refs/heads`);
        await sharedFiles.mkdir(`${dir}/refs/tags`);
      }
      if (shared) await adjustSharedPerm(repoFiles, `${dir}/refs`, shared);
      // create_object_database: objects/pack and objects/info, made where missing
      await sharedFiles.mkdir(`${dir}/objects/pack`);
      await sharedFiles.mkdir(`${dir}/objects/info`);
      if (hasHead) {
        // the branch an existing repository's HEAD names (empty when detached)
        const head = await history.refs.get("HEAD");
        initialBranch =
          head && "target" in head && head.target.startsWith("refs/heads/")
            ? head.target.slice("refs/heads/".length)
            : "";
      }
      if (!hasHead && !fresh) {
        await history.refs.setSymbolic("HEAD", `refs/heads/${initialBranch}`);
      }
      // The index lives in the repository too: a reopened repository keeps what was staged
      // (its last commit's files), so the next commit does not drop them.
      if (this.stagingStore) {
        staging = this.stagingStore;
      } else if (this.bare) {
        staging = new MemoryStagingStore();
      } else {
        const fileStaging = new FileStagingStore(sharedFiles, `${dir}/index`, { objectFormat });
        // a SHA-256 repository's index is not read yet: its first use refuses
        if (objectFormat.name === "sha1") await fileStaging.read();
        staging = fileStaging;
      }
    } else {
      objectFormat = explicitFormat ?? (await this.defaultObjectFormat(warnings));
      await chooseBranch();
      shared = this.shared ?? 0;
      history = createMemoryHistory({ objectFormat });
      await history.initialize();
      // Set initial branch by creating symbolic ref for HEAD
      await history.refs.setSymbolic("HEAD", `refs/heads/${initialBranch}`);
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
          rootPath: worktreeRoot,
          blobs: history.blobs,
          trees: history.trees,
          gitDir: resultGitDir,
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
      initialBranch,
      ...(hints ? { hints } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      bare: this.bare,
      gitDir: resultGitDir,
      reinitialized,
      shared,
    };
  }

  /**
   * `core.sharedRepository` of the repository at `dir` as git reads it then (system, global,
   * the repository's file, command line); 0 when unset.
   */
  private async configuredShared(files: FilesApi, dir: string): Promise<number> {
    const config = await createWorkingCopyConfig(
      configFilesApiOf(files, { readOnly: "init reads the configuration only" }),
      dir,
      undefined,
      this.environment ? { environment: this.environment } : {},
    );
    return sharedRepositoryOf(config.get("core.sharedRepository"));
  }

  /**
   * cmd_init_db's `--separate-git-dir` and setup.c's `separate_git_dir`: a repository at
   * `link` (a `.git` directory, or the one its gitfile names; inside a linked worktree the
   * repository's common directory, its main worktree's `.git` then the link) is moved to
   * `real`, the gitfile written in its place, then its linked worktrees repaired (best
   * effort: each one that cannot be is reported in `warnings`). A move that cannot be
   * completed is rolled back, so the repository is never left without its `.git`.
   *
   * @returns the main worktree's top when `link` was a linked worktree's gitfile
   */
  private async separateGitDirectory(
    files: FilesApi,
    link: string,
    real: string,
    warnings: string[],
  ): Promise<{ worktreeTop?: string }> {
    let worktreeTop: string | undefined;
    const kind = (await files.stats(link))?.kind;
    let source: string | undefined;
    if (kind === "directory") source = link;
    else if (kind === "file") {
      const target = await gitfileTargetOf(files, link);
      if (target && !target.reachable) {
        throw new InitOptionsError(
          `fatal: the repository '${target.path}' the gitfile '${link}' names lies outside the storage`,
        );
      }
      source = target?.path;
      // inside a linked worktree the common directory moves (init-db.c: get_common_dir)
      const common = source !== undefined ? await commonDirectoryOf(files, source) : undefined;
      if (common !== undefined) {
        // guess_repository_type: a common directory not named `.git` is a bare repository
        if (!/(^|\/)\.git$/.test(normalizePath(common))) {
          throw new InitOptionsError("fatal: --separate-git-dir incompatible with bare repository");
        }
        source = common;
        link = common;
        worktreeTop = dirname(normalizePath(common)).replace(/^\/+/, "");
      }
    }
    if (source !== undefined && normalizePath(source) !== normalizePath(real)) {
      // the worktrees' relative links resolve from where the repository was
      const oldHost = await this.hostPath(files, source);
      if (!(await files.move(source, real))) {
        throw new InitOptionsError(`fatal: unable to move ${source} to ${real}`);
      }
      try {
        await this.writeGitfile(files, link, real);
      } catch (error) {
        // never leave the repository without its `.git`: the move is undone
        await files.remove(link).catch(() => false);
        await files.move(real, source).catch(() => false);
        throw error;
      }
      await this.repairWorktreesAfterGitdirMove(files, real, oldHost, warnings);
      return worktreeTop !== undefined ? { worktreeTop } : {};
    }
    await this.writeGitfile(files, link, real);
    return worktreeTop !== undefined ? { worktreeTop } : {};
  }

  /** `write_file(git_link, "gitdir: %s", git_dir)`: the git directory's real host path. */
  private async writeGitfile(files: FilesApi, link: string, real: string): Promise<void> {
    await files.write(link, [encodeGitPath(`gitdir: ${await this.hostPath(files, real)}\n`)]);
  }

  /**
   * worktree.c's `repair_worktrees_after_gitdir_move`: each linked worktree of the repository
   * now at `gitDir` (before at host path `oldHost`) whose `.git` file still exists gets its
   * gitfile and back-pointer written anew, absolute or relative as they were. A worktree
   * outside the FilesApi is reached through `GitHostEnvironment.hostFilesOf`; one that cannot
   * be reached or written is reported in `warnings` and the others go on.
   */
  private async repairWorktreesAfterGitdirMove(
    files: FilesApi,
    gitDir: string,
    oldHost: string,
    warnings: string[],
  ): Promise<void> {
    const admin = joinPath(gitDir, "worktrees");
    if ((await files.stats(admin))?.kind !== "directory") return;
    const newHost = (await this.hostPath(files, gitDir)).replace(/\/+$/, "");
    const names: string[] = [];
    for await (const entry of files.list(admin))
      if (entry.kind === "directory") names.push(entry.name);
    for (const id of names.sort()) {
      const backPointer = joinPath(admin, id, "gitdir");
      let dotgitHost: string | undefined;
      try {
        if ((await files.stats(backPointer))?.kind !== "file") continue;
        const dotgit = decodeGitPath(await readFile(files, backPointer)).replace(
          /[ \t\n\v\f\r]+$/,
          "",
        );
        const relative = !isAbsoluteGitPath(dotgit);
        // strbuf_realpath_forgiving of the old place joined with the relative link
        dotgitHost = relative ? resolveDots(`${oldHost}/worktrees/${id}/${dotgit}`) : dotgit;
        const target = await this.reachHostPath(files, dotgitHost);
        if (!target) {
          warnings.push(`error: could not repair worktree link, not reachable here: ${dotgitHost}`);
          continue;
        }
        // file_exists: a worktree gone is left alone
        if ((await target.files.stats(target.path)) === undefined) continue;
        const adminHost = `${newHost}/worktrees/${id}`;
        const gitfile = relative ? relativePath(parentOf(dotgitHost), adminHost) : adminHost;
        const back = relative ? relativePath(adminHost, dotgitHost) : dotgitHost;
        await target.files.write(target.path, [encodeGitPath(`gitdir: ${gitfile}\n`)]);
        await files.write(backPointer, [encodeGitPath(`${back}\n`)]);
      } catch (error) {
        warnings.push(
          `error: could not repair worktree link: ${dotgitHost ?? backPointer}: ${(error as Error).message}`,
        );
      }
    }
  }

  /** A host path as a FilesApi reaches it: this one (under its root), else the host's. */
  private async reachHostPath(
    files: FilesApi,
    host: string,
  ): Promise<{ files: FilesApi; path: string } | undefined> {
    const root = hostRootOf(files);
    if (root === undefined) return { files, path: host };
    const paths = new HostPaths(root);
    if (paths.inside(host)) return { files, path: paths.filesPath(host) };
    return (await this.environment?.hostFilesOf?.(host).catch(() => undefined)) ?? undefined;
  }

  /** The host's absolute (real) path of `path` in `files`, as git's real_pathdup names it. */
  private async hostPath(files: FilesApi, path: string): Promise<string> {
    const host = hostPathOf(files, normalizePath(path));
    const realPath = this.environment?.realPath;
    if (!realPath) return host;
    const real = await realPath(host).catch(() => undefined);
    if (real !== undefined) return real;
    const slash = host.lastIndexOf("/");
    const parent =
      slash > 0 ? await realPath(host.slice(0, slash)).catch(() => undefined) : undefined;
    return parent !== undefined ? `${parent.replace(/\/+$/, "")}${host.slice(slash)}` : host;
  }

  /**
   * setup.c's `copy_templates`: the template directory (option, `$GIT_TEMPLATE_DIR`,
   * `init.templateDir`) copied into `dir`, unless its config is of a repository version
   * git does not know.
   */
  private async copyTemplates(target: FilesApi, dir: string, warnings: string[]): Promise<void> {
    const source = await this.templateSource();
    if (!source) return;
    const { files, path, display } = source;
    if ((await files.stats(path).catch(() => undefined))?.kind !== "directory") {
      warnings.push(`warning: templates not found in ${display}`);
      return;
    }
    // "make sure that template is from the correct vintage"
    const configPath = joinPath(path, "config");
    if ((await files.stats(configPath))?.kind === "file") {
      const text = decodeGitPath(await readFile(files, configPath));
      const version = templateRepositoryVersion(text);
      if (version !== undefined && version > 1) {
        warnings.push(
          `warning: not copying templates from '${display}': Expected git repo version <= 1, found ${version}`,
        );
        return;
      }
    }
    await copyTemplateDirectory(files, path, target, dir);
  }

  /** The templates to copy, as `get_template_dir` finds them; undefined for none. */
  private async templateSource(): Promise<
    { files: FilesApi; path: string; display: string } | undefined
  > {
    if (this.template !== undefined) {
      if (this.template.path === "") return undefined;
      const files = this.template.files ?? this.files;
      if (!files) return undefined;
      // git names it absolute (absolute_pathdup)
      const display = hostPathOf(files, normalizePath(this.template.path));
      return { files, path: this.template.path, display };
    }
    const environment = this.environment;
    let hostDir = environment?.templateDir;
    if (hostDir === undefined) {
      const configured = (await readProtectedConfig(environment))
        .filter((e) => e.key.toLowerCase() === "init.templatedir")
        .at(-1);
      if (configured?.value !== undefined)
        hostDir = await expandConfigPath(configured.value, environment);
    }
    if (!hostDir || !environment?.hostFilesOf) return undefined;
    const host = await environment.hostFilesOf(hostDir.replace(/\/+$/, "")).catch(() => undefined);
    if (!host) return undefined;
    return { files: host.files, path: host.path, display: hostDir };
  }

  /**
   * The format of a new repository without `--object-format` (validate_hash_algorithm):
   * `$GIT_DEFAULT_HASH` (an unknown name dies), else `init.defaultObjectFormat` (git 2.45+;
   * an unknown name warns and is ignored), else SHA-1.
   */
  private async defaultObjectFormat(warnings: string[]): Promise<ObjectFormat> {
    const env = this.environment?.defaultHash;
    if (env !== undefined) return knownHashAlgorithm(env);
    const config = await readProtectedConfig(this.environment);
    const configured = config
      .filter((e) => e.key.toLowerCase() === "init.defaultobjectformat")
      .at(-1);
    if (configured?.value !== undefined) {
      const found = objectFormatByName(configured.value);
      if (found) return found;
      warnings.push(`warning: unknown hash algorithm '${configured.value}'`);
    }
    return SHA1_OBJECT_FORMAT;
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

/** `--object-format` or `$GIT_DEFAULT_HASH` names no format git knows: git dies (exit 128). */
export class UnknownHashAlgorithmError extends Error {
  override name = "UnknownHashAlgorithmError";
  readonly lines: string[];
  constructor(readonly value: string) {
    const line = `fatal: unknown hash algorithm '${value}'`;
    super(line);
    this.lines = [line];
  }
}

/** `--object-format` names another format than the existing repository's: git dies (exit 128). */
export class ReinitializeHashError extends Error {
  override name = "ReinitializeHashError";
  readonly lines = ["fatal: attempt to reinitialize repository with different hash"];
  constructor() {
    super("fatal: attempt to reinitialize repository with different hash");
  }
}

/** The format named `name`, or `UnknownHashAlgorithmError` (git's `hash_algo_by_name`). */
function knownHashAlgorithm(name: string): ObjectFormat {
  const found = objectFormatByName(name);
  if (!found) throw new UnknownHashAlgorithmError(name);
  return found;
}

/** Options `git init` refuses together, or a step of `--separate-git-dir` that failed: git dies. */
export class InitOptionsError extends Error {
  override name = "InitOptionsError";
  readonly lines: string[];
  constructor(line: string) {
    super(line);
    this.lines = [line];
  }
}

/**
 * The git directory the gitfile at `path` names, as a path of `files` (an absolute target
 * mapped through the FilesApi's `rootDirectory`, a relative one from the gitfile's
 * directory), and whether the FilesApi reaches it; undefined when `path` is no gitfile.
 */
async function gitfileTargetOf(
  files: FilesApi,
  path: string,
): Promise<{ path: string; reachable: boolean } | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const target = parseGitfile(decodeGitPath(await readFile(files, path)));
  if (target === undefined) return undefined;
  if (isAbsoluteGitPath(target)) {
    const root = hostRootOf(files);
    if (root === undefined) return { path: target, reachable: true };
    const paths = new HostPaths(root);
    return { path: paths.filesPath(target), reachable: paths.inside(target) };
  }
  const resolved = resolveDots(joinPath(dirname(path), target));
  return { path: resolved, reachable: !resolved.startsWith("/..") };
}

/**
 * The common directory a linked worktree's git directory names (`commondir`, relative to it
 * unless absolute), as a path of `files`; undefined when `gitDir` has none.
 */
async function commonDirectoryOf(files: FilesApi, gitDir: string): Promise<string | undefined> {
  const file = joinPath(gitDir, "commondir");
  if ((await files.stats(file))?.kind !== "file") return undefined;
  const value = decodeGitPath(await readFile(files, file)).replace(/[\r\n]+$/, "");
  if (!value) return undefined;
  if (isAbsoluteGitPath(value)) {
    const root = hostRootOf(files);
    return root === undefined ? value : new HostPaths(root).filesPath(value);
  }
  return resolveDots(joinPath(gitDir, value));
}

/** `path` with its `.` and `..` components resolved lexically (`..` above the root kept). */
function resolveDots(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (part === ".." && absolute && out.length === 0) out.push("..");
    else out.push(part);
  }
  return `${absolute ? "/" : ""}${out.join("/")}`;
}

/** The directory holding `path` (a host path or a path of a FilesApi). */
function parentOf(path: string): string {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** The relative path from directory `from` to `to` (both paths of one FilesApi). */
function relativePath(from: string, to: string): string {
  const a = normalizePath(from).split("/").filter(Boolean);
  const b = normalizePath(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** `core.repositoryformatversion` of a template's config text (read_repository_format). */
function templateRepositoryVersion(text: string): number | undefined {
  let section = "";
  let version: number | undefined;
  for (const line of text.split("\n")) {
    const header = /^\s*\[\s*([^\]\s"]+)/.exec(line);
    if (header) section = header[1].toLowerCase();
    const match = /^\s*(?:\[[^\]]*\])?\s*repositoryformatversion\s*=\s*(-?\d+)/i.exec(line);
    if (match && section === "core") version = Number(match[1]);
  }
  return version;
}

/** git_config_pathname of a value: `~/` and `~user/` expanded (no expansion: as given). */
async function expandConfigPath(
  value: string,
  environment: GitHostEnvironment | undefined,
): Promise<string> {
  if (!value.startsWith("~")) return value;
  const slash = value.indexOf("/");
  const user = value.slice(1, slash < 0 ? undefined : slash);
  const rest = slash < 0 ? "" : value.slice(slash);
  const home = user === "" ? environment?.home : await environment?.expandUserHome?.(user);
  return home === undefined ? value : `${home.replace(/\/+$/, "")}${rest}`;
}

/**
 * setup.c's `copy_templates_1`: `source`'s entries copied into `target`'s `dir` (made
 * first), names starting with `.` skipped, directories recursed into, an existing entry
 * kept, a link copied as a link, a file with any execute bit made executable (copy_file's
 * 0777), anything else left out.
 */
async function copyTemplateDirectory(
  sourceFiles: FilesApi,
  source: string,
  targetFiles: FilesApi,
  dir: string,
): Promise<void> {
  const from = sourceFiles as PosixFilesApi;
  const to = targetFiles as PosixFilesApi;
  await targetFiles.mkdir(dir);
  const names: string[] = [];
  for await (const entry of sourceFiles.list(source)) names.push(entry.name);
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const src = joinPath(source, name);
    const dst = joinPath(dir, name);
    const st = from.lstat ? await from.lstat(src) : await sourceFiles.stats(src);
    if (!st) continue;
    if (st.kind === "directory") {
      await copyTemplateDirectory(sourceFiles, src, targetFiles, dst);
      continue;
    }
    const exists = to.lstat ? await to.lstat(dst) : await targetFiles.stats(dst);
    if (exists) continue;
    if (st.kind === "symlink") {
      const link = await from.readlink?.(src);
      if (link && to.symlink) await to.symlink(link, dst);
      continue;
    }
    if (st.kind !== "file") continue;
    await targetFiles.write(dst, [await readFile(sourceFiles, src)]);
    const mode = "mode" in st ? st.mode : undefined;
    if (mode !== undefined && mode & 0o111 && to.lstat && to.chmod) {
      const made = (await to.lstat(dst))?.mode;
      if (made !== undefined) await to.chmod(dst, made | ((made & 0o444) >> 2));
    }
  }
}
