/**
 * The worktrees of a repository, as git keeps them: the main worktree and the linked ones,
 * each with an administrative directory (`.git/worktrees/<id>`).
 *
 * @example
 * ```typescript
 * const worktrees = workingCopy.worktrees;
 * if (!worktrees) throw new Error("this backend has no linked worktrees");
 * for (const wt of await worktrees.list()) {
 *   console.log(wt.path, wt.headRef ?? wt.head, wt.lockReason ?? "");
 * }
 * ```
 *
 * This is the storage side of `git worktree` (git's `worktree.c`): it reads and writes the
 * administrative files, and keeps the rules that are about their layout (when a worktree
 * is prunable, whether its `.git` file points back, how a new one is named). What a
 * command refuses and what it prints is the porcelain's (`vcs-commands`).
 *
 * A backend that cannot hold linked worktrees leaves `WorkingCopy.worktrees` undefined; the
 * porcelain then says the operation is unsupported.
 *
 * Paths: a path given to these methods is a path of the backend's storage (as given to
 * `WorkingCopyFactory.addWorktree`), or an absolute host path. Paths returned (`path`) are
 * what git prints and writes: absolute host paths when the backend knows where its storage
 * is on the host.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { WorkingCopy } from "../working-copy.js";

/** A worktree as git's `get_worktrees` describes it. */
export interface WorktreeInfo {
  /** The administrative directory's name (`.git/worktrees/<id>`); undefined for the main worktree. */
  readonly id?: string;
  /** Where the worktree is, as git prints it (the `gitdir` file without `/.git` for a linked one). */
  readonly path: string;
  /** The main worktree of a bare repository (no files, no HEAD shown). */
  readonly bare: boolean;
  /** The commit HEAD resolves to; undefined when it does not resolve (an unborn branch). */
  readonly head?: ObjectId;
  /** The ref HEAD points at (`refs/heads/x`), when HEAD is symbolic. */
  readonly headRef?: string;
  /** HEAD holds a commit id. */
  readonly detached: boolean;
  /** The worktree of the working copy this list was taken from. */
  readonly current: boolean;
  /**
   * The lock reason (the `locked` file, trimmed as git trims it): `""` for a lock without a
   * reason, undefined when not locked. Never set for the main worktree.
   */
  readonly lockReason?: string;
  /** The branch (`refs/heads/x`) a rebase in progress in this worktree works on. */
  readonly rebasing?: string;
  /** The branch (`refs/heads/x`) a bisect in progress in this worktree started from. */
  readonly bisecting?: string;
}

/** Why a worktree can be pruned, and where its `gitdir` file says it is (`should_prune_worktree`). */
export interface WorktreePruneCheck {
  /** The reason, as git words it; undefined when the worktree is kept. */
  readonly reason?: string;
  /** The `gitdir` file's path (the worktree's `.git`), when it was read and the worktree is kept. */
  readonly gitdirPath?: string;
}

/** What a new linked worktree's HEAD holds. */
export type NewWorktreeHead = { readonly ref: string } | { readonly id: ObjectId };

/** Options of {@link LinkedWorktrees.create}. */
export interface CreateLinkedWorktreeOptions {
  /** Where the worktree goes. */
  readonly path: string;
  /** What HEAD holds. */
  readonly head: NewWorktreeHead;
  /**
   * The lock written while the worktree is set up (git's `locked` file); `keepLocked` in
   * {@link LinkedWorktrees.finishCreate} keeps it. Default: `initializing`.
   */
  readonly lockReason?: string;
  /**
   * The identity of the HEAD reflog line (`Name <email> 1700000000 +0000`); written when
   * HEAD resolves to a commit, as git writes `logs/HEAD` on add. Default: the backend's.
   */
  readonly ident?: string;
}

/** A linked worktree that {@link LinkedWorktrees.create} set up. */
export interface CreatedLinkedWorktree {
  /** The administrative directory's name. */
  readonly id: string;
  /** Whether the worktree directory was created (it did not exist before). */
  readonly createdDirectory: boolean;
}

/** One finding of {@link LinkedWorktrees.repair}, as git's `report_repair` reports it. */
export interface WorktreeRepairReport {
  /** An error (nothing repaired) rather than a repair. */
  readonly error: boolean;
  /** The path the message is about. */
  readonly path: string;
  /** git's message (`.git file broken`, `gitdir incorrect`, ...). */
  readonly message: string;
}

/** The kind of what is at a path: git's `file_exists` / `is_empty_dir` / `is_directory`. */
export type WorktreePathState = "missing" | "empty-directory" | "directory" | "file";

/** The worktrees of a repository (the storage side of `git worktree`). */
export interface LinkedWorktrees {
  /** The main worktree first, then the linked ones whose `gitdir` file can be read (`get_worktrees`). */
  list(): Promise<WorktreeInfo[]>;

