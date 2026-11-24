import type { History } from "@statewalker/vcs-core";
import type { GitTransportRegistry } from "@statewalker/vcs-transport";
import type { Checkout, WorkingCopy, Worktree, WorktreeAdmin } from "@statewalker/vcs-working-tree";

import {
  AddCommand,
  AmCommand,
  ApplyCommand,
  BackfillCommand,
  BisectCommand,
  BisectLogCommand,
  BisectNextCommand,
  BisectReplayCommand,
  BisectResetCommand,
  BisectRunCommand,
  BisectSkipCommand,
  BisectStartCommand,
  BisectStateCommand,
  BisectTermsCommand,
  BlameCommand,
  CheckoutCommand,
  CherryPickCommand,
  CleanCommand,
  CloneCommand,
  CommitCommand,
  CopyBranchCommand,
  CreateBranchCommand,
  DeleteBranchCommand,
  DeleteTagCommand,
  DescribeCommand,
  DiffCommand,
  EditBranchDescriptionCommand,
  FetchCommand,
  ForEachRefCommand,
  FormatPatchCommand,
  FsckCommand,
  GarbageCollectCommand,
  HookListCommand,
  HookRunCommand,
  InitCommand,
  InterpretTrailersCommand,
  ListBranchCommand,
  ListTagCommand,
  LogCommand,
  LsRemoteCommand,
  MergeCommand,
  MvCommand,
  NotesCommands,
  PackRefsCommand,
  PullCommand,
  PushCommand,
  ReadTreeCommand,
  RebaseCommand,
  ReflogCommand,
  RemoteAddCommand,
  RemoteGetUrlCommand,
  RemoteListCommand,
  RemoteRemoveCommand,
  RemoteRenameCommand,
  RemoteSetHeadCommand,
  RemoteSetUrlCommand,
  RenameBranchCommand,
  ResetCommand,
  RestoreCommand,
  RevertCommand,
  RevListCommand,
  RevParseCommand,
  RmCommand,
  SetUpstreamBranchCommand,
  ShowCurrentBranchCommand,
  SparseCheckoutCommand,
  StashApplyCommand,
  StashCreateCommand,
  StashDropCommand,
  StashListCommand,
  StatusCommand,
  SubmoduleDeinitCommand,
  SubmoduleForeachCommand,
  SubmoduleInitCommand,
  SubmoduleSetBranchCommand,
  SubmoduleSetUrlCommand,
  SubmoduleSummaryCommand,
  SubmoduleSyncCommand,
  SwitchCommand,
  TagCommand,
  UnsetUpstreamBranchCommand,
  VerifyPackCommand,
  WorktreeAddCommand,
  WorktreeListCommand,
  WorktreeLockCommand,
  WorktreeMoveCommand,
  WorktreePruneCommand,
  WorktreeRemoveCommand,
  WorktreeRepairCommand,
  WorktreeUnlockCommand,
} from "./commands/index.js";
import { worktreeAdminWorkingCopy } from "./commands/worktree-support.js";

/**
 * Options of {@link Git.fromWorkingCopy}.
 *
 * @example
 * ```typescript
 * const transports = createDefaultTransports();
 * transports.register(myWebSocketConnector);
 * const git = Git.fromWorkingCopy(workingCopy, { transports });
 * await git.fetch().setRemote("wss://peer.example/repo").call();
 * ```
 */
export interface GitOptions {
  /**
   * The transports the remote commands (fetch, pull, push, clone, ls-remote, remote set-head)
   * reach non-local remotes through; default `createDefaultTransports()` (smart HTTP)
   */
  transports?: GitTransportRegistry;
}

/**
 * Main entry point for high-level Git operations.
 *
 * The Git class is a facade that wraps a WorkingCopy and provides
 * factory methods for all Git commands.
 *
 * Based on JGit's Git class.
 *
 * @example
 * ```typescript
 * // Create a WorkingCopy
 * const workingCopy = await createWorkingCopy({ files, workDir: "/repo" });
 *
 * // Create Git facade
 * const git = Git.fromWorkingCopy(workingCopy);
 *
 * // Use commands
 * await git.commit().setMessage("Initial commit").call();
 * const branches = await git.branchList().call();
 *
 * // Access components for advanced usage
 * const history = git.history;
 * const checkout = git.checkout;
 *
 * // Clean up
 * git.close();
 * ```
 */
export class Git implements Disposable {
  private _workingCopy: WorkingCopy;
  private readonly transports?: GitTransportRegistry;
  private closed = false;

  private constructor(workingCopy: WorkingCopy, options: GitOptions = {}) {
    this._workingCopy = workingCopy;
    this.transports = options.transports;
  }

  /** The facade's transports on a remote command, when given (see {@link GitOptions}). */
  private withTransports<C extends { setTransports(t: GitTransportRegistry): C }>(command: C): C {
    return this.transports ? command.setTransports(this.transports) : command;
  }

  // ============ Static Factory Methods ============

  /**
   * Create a Git facade from a WorkingCopy.
   *
   * This is the recommended way to create a Git instance. The WorkingCopy
   * provides access to all components: History, Checkout, and Worktree.
   *
   * @example
   * ```typescript
   * const workingCopy = await createWorkingCopy({ files, workDir: "/repo" });
   * const git = Git.fromWorkingCopy(workingCopy);
   *
   * // Use commands
   * await git.add().addFilepattern(".").call();
   * await git.commit().setMessage("Initial commit").call();
   *
   * // Access components
   * const history = git.history;
   * const checkout = git.checkout;
   * ```
   *
   * @param workingCopy The WorkingCopy to wrap
   * @param options The transports remote commands use ({@link GitOptions})
   * @returns A Git instance wrapping the working copy
   */
  static fromWorkingCopy(workingCopy: WorkingCopy, options: GitOptions = {}): Git {
    return new Git(workingCopy, options);
  }

