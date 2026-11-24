import {
  isSymbolicRef,
  isValidBranchName,
  type ObjectId,
  type PersonIdent,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type {
  CreatedLinkedWorktree,
  LinkedWorktrees,
  NewWorktreeHead,
  WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { WorktreeError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  ambiguousRemoteAdvice,
  installTracking,
  planTracking,
  TrackMode,
  trackableStart,
  uniqueTrackingName,
  worktreeAmbiguityHints,
} from "./branch-tracking.js";
import { abbrevLengths, coreBool, worktreeModeTrust } from "./core-config.js";
import { runPostCheckoutHook } from "./git-hooks.js";
import { checkoutFreshTree } from "./tree-restore.js";
import { worktreePathRules } from "./worktree-path-rules.js";
import {
  checkCandidatePath,
  refuseIfCheckedOut,
  requireWorktrees,
  worktreeUsingBranch,
} from "./worktree-support.js";

/** What {@link WorktreeAddCommand} did. */
export interface WorktreeAddResult {
  /** The new worktree's path, as git prints it. */
  path: string;
  /** Its administrative directory's name (`.git/worktrees/<id>`). */
  id: string;
  /** The branch HEAD points at (`refs/heads/x`); undefined for a detached HEAD. */
  branch?: string;
  /** The commit HEAD resolves to; undefined for an unborn (`--orphan`) branch. */
  head?: ObjectId;
  /** What git prints on stderr (`Preparing worktree (...)`), without `--quiet`. */
  messages: string[];
  /** The post-checkout hook's exit code when it failed (git exits with it; the worktree stays) */
  hookExitCode?: number;
  /**
   * What git prints on stdout without `--quiet`: the new branch's tracking
   * (`branch 'x' set up to track 'origin/x'.`), then the checkout's
   * `HEAD is now at <abbrev> <subject>`.
   */
  output: string[];
  /** A working copy of the new worktree. */
  workingCopy: WorkingCopy;
}

/**
 * Add a linked worktree.
 *
 * Equivalent to `git worktree add [-f] [--detach] [--no-checkout] [--lock [--reason <r>]]
 * [--orphan] [--[no-]track] [--[no-]guess-remote] [--[no-]relative-paths]
 * [(-b | -B) <new-branch>] <path> [<commit-ish>]`.
 *
 * @example
 * ```typescript
 * // a worktree on a new branch, checked out
 * await git.worktreeAdd().setPath("../hotfix").setNewBranch("hotfix").call();
 * // detached at a tag, locked
 * await git.worktreeAdd().setPath("../v1").setCommitish("v1.0").setDetach(true)
 *   .setLock(true).setLockReason("on a USB disk").call();
 * // `git worktree add ../foo foo` with only origin/foo: branch foo tracking origin/foo
 * await git.worktreeAdd().setPath("../foo").setCommitish("foo").call();
 * // relative links (git 2.48+): extensions.relativeWorktrees is set
 * await git.worktreeAdd().setPath("../rel").setRelativePaths(true).call();
 * ```
 *
 * As git's `add`: without a commit-ish the new branch is named after the path's last
 * component (an existing branch of that name is checked out instead), and a repository
 * without any commit infers `--orphan`. Refused, with git's message (`WorktreeError`): a
 * path that exists and is not an empty directory; a missing path a worktree is still
 * registered at (unless forced: once, or twice when it is locked); a branch checked out in
 * another worktree (`BranchUsedByWorktreeError`, unless forced); a commit-ish that names no
 * commit; `-b` with a branch that exists.
 *
 * Steps, as git takes them: the branch is created first (`git branch`, reflog
 * `branch: Created from <commit-ish>`) and stays if the worktree then fails; the
 * administrative directory is written locked (`initializing`, or the `--lock` reason);
 * HEAD and its reflog line; then, unless `--no-checkout`, the files and the index are
 * checked out (git runs `reset --hard`: ORIG_HEAD and, on a branch, the reflog line
 * `reset: moving to HEAD`). A failure removes what was created. The `post-checkout`
 * hook runs in the new worktree once it is checked out (`<null> <HEAD> 1`).
 *
 * Remote branches, as git's DWIM: a commit-ish that names no commit but the one
 * remote-tracking branch of that name (`unique_tracking_name`, `checkout.defaultRemote`
 * among several) creates a local branch from it; without a commit-ish,
 * {@link setGuessRemote} (`worktree.guessRemote`) does the same for the name taken from the
 * path. A new branch tracks its start as `git branch` does ({@link setTrack},
 * `branch.autoSetupMerge`). Several matches die with git's advice in 2.5x; git 2.43
 * ({@link setCompatibility}) takes them for no match.
 */
export class WorktreeAddCommand extends GitCommand<WorktreeAddResult> {
  private path?: string;
  private commitish?: string;
  private newBranch?: string;
  private forceNewBranch = false;
  private detach = false;
  private force = 0;
  private checkout = true;
  private lock = false;
  private lockReason?: string;
  private orphan = false;
  private quiet = false;
  private who?: PersonIdent;
  private track?: TrackMode;
  private guessRemote?: boolean;
  private relativePaths?: boolean;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** The new worktree's path (a path of the repository's storage, or an absolute host path). */
  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  /** What to check out (default: HEAD; with a new branch, its start). */
  setCommitish(commitish: string): this {
    this.checkCallable();
    this.commitish = commitish;
    return this;
  }

  /** `-b <branch>` (or `-B <branch>` with `force`): create the branch and check it out. */
  setNewBranch(branch: string, force = false): this {
    this.checkCallable();
    this.newBranch = branch;
    this.forceNewBranch = force;
    return this;
  }

  /** `--detach`: HEAD holds the commit, even when a branch is named. */
  setDetach(detach: boolean): this {
    this.checkCallable();
    this.detach = detach;
    return this;
  }

  /** `-f` (`true` or 1), `-f -f` (2). */
  setForce(force: boolean | number): this {
    this.checkCallable();
    this.force = typeof force === "number" ? force : force ? 1 : 0;
    return this;
  }

  /** `--[no-]checkout` (default: checked out). */
  setCheckout(checkout: boolean): this {
    this.checkCallable();
    this.checkout = checkout;
    return this;
  }

  /** `--lock`: the worktree stays locked. */
  setLock(lock: boolean): this {
    this.checkCallable();
    this.lock = lock;
    return this;
  }

  /** `--reason <text>` (requires `--lock`). */
  setLockReason(reason: string): this {
    this.checkCallable();
    this.lockReason = reason;
    return this;
  }

  /** `--orphan`: an unborn branch with an empty index. */
  setOrphan(orphan: boolean): this {
    this.checkCallable();
    this.orphan = orphan;
    return this;
  }

  /** `--quiet`: no messages. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /**
   * `--track[=inherit]` / `--no-track`: how a new branch tracks its start (git passes it to
   * its `git branch` child); without a new branch the add is refused.
   */
  setTrack(mode: TrackMode): this {
    this.checkCallable();
    this.track = mode;
    return this;
  }

  /**
   * `--[no-]guess-remote` (default `worktree.guessRemote`, false): without a commit-ish, the
   * new branch named after the path starts at the remote-tracking branch of that name.
   */
  setGuessRemote(guess: boolean): this {
    this.checkCallable();
    this.guessRemote = guess;
    return this;
  }

  /**
   * `--[no-]relative-paths` (git 2.48+, default `worktree.useRelativePaths`): the link files
   * hold relative paths and the repository gets `extensions.relativeWorktrees` (which git
   * before 2.48 refuses: only on request).
   */
  setRelativePaths(relative: boolean): this {
    this.checkCallable();
    this.relativePaths = relative;
    return this;
  }

  /**
   * The git version reproduced (default 2.56). 2.43 has no relative links (the option is
   * refused, `worktree.useRelativePaths` ignored) and takes an ambiguous remote branch name
   * for none.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** The identity of the reflog lines (default: the repository's `user.name` / `user.email`). */
  setIdent(who: PersonIdent): this {
    this.checkCallable();
    this.who = who;
    return this;
  }

  async call(): Promise<WorktreeAddResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "add");
    const config = RemoteConfigStore.from(this.workingCopy);
    const configBool = (key: string) => {
      const value = config.value(key);
      return value === undefined ? undefined : (parseGitBool(value) ?? false);
    };
    const legacy = this.compatibility === "2.43";
    if (legacy && this.relativePaths !== undefined) {
      throw new WorktreeError(`unknown option \`${this.relativePaths ? "" : "no-"}relative-paths'`);
    }
    const relativePaths = legacy
      ? false
      : (this.relativePaths ?? configBool("worktree.useRelativePaths") ?? false);
    const guessRemote = this.guessRemote ?? configBool("worktree.guessRemote") ?? false;
    const track = this.track;
    const path = this.path;
    if (path === undefined || path === "")
      throw new WorktreeError("worktree add: <path> is required");

    if (this.detach && this.newBranch !== undefined) {
      throw new WorktreeError("options '-b', '-B', and '--detach' cannot be used together");
    }
    if (this.detach && this.orphan) {
      throw new WorktreeError("options '--orphan' and '--detach' cannot be used together");
    }
    if (this.orphan && track !== undefined) {
      throw new WorktreeError("options '--orphan' and '--track' cannot be used together");
    }
    if (this.orphan && !this.checkout) {
      throw new WorktreeError("options '--orphan' and '--no-checkout' cannot be used together");
    }
    if (this.orphan && this.commitish !== undefined) {
      throw new WorktreeError("option '--orphan' and commit-ish cannot be used together");
    }
    if (this.lockReason !== undefined && !this.lock) {
      throw new WorktreeError("the option '--reason' requires '--lock'");
    }
    const keepLocked = this.lockReason ?? (this.lock ? "added with --lock" : undefined);

    let branch = this.commitish === "-" ? "@{-1}" : (this.commitish ?? "HEAD");
    let newBranch = this.newBranch;
    let orphan = this.orphan;
    const messages: string[] = [];
    const output: string[] = [];
    const basename = path.replace(/\/+$/, "").split("/").pop() ?? "";

    if (this.forceNewBranch && newBranch !== undefined && this.force === 0) {
      const ref = `refs/heads/${newBranch}`;
      if (isValidBranchName(newBranch) && (await this.refsStore.has(ref))) {
        await refuseIfCheckedOut(worktrees, ref, false);
      }
    }

    if (orphan && newBranch === undefined) {
      newBranch = basename;
    } else if (orphan) {
      // nothing to guess
    } else if (this.detach) {
      if (branch === "HEAD") await this.canUseLocalRefs(messages);
    } else if (this.commitish === undefined && newBranch !== undefined) {
      orphan = await this.dwimOrphan(messages, false, guessRemote);
    } else if (this.commitish === undefined) {
      // dwim_branch: the branch named after the path, checked out if it exists, else created
      // (from the remote-tracking branch of that name with --guess-remote)
      let found: string | undefined;
      if (isValidBranchName(basename) && (await this.refsStore.has(`refs/heads/${basename}`))) {
        branch = basename;
        found = basename;
      } else {
        newBranch = basename;
        if (guessRemote) {
          found = await this.trackingName(basename, path);
          if (found) branch = found;
        }
      }
      if (!found) orphan = await this.dwimOrphan(messages, true, guessRemote);
    } else if (newBranch !== undefined && !legacy) {
      if (branch === "HEAD") await this.canUseLocalRefs(messages);
    } else {
      // (git 2.43 guesses here even with -b, and the guess replaces the -b branch's name)
      if ((await this.commitOf(branch)) === undefined) {
        const remote = await this.trackingName(branch, path);
        if (remote) {
          newBranch = branch;
          branch = remote;
        }
      }
      if (branch === "HEAD") await this.canUseLocalRefs(messages);
    }

    const commitId = await this.commitOf(branch);
    if (!orphan && commitId === undefined) {
      throw new WorktreeError(`invalid reference: ${branch}`, messages);
    }

    if (!this.quiet) messages.push(await this.preparingLine(branch, newBranch));

    if (orphan) {
      branch = newBranch ?? basename;
    } else if (newBranch !== undefined && commitId !== undefined) {
      await this.createBranch(worktrees, newBranch, branch, commitId, messages, output);
      branch = newBranch;
    } else if (track !== undefined) {
      throw new WorktreeError("--[no-]track can only be used if a new branch is created", messages);
    }

    return this.addWorktree(
      worktrees,
      path,
      branch,
      orphan,
      keepLocked,
      relativePaths,
      messages,
      output,
    );
  }

  /**
   * git's `unique_tracking_name` for `worktree add`: the remote-tracking branch `name` is
   * guessed from, undefined when none; several without `checkout.defaultRemote` die with
   * git's advice (2.5x) or count as none (2.43).
   */
  private async trackingName(name: string, path: string): Promise<string | undefined> {
    const { ref, remotes } = await uniqueTrackingName(this.workingCopy, this.refsStore, name);
    if (ref) return ref;
    if (remotes.length > 1 && this.compatibility !== "2.43") {
      const hints =
        !this.quiet && ambiguousRemoteAdvice(this.workingCopy)
          ? worktreeAmbiguityHints(path, name, remotes)
          : [];
      throw new WorktreeError(
        `'${name}' matched multiple (${remotes.length}) remote tracking branches`,
        hints,
      );
    }
    return undefined;
  }

  /**
   * git's `can_use_local_refs`: HEAD resolves, or some branch does (then, unless quiet, the
   * warning that HEAD is invalid).
   */
  private async canUseLocalRefs(messages: string[]): Promise<boolean> {
    if ((await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId) return true;
    for await (const ref of this.refsStore.list("refs/heads/")) {
      if ("objectId" in ref && ref.objectId) {
        if (!this.quiet) {
          messages.push("warning: HEAD points to an invalid (or orphaned) reference.", "");
        }
        return true;
      }
    }
    return false;
  }

  /**
   * git's `dwim_orphan`: no valid HEAD, no branch and (`remote` with --guess-remote) no
   * remote-tracking branch infers `--orphan`; a remote with nothing fetched refuses the add
   * unless forced.
   */
  private async dwimOrphan(
    messages: string[],
    remote: boolean,
    guessRemote: boolean,
  ): Promise<boolean> {
    if (await this.canUseLocalRefs(messages)) return false;
    if (remote && guessRemote) {
      for await (const ref of this.refsStore.list("refs/remotes/")) {
        if ("objectId" in ref && ref.objectId) return false;
      }
      const config = RemoteConfigStore.from(this.workingCopy);
      if (this.force === 0 && config.configuredNames().length > 0) {
        throw new WorktreeError(
          "No local or remote refs exist despite at least one remote\npresent, stopping; use 'add -f' to override or fetch a remote first",
          messages,
        );
      }
    }
    if (!this.quiet) messages.push("No possible source branch, inferring '--orphan'");
    if (this.track !== undefined) {
      throw new WorktreeError("options '--orphan' and '--track' cannot be used together", messages);
    }
    if (!this.checkout) {
      throw new WorktreeError(
        "options '--orphan' and '--no-checkout' cannot be used together",
        messages,
      );
    }
    return true;
  }

  /** The commit `name` names (`lookup_commit_reference_by_name`), else undefined. */
  private async commitOf(name: string): Promise<ObjectId | undefined> {
    try {
      // a tree, a blob or a missing object is no commit either (git's "invalid reference")
      return await this.resolveRef(name);
    } catch {
      return undefined;
    }
  }

  private async abbrev(id: ObjectId): Promise<string> {
    const lengths = await abbrevLengths(this.workingCopy, [id]);
    return id.slice(0, lengths.get(id) ?? 7);
  }

  /** git's `print_preparing_worktree_line`. */
  private async preparingLine(branch: string, newBranch: string | undefined): Promise<string> {
    if (this.forceNewBranch && newBranch !== undefined) {
      const existing = await this.commitOf(newBranch);
      return existing === undefined
        ? `Preparing worktree (new branch '${newBranch}')`
        : `Preparing worktree (resetting branch '${newBranch}'; was at ${await this.abbrev(existing)})`;
    }
    if (newBranch !== undefined) return `Preparing worktree (new branch '${newBranch}')`;
    if (!this.detach && (await this.isBranch(branch))) {
      return `Preparing worktree (checking out '${branch}')`;
    }
    const id = (await this.commitOf(branch)) as ObjectId;
    return `Preparing worktree (detached HEAD ${await this.abbrev(id)})`;
  }

  private async isBranch(name: string): Promise<boolean> {
    return isValidBranchName(name) && (await this.refsStore.has(`refs/heads/${name}`));
  }

  /** The identity set, else git's committer ident (environment, configuration). */
  private ident(): string | undefined {
    return this.reflogLine("", this.who).ident;
  }

  /**
   * `git branch [--force] [--quiet] <new> <start> [--[no-]track]`, with git's reflog line and
   * the tracking `create_branch` sets up (its message on `output` unless quiet).
   */
  private async createBranch(
    worktrees: LinkedWorktrees,
    name: string,
    start: string,
    commitId: ObjectId,
    messages: string[],
    output: string[],
  ): Promise<void> {
    if (!isValidBranchName(name)) throw new WorktreeError(`'${name}' is not a valid branch name`);
    const ref = `refs/heads/${name}`;
    const exists = await this.refsStore.has(ref);
    if (exists && !this.forceNewBranch) {
      throw new WorktreeError(`a branch named '${name}' already exists`);
    }
    if (exists) {
      // git branch --force refuses a branch some worktree has checked out, whatever -f says
      const user = await worktreeUsingBranch(worktrees, ref);
      if (user) {
        throw new WorktreeError(
          `cannot force update the branch '${name}' used by worktree at '${user.path}'`,
        );
      }
    }
    // dwim_branch_start: the branch the start names, refused under --track when none
    const mode = this.track ?? TrackMode.DEFAULT;
    const startRef = await this.childStep(messages, () =>
      trackableStart(this.workingCopy, this.refsStore, start, mode),
    );
    const message = exists ? `branch: Reset to ${start}` : `branch: Created from ${start}`;
    const result = await this.refsStore.batch([{ name: ref, new: commitId, noDeref: true }], {
      message,
      ...(this.ident() ? { ident: this.ident() } : {}),
    });
    if (!result.ok) throw new WorktreeError(`cannot create branch '${name}'`);
    if (startRef === undefined) return;
    // setup_tracking, once the branch is written (a refusal leaves it, as git's child does)
    const { plan, warnings } = await this.childStep(messages, async () =>
      planTracking(this.workingCopy, name, startRef, mode, { compatibility: this.compatibility }),
    );
    messages.push(...warnings);
    if (!plan) return;
    const lines = await installTracking(this.workingCopy, name, plan);
    if (!this.quiet) output.push(...lines);
  }

  /**
   * A step of git's `git branch` child: its death (`fatal: ...` with hints, whatever their
   * order) becomes a WorktreeError carrying what was printed before.
   */
  private async childStep<T>(messages: string[], step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof WorktreeError || !(error instanceof Error)) throw error;
      const lines = error.message.split("\n");
      const at = lines.findIndex((line) => line.startsWith("fatal: "));
      if (at < 0) throw error;
      const rest = [lines[at].slice("fatal: ".length), ...lines.slice(at + 1)].join("\n");
      throw new WorktreeError(rest, [...messages, ...lines.slice(0, at)]);
    }
  }

  /** git's `add_worktree`. */
  private async addWorktree(
    worktrees: LinkedWorktrees,
    path: string,
    branch: string,
    orphan: boolean,
    keepLocked: string | undefined,
    relativePaths: boolean,
    messages: string[],
    output: string[],
  ): Promise<WorktreeAddResult> {
    await checkCandidatePath(worktrees, path, this.force, "add");

    const ref = `refs/heads/${branch}`;
    const isBranch = !this.detach && (await this.isBranch(branch));
    if (isBranch && this.force === 0) await refuseIfCheckedOut(worktrees, ref, false);
    const commitId = await this.commitOf(branch);
    if (commitId === undefined && !orphan) throw new WorktreeError(`invalid reference: ${branch}`);
    if (orphan) {
      if (!isValidBranchName(branch))
        throw new WorktreeError(`'${branch}' is not a valid branch name`);
      if (await this.refsStore.has(ref)) {
        throw new WorktreeError(`a branch named '${branch}' already exists`);
      }
    }

    const head: NewWorktreeHead =
      !isBranch && !orphan && commitId !== undefined ? { id: commitId } : { ref };
    let created: CreatedLinkedWorktree;
    try {
      created = await worktrees.create({
        path,
        head,
        ...(keepLocked !== undefined ? { lockReason: keepLocked } : {}),
        ...(this.ident() ? { ident: this.ident() } : {}),
        ...(relativePaths ? { relativePaths } : {}),
      });
    } catch (error) {
      throw error instanceof WorktreeError
        ? error
        : new WorktreeError(error instanceof Error ? error.message : String(error));
    }

    const entry = (await worktrees.list()).find((wt) => wt.id === created.id);
    if (!entry) {
      await worktrees.discardCreate(created, path);
      throw new WorktreeError(`could not find created worktree '${created.id}'`);
    }
    let workingCopy: WorkingCopy;
    try {
      workingCopy = await worktrees.open(entry);
      if (this.checkout) await this.checkoutWorktree(workingCopy, orphan, output);
    } catch (error) {
      await worktrees.discardCreate(created, path);
      throw error;
    }
    await worktrees.finishCreate(created.id, keepLocked !== undefined);
    // add_worktree's post-checkout hook, in the new worktree (not for --no-checkout, nor an
    // orphan): from no commit to its HEAD; its exit code becomes git's exit status
    let hookExitCode: number | undefined;
    if (this.checkout && !orphan && commitId !== undefined && this.hooks.enabled) {
      const root = (workingCopy.worktree as { getRoot?(): string }).getRoot?.();
      // run without GIT_DIR and GIT_WORK_TREE (add_worktree unsets both): the hook finds
      // the new worktree's repository from its directory
      const code = await runPostCheckoutHook(
        this.hooks,
        undefined,
        commitId,
        true,
        undefined,
        root,
        true,
        ["GIT_DIR", "GIT_WORK_TREE"],
      );
      if (code !== 0) hookExitCode = code;
    }
    return {
      ...(hookExitCode !== undefined ? { hookExitCode } : {}),
      path: entry.path,
      id: created.id,
      ...("ref" in head ? { branch: head.ref } : {}),
      ...(commitId !== undefined && !orphan ? { head: commitId } : {}),
      messages,
      output,
      workingCopy,
    };
  }

  /** git's `reset --hard --no-recurse-submodules` in the new worktree. */
  private async checkoutWorktree(
    workingCopy: WorkingCopy,
    orphan: boolean,
    output: string[],
  ): Promise<void> {
    const refs = workingCopy.history.refs;
    const staging = workingCopy.checkout.staging;
    const headId = orphan ? undefined : (await refs.resolve("HEAD"))?.objectId;
    // read through replace refs, as git's reset reads HEAD (the repository's objects and refs/replace)
    const commit = headId ? await this.commits.load(headId) : undefined;
    if (!commit || !headId) {
      // an unborn branch: the index is the empty tree
      await staging.clear();
      await staging.write();
      return;
    }
    const worktree = workingCopy.worktree;
    await checkoutFreshTree(
      {
        // the new worktree's history shares the repository's objects
        trees: this.trees,
        blobs: this.blobs,
        staging,
        worktree,
        symlinks: worktreeModeTrust(workingCopy, worktree).symlinks,
        ignoreCase: coreBool(workingCopy, "ignorecase", false),
        pathRules: worktreePathRules(workingCopy, worktree),
      },
      commit.tree,
      "worktree add",
    );
    // reset_refs: ORIG_HEAD, and HEAD moved to where it is (logged through a branch)
    await refs.set("ORIG_HEAD", headId);
    const head = await refs.get("HEAD");
    if (head && isSymbolicRef(head)) {
      const ident = this.ident();
      await refs.batch([{ name: "HEAD", new: headId }], {
        message: "reset: moving to HEAD",
        ...(ident ? { ident } : {}),
      });
    }
    if (!this.quiet) {
      // the subject as pretty=oneline gives it: the first paragraph on one line
      const subject = commit.message
        .trim()
        .split(/\n\s*\n/)[0]
        .replace(/\s*\n\s*/g, " ");
      output.push(`HEAD is now at ${await this.abbrev(headId)} ${subject}`);
    }
  }
}