  /**
   * git's `should_prune_worktree` for `.git/worktrees/<id>`: not a directory, no or an
   * invalid `gitdir` file, or one naming a missing place whose `index` is not newer than
   * `expire` (seconds since the epoch; `Infinity` prunes every missing one). Locked: kept.
   */
  pruneCheck(id: string, expire: number): Promise<WorktreePruneCheck>;

  /** The names under `.git/worktrees`, directories or not (what `git worktree prune` walks). */
  adminIds(): Promise<string[]>;

  /** The repository directory as `prune_dups` compares it (absolute, `/.` stripped). */
  commonDirPath(): string;

  /**
   * git's `find_worktree`: a unique worktree whose path ends with `arg` at a directory
   * boundary, else the worktree at the path `arg` names.
   */
  find(arg: string): Promise<WorktreeInfo | undefined>;

  /** git's `find_worktree_by_path`: the worktree at `path`. */
  findByPath(path: string): Promise<WorktreeInfo | undefined>;

  /** The host path git writes for `path`. */
  hostPath(path: string): string;

  /** What is at `path`. */
  pathState(path: string): Promise<WorktreePathState>;

  /**
   * git's `validate_worktree`: the message why `entry` is not intact (its `.git` file
   * missing or not pointing back), undefined when it is. `missingOk` accepts a worktree
   * whose directory is gone (`WT_VALIDATE_WORKTREE_MISSING_OK`).
   */
  validate(entry: WorktreeInfo, options?: { missingOk?: boolean }): Promise<string | undefined>;

  /** git's `validate_no_submodules`: a `modules` directory, or a populated gitlink in the index. */
  hasSubmodules(entry: WorktreeInfo): Promise<boolean>;

  /**
   * git's `add_worktree` up to the checkout: the administrative directory under a name made
   * from the path's last component (`sanitize_refname_component`, numbered when taken), the
   * `locked` file, `gitdir`, the worktree's `.git` file, `commondir`, HEAD and its reflog
   * line. On a failure what it created is removed again.
   */
  create(options: CreateLinkedWorktreeOptions): Promise<CreatedLinkedWorktree>;

  /** The end of `add_worktree`: the transient lock goes unless `keepLocked`. */
  finishCreate(id: string, keepLocked: boolean): Promise<void>;

  /** git's `remove_junk`: a failed add's administrative directory and the directory it created. */
  discardCreate(created: CreatedLinkedWorktree, path: string): Promise<void>;

  /**
   * A working copy of `entry` (its HEAD, index and files). Refused for a bare main worktree
   * and for a worktree beyond this storage ({@link LinkedWorktrees.reachable}).
   */
  open(entry: WorktreeInfo): Promise<WorkingCopy>;

  /**
   * Point `entry`'s HEAD at the branch `target` (`ref: <target>`) through that worktree's
   * own ref store, without opening its working copy, and log it as git's
   * `refs_update_symref` does (`branch -m` repointing other worktrees): from the id HEAD
   * resolved to before (the zero id when it no longer resolves) to `target`'s id, when
   * `target` resolves.
   */
  updateHead(
    entry: WorktreeInfo,
    target: string,
    log: { message: string; ident?: string },
  ): Promise<void>;

  /**
   * Whether this storage can name `entry`'s directory. One outside the FilesApi's root, or
   * written through a path the root does not match (a symbolic link's target), cannot be
   * looked at: it counts as present (never pruned), and `remove` and `move` refuse it.
   */
  reachable(entry: WorktreeInfo): boolean;

  /** Write `entry`'s lock (`write_file`: a line end added when missing; an empty reason: empty file). */
  lock(entry: WorktreeInfo, reason: string): Promise<void>;

  /** Remove `entry`'s lock. */
  unlock(entry: WorktreeInfo): Promise<void>;

  /** git's `delete_git_dir`: `.git/worktrees/<id>` with its contents (or the file of that name). */
  deleteAdminDir(id: string): Promise<void>;

  /** git's `delete_worktrees_dir_if_empty`. */
  deleteAdminRootIfEmpty(): Promise<void>;

  /** git's `delete_git_work_tree`: the worktree directory with its contents. */
  deleteWorkTree(entry: WorktreeInfo): Promise<void>;

  /** Move `entry`'s directory to `destination` and point its link files there (`update_worktree_location`). */
  move(entry: WorktreeInfo, destination: string): Promise<void>;

  /**
   * git's `worktree repair`: each path's `gitdir` back-link (`repair_worktree_at_path`),
   * then every linked worktree's `.git` file (`repair_worktrees`).
   */
  repair(paths: string[]): Promise<WorktreeRepairReport[]>;
}