  /**
   * A Git facade for `git worktree` from a repository that may be bare: the `worktree*()`
   * commands (add, list, prune, lock, unlock, remove, move, repair) work as native git runs
   * them inside a bare repository; commands that need a working tree refuse with `this
   * operation must be run in a work tree`.
   *
   * @example
   * ```typescript
   * const worktrees = await openGitLinkedWorktrees({ files, gitDir: "bare.git", history });
   * const git = Git.fromWorktreeAdmin(await worktrees.openAdmin());
   * await git.worktreeAdd().setPath("../wt").setNewBranch("topic").call();
   * console.log((await git.worktreeList().call()).output); // "<path>  (bare)" first
   * ```
   */
  static fromWorktreeAdmin(admin: WorktreeAdmin): Git {
    return new Git(worktreeAdminWorkingCopy(admin));
  }

  /**
   * Create an InitCommand for initializing a new Git repository.
   *
   * This static factory method provides convenient access to repository
   * initialization without needing to import InitCommand directly.
   *
   * @example
   * ```typescript
   * // Initialize in-memory repository
   * const result = await Git.init().call();
   * const git = result.git;
   *
   * // Initialize file-based repository with worktree support
   * const result = await Git.init()
   *   .setFilesApi(files)
   *   .setWorktree(true)
   *   .call();
   *
   * // Now git.add() works
   * await result.git.add().addFilepattern(".").call();
   *
   * // Initialize with custom staging for native git compatibility
   * import { FileStagingStore } from "@statewalker/vcs-store-files";
   * const staging = new FileStagingStore(files, ".git/index");
   *
   * const result = await Git.init()
   *   .setFilesApi(files)
   *   .setStagingStore(staging)
   *   .setWorktree(true)
   *   .call();
   * ```
   *
   * @returns A new InitCommand instance
   */
  static init(): InitCommand {
    return new InitCommand();
  }

  // ============ Add Operations ============

  /**
   * Create an AddCommand for staging files from working tree.
   *
   * Requires a WorkingCopy with worktree interface.
   *
   * @example
   * ```typescript
   * // Add specific files
   * await git.add()
   *   .addFilepattern("src/")
   *   .addFilepattern("lib/")
   *   .call();
   *
   * // Update only tracked files (git add -u)
   * await git.add()
   *   .addFilepattern(".")
   *   .setUpdate(true)
   *   .call();
   * ```
   */
  add(): AddCommand {
    this.checkClosed();
    return new AddCommand(this._workingCopy);
  }

  // ============ Blame Operations ============

  /**
   * Create a BlameCommand for annotating file lines with authorship.
   *
   * @example
   * ```typescript
   * const result = await git.blame()
   *   .setFilePath("src/main.ts")
   *   .call();
   *
   * for (const entry of result.entries) {
   *   console.log(`${entry.commit.author.name}: lines ${entry.resultStart}-${entry.resultStart + entry.lineCount - 1}`);
   * }
   * ```
   */
  blame(): BlameCommand {
    this.checkClosed();
    return new BlameCommand(this._workingCopy);
  }

  // ============ Checkout Operations ============

  /**
   * Create a CheckoutCommand for switching branches or restoring files.
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
   * // Checkout paths from commit
   * await git.checkout()
   *   .setStartPoint("HEAD~1")
   *   .addPath("file.txt")
   *   .call();
   * ```
   */
  checkout(): CheckoutCommand {
    this.checkClosed();
    return new CheckoutCommand(this._workingCopy);
  }

  /**
   * Create a SwitchCommand (`git switch`): switch to a branch, create one (`-c`/`-C`),
   * detach HEAD (`--detach`), or start an orphan branch (`--orphan`).
   *
   * @example
   * ```typescript
   * await git.switch().setName("feature").call();
   * await git.switch().setCreateBranch("topic").setName("origin/topic").call();
   * await git.switch().setName("-").call();
   * ```
   */
  switch(): SwitchCommand {
    this.checkClosed();
    return new SwitchCommand(this._workingCopy);
  }

  // ============ Commit Operations ============

  /**
   * Create a CommitCommand for creating commits.
   *
   * @example
   * ```typescript
   * await git.commit()
   *   .setMessage("Add feature")
   *   .setAuthor("John", "john@example.com")
   *   .call();
   * ```
   */
  commit(): CommitCommand {
    this.checkClosed();
    return new CommitCommand(this._workingCopy);
  }

  // ============ Log Operations ============

  /**
   * Create a LogCommand for viewing commit history.
   *
   * @example
   * ```typescript
   * for await (const commit of await git.log().call()) {
   *   console.log(commit.message);
   * }
   * ```
   */
  log(): LogCommand {
    this.checkClosed();
    return new LogCommand(this._workingCopy);
  }

  /**
   * Create a ReflogCommand for viewing reflog entries.
   *
   * @example
   * ```typescript
   * // Get HEAD reflog
   * const entries = await git.reflog().call();
   *
   * // Get reflog for specific branch
   * const branchEntries = await git.reflog()
   *   .setRef("refs/heads/main")
   *   .call();
   * ```
   */
  reflog(): ReflogCommand {
    this.checkClosed();
    return new ReflogCommand(this._workingCopy);
  }

  // ============ Branch Operations ============

