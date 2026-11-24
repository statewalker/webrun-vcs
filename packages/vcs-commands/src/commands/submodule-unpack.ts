/**
 * unpack-trees' submodule support (`--recurse-submodules`, `submodule.recurse`): the checks
 * `check_submodule_move_head` makes in `verify_uptodate_1`, `verify_absent_1` and
 * `merged_entry`, and the moves entry.c's `checkout_entry` and `unlink_entry` make in
 * `check_updates`, for the commands that switch a superproject's index and worktree
 * (checkout, switch, reset, read-tree, restore).
 */
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { SubmoduleHeadMover } from "./submodule-commands.js";

/** An index or tree entry as the checks see it. */
interface Entry {
  objectId: ObjectId;
  mode: number;
}

/**
 * Whether a command recurses into submodules: `--[no-]recurse-submodules` when given, else
 * `submodule.recurse` (git's `config_update_recurse_submodules`).
 */
export function recursesIntoSubmodules(
  workingCopy: WorkingCopy,
  given: boolean | undefined,
): boolean {
  if (given !== undefined) return given;
  const value = RemoteConfigStore.from(workingCopy).value("submodule.recurse");
  return value === undefined ? false : parseGitBool(value) === true;
}

/**
 * One unpack-trees run's submodule handling. The checks run before anything is written and
 * record what they refuse ({@link rejected}, git's `ERROR_WOULD_LOSE_SUBMODULE`) with the
 * lines the submodules' own read-tree printed ({@link lines}); the moves run with the
 * worktree update, removals first, then (`.gitmodules` read again) the checkouts.
 */
export class SubmoduleUnpack {
  /** The lines printed while checking or moving (the child read-trees' errors, git's `error:`) */
  readonly lines: string[] = [];
  /** The paths refused as `Cannot update submodule` (ERROR_WOULD_LOSE_SUBMODULE) */
  readonly rejected: string[] = [];

  private moverLoad?: Promise<SubmoduleHeadMover>;
  private loadedMover?: SubmoduleHeadMover;
  /** submodule-commands.ts, loaded when first needed (it imports the commands this serves) */
  private commands?: typeof import("./submodule-commands.js");

  private constructor(
    private readonly workingCopy: WorkingCopy,
    /** unpack-trees' `o->reset`: the checks pass `SUBMODULE_MOVE_HEAD_FORCE` */
    readonly reset: boolean,
    /** git's `--super-prefix` of the run (its plain messages name paths with it) */
    readonly superPrefix: string,
  ) {}

  /**
   * The run's submodule handling, or undefined when the command does not recurse. The
   * `.gitmodules` the run starts with is read here, before anything changes it (git reads it
   * before its removals: `load_gitmodules_file`).
   */
  static async start(
    workingCopy: WorkingCopy,
    options: { recurse: boolean; reset: boolean; superPrefix?: string },
  ): Promise<SubmoduleUnpack | undefined> {
    if (!options.recurse || !workingCopy.worktree) return undefined;
    const unpack = new SubmoduleUnpack(workingCopy, options.reset, options.superPrefix ?? "");
    await (await unpack.m()).isSubmodule("");
    return unpack;
  }

  private async m(): Promise<SubmoduleHeadMover> {
    if (this.loadedMover) return this.loadedMover;
    this.moverLoad ??= import("./submodule-commands.js").then((commands) => {
      this.commands = commands;
      this.loadedMover = new commands.SubmoduleHeadMover(this.workingCopy, this.superPrefix);
      return this.loadedMover;
    });
    return this.moverLoad;
  }

  /** `submodule_from_ce`: a gitlink `.gitmodules` (as read now) names. */
  async isSubmodule(path: string, entry: Entry | undefined): Promise<boolean> {
    if (!entry || entry.mode !== FileMode.GITLINK) return false;
    return (await this.m()).isSubmodule(path);
  }

  /** `file_exists`. */
  async exists(path: string): Promise<boolean> {
    return (await this.m()).exists(path);
  }

  /** Whether the submodule at `path` keeps its repository in its worktree (`.git` directory). */
  async hasGitDirectory(path: string): Promise<boolean> {
    return (await this.m()).hasGitDirectory(path);
  }

  /**
   * `check_submodule_move_head` (a dry run): whether the submodule at `path` could move from
   * `oldHead` to `newHead`; a refusal is recorded. True when refused.
   */
  async refuses(path: string, oldHead: string | null, newHead: string | null): Promise<boolean> {
    const ok = await this.run(async () =>
      (await this.m()).moveHead(path, oldHead, newHead, { dryRun: true, force: this.reset }),
    );
    if (ok) return false;
    if (!this.rejected.includes(path)) this.rejected.push(path);
    return true;
  }

  /**
   * `verify_uptodate_1` of the index entry `entry` at `path`: undefined when it is not a
   * submodule there (the file checks apply), else whether it is refused (its HEAD cannot move
   * to the recorded commit: local changes, a dirty index).
   */
  async notUptodate(path: string, entry: Entry): Promise<boolean | undefined> {
    if (this.reset) return false;
    if (!(await this.isSubmodule(path, entry)) || !(await this.exists(path))) return undefined;
    return this.refuses(path, "HEAD", entry.objectId);
  }

  /**
   * `merged_entry`'s check of the entry `next` replacing `old` (none for a new path): the
   * submodule there must be able to move. True when refused.
   */
  async mergedRefuses(path: string, old: Entry | undefined, next: Entry): Promise<boolean> {
    if (!(await this.isSubmodule(path, next)) || !(await this.exists(path))) return false;
    return this.refuses(path, old?.objectId ?? null, next.objectId);
  }

