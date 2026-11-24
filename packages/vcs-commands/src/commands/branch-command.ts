import type { ObjectId, OwnReflogLine, Ref, Refs } from "@statewalker/vcs-core";
import {
  compareRefNames,
  formatPersonIdent,
  isSymbolicRef,
  isValidBranchName,
} from "@statewalker/vcs-core";
import { encodeGitPath, gitStrWidth, parseGitBool } from "@statewalker/vcs-utils";
import type { LinkedWorktrees, WorktreeInfo } from "@statewalker/vcs-working-tree";

import {
  BranchUsedByWorktreeError,
  CannotDeleteCurrentBranchError,
  GitApiError,
  InvalidRefNameError,
  NotMergedError,
  RefAlreadyExistsError,
  RefFilterError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { ListBranchMode } from "../types.js";
import {
  installTracking,
  planTracking,
  TrackMode,
  trackableStart,
  upstreamMissingError,
} from "./branch-tracking.js";
import { configBool } from "./merge-config.js";
import { OperationState } from "./merge-support.js";
import { canonicalObjectId } from "./object-id-input.js";
import { parseColorSpec } from "./pretty-format.js";
import {
  fillAheadBehind,
  filterRefs,
  parseRefSorting,
  type RefFilterOptions,
  RefFormat,
  RefKind,
  RefListingCommand,
  type RefSortKey,
  sortRefs,
} from "./ref-filter/index.js";
import { reflogMessages } from "./reflog-messages.js";
import { readHeadDescription } from "./status-header.js";
import { shortBranchName, worktreeUsingBranch } from "./worktree-support.js";

/**
 * Create a new branch.
 *
 * Equivalent to `git branch <name>`. With `setForce`, an existing branch some worktree has
 * checked out is refused (`BranchUsedByWorktreeError`: `cannot force update the branch 'x'
 * used by worktree at '<path>'`), where the backend keeps linked worktrees.
 *
 * Based on JGit's CreateBranchCommand.
 *
 * @example
 * ```typescript
 * // Create branch from HEAD
 * await git.branchCreate().setName("feature").call();
 *
 * // Create branch from specific commit
 * await git.branchCreate()
 *   .setName("hotfix")
 *   .setStartPoint("abc123")
 *   .call();
 *
 * // Force create (overwrite existing)
 * await git.branchCreate()
 *   .setName("existing")
 *   .setForce(true)
 *   .call();
 * ```
 */
export class CreateBranchCommand extends GitCommand<Ref> {
  private name?: string;
  private startPoint?: string;
  private force = false;
  private track = TrackMode.DEFAULT;
  private createReflog = false;
  private quiet = false;
  private readonly output: string[] = [];
  private readonly warnings: string[] = [];

  /**
   * Set the name of the branch to create.
   *
   * @param name Branch name (without refs/heads/ prefix)
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Set the starting point for the new branch.
   *
   * Can be a commit ID, branch name, or tag name.
   * If not set, defaults to HEAD.
   *
   * @param startPoint Commit-ish to start from
   */
  setStartPoint(startPoint: string): this {
    this.checkCallable();
    this.startPoint = startPoint;
    return this;
  }

  /**
   * Set whether to force create the branch.
   *
   * If true, overwrites an existing branch.
   *
   * @param force Whether to force create
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * How the new branch tracks its start point: git's `-t`/`--track[=direct]`
   * (`TrackMode.DIRECT`: the start point must be a branch, a local one tracked with
   * `remote = .`), `--track=inherit` (the start branch's own upstream copied), `--no-track`;
   * by default `branch.autoSetupMerge` decides (`true`: a remote-tracking start point is
   * tracked; `always`, `inherit`, `simple`, `false`). `branch.autoSetupRebase` adds
   * `branch.<name>.rebase = true`.
   *
   * @example
   * ```typescript
   * const command = git.branchCreate().setName("topic").setStartPoint("origin/topic");
   * await command.setTrack(TrackMode.DIRECT).call();
   * command.getOutput(); // ["branch 'topic' set up to track 'origin/topic'."]
   * ```
   */
  setTrack(mode: TrackMode): this {
    this.checkCallable();
    this.track = mode;
    return this;
  }

  /**
   * git's `--create-reflog`: the branch's reflog is created whatever
   * `core.logAllRefUpdates` says.
   */
  setCreateReflog(createReflog: boolean): this {
    this.checkCallable();
    this.createReflog = createReflog;
    return this;
  }

  /** git's `-q`: no "set up to track" message ({@link getOutput} stays empty). */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /**
   * What git printed on stdout, line by line: `branch '<b>' set up to track
   * '<upstream>'.` (see {@link setTrack}). Read after {@link call}.
   */
  getOutput(): string[] {
    return [...this.output];
  }

  /**
   * What git printed on stderr, line by line: `warning: asked to inherit tracking from
   * '<b>', but no remote is set` and the like. Read after {@link call}.
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Execute the branch creation (git's `create_branch`).
   *
   * @returns The created branch ref
   * @throws InvalidRefNameError if branch name is invalid
   * @throws RefAlreadyExistsError if branch exists and force is false
   * @throws RefNotFoundError when the start point names nothing (`fatal: not a valid object
   *   name: '<start>'`), or when several remotes fetch into the tracked start point (once the
   *   branch is created, as git dies)
   * @throws InvalidArgumentError when `--track` cannot track the start point
   */
  async call(): Promise<Ref> {
    this.checkCallable();

    if (!this.name) {
      throw new InvalidRefNameError("", "Branch name is required");
    }

    if (!isValidBranchName(this.name)) {
      throw new InvalidRefNameError(this.name);
    }

    const refName = `refs/heads/${this.name}`;

    // Check if already exists
    const exists = await this.refsStore.has(refName);
    if (!this.force && exists) {
      throw new RefAlreadyExistsError(refName, `Branch '${this.name}' already exists`);
    }
    // git's validate_new_branchname: a branch a worktree has checked out is not force-moved
    const worktrees = this.workingCopy.worktrees;
    if (exists && worktrees) {
      const user = await worktreeUsingBranch(worktrees, refName);
      if (user) {
        throw new BranchUsedByWorktreeError(
          this.name,
          user.path,
          `cannot force update the branch '${this.name}' used by worktree at '${user.path}'`,
        );
      }
    }

    // without a start point, cmd_branch names the branch checked out (`HEAD` when detached)
    const current = await this.getCurrentBranch();
    const start = this.startPoint ?? (current ? current.replace(/^refs\/heads\//, "") : "HEAD");

    // git's dwim_branch_start: the object, then (tracking) the branch it names, then a commit
    const compatibility = this.hooks.compatibility;
    const objectId = await this.revisionResolver()
      .resolve(start)
      .catch((error) => {
        if (error instanceof RefNotFoundError) return undefined;
        throw error;
      });
    if (objectId === undefined) {
      if (this.track === TrackMode.DIRECT) {
        throw upstreamMissingError(this.workingCopy, start, compatibility);
      }
      throw new RefNotFoundError(start, `fatal: not a valid object name: '${start}'`);
    }
    const startRef =
      this.track === TrackMode.NONE
        ? undefined
        : await trackableStart(this.workingCopy, this.refsStore, start, this.track);
    const targetId = await this.resolveRef(start, (n) => `fatal: not a valid branch point: '${n}'`);

    // git's create_branch: "branch: Created from <start>", "branch: Reset to <start>" (-f)
    const message = exists
      ? reflogMessages.branchReset(start)
      : reflogMessages.branchCreated(start);
    if (this.createReflog) {
      // REF_FORCE_CREATE_REFLOG
      const result = await this.refsStore.batch([{ name: refName, new: targetId }], {
        ...this.reflogLine(message),
        createReflog: true,
      });
      if (!result.ok) {
        const reasons = result.rejected.map((r) => r.reason).join(", ");
        throw new GitApiError(`fatal: cannot lock ref '${refName}': ${reasons}`);
      }
    } else {
      await this.refsStore.set(refName, targetId, this.reflogLine(message));
    }

    this.setCallable(false);

    // setup_tracking, once the branch exists (its refusals die after the write)
    if (startRef !== undefined) {
      const { plan, warnings } = planTracking(this.workingCopy, this.name, startRef, this.track, {
        compatibility,
      });
      this.warnings.push(...warnings);
      if (plan) {
        const lines = await installTracking(this.workingCopy, this.name, plan);
        if (!this.quiet) this.output.push(...lines);
      }
    }

    const ref = await this.refsStore.get(refName);
    return ref as Ref;
  }
}

/**
 * Delete branches.
 *
 * Equivalent to `git branch -d` or `git branch -D`.
 *
 * Where the backend keeps linked worktrees (`WorkingCopy.worktrees`), a branch any worktree
 * has checked out (or is rebasing or bisecting) is refused, as git's `branch_checked_out`:
 * `cannot delete branch 'x' used by worktree at '<path>'` (`BranchUsedByWorktreeError`;
 * `CannotDeleteCurrentBranchError` with that message for this worktree's own branch).
 *
 * Based on JGit's DeleteBranchCommand.
 *
 * @example
 * ```typescript
 * // Delete a single branch
 * await git.branchDelete().setBranchNames("feature").call();
 *
 * // Delete multiple branches
 * await git.branchDelete()
 *   .setBranchNames("feature", "hotfix")
 *   .call();
 *
 * // Force delete (even if not merged)
 * await git.branchDelete()
 *   .setBranchNames("feature")
 *   .setForce(true)
 *   .call();
 * ```
 */
export class DeleteBranchCommand extends GitCommand<string[]> {
  private branchNames: string[] = [];
  private force = false;

  /**
   * Set the branches to delete.
   *
   * @param names Branch names (without refs/heads/ prefix)
   */
  setBranchNames(...names: string[]): this {
    this.checkCallable();
    this.branchNames.push(...names);
    return this;
  }

  /**
   * Set whether to force delete.
   *
   * If true, deletes even if branch is not fully merged.
   *
   * @param force Whether to force delete
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Execute the branch deletion.
   *
   * @returns List of deleted branch names (full ref names)
   * @throws CannotDeleteCurrentBranchError if trying to delete current branch
   * @throws RefNotFoundError if branch doesn't exist
   * @throws NotMergedError if branch is not merged and force is false
   */
  async call(): Promise<string[]> {
    this.checkCallable();
    this.setCallable(false);

    const currentBranch = await this.getCurrentBranch();
    const worktrees = this.workingCopy.worktrees;
    // git's delete_branches: each name checked (each refusal reported, the others still
    // deleted), then all of them deleted with one delete_refs
    const toDelete: string[] = [];
    const refusals: { error: GitApiError; text: string }[] = [];

    for (const name of this.branchNames) {
      const refName = name.startsWith("refs/") ? name : `refs/heads/${name}`;
      const refusal = await this.refusalOf(name, refName, currentBranch, worktrees);
      if (refusal) refusals.push(refusal);
      else if (!toDelete.includes(refName)) toDelete.push(refName);
    }

    const { removed: deleted, error } =
      toDelete.length > 0 ? await this.removeRefsAsGit(toDelete) : { removed: [] };

    // git's delete_branch_config: a deleted branch's `[branch "<name>"]` section goes too
    const config = RemoteConfigStore.from(this.workingCopy);
    const configured = new Set(config.subsections("branch"));
    const sections = deleted
      .filter((r) => r.startsWith("refs/heads/"))
      .map((r) => shortBranchName(r))
      .filter((name) => configured.has(name));
    for (const name of sections) config.removeSection(`branch.${name}`);
    if (sections.length > 0) await config.save();

    if (refusals.length > 0) throw GitApiError.ofRefusals(refusals);
    if (error !== undefined) throw error;
    return deleted;
  }

  /**
   * Why git's delete_branches refuses to delete a branch (the error, and git's stderr for
   * it); nothing for a deletable one. Any other failure is thrown.
   */
  private async refusalOf(
    name: string,
    refName: string,
    currentBranch: string | undefined,
    worktrees: LinkedWorktrees | undefined,
  ): Promise<{ error: GitApiError; text: string } | undefined> {
    const short = shortBranchName(refName);
    // git's branch_checked_out: no worktree's branch is deleted (this one's included)
    const user = worktrees ? await worktreeUsingBranch(worktrees, refName) : undefined;
    if (user) {
      const message = `cannot delete branch '${short}' used by worktree at '${user.path}'`;
      // git's delete_branches: error() and the next branch, exit status 1
      const error = user.current
        ? new CannotDeleteCurrentBranchError(name, message)
        : new BranchUsedByWorktreeError(short, user.path, message).withExitCode(1);
      return { error, text: `error: ${message}` };
    }

    // Cannot delete current branch
    if (currentBranch === refName) {
      const error = new CannotDeleteCurrentBranchError(name);
      return { error, text: `error: ${error.message}` };
    }

    // Check if exists
    if (!(await this.refsStore.has(refName))) {
      // git's delete_branches: error("branch '%s' not found"), exit status 1 (with a hint
      // when a remote-tracking branch of that name exists)
      const remote = await this.refsStore.has(`refs/remotes/${short}`);
      return {
        error: new RefNotFoundError(refName, `Branch '${name}' not found`).withExitCode(1),
        text: remote
          ? `error: branch '${short}' not found.\nDid you forget --remote?`
          : `error: branch '${short}' not found`,
      };
    }

    // Check if fully merged (unless force): check_branch_commit
    if (!this.force && !(await this.isBranchMerged(refName))) {
      const lines =
        this.hooks.compatibility === "2.43"
          ? [
              `error: the branch '${short}' is not fully merged.`,
              `If you are sure you want to delete it, run 'git branch -D ${short}'`,
            ]
          : [
              `error: the branch '${short}' is not fully merged`,
              ...(configBool(this.workingCopy, "advice.forceDeleteBranch", true)
                ? [
                    `hint: If you are sure you want to delete it, run 'git branch -D ${short}'`,
                    `hint: Disable this message with "git config set advice.forceDeleteBranch false"`,
                  ]
                : []),
            ];
      return { error: new NotMergedError(name), text: lines.join("\n") };
    }
    return undefined;
  }

  /**
   * Check if a branch is fully merged into HEAD or upstream.
   */
  private async isBranchMerged(refName: string): Promise<boolean> {
    const ref = await this.refsStore.resolve(refName);
    if (!ref?.objectId) {
      return true; // Non-existent is "merged"
    }

    // Check if branch commit is ancestor of HEAD
    try {
      const headId = await this.resolveHead();
      return this.commits.isAncestor(ref.objectId, headId);
    } catch {
      // If HEAD doesn't exist, consider it merged
      return true;
    }
  }
}

/** What {@link ListBranchCommand.callText} printed. */
export interface BranchListResult {
  /** git's stdout: each branch's line and its newline (bytes outside UTF-8 as `decodeGitPath` keeps them) */
  output: string;
  /** Each shown branch's line, in order (an empty one left out with `--omit-empty`) */
  lines: string[];
  /** The refs shown, in order (`HEAD` for a detached HEAD) */
  branches: { refname: string; objectId: ObjectId }[];
  /** git's warnings on stderr */
  warnings: string[];
}

/** git's branch colors (builtin/branch.c `branch_colors`), by `color.branch.<slot>`. */
const BRANCH_COLORS = {
  reset: "\x1b[m",
  plain: "",
  remote: "\x1b[31m",
  local: "",
  current: "\x1b[32m",
  upstream: "\x1b[34m",
  worktree: "\x1b[36m",
} as const;

type BranchColorSlot = keyof typeof BRANCH_COLORS;

/** quote_literal_for_format: `%` doubled. */
const quoteLiteral = (s: string) => s.replaceAll("%", "%%");

/**
 * List branches.
 *
 * Equivalent to `git branch --list`. {@link call} returns the branch refs (symbolic ones
 * left out); {@link callText} prints git's listing: `* ` before the branch checked out here,
 * `+ ` before one another worktree has checked out, a detached HEAD first as
 * `(HEAD detached at <name>)` (or `from`, `(no branch, rebasing <branch>)`,
 * `(no branch, bisect started on <branch>)`), symbolic refs as `name -> target`, and with
 * `-v` each branch's abbreviated id, upstream tracking and subject (`-vv`: the upstream's
 * name and other worktrees' paths), aligned as git aligns them.
 *
 * The ref filter is git's (`ref-filter`): patterns match after `refs/heads/` or
 * `refs/remotes/` (`setPatterns("feature/*")`), `setSort` keys follow `--sort` (the last is
 * primary; `branch.sort` keys come before them, `refname` when none), `setFormat` takes the
 * `for-each-ref` language, and the reachability filters (`setContains`, `setNoContains`,
 * `setMerged`, `setNoMerged`, `setPointsAt`) take revision names (HEAD when none is given).
 * Colors follow `--color` or `color.branch`/`color.ui` set to `always` (no terminal is
 * assumed), with `color.branch.<slot>`. Not supported: `--column` layouts (lines are
 * printed as `--no-column` prints them).
 *
 * Based on JGit's ListBranchCommand and git's builtin/branch.c.
 *
 * @example
 * ```typescript
 * // List local branches
 * const branches = await git.branchList().call();
 *
 * // git branch -a -vv --merged
 * const { output } = await git.branchList()
 *   .setListMode(ListBranchMode.ALL)
 *   .setVerbose(2)
 *   .setMerged()
 *   .callText();
 *
 * // git branch --sort=-committerdate --format='%(refname:short)' 'feature/*'
 * const { lines } = await git.branchList()
 *   .setSort("-committerdate")
 *   .setFormat("%(refname:short)")
 *   .setPatterns("feature/*")
 *   .callText();
 * ```
 */
export class ListBranchCommand extends RefListingCommand<Ref[]> {
  private listMode = ListBranchMode.LOCAL;
  private patterns: string[] = [];
  private verbose = 0;
  private abbrev?: number;
  private format?: string;
  private sortKeys: string[] = [];
  private ignoreCase = false;
  private omitEmpty = false;
  private color?: boolean;
  private pointsAt: string[] = [];
  private contains: string[] = [];
  private noContains: string[] = [];
  private merged: string[] = [];
  private noMerged: string[] = [];
  private compatibility: "2.43" | "2.56" = "2.56";

  /**
   * Set the listing mode: local branches (default), `-r` (remote-tracking) or `-a` (both).
   *
   * @param mode Which branches to list
   */
  setListMode(mode: ListBranchMode): this {
    this.checkCallable();
    this.listMode = mode;
    return this;
  }

  /** `<pattern>...`: branches whose name after `refs/heads/` or `refs/remotes/` matches one. */
  setPatterns(...patterns: string[]): this {
    this.checkCallable();
    this.patterns = patterns;
    return this;
  }

  /** `-v` (1) or `-vv` (2): ids and subjects, then upstreams and worktree paths. */
  setVerbose(level: number): this {
    this.checkCallable();
    this.verbose = level;
    return this;
  }

  /** `--abbrev=<n>` for `-v`'s ids (0: `--no-abbrev`, the full id). */
  setAbbrev(length: number): this {
    this.checkCallable();
    // parse_opt_abbrev_cb: at least 4, at most the id's length
    this.abbrev = length && length < 4 ? 4 : Math.min(length, 64);
    return this;
  }

  /** `--format=<format>`: each branch through git's ref format language. */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** `--sort=<key>` for each key, in command-line order (the last is the primary key). */
  setSort(...keys: string[]): this {
    this.checkCallable();
    this.sortKeys = keys;
    return this;
  }

  /** `-i`: patterns and sorting without case. */
  setIgnoreCase(ignore: boolean): this {
    this.checkCallable();
    this.ignoreCase = ignore;
    return this;
  }

  /** `--omit-empty`: no line for a branch whose format expands to nothing. */
  setOmitEmpty(omit: boolean): this {
    this.checkCallable();
    this.omitEmpty = omit;
    return this;
  }

  /** `--color` (true) or `--no-color` (false); default `color.branch`/`color.ui` `always`. */
  setColor(color: boolean): this {
    this.checkCallable();
    this.color = color;
    return this;
  }

  /** `--points-at=<object>`: branches naming one of these objects. */
  setPointsAt(...objects: string[]): this {
    this.checkCallable();
    this.pointsAt = objects;
    return this;
  }

  /**
   * `--contains[=<commit>]` (HEAD without one): branches whose commit reaches one of these.
   *
   * @param commits Revision names or object ids
   */
  setContains(...commits: string[]): this {
    this.checkCallable();
    this.contains = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--no-contains[=<commit>]` (HEAD without one): branches whose commit reaches none. */
  setNoContains(...commits: string[]): this {
    this.checkCallable();
    this.noContains = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--merged[=<commit>]` (HEAD without one): branches one of these reaches. */
  setMerged(...commits: string[]): this {
    this.checkCallable();
    this.merged = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--no-merged[=<commit>]` (HEAD without one): branches none of these reaches. */
  setNoMerged(...commits: string[]): this {
    this.checkCallable();
    this.noMerged = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /**
   * The git version whose `--format` output to follow where versions differ (default 2.56;
   * see `ForEachRefCommand.setCompatibility`).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  private kind(): number {
    return this.listMode === ListBranchMode.REMOTE
      ? RefKind.REMOTES
      : this.listMode === ListBranchMode.ALL
        ? RefKind.BRANCHES | RefKind.REMOTES
        : RefKind.BRANCHES;
  }

  private async filterOptions(kind: number): Promise<RefFilterOptions> {
    const resolved = await this.resolveFilterArgs({
      pointsAt: this.pointsAt,
      contains: this.contains,
      noContains: this.noContains,
      merged: this.merged,
      noMerged: this.noMerged,
    });
    return {
      kind,
      patterns: this.patterns,
      ignoreCase: this.ignoreCase,
      ...resolved,
      ...(this.verbose ? { needCommit: true } : {}),
    };
  }

  /**
   * Execute the branch listing.
   *
   * @returns The branch refs the filters keep, symbolic refs left out, in name order
   */
  async call(): Promise<Ref[]> {
    this.checkCallable();
    this.setCallable(false);
    const { items } = await filterRefs(this.filterSource(), await this.filterOptions(this.kind()));
    // one listing of the refs, not a lookup per kept branch (a packed ref's lookup reads
    // packed-refs again: quadratic over thousands of branches)
    const listed = new Map<string, Ref>();
    for await (const ref of this.refsStore.list("refs/")) {
      if (!isSymbolicRef(ref)) listed.set(ref.name, ref);
    }
    const branches: Ref[] = [];
    for (const item of items) {
      if (item.flags.symref) continue;
      const ref = listed.get(item.refname);
      if (ref) branches.push(ref);
    }
    branches.sort((a, b) => compareRefNames(a.name, b.name));
    return branches;
  }

  /**
   * `git branch --list`'s output.
   *
   * @throws RefFilterError where git refuses an option or dies (bad format, bad sort key,
   *   a name that is no commit)
   */
  async callText(): Promise<BranchListResult> {
    this.checkCallable();
    this.setCallable(false);
    const config = RemoteConfigStore.from(this.workingCopy);
    // refs_resolve_refdup("HEAD")
    const head = await this.refsStore.get("HEAD").catch(() => undefined);
    if (!head) throw new RefFilterError("fatal: failed to resolve HEAD as a valid ref", 128);
    const detached = !isSymbolicRef(head);
    if (!detached && !head.target.startsWith("refs/heads/")) {
      throw new RefFilterError("fatal: HEAD not found below refs/heads!", 128);
    }
    // branch.sort keys first, then --sort (parse_opt_ref_sorting appends)
    const sortKeys = [...config.values("branch.sort"), ...this.sortKeys];
    if (sortKeys.length === 0) sortKeys.push("refname");
    const useColor = this.color ?? wantsColor(config);
    const colors = branchColors(config, useColor);
    const formatSource = this.formatSource();
    let description: Promise<string> | undefined;
    formatSource.headDescription = () => {
      description ??= this.headDescription();
      return description;
    };
    const compatibility = this.compatibility;
    const formatOptions = { useColor, compatibility } as const;
    // ref_sorting_options runs before the format is verified
    const sortFormat = new RefFormat("", formatSource, formatOptions);
    parseRefSorting(sortKeys, sortFormat);
    // git 2.43 collects `%(ahead-behind)` bases per format: atoms the sort keys parsed
    // first (into a dummy format) get none
    const sortedFirst = new Set(
      compatibility === "2.43" ? sortFormat.atoms.map((a) => a.name) : [],
    );

    let kind = this.kind();
    if (kind & RefKind.BRANCHES && detached) kind |= RefKind.DETACHED_HEAD;
    const source = this.filterSource();
    const { items, warnings } = await filterRefs(source, await this.filterOptions(kind));
    const remotePrefix = kind === RefKind.REMOTES ? "" : "remotes/";
    let maxwidth = 0;
    if (this.verbose) {
      for (const item of items) {
        let w: number;
        if (item.kind & RefKind.DETACHED_HEAD) {
          w = textWidth(await formatSource.headDescription());
        } else {
          let desc = item.refname;
          if (desc.startsWith("refs/heads/")) desc = desc.slice(11);
          if (desc.startsWith("refs/remotes/")) desc = desc.slice(13);
          w = textWidth(desc);
        }
        if (item.kind === RefKind.REMOTES) w += remotePrefix.length;
        if (w > maxwidth) maxwidth = w;
      }
    }
    const formatText =
      this.format ?? buildBranchFormat(this.verbose, this.abbrev, maxwidth, remotePrefix, colors);
    let format: RefFormat;
    try {
      format = new RefFormat(formatText, formatSource, formatOptions);
    } catch (e) {
      // verify_ref_format's error, then branch's death
      if (e instanceof RefFilterError && e.message.startsWith("error: malformed format string")) {
        throw new RefFilterError(`${e.message}\nfatal: unable to parse format string`, 128);
      }
      throw e;
    }
    const sorting: RefSortKey[] = parseRefSorting(sortKeys, format).map((key) => ({
      ...key,
      detachedHeadFirst: true,
      ...(this.ignoreCase ? { icase: true } : {}),
    }));
    const bases: ObjectId[] = [];
    for (const atom of format.atoms) {
      if (atom.type !== "ahead-behind" || sortedFirst.has(atom.name)) continue;
      const name = atom.base as string;
      const commit = await source.commitByName(name, warnings);
      if (!commit) throw new RefFilterError(`fatal: failed to find '${name}'`, 128);
      bases.push(commit);
    }
    await fillAheadBehind(items, bases, source, warnings);
    await sortRefs(items, sorting, format, source, warnings);
    const lines: string[] = [];
    let output = "";
    for (const item of items) {
      const line = await format.format(item);
      if (line.length || !this.omitEmpty) {
        lines.push(line);
        output += `${line}\n`;
      }
    }
    return {
      output,
      lines,
      branches: items.map((i) => ({ refname: i.refname, objectId: i.objectId })),
      warnings,
    };
  }

  /** get_head_description over this repository's state. */
  private headDescription(): Promise<string> {
    const resolver = this.revisionResolver();
    const refs = this.refsStore;
    return readHeadDescription({
      refs,
      state: new OperationState(this.workingCopy.checkout, refs),
      abbreviate: (id) => this.abbreviateObjectId(id),
      dwimRef: (name) => resolver.dwimRef(name).catch(() => []),
      commitOf: async (id) => resolver.commitReference(id).catch(() => undefined),
      objectExists: async (id) =>
        (await resolver.objectType(id).catch(() => undefined)) !== undefined,
      config: (key) => RemoteConfigStore.from(this.workingCopy).value(key),
    });
  }
}

/** A full object id canonicalised (lowercase), any other name as given. */
function canonicalName(name: string): string {
  return /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(name) ? canonicalObjectId(name) : name;
}

/** git_config_colorbool of `color.branch`, else `color.ui`: only `always` colors without a terminal. */
function wantsColor(config: RemoteConfigStore): boolean {
  const value = config.value("color.branch") ?? config.value("color.ui");
  return value?.trim().toLowerCase() === "always";
}

/** branch_get_color for every slot: `color.branch.<slot>` over git's defaults, "" without color. */
function branchColors(
  config: RemoteConfigStore,
  useColor: boolean,
): Record<BranchColorSlot, string> {
  const out = { ...BRANCH_COLORS } as Record<BranchColorSlot, string>;
  for (const slot of Object.keys(out) as BranchColorSlot[]) {
    if (!useColor) {
      out[slot] = "";
      continue;
    }
    const value = config.value(`color.branch.${slot}`);
    if (value === undefined) continue;
    try {
      out[slot] = parseColorSpec(value);
    } catch {
      // git refuses the configuration; the default stays
    }
  }
  return out;
}

/** builtin/branch.c's build_format. */
function buildBranchFormat(
  verbose: number,
  abbrev: number | undefined,
  maxwidth: number,
  remotePrefix: string,
  c: Record<BranchColorSlot, string>,
): string {
  let local = `%(if)%(HEAD)%(then)* ${c.current}%(else)%(if)%(worktreepath)%(then)+ ${c.worktree}%(else)  ${c.local}%(end)%(end)`;
  let remote = `  ${c.remote}`;
  if (verbose) {
    const obname =
      abbrev === undefined || abbrev < 0
        ? "%(objectname:short)"
        : abbrev === 0
          ? "%(objectname)"
          : `%(objectname:short=${abbrev})`;
    local += `%(align:${maxwidth},left)%(refname:lstrip=2)%(end)`;
    local += c.reset;
    local += ` ${obname} `;
    if (verbose > 1) {
      local += `%(if:notequals=*)%(HEAD)%(then)%(if)%(worktreepath)%(then)(${c.worktree}%(worktreepath)${c.reset}) %(end)%(end)`;
      local += `%(if)%(upstream)%(then)[${c.upstream}%(upstream:short)${c.reset}%(if)%(upstream:track)%(then): %(upstream:track,nobracket)%(end)] %(end)%(contents:subject)`;
    } else {
      local += "%(if)%(upstream:track)%(then)%(upstream:track) %(end)%(contents:subject)";
    }
    remote += `%(align:${maxwidth},left)${quoteLiteral(remotePrefix)}%(refname:lstrip=2)%(end)${c.reset}%(if)%(symref)%(then) -> %(symref:short)%(else) ${obname} %(contents:subject)%(end)`;
  } else {
    local += `%(refname:lstrip=2)${c.reset}%(if)%(symref)%(then) -> %(symref:short)%(end)`;
    remote += `${quoteLiteral(remotePrefix)}%(refname:lstrip=2)${c.reset}%(if)%(symref)%(then) -> %(symref:short)%(end)`;
  }
  return `%(if:notequals=refs/remotes)%(refname:rstrip=-2)%(then)${local}%(else)${remote}%(end)`;
}

/** utf8_strwidth. */
const textWidth = (text: string) => gitStrWidth(encodeGitPath(text));

/**
 * Rename a branch. Other worktrees whose HEAD is on it follow the new name, with git's
 * `Branch: renamed <old> to <new>` line in their HEAD reflog (git's
 * `replace_each_worktree_head_symref`). Refused (`BranchUsedByWorktreeError`) while a
 * worktree rebases or bisects the branch (`branch refs/heads/x is being rebased at <path>`).
 *
 * Equivalent to `git branch -m`.
 *
 * Based on JGit's RenameBranchCommand.
 *
 * @example
 * ```typescript
 * // Rename current branch
 * await git.branchRename().setNewName("new-name").call();
 *
 * // Rename specific branch
 * await git.branchRename()
 *   .setOldName("old-branch")
 *   .setNewName("new-branch")
 *   .call();
 * ```
 */
export class RenameBranchCommand extends GitCommand<Ref> {
  private oldName?: string;
  private newName?: string;

  /**
   * Set the old branch name.
   *
   * If not set, uses the current branch.
   *
   * @param oldName Current branch name
   */
  setOldName(oldName: string): this {
    this.checkCallable();
    this.oldName = oldName;
    return this;
  }

  /**
   * Set the new branch name.
   *
   * @param newName New branch name
   */
  setNewName(newName: string): this {
    this.checkCallable();
    this.newName = newName;
    return this;
  }

  /**
   * Execute the branch rename.
   *
   * @returns The renamed branch ref
   * @throws InvalidRefNameError if new name is invalid
   * @throws RefNotFoundError if old branch doesn't exist
   * @throws RefAlreadyExistsError if new branch already exists
   */
  async call(): Promise<Ref> {
    this.checkCallable();

    if (!this.newName) {
      throw new InvalidRefNameError("", "New branch name is required");
    }

    if (!isValidBranchName(this.newName)) {
      throw new InvalidRefNameError(this.newName);
    }

    // Determine old ref name
    let oldRefName: string;
    if (this.oldName) {
      oldRefName = this.oldName.startsWith("refs/") ? this.oldName : `refs/heads/${this.oldName}`;
    } else {
      const currentBranch = await this.getCurrentBranch();
      if (!currentBranch) {
        throw new RefNotFoundError("HEAD", "HEAD is detached, specify old branch name");
      }
      oldRefName = currentBranch;
    }

    const newRefName = `refs/heads/${this.newName}`;

    // Check old exists
    const oldRef = await this.refsStore.resolve(oldRefName);
    if (!oldRef?.objectId) {
      throw new RefNotFoundError(oldRefName);
    }

    // Check new doesn't exist
    if (await this.refsStore.has(newRefName)) {
      throw new RefAlreadyExistsError(newRefName, `Branch '${this.newName}' already exists`);
    }

    // Everything checked before anything changes: git's reject_rebase_or_bisect_branch (a
    // worktree with a detached HEAD rebasing or bisecting the branch), and the other
    // worktrees whose HEAD is on it
    const worktrees = this.workingCopy.worktrees;
    const others: WorktreeInfo[] = [];
    if (worktrees) {
      for (const wt of await worktrees.list()) {
        if (wt.detached && wt.rebasing === oldRefName) {
          throw new BranchUsedByWorktreeError(
            shortBranchName(oldRefName),
            wt.path,
            `branch ${oldRefName} is being rebased at ${wt.path}`,
          );
        }
        if (wt.detached && wt.bisecting === oldRefName) {
          throw new BranchUsedByWorktreeError(
            shortBranchName(oldRefName),
            wt.path,
            `branch ${oldRefName} is being bisected at ${wt.path}`,
          );
        }
        if (!wt.current && !wt.detached && wt.headRef === oldRefName) others.push(wt);
      }
    }

    // As git's files_copy_or_rename_ref: the old ref deleted (HEAD on it logs `<id> 0`), its
    // reflog carried over to the new ref with a `<id> <id>` line; then HEAD follows
    const message = reflogMessages.branchRenamed(oldRefName, newRefName);
    const log = this.reflogLine(message);
    const id = oldRef.objectId;
    const carried = await reflogLinesOfRef(this.refsStore, oldRefName);
    // (no log to carry: the new ref gets one only where git creates logs of branches,
    // core.logAllRefUpdates, false by default in a bare repository)
    const config = RemoteConfigStore.from(this.workingCopy);
    const logAll = logsBranches(config);
    const ownLines = [...carried, { oldId: id, newId: id, message, ...log }];
    const created = await this.refsStore.batch(
      [
        {
          name: newRefName,
          old: null,
          new: id,
          ...(carried.length > 0 || logAll ? { reflog: ownLines } : {}),
        },
      ],
      log,
    );
    if (!created.ok) {
      throw new RefAlreadyExistsError(newRefName, `Branch '${this.newName}' already exists`);
    }
    const head = await this.refsStore.get("HEAD");
    const onHead = head && isSymbolicRef(head) && head.target === oldRefName;
    await this.refsStore.batch([{ name: oldRefName, new: null }], log);

    // Update HEAD if it was pointing to old branch
    if (onHead) await this.refsStore.setSymbolic("HEAD", newRefName, log);
    // and every other worktree's HEAD on it, through that worktree's own refs, logged as
    // git's replace_each_worktree_head_symref logs it
    for (const wt of others) await worktrees?.updateHead(wt, newRefName, { ...log, message });

    // git's copy_or_rename_branch: the branch's configuration follows it
    // (git_config_rename_section of branch.<old> to branch.<new>)
    const oldShort = shortBranchName(oldRefName);
    if (oldShort !== this.newName) {
      config.renameSection(`branch.${oldShort}`, `branch.${this.newName}`);
      await config.save();
    }

    this.setCallable(false);

    const ref = await this.refsStore.get(newRefName);
    return ref as Ref;
  }
}

/**
 * Copy a branch: the new branch at the old one's commit, with a copy of its reflog and of
 * its configuration (`branch.<old>.*`), as git's `branch -c` (`files_copy_or_rename_ref`
 * with copy, `git_config_copy_section`). HEAD stays where it is, also when the branch
 * copied is the current one. Its reflog gets `Branch: copied refs/heads/<old> to
 * refs/heads/<new>`.
 *
 * Equivalent to `git branch -c [<old>] <new>` (`-C` with `setForce`).
 *
 * @example
 * ```typescript
 * await git.branchCopy().setNewName("feature-backup").call(); // the current branch
 * await git.branchCopy().setOldName("feature").setNewName("feature2").call();
 * ```
 */
export class CopyBranchCommand extends GitCommand<Ref> {
  private oldName?: string;
  private newName?: string;
  private force = false;

  /** The branch to copy (default: the current one). */
  setOldName(oldName: string): this {
    this.checkCallable();
    this.oldName = oldName;
    return this;
  }

  /** The new branch's name. */
  setNewName(newName: string): this {
    this.checkCallable();
    this.newName = newName;
    return this;
  }

  /** Overwrite a branch of the new name (`-C`); never one a worktree has checked out. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * @returns the new branch
   * @throws InvalidRefNameError for an invalid new name
   * @throws RefNotFoundError when the branch to copy does not exist (`fatal: no branch
   *   named 'x'`, or `fatal: no commit on branch 'x' yet` for the current, unborn one)
   * @throws RefAlreadyExistsError when the new branch exists, without `setForce`
   * @throws BranchUsedByWorktreeError when it is checked out in a worktree
   */
  async call(): Promise<Ref> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.newName) throw new InvalidRefNameError("", "New branch name is required");
    if (!isValidBranchName(this.newName)) {
      throw new InvalidRefNameError(
        this.newName,
        `fatal: '${this.newName}' is not a valid branch name`,
      );
    }
    const current = await this.getCurrentBranch();
    let oldRefName: string;
    if (this.oldName) {
      oldRefName = this.oldName.startsWith("refs/") ? this.oldName : `refs/heads/${this.oldName}`;
    } else if (current) {
      oldRefName = current;
    } else {
      throw new RefNotFoundError("HEAD", "fatal: cannot copy the current branch while not on any");
    }
    const oldShort = shortBranchName(oldRefName);
    const newRefName = `refs/heads/${this.newName}`;
    const oldRef = await this.refsStore.get(oldRefName);
    const id = oldRef && !isSymbolicRef(oldRef) ? oldRef.objectId : undefined;
    if (!id) {
      throw new RefNotFoundError(
        oldRefName,
        current === oldRefName
          ? `fatal: no commit on branch '${oldShort}' yet`
          : `fatal: no branch named '${oldShort}'`,
      );
    }

    // validate_new_branchname (validate_branchname when copying a branch onto itself)
    if (newRefName !== oldRefName && (await this.refsStore.has(newRefName))) {
      if (!this.force) {
        throw new RefAlreadyExistsError(
          newRefName,
          `fatal: a branch named '${this.newName}' already exists`,
        );
      }
      const worktrees = this.workingCopy.worktrees;
      const user = worktrees
        ? await worktreeUsingBranch(worktrees, newRefName)
        : current === newRefName
          ? { path: "." }
          : undefined;
      if (user) {
        throw new BranchUsedByWorktreeError(
          this.newName,
          user.path,
          `fatal: cannot force update the branch '${this.newName}' used by worktree at '${user.path}'`,
        );
      }
    }

    // files_copy_or_rename_ref with copy: the old reflog copied over the new one's, then
    // the new ref written with an `<id> <id>` line (HEAD logs it only when on the new ref)
    const message = reflogMessages.branchCopied(oldRefName, newRefName);
    const log = this.reflogLine(message);
    const config = RemoteConfigStore.from(this.workingCopy);
    const carried = await reflogLinesOfRef(this.refsStore, oldRefName);
    const line = { oldId: id, newId: id, message, ...log };
    if (newRefName === oldRefName) {
      // copied onto itself: one `<id> <id>` line (also HEAD's, when on it)
      await this.refsStore.batch([{ name: newRefName, new: id, reflog: [line] }], log);
    } else if (carried.length > 0 || logsBranches(config)) {
      // the new branch's own log is replaced: a branch -C overwrites goes first
      if (await this.refsStore.has(newRefName)) {
        await this.refsStore.batch([{ name: newRefName, new: null }], log);
      }
      await this.refsStore.batch([{ name: newRefName, new: id, reflog: [...carried, line] }], log);
    } else {
      await this.refsStore.set(newRefName, id, log);
    }

    // git_config_copy_section(branch.<old>, branch.<new>), unless the names are the same
    if (oldShort !== this.newName) {
      config.copySection(`branch.${oldShort}`, `branch.${this.newName}`);
      await config.save();
    }

    return (await this.refsStore.get(newRefName)) as Ref;
  }
}

/** Whether git creates reflogs of branches (core.logAllRefUpdates; off in a bare repository). */
function logsBranches(config: RemoteConfigStore): boolean {
  const setting = config.value("core.logAllRefUpdates");
  return (
    setting?.trim().toLowerCase() === "always" ||
    (parseGitBool(setting) ?? !(parseGitBool(config.value("core.bare")) ?? false))
  );
}

/** A reflog's lines, oldest first, as a batch carries them to another ref. */
async function reflogLinesOfRef(refs: Refs, name: string): Promise<OwnReflogLine[]> {
  const log = await refs.getReflog?.(name);
  if (!log) return [];
  return (await log.getReverseEntries()).reverse().map((entry) => ({
    oldId: entry.oldId,
    newId: entry.newId,
    ident: formatPersonIdent(entry.who),
    message: entry.comment,
  }));
}