  /**
   * Create a CreateBranchCommand for creating branches.
   *
   * @example
   * ```typescript
   * await git.branchCreate().setName("feature").call();
   * ```
   */
  branchCreate(): CreateBranchCommand {
    this.checkClosed();
    return new CreateBranchCommand(this._workingCopy);
  }

  /**
   * Create a DeleteBranchCommand for deleting branches.
   *
   * @example
   * ```typescript
   * await git.branchDelete().setBranchNames("feature").call();
   * ```
   */
  branchDelete(): DeleteBranchCommand {
    this.checkClosed();
    return new DeleteBranchCommand(this._workingCopy);
  }

  /**
   * Create a ListBranchCommand for listing branches.
   *
   * @example
   * ```typescript
   * const branches = await git.branchList().call();
   * ```
   */
  branchList(): ListBranchCommand {
    this.checkClosed();
    return new ListBranchCommand(this._workingCopy);
  }

  /**
   * Create a RenameBranchCommand for renaming branches.
   *
   * @example
   * ```typescript
   * await git.branchRename()
   *   .setOldName("old")
   *   .setNewName("new")
   *   .call();
   * ```
   */
  branchRename(): RenameBranchCommand {
    this.checkClosed();
    return new RenameBranchCommand(this._workingCopy);
  }

  /**
   * Create a CopyBranchCommand (`git branch -c` / `-C`): a copy of a branch with its
   * reflog and its `branch.<name>.*` configuration.
   *
   * @example
   * ```typescript
   * await git.branchCopy().setOldName("feature").setNewName("feature2").call();
   * ```
   */
  branchCopy(): CopyBranchCommand {
    this.checkClosed();
    return new CopyBranchCommand(this._workingCopy);
  }

  /**
   * Create a SetUpstreamBranchCommand (`git branch --set-upstream-to`).
   *
   * @example
   * ```typescript
   * await git.branchSetUpstream().setUpstream("origin/main").call();
   * ```
   */
  branchSetUpstream(): SetUpstreamBranchCommand {
    this.checkClosed();
    return new SetUpstreamBranchCommand(this._workingCopy);
  }

  /**
   * Create an UnsetUpstreamBranchCommand (`git branch --unset-upstream`).
   *
   * @example
   * ```typescript
   * await git.branchUnsetUpstream().setBranch("topic").call();
   * ```
   */
  branchUnsetUpstream(): UnsetUpstreamBranchCommand {
    this.checkClosed();
    return new UnsetUpstreamBranchCommand(this._workingCopy);
  }

  /**
   * Create a ShowCurrentBranchCommand (`git branch --show-current`).
   *
   * @example
   * ```typescript
   * const name = await git.branchShowCurrent().call(); // undefined when detached
   * ```
   */
  branchShowCurrent(): ShowCurrentBranchCommand {
    this.checkClosed();
    return new ShowCurrentBranchCommand(this._workingCopy);
  }

  /**
   * Create an EditBranchDescriptionCommand (`git branch --edit-description`).
   *
   * @example
   * ```typescript
   * await git.branchEditDescription().setEditor(async () => "Parser work\n").call();
   * ```
   */
  branchEditDescription(): EditBranchDescriptionCommand {
    this.checkClosed();
    return new EditBranchDescriptionCommand(this._workingCopy);
  }

  // ============ Notes Operations ============

  /**
   * The `git notes` subcommands (list, add, append, edit, copy, show, remove, prune,
   * get-ref, merge), on `ref` when given (`git notes --ref=<ref>`).
   *
   * @example
   * ```typescript
   * await git.notes().add().addMessage("Reviewed").call();
   * const { output } = await git.notes("review").show().setObject("HEAD~1").call();
   * ```
   */
  notes(ref?: string): NotesCommands {
    this.checkClosed();
    return new NotesCommands(this._workingCopy, ref);
  }

  // ============ Tag Operations ============

  /**
   * Create a TagCommand for creating tags.
   *
   * @example
   * ```typescript
   * await git.tag().setName("v1.0.0").call();
   * ```
   */
  tag(): TagCommand {
    this.checkClosed();
    return new TagCommand(this._workingCopy);
  }

  /**
   * Create a DeleteTagCommand for deleting tags.
   *
   * @example
   * ```typescript
   * await git.tagDelete().setTags("v1.0.0").call();
   * ```
   */
  tagDelete(): DeleteTagCommand {
    this.checkClosed();
    return new DeleteTagCommand(this._workingCopy);
  }

  /**
   * Create a ListTagCommand for listing tags.
   *
   * @example
   * ```typescript
   * const tags = await git.tagList().call();
   * ```
   */
  tagList(): ListTagCommand {
    this.checkClosed();
    return new ListTagCommand(this._workingCopy);
  }

  // ============ Reset Operations ============

  /**
   * Create a ResetCommand for resetting HEAD.
   *
   * @example
   * ```typescript
   * await git.reset().setRef("HEAD~1").call();
   * ```
   */
  reset(): ResetCommand {
    this.checkClosed();
    return new ResetCommand(this._workingCopy);
  }

  /**
   * Create a RestoreCommand (`git restore`): restore worktree files or index entries a
   * pathspec names, from the index or a tree-ish.
   *
   * @example
   * ```typescript
   * await git.restore().setStaged(true).addPath("src/*.ts").call();
   * ```
   */
  restore(): RestoreCommand {
    this.checkClosed();
    return new RestoreCommand(this._workingCopy);
  }

  // ============ Merge Operations ============

  /**
   * Create a MergeCommand for merging branches.
   *
   * @example
   * ```typescript
   * await git.merge().include("feature").call();
   * ```
   */
  merge(): MergeCommand {
    this.checkClosed();
    return new MergeCommand(this._workingCopy);
  }