  /**
   * `verify_absent_1` of a new entry `next` at `path` (with an update, without
   * `UNPACK_RESET_OVERWRITE_UNTRACKED`): undefined when not a submodule (the untracked-file
   * checks apply), else whether it is refused.
   */
  async absentRefuses(path: string, next: Entry): Promise<boolean | undefined> {
    if (!(await this.isSubmodule(path, next)) || !(await this.exists(path))) return undefined;
    return this.refuses(path, next.objectId, null);
  }

  /** `load_gitmodules_file` after `.gitmodules` was checked out. */
  reload(): void {
    this.loadedMover?.reload();
  }

  /**
   * `unlink_entry` of a gitlink `entry` leaving the index: the submodule moved to nothing
   * (forced), then its directory removed when empty.
   */
  async unlink(worktree: Worktree, path: string, entry: Entry): Promise<void> {
    if (await this.isSubmodule(path, entry)) {
      await this.run(async () => (await this.m()).moveHead(path, "HEAD", null, { force: true }));
    }
    await worktree.removeEmptyDirectory?.(path);
  }

  /** `unlink_entry`'s move of a submodule leaving the index (forced), without the rmdir. */
  async moveAway(path: string, entry: Entry): Promise<void> {
    if (!(await this.isSubmodule(path, entry))) return;
    await this.run(async () => (await this.m()).moveHead(path, "HEAD", null, { force: true }));
  }

  /**
   * `checkout_entry` of the gitlink `entry` (check_updates' `state.force`): an existing
   * submodule moved to its commit (forced), a missing or unpopulated one checked out there.
   * False when the move failed.
   */
  async checkout(worktree: Worktree, path: string, entry: Entry): Promise<boolean> {
    const kind = await (await this.m()).kind(path);
    if (!(await this.isSubmodule(path, entry))) {
      if (kind === undefined) await worktree.mkdir(path);
      return true;
    }
    if (kind === "symlink") {
      // a link git's stat follows into a repository: validate_submodule_path dies
      await this.run(async () => (await this.m()).validateLinked(path).then(() => true));
    }
    if (kind === undefined) {
      await worktree.mkdir(path);
      return this.run(async () =>
        (await this.m()).moveHead(path, null, entry.objectId, { force: true }),
      );
    }
    if (!(await (await this.m()).populated(path))) {
      if (kind !== "directory") await worktree.remove(path);
      return this.run(async () => (await this.m()).moveHead(path, null, entry.objectId, {}));
    }
    return this.run(async () =>
      (await this.m()).moveHead(path, "HEAD", entry.objectId, { force: true }),
    );
  }

  /**
   * The refusal git prints for the recorded submodules, in porcelain form (`Cannot update
   * submodule:` and the list) or plain (`Submodule '<path>' cannot checkout new HEAD.`).
   */
  refusalLines(plain: boolean): string[] {
    if (this.rejected.length === 0) return [];
    if (plain) {
      return this.rejected.map(
        (p) => `error: Submodule '${this.superPrefix}${p}' cannot checkout new HEAD.`,
      );
    }
    return [
      ["error: Cannot update submodule:", ...this.rejected.map((p) => `\t${p}`), ""].join("\n"),
    ];
  }

  /** The lines printed so far, as one text (each line ended). */
  printed(): string {
    return this.lines.join("");
  }

  /**
   * A plain (read-tree, reset) refusal of `path`: what the submodules printed, then
   * unpack-trees' own lines (`not uptodate` too when `verify_uptodate` refused it).
   */
  plainRefusal(path: string, notUptodate: boolean): string {
    const lines = [...this.refusalLines(true)];
    if (notUptodate) {
      lines.push(`error: Entry '${this.superPrefix}${path}' not uptodate. Cannot merge.`);
    }
    return `${this.printed()}${lines.join("\n")}`;
  }

  /**
   * A worktree file or link replacing the submodule at `path`: refused where its repository
   * is a `.git` directory in it (a deliberate divergence: git's `checkout_entry` removes the
   * whole directory, the submodule's only copy of its history included); else the directory
   * goes, untracked files and all, as git's `remove_subtree`. True when refused.
   */
  async fileReplacesRefuses(path: string, old: Entry): Promise<boolean> {
    if (!(await this.isSubmodule(path, old))) return false;
    if (!(await this.hasGitDirectory(path))) return false;
    if (!this.rejected.includes(path)) this.rejected.push(path);
    return true;
  }

  /** git's `remove_subtree` of a submodule's directory a file replaces. */
  async removeForFile(worktree: Worktree, path: string, old: Entry): Promise<void> {
    if (!(await this.isSubmodule(path, old))) return;
    if ((await (await this.m()).kind(path)) !== "directory") return;
    if (await this.hasGitDirectory(path)) return;
    await worktree.remove(path, { recursive: true, nonRepositoryGitDirs: true });
  }

  /** Runs a move, its printed lines kept; git's deaths propagate. */
  private async run(move: () => Promise<boolean>): Promise<boolean> {
    try {
      return await move();
    } catch (error) {
      if (this.commands && error instanceof this.commands.SubmoduleCommandError) {
        const text = `${(await this.m()).takeStderr()}${error.result.stderr}`;
        throw new GitApiError(`${text}${error.message}`);
      }
      throw error;
    } finally {
      const text = (await this.m()).takeStderr();
      if (text) this.lines.push(text);
    }
  }
}