  // ============ Cherry-pick Operations ============

  /**
   * Create a CherryPickCommand for cherry-picking commits.
   *
   * @example
   * ```typescript
   * await git.cherryPick().include(commitId).call();
   * ```
   */
  cherryPick(): CherryPickCommand {
    this.checkClosed();
    return new CherryPickCommand(this._workingCopy);
  }

  // ============ Revert Operations ============

  /**
   * Create a RevertCommand for reverting commits.
   *
   * @example
   * ```typescript
   * await git.revert().include(commitId).call();
   * ```
   */
  revert(): RevertCommand {
    this.checkClosed();
    return new RevertCommand(this._workingCopy);
  }

  // ============ Mv Operations ============

  /**
   * Create an MvCommand for moving or renaming files, directories and submodules.
   *
   * @example
   * ```typescript
   * await git.mv().addSource("old.txt").setDestination("new.txt").call();
   * ```
   */
  mv(): MvCommand {
    this.checkClosed();
    return new MvCommand(this._workingCopy);
  }

  /**
   * Create a ReadTreeCommand for reading trees into the index (`git read-tree`).
   *
   * @example
   * ```typescript
   * await git.readTree().addTree("HEAD").setMerge(true).setUpdate(true).call();
   * ```
   */
  readTree(): ReadTreeCommand {
    this.checkClosed();
    return new ReadTreeCommand(this._workingCopy);
  }

  // ============ Rm Operations ============

  /**
   * Create an RmCommand for removing files from the index.
   *
   * @example
   * ```typescript
   * // Remove file from index (and working tree if not cached)
   * await git.rm()
   *   .addFilepattern("file.txt")
   *   .call();
   *
   * // Remove from index only (keep in working tree)
   * await git.rm()
   *   .addFilepattern("file.txt")
   *   .setCached(true)
   *   .call();
   * ```
   */
  rm(): RmCommand {
    this.checkClosed();
    return new RmCommand(this._workingCopy);
  }

  // ============ Revision Operations ============

  /**
   * Create a RevParseCommand (`git rev-parse --verify <rev>`): the object a revision names.
   *
   * @example
   * ```typescript
   * const { objectId } = await git.revParse().setRevision("@{u}").call();
   * const { objectId: blob } = await git.revParse().setRevision("HEAD:README.md").call();
   * ```
   */
  revParse(): RevParseCommand {
    this.checkClosed();
    return new RevParseCommand(this._workingCopy);
  }

  /**
   * Create a RevListCommand (`git log` / `git rev-list <revisions>`): commits of ranges and
   * revision sets (`a..b`, `a...b`, `^a`, `x^@`, `x^!`, `x^-<n>`, `--not`).
   *
   * @example
   * ```typescript
   * for await (const c of await git.revList().addRevision("main..feat").call()) console.log(c.id);
   * ```
   */
  revList(): RevListCommand {
    this.checkClosed();
    return new RevListCommand(this._workingCopy);
  }

  // ============ Ref listing ============

  /**
   * Create a ForEachRefCommand: git's `for-each-ref`, the refs filtered, sorted and
   * formatted by git's ref-filter.
   *
   * @example
   * ```typescript
   * const { output } = await git
   *   .forEachRef()
   *   .setFormat("%(refname:short) %(objectname:short)")
   *   .setSort("-creatordate")
   *   .setPatterns("refs/tags/")
   *   .call();
   * ```
   */
  forEachRef(): ForEachRefCommand {
    this.checkClosed();
    return new ForEachRefCommand(this._workingCopy);
  }

  // ============ Describe Operations ============

  /**
   * Create a DescribeCommand for describing commits with tags.
   *
   * @example
   * ```typescript
   * // Describe HEAD
   * const result = await git.describe().call();
   * console.log(result.description); // e.g., "v1.0.0-5-gabcdef0"
   *
   * // Describe with all tags including lightweight
   * const result = await git.describe().setTags(true).call();
   *
   * // Always output something
   * const result = await git.describe().setAlways(true).call();
   * ```
   */
  describe(): DescribeCommand {
    this.checkClosed();
    return new DescribeCommand(this._workingCopy);
  }

  // ============ Maintenance Operations ============

  /**
   * Create a GarbageCollectCommand for repository maintenance.
   *
   * @example
   * ```typescript
   * // Basic garbage collection
   * const result = await git.gc().call();
   *
   * // Aggressive GC with repacking
   * const result = await git.gc()
   *   .setAggressive(true)
   *   .call();
   * ```
   */
  gc(): GarbageCollectCommand {
    this.checkClosed();
    return new GarbageCollectCommand(this._workingCopy);
  }

  /**
   * Create an FsckCommand that verifies the connectivity and validity of the objects
   * (`git fsck`).
   *
   * @example
   * ```typescript
   * const result = await git.fsck().setRepositoryFiles({ files }).call();
   * if (result.exitCode !== 0) console.error(result.errorOutput);
   * ```
   */
  fsck(): FsckCommand {
    this.checkClosed();
    return new FsckCommand(this._workingCopy);
  }

  /**
   * Create a VerifyPackCommand that verifies pack files (`git verify-pack`).
   *
   * @example
   * ```typescript
   * const result = await git.verifyPack()
   *   .setRepositoryFiles({ files })
   *   .addPack(".git/objects/pack/pack-1234.idx")
   *   .setVerbose(true)
   *   .call();
   * ```
   */
  verifyPack(): VerifyPackCommand {
    this.checkClosed();
    return new VerifyPackCommand(this._workingCopy);
  }

  /**
   * Create an InterpretTrailersCommand that adds or parses the trailers of a message
   * (`git interpret-trailers`), with the `trailer.*` configuration.
   *
   * @example
   * ```typescript
   * const { stdout } = await git.interpretTrailers().setInput("Fix\n").addTrailer("Acked-by: A").call();
   * // "Fix\n\nAcked-by: A\n"
   * ```
   */
  interpretTrailers(): InterpretTrailersCommand {
    this.checkClosed();
    return new InterpretTrailersCommand(this._workingCopy);
  }

  /**
   * Create a HookRunCommand that runs a hook (`git hook run <hook-name>`): the configured
   * hooks (git 2.5x) and the hooks directory's script, through the host's hook runner.
   *
   * @example
   * ```typescript
   * const { exitCode, output } = await git.hookRun("pre-commit").setIgnoreMissing(true).call();
   * ```
   */
  hookRun(name?: string): HookRunCommand {
    this.checkClosed();
    const command = new HookRunCommand(this._workingCopy);
    return name === undefined ? command : command.setHookName(name);
  }

  /**
   * Create a HookListCommand that lists the hooks of an event (git 2.5x `git hook list`).
   *
   * @example
   * ```typescript
   * const { stdout } = await git.hookList("pre-commit").call(); // "lint\nhook from hookdir\n"
   * ```
   */
  hookList(name?: string): HookListCommand {
    this.checkClosed();
    const command = new HookListCommand(this._workingCopy);
    return name === undefined ? command : command.setHookName(name);
  }

  /**
   * Create a PackRefsCommand for packing loose refs.
   *
   * @example
   * ```typescript
   * // Pack all refs
   * const result = await git.packRefs()
   *   .setAll(true)
   *   .call();
   * ```
   */
  packRefs(): PackRefsCommand {
    this.checkClosed();
    return new PackRefsCommand(this._workingCopy);
  }

  /**
   * Create a CleanCommand for removing untracked files.
   *
   * @example
   * ```typescript
   * // Preview what would be cleaned (dry run)
   * const result = await git.clean()
   *   .setDryRun(true)
   *   .call();
   * ```
   */
  clean(): CleanCommand {
    this.checkClosed();
    return new CleanCommand(this._workingCopy);
  }

  // ============ Status Operations ============

  /**
   * Create a StatusCommand for showing the index and worktree status.
   *
   * @example
   * ```typescript
   * const status = await git.status().call();
   * if (status.isClean()) {
   *   console.log("Nothing to commit");
   * }
   * ```
   */
  status(): StatusCommand {
    this.checkClosed();
    return new StatusCommand(this._workingCopy);
  }

  /**
   * Create a SubmoduleSummaryCommand: the commits of changed submodules, as
   * `git submodule summary`.
   *
   * @example
   * ```typescript
   * const text = await git.submoduleSummary().setCached(true).call();
   * ```
   */
  submoduleSummary(): SubmoduleSummaryCommand {
    this.checkClosed();
    return new SubmoduleSummaryCommand(this._workingCopy);
  }

  /**
   * `git submodule init`: register the submodules of `.gitmodules` in `.git/config`.
   *
   * @example
   * ```typescript
   * const { stderr } = await git.submoduleInit().call();
   * ```
   */
  submoduleInit(): SubmoduleInitCommand {
    this.checkClosed();
    return new SubmoduleInitCommand(this._workingCopy);
  }

  /**
   * `git submodule deinit`: empty submodules' worktrees and unregister them.
   *
   * @example
   * ```typescript
   * await git.submoduleDeinit().addPath("lib").setForce(true).call();
   * ```
   */
  submoduleDeinit(): SubmoduleDeinitCommand {
    this.checkClosed();
    return new SubmoduleDeinitCommand(this._workingCopy);
  }

  /**
   * `git submodule sync`: register submodules' URLs again from `.gitmodules`.
   *
   * @example
   * ```typescript
   * await git.submoduleSync().setRecursive(true).call();
   * ```
   */
  submoduleSync(): SubmoduleSyncCommand {
    this.checkClosed();
    return new SubmoduleSyncCommand(this._workingCopy);
  }

  /**
   * `git submodule set-url <path> <newurl>`.
   *
   * @example
   * ```typescript
   * await git.submoduleSetUrl().setPath("lib").setUrl("../lib2").call();
   * ```
   */
  submoduleSetUrl(): SubmoduleSetUrlCommand {
    this.checkClosed();
    return new SubmoduleSetUrlCommand(this._workingCopy);
  }

  /**
   * `git submodule set-branch (-b <branch> | -d) <path>`.
   *
   * @example
   * ```typescript
   * await git.submoduleSetBranch().setPath("lib").setBranch("stable").call();
   * ```
   */
  submoduleSetBranch(): SubmoduleSetBranchCommand {
    this.checkClosed();
    return new SubmoduleSetBranchCommand(this._workingCopy);
  }

  /**
   * `git submodule foreach`: a command (or callback) in each populated submodule.
   *
   * @example
   * ```typescript
   * await git.submoduleForeach().setCommand(["git status --short"]).call();
   * ```
   */
  submoduleForeach(): SubmoduleForeachCommand {
    this.checkClosed();
    return new SubmoduleForeachCommand(this._workingCopy);
  }

  // ============ Diff Operations ============

  /**
   * Create a DiffCommand for comparing trees/commits.
   *
   * @example
   * ```typescript
   * const entries = await git.diff()
   *   .setOldTree("main")
   *   .setNewTree("feature")
   *   .call();
   * ```
   */
  diff(): DiffCommand {
    this.checkClosed();
    return new DiffCommand(this._workingCopy);
  }

  // ============ Patch Operations ============

  /**
   * `git apply`: applies patches to the worktree and/or the index.
   *
   * @example
   * ```typescript
   * const { exitCode, errors } = await git.apply().addPatch(patchBytes).setIndex(true).call();
   * ```
   */
  apply(): ApplyCommand {
    this.checkClosed();
    return new ApplyCommand(this._workingCopy);
  }

  /**
   * `git format-patch`: commits as emails.
   *
   * @example
   * ```typescript
   * const { patches } = await git.formatPatch().addRevision("main..topic").call();
   * ```
   */
  /**
   * `git am`: applies patches from mailboxes, one commit per mail.
   *
   * @example
   * ```typescript
   * await git.am().addMbox(mbox).call();
   * ```
   */
  am(): AmCommand {
    this.checkClosed();
    return new AmCommand(this._workingCopy);
  }

  formatPatch(): FormatPatchCommand {
    this.checkClosed();
    return new FormatPatchCommand(this._workingCopy);
  }

  // ============ Remote Operations ============

  /**
   * Create a FetchCommand for fetching from remotes.
   *
   * @example
   * ```typescript
   * await git.fetch()
   *   .setRemote("origin")
   *   .call();
   * ```
   */
  fetch(): FetchCommand {
    this.checkClosed();
    return this.withTransports(new FetchCommand(this._workingCopy));
  }

  /**
   * Create a PushCommand for pushing to remotes.
   *
   * @example
   * ```typescript
   * await git.push()
   *   .setRemote("origin")
   *   .call();
   * ```
   */
  push(): PushCommand {
    this.checkClosed();
    return this.withTransports(new PushCommand(this._workingCopy));
  }

  /**
   * Create a PullCommand for pulling from remotes.
   *
   * @example
   * ```typescript
   * await git.pull()
   *   .setRemote("origin")
   *   .call();
   * ```
   */
  pull(): PullCommand {
    this.checkClosed();
    return this.withTransports(new PullCommand(this._workingCopy));
  }

  /**
   * Create a CloneCommand for cloning repositories.
   *
   * @example
   * ```typescript
   * await git.clone()
   *   .setURI("https://github.com/user/repo")
   *   .call();
   * ```
   */
  clone(): CloneCommand {
    this.checkClosed();
    // a clone that switches the repository to the remote's object format reopens it: this
    // facade then works on the reopened working copy
    return this.withTransports(
      new CloneCommand(this._workingCopy).onWorkingCopyReopened((workingCopy) => {
        this._workingCopy = workingCopy;
      }),
    );
  }

  /**
   * Create an LsRemoteCommand for listing remote refs.
   *
   * @example
   * ```typescript
   * const refs = await git.lsRemote()
   *   .setRemote("https://github.com/user/repo")
   *   .call();
   * ```
   */
  lsRemote(): LsRemoteCommand {
    this.checkClosed();
    return this.withTransports(new LsRemoteCommand(this._workingCopy));
  }

  // ============ Remote Configuration Operations ============

  /**
   * Create a RemoteAddCommand for adding remotes.
   *
   * @example
   * ```typescript
   * await git.remoteAdd()
   *   .setName("upstream")
   *   .setUri("https://github.com/user/repo")
   *   .call();
   * ```
   */
  remoteAdd(): RemoteAddCommand {
    this.checkClosed();
    return this.withTransports(new RemoteAddCommand(this._workingCopy));
  }

  /**
   * Create a RemoteRemoveCommand for removing remotes.
   *
   * @example
   * ```typescript
   * await git.remoteRemove()
   *   .setRemoteName("upstream")
   *   .call();
   * ```
   */
  remoteRemove(): RemoteRemoveCommand {
    this.checkClosed();
    return new RemoteRemoveCommand(this._workingCopy);
  }

  /**
   * Create a RemoteListCommand for listing remotes.
   *
   * @example
   * ```typescript
   * const remotes = await git.remoteList().call();
   * ```
   */
  remoteList(): RemoteListCommand {
    this.checkClosed();
    return new RemoteListCommand(this._workingCopy);
  }

  /**
   * Create a RemoteGetUrlCommand for reading a remote's URLs (`git remote get-url`).
   *
   * @example
   * ```typescript
   * const [pushUrl] = await git.remoteGetUrl().setRemoteName("origin").setPush(true).call();
   * ```
   */
  remoteGetUrl(): RemoteGetUrlCommand {
    this.checkClosed();
    return new RemoteGetUrlCommand(this._workingCopy);
  }

  /**
   * Create a RemoteSetUrlCommand for changing remote URLs.
   *
   * @example
   * ```typescript
   * await git.remoteSetUrl()
   *   .setRemoteName("origin")
   *   .setRemoteUri("https://github.com/user/repo")
   *   .call();
   * ```
   */
  remoteSetUrl(): RemoteSetUrlCommand {
    this.checkClosed();
    return new RemoteSetUrlCommand(this._workingCopy);
  }

  /**
   * Create a RemoteSetHeadCommand for setting or deleting `refs/remotes/<name>/HEAD`.
   *
   * @example
   * ```typescript
   * await git.remoteSetHead().setRemoteName("origin").setBranch("develop").call();
   * ```
   */
  remoteSetHead(): RemoteSetHeadCommand {
    this.checkClosed();
    return this.withTransports(new RemoteSetHeadCommand(this._workingCopy));
  }

  /**
   * Create a RemoteRenameCommand for renaming a remote (`git remote rename`).
   *
   * @example
   * ```typescript
   * await git.remoteRename().setOldName("origin").setNewName("upstream").call();
   * ```
   */
  remoteRename(): RemoteRenameCommand {
    this.checkClosed();
    return new RemoteRenameCommand(this._workingCopy);
  }

  // ============ Rebase Operations ============

  /**
   * Create a RebaseCommand for rebasing commits.
   *
   * @example
   * ```typescript
   * // Rebase current branch onto main
   * const result = await git.rebase()
   *   .setUpstream(mainCommitId)
   *   .call();
   *
   * // Abort rebase in progress
   * const result = await git.rebase()
   *   .setOperation(RebaseOperation.ABORT)
   *   .call();
   * ```
   */
  rebase(): RebaseCommand {
    this.checkClosed();
    return new RebaseCommand(this._workingCopy);
  }

  // ============ Sparse Checkout ============

  /**
   * `git sparse-checkout <subcommand>`: `init`, `set`, `add`, `list`, `reapply`, `disable`
   * `check-rules` and (git 2.5x) `clean`, over git's own files (`info/sparse-checkout`, `config.worktree`).
   *
   * @example
   * ```typescript
   * await git.sparseCheckout().setArguments(["set", "src", "docs"]).call();
   * const { stdout } = await git.sparseCheckout().setSubcommand("list").call();
   * ```
   */
  sparseCheckout(): SparseCheckoutCommand {
    this.checkClosed();
    return new SparseCheckoutCommand(this._workingCopy);
  }

  /**
   * `git backfill` (git 2.49+): a partial clone's missing blobs fetched in batches of paths.
   *
   * @example
   * ```typescript
   * const { batches } = await git.backfill().setMinBatchSize(1000).call();
   * ```
   */
  backfill(): BackfillCommand {
    this.checkClosed();
    return new BackfillCommand(this._workingCopy);
  }

  // ============ Bisect Operations ============

  /**
   * `git bisect <args>...` as git dispatches it (`start`, `bad`, `good`, a term, `skip`,
   * `next`, `reset`, `terms`, `log`, `replay`, `run`).
   *
   * @example
   * ```typescript
   * const step = await git.bisect().setArguments(["start", "main", "v1.0"]).call();
   * ```
   */
  bisect(): BisectCommand {
    this.checkClosed();
    return new BisectCommand(this._workingCopy);
  }

  /**
   * `git bisect start`: a bisection between a bad and good revisions.
   *
   * @example
   * ```typescript
   * await git.bisectStart().setBad("main").addGood("v1.0").call();
   * ```
   */
  bisectStart(): BisectStartCommand {
    this.checkClosed();
    return new BisectStartCommand(this._workingCopy);
  }

  /**
   * `git bisect <term> [<rev>...]` (`bad`, `good`, `new`, `old` or a custom term).
   *
   * @example
   * ```typescript
   * const step = await git.bisectState("good").call(); // HEAD is good
   * ```
   */
  bisectState(term: string): BisectStateCommand {
    this.checkClosed();
    return new BisectStateCommand(this._workingCopy).setTerm(term);
  }

  /** `git bisect skip [(<rev>|<range>)...]` */
  bisectSkip(): BisectSkipCommand {
    this.checkClosed();
    return new BisectSkipCommand(this._workingCopy);
  }

  /** `git bisect next` */
  bisectNext(): BisectNextCommand {
    this.checkClosed();
    return new BisectNextCommand(this._workingCopy);
  }

  /** `git bisect reset [<commit>]` */
  bisectReset(): BisectResetCommand {
    this.checkClosed();
    return new BisectResetCommand(this._workingCopy);
  }

  /** `git bisect terms [--term-good | --term-bad]` */
  bisectTerms(): BisectTermsCommand {
    this.checkClosed();
    return new BisectTermsCommand(this._workingCopy);
  }

  /** `git bisect log` */
  bisectLog(): BisectLogCommand {
    this.checkClosed();
    return new BisectLogCommand(this._workingCopy);
  }

  /** `git bisect replay`, over a log's text */
  bisectReplay(): BisectReplayCommand {
    this.checkClosed();
    return new BisectReplayCommand(this._workingCopy);
  }

  /**
   * `git bisect run <cmd>...`, the command run through a host hook.
   *
   * @example
   * ```typescript
   * await git.bisectRun().setCommand(["make", "test"]).setRunHandler(async () => 0).call();
   * ```
   */
  bisectRun(): BisectRunCommand {
    this.checkClosed();
    return new BisectRunCommand(this._workingCopy);
  }

  // ============ Stash Operations ============

  /**
   * Create a StashCreateCommand for stashing changes.
   *
   * Despite its name this is `git stash push`: the stash is stored in `refs/stash` and the
   * index and the worktree are reset to HEAD. git's `git stash create` (the stash commit
   * only: worktree, index and `refs/stash` untouched) is `stashCreate().setRef(null)`.
   *
   * @example
   * ```typescript
   * // git stash push -m "WIP: feature work": stashed, then reset to HEAD
   * const stashCommit = await git.stashCreate()
   *   .setMessage("WIP: feature work")
   *   .call();
   *
   * // git stash create "msg": the commit id only, nothing else changes
   * const id = await git.stashCreate().setRef(null).setMessage("msg").call();
   * ```
   */
  stashCreate(): StashCreateCommand {
    this.checkClosed();
    return new StashCreateCommand(this._workingCopy);
  }

  /**
   * Create a StashApplyCommand for applying stashed changes.
   *
   * @example
   * ```typescript
   * // Apply most recent stash
   * const result = await git.stashApply().call();
   *
   * // Apply specific stash
   * const result = await git.stashApply()
   *   .setStashRef("stash@{2}")
   *   .call();
   * ```
   */
  stashApply(): StashApplyCommand {
    this.checkClosed();
    return new StashApplyCommand(this._workingCopy);
  }

  /**
   * Create a StashDropCommand for dropping stashes.
   *
   * @example
   * ```typescript
   * // Drop most recent stash
   * await git.stashDrop().call();
   *
   * // Drop all stashes
   * await git.stashDrop().setAll(true).call();
   * ```
   */
  stashDrop(): StashDropCommand {
    this.checkClosed();
    return new StashDropCommand(this._workingCopy);
  }

  /**
   * Create a StashListCommand for listing stashes.
   *
   * @example
   * ```typescript
   * const stashes = await git.stashList().call();
   * for (const stash of stashes) {
   *   console.log(`stash@{${stash.index}}: ${stash.message}`);
   * }
   * ```
   */
  stashList(): StashListCommand {
    this.checkClosed();
    return new StashListCommand(this._workingCopy);
  }

  // ============ Component Access ============

  /**
   * Get the underlying WorkingCopy.
   *
   * @example
   * ```typescript
   * const git = Git.fromWorkingCopy(workingCopy);
   * const wc = git.workingCopy;
   *
   * // Access full WorkingCopy API
   * const status = await wc.getStatus();
   * const branch = await wc.getCurrentBranch();
   * ```
   */
  get workingCopy(): WorkingCopy {
    return this._workingCopy;
  }

  /**
   * Get the History interface for accessing repository objects.
   *
   * Provides access to blobs, trees, commits, tags, and refs.
   * Returns undefined if WorkingCopy doesn't have history.
   *
   * @example
   * ```typescript
   * const history = git.history;
   * if (history) {
   *   const commit = await history.commits.load(commitId);
   *   const tree = await history.trees.load(commit.tree);
   * }
   * ```
   */
  get history(): History | undefined {
    return this._workingCopy.history;
  }

  /**
   * Get the Checkout interface for managing local state.
   *
   * Provides access to staging area, HEAD, and in-progress operations.
   * Returns undefined if WorkingCopy doesn't have checkout.
   *
   * Note: Named `checkoutState` to avoid conflict with `checkout()` command method.
   *
   * @example
   * ```typescript
   * const checkoutState = git.checkoutState;
   * if (checkoutState) {
   *   const staging = checkoutState.staging;
   *   const head = await checkoutState.getHeadCommit();
   * }
   * ```
   */
  get checkoutState(): Checkout | undefined {
    return this._workingCopy.checkout;
  }

  /**
   * Get the Worktree interface for filesystem operations.
   *
   * Provides access to working directory read/write operations.
   * Returns undefined if WorkingCopy doesn't have worktree.
   *
   * @example
   * ```typescript
   * const worktree = git.worktree;
   * if (worktree) {
   *   for await (const entry of worktree.walk()) {
   *     console.log(entry.path);
   *   }
   * }
   * ```
   */
  get worktree(): Worktree | undefined {
    return this._workingCopy.worktree;
  }

  // ============ Lifecycle ============

  // ============ Worktrees ============

  /**
   * Add a linked worktree (`git worktree add`).
   *
   * Needs a backend that keeps linked worktrees (`WorkingCopy.worktrees`); others throw
   * `WorktreesUnsupportedError`, as every `worktree*()` command does.
   *
   * @example
   * ```typescript
   * await git.worktreeAdd().setPath("../hotfix").setNewBranch("hotfix").call();
   * ```
   */
  worktreeAdd(): WorktreeAddCommand {
    this.checkClosed();
    return new WorktreeAddCommand(this._workingCopy);
  }

  /** List the worktrees (`git worktree list`). */
  worktreeList(): WorktreeListCommand {
    this.checkClosed();
    return new WorktreeListCommand(this._workingCopy);
  }

  /** Prune the administrative files of gone worktrees (`git worktree prune`). */
  worktreePrune(): WorktreePruneCommand {
    this.checkClosed();
    return new WorktreePruneCommand(this._workingCopy);
  }

  /** Lock a linked worktree (`git worktree lock`). */
  worktreeLock(): WorktreeLockCommand {
    this.checkClosed();
    return new WorktreeLockCommand(this._workingCopy);
  }

  /** Unlock a linked worktree (`git worktree unlock`). */
  worktreeUnlock(): WorktreeUnlockCommand {
    this.checkClosed();
    return new WorktreeUnlockCommand(this._workingCopy);
  }

  /** Remove a linked worktree (`git worktree remove`). */
  worktreeRemove(): WorktreeRemoveCommand {
    this.checkClosed();
    return new WorktreeRemoveCommand(this._workingCopy);
  }

  /** Move a linked worktree (`git worktree move`). */
  worktreeMove(): WorktreeMoveCommand {
    this.checkClosed();
    return new WorktreeMoveCommand(this._workingCopy);
  }

  /** Repair the links between worktrees and the repository (`git worktree repair`). */
  worktreeRepair(): WorktreeRepairCommand {
    this.checkClosed();
    return new WorktreeRepairCommand(this._workingCopy);
  }

  /**
   * Close the Git instance.
   *
   * After calling this method, no more commands can be created.
   * This does NOT close the underlying store.
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Disposable interface implementation.
   */
  [Symbol.dispose](): void {
    this.close();
  }

  // ============ Private ============

  private checkClosed(): void {
    if (this.closed) {
      throw new Error("Git instance is closed");
    }
  }
}
