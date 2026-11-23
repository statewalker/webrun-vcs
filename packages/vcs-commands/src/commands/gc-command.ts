import type { FilesApi, History } from "@statewalker/vcs-core";
import { type GcResult, parseExpiryDate, gc as storeGc } from "@statewalker/vcs-store-files";
import { parseGitInt } from "@statewalker/vcs-utils";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { WorktreePruneCommand } from "./worktree-prune-command.js";

/**
 * Result of garbage collection
 */
export interface GCCommandResult {
  /**
   * Objects the repository no longer stores: distinct object ids (loose or packed) in its own
   * objects directory before the gc, less those after it. 0 without a files backend.
   */
  objectsRemoved: number;
  /**
   * Bytes freed in the objects directory (loose object files and the pack directory's files),
   * before less after: negative when the gc made it grow (a cruft pack beside packs kept)
   */
  bytesFreed: number;
  /** Whether refs were packed */
  refsPacked: boolean;
  /** Duration of the GC operation in milliseconds */
  durationMs: number;
  /**
   * The linked worktrees whose administrative files were pruned (`git worktree prune
   * --expire <gc.worktreePruneExpire>`, default `3.months.ago`), where the backend keeps them.
   */
  worktreesPruned: string[];
  /**
   * `setAuto(true)` only: why nothing was done (git's `gc --auto` returning at once): no
   * housekeeping needed (`not-needed`, gc.auto 0 included), the pre-auto-gc hook refused
   * it (`hook`), or another gc holds `gc.pid` (`running`)
   */
  autoSkipped?: "not-needed" | "hook" | "running";
  /** `setAuto(true)` and run: git's "Auto packing the repository ..." lines (its stderr) */
  messages?: string[];
  /**
   * git's error lines (its stderr): first the alternates' (`alternatesErrors()`, once: git's
   * repack and prune children repeat them), then those while packing refs (also in the hook
   * output): a loose ref whose object is missing stays loose, a ref changed before its prune
   * keeps its loose file; then the reflog expiry's
   */
  errors?: string[];
  /** git's warnings (a bitmap not written, `--auto`'s "too many unreachable loose objects") */
  warnings?: string[];
  /**
   * What the store's gc did (repack, prune, reflog expiry, rerere gc, commit-graph), where the
   * repository is a files repository; absent otherwise (only refs and worktrees are handled)
   */
  details?: GcResult;
}

/** git's defaults: `gc.auto` loose objects, `gc.autoPackLimit` packs. */
const GC_AUTO_DEFAULT = 6700;
const GC_AUTO_PACK_LIMIT_DEFAULT = 50;

/**
 * Run garbage collection on the repository: `git gc`.
 *
 * Over a files repository it runs what `git gc` runs, in git's order (builtin/gc.c): `pack-refs
 * --all --prune` (`gc.packRefs`), `reflog expire --all` (`gc.reflogExpire*`), `worktree prune
 * --expire <gc.worktreePruneExpire>` and `rerere gc` (`gc.rerereResolved`/`Unresolved`), the
 * repack (`repack -d -l` with `--cruft --cruft-expiration=<gc.pruneExpire>` (`gc.cruftPacks`,
 * default), `-A --unpack-unreachable=<expire>` without cruft packs, or `-a` for `--prune=now`;
 * `--keep-pack` for `--keep-largest-pack`/`gc.bigPackThreshold`; `-f --depth --window` for
 * `--aggressive`; a bitmap in a bare repository), `update-server-info`, `prune --expire
 * <expire>` (with `prune_shallow`), and the commit-graph (`gc.writeCommitGraph`). git 2.43 runs
 * the worktree prune and rerere gc after the prune, 2.5x before the repack: the hook runner's
 * compatibility decides. Without a files repository only refs are packed and worktrees pruned.
 *
 * @example
 * ```typescript
 * const result = await git.gc().call();
 * console.log(`Removed ${result.objectsRemoved} objects`);
 *
 * // git gc --aggressive --prune=now
 * await git.gc().setAggressive(true).setPrune("now").call();
 *
 * // git gc --no-prune
 * await git.gc().setPrune(false).call();
 * ```
 */
export class GarbageCollectCommand extends GitCommand<GCCommandResult> {
  private _packRefs?: boolean;

  /** git's fsck and gc read the objects as stored, never through replace refs. */
  protected override readsReplacedObjects(): boolean {
    return false;
  }
  private _aggressive = false;
  private _expire?: Date;
  private _prune?: string | boolean;
  private _auto = false;
  private _quiet = false;
  private _cruft?: boolean;
  private _maxCruftSize?: number;
  private _keepLargestPack?: boolean;
  private _force = false;

  /**
   * `git gc --auto`: housekeeping only when needed (git's `need_to_gc`: more loose objects
   * than `gc.auto`, estimated from `objects/17` as git does, default 6700, or more packs
   * without a `.keep` than `gc.autoPackLimit`, default 50; 0 or less turns either check
   * off, `gc.auto=0` all of auto gc), and only when the pre-auto-gc hook, run first, agrees.
   * With too many packs the repack is a full one, else an incremental one (the reachable loose
   * objects into a new pack). No command runs it by itself: callers decide when (git's
   * `maintenance.auto` after a commit, merge or fetch is not reproduced).
   *
   * @example
   * ```typescript
   * const result = await git.gc().setAuto(true).call();
   * if (result.autoSkipped) console.log(`nothing done: ${result.autoSkipped}`);
   * ```
   */
  setAuto(auto: boolean): this {
    this.checkCallable();
    this._auto = auto;
    return this;
  }

  /** `--quiet`: no "Auto packing the repository ..." messages. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this._quiet = quiet;
    return this;
  }

  /**
   * `--prune=<date>` (a git expiry date: `now`, `never`, `2.weeks.ago`, a `Date`), `--prune`
   * (true: `gc.pruneExpire`, default two weeks) or `--no-prune` (false: nothing unreachable
   * expires, `git prune` does not run).
   */
  setPrune(prune: string | Date | boolean): this {
    this.checkCallable();
    if (prune instanceof Date) this._expire = prune;
    else this._prune = prune;
    return this;
  }

  /** `--cruft` / `--no-cruft` (default `gc.cruftPacks`, true). */
  setCruft(cruft: boolean): this {
    this.checkCallable();
    this._cruft = cruft;
    return this;
  }

  /** `--max-cruft-size=<bytes>` (default `gc.maxCruftSize`). */
  setMaxCruftSize(bytes: number): this {
    this.checkCallable();
    this._maxCruftSize = bytes;
    return this;
  }

  /**
   * `--keep-largest-pack` (true) / `--no-keep-largest-pack` (false): the largest non-cruft
   * pack is kept as it is; false also ignores `gc.bigPackThreshold`.
   */
  setKeepLargestPack(keep: boolean): this {
    this.checkCallable();
    this._keepLargestPack = keep;
    return this;
  }

  /** git's `need_to_gc`: whether `gc --auto` has work to do. */
  private async needsAutoGc(): Promise<boolean> {
    const config = RemoteConfigStore.from(this.workingCopy);
    // git_config_int: k, m and g units, hex and octal; git dies on anything else
    const int = (key: string, fallback: number) => {
      const value = config.value(key);
      if (value === undefined) return fallback;
      const n = parseGitInt(value);
      if (n === undefined) {
        throw new GitApiError(
          `fatal: bad numeric config value '${value}' for '${key.toLowerCase()}': invalid unit`,
        );
      }
      return n;
    };
    const gcAuto = int("gc.auto", GC_AUTO_DEFAULT);
    if (gcAuto <= 0) return false;
    const packLimit = int("gc.autoPackLimit", GC_AUTO_PACK_LIMIT_DEFAULT);
    const objects = await this.hooks.commonGitFile("objects");
    if (!objects) return false;
    const names = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      try {
        for await (const info of objects.files.list(`${objects.path}/${dir}`)) out.push(info.name);
      } catch {
        // a directory that cannot be listed counts as empty
      }
      return out;
    };
    if (packLimit > 0) {
      const files = new Set(await names("pack"));
      let packs = 0;
      // too_many_packs counts the packs git loads (a `.idx` with its `.pack`), not kept
      for (const name of files) {
        if (!name.endsWith(".pack")) continue;
        const base = name.slice(0, -5);
        if (files.has(`${base}.idx`) && !files.has(`${base}.keep`)) packs++;
      }
      if (packs > packLimit) return true;
    }
    // the loose objects estimated from one fan-out directory, against the limit rounded up
    // to a multiple of 256
    // names of the repository's format only (git's for_each_loose_file_in_objdir)
    const loose = new RegExp(`^[0-9a-f]{${this.objectFormat.hexLength - 2}}$`);
    const inSeventeen = (await names("17")).filter((n) => loose.test(n)).length;
    return inSeventeen * 256 > Math.ceil(gcAuto / 256) * 256;
  }

  /**
   * `--force`: run even when `gc.pid` says another gc is running (git's `lock_repo_for_gc`
   * with `force`); `gc.pid.lock` must still be free.
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this._force = force;
    return this;
  }

  /**
   * `--aggressive`: deltas searched again (`repack -f`) with `gc.aggressiveWindow` (250) and
   * `gc.aggressiveDepth` (50).
   */
  setAggressive(aggressive: boolean): this {
    this.checkCallable();
    this._aggressive = aggressive;
    return this;
  }

  /**
   * Whether to pack refs (`git pack-refs --all --prune`). Default: `gc.packRefs` (true;
   * `notbare` packs them only in a repository with a worktree).
   */
  setPackRefs(packRefs: boolean): this {
    this.checkCallable();
    this._packRefs = packRefs;
    return this;
  }

  /**
   * `--prune=<date>`: unreachable objects older than this date expire; younger ones stay
   * (loose, or in a cruft pack) in case a write in progress needs them.
   */
  setExpire(expire: Date): this {
    this.checkCallable();
    this._expire = expire;
    return this;
  }

  /** The repository's files backend: its FilesApi, common git directory and history. */
  private async filesRepository(): Promise<
    { files: FilesApi; gitDir: string; history: History } | undefined
  > {
    const history = this.workingCopy.history as History | undefined;
    if (!history?.objects || !history.packs) return undefined;
    const objects = await this.hooks.commonGitFile("objects");
    if (!objects) return undefined;
    return { files: objects.files, gitDir: objects.path.replace(/\/?objects$/, ""), history };
  }

  /** The prune expiry in milliseconds before now, undefined for the config's. */
  private pruneExpireMs(): number | undefined {
    if (this._expire) return Math.max(0, Date.now() - this._expire.getTime());
    if (typeof this._prune !== "string") return undefined;
    const nowMs = Date.now();
    const cutoff = parseExpiryDate(this._prune, Math.floor(nowMs / 1000), "--prune");
    if (cutoff === 0) return Number.POSITIVE_INFINITY;
    if (cutoff === Number.POSITIVE_INFINITY) return 0;
    return Math.max(0, nowMs - cutoff * 1000);
  }

  /** `gc.packRefs`: a boolean, or `notbare` (packed unless the repository is bare). */
  private packRefsConfigured(): boolean {
    if (this._packRefs !== undefined) return this._packRefs;
    const config = RemoteConfigStore.from(this.workingCopy);
    const value = config.value("gc.packRefs");
    if (value === undefined) return true;
    if (value === "notbare") {
      const bare = config.value("core.bare");
      return !(bare !== undefined && (parseGitBool(bare) ?? false));
    }
    return parseGitBool(value) ?? true;
  }

  /**
   * Execute the garbage collection.
   *
   * @returns GC result with statistics
   */
  async call(): Promise<GCCommandResult> {
    this.checkCallable();
    this.setCallable(false);

    const startTime = Date.now();
    let refsPacked = false;
    const messages: string[] = [];
    const skipped = (autoSkipped: "not-needed" | "hook" | "running"): GCCommandResult => ({
      objectsRemoved: 0,
      bytesFreed: 0,
      refsPacked,
      durationMs: Date.now() - startTime,
      worktreesPruned: [],
      autoSkipped,
    });
    if (this._auto) {
      if (!(await this.needsAutoGc())) return skipped("not-needed");
      // git's `gc --auto`: the pre-auto-gc hook may refuse the housekeeping
      const hook = await this.hooks.run("pre-auto-gc");
      if (hook && hook.exitCode !== 0) return skipped("hook");
      if (!this._quiet)
        messages.push(
          "Auto packing the repository for optimum performance.",
          'See "git help gc" for manual housekeeping.',
        );
    }

    // `pack-refs --all --prune` (git 2.5x's `gc --auto` adds `--auto`, should_pack_refs)
    const errors: string[] = [];
    const packRefs = async () => {
      if (!this.refsStore.packRefs) return;
      await this.refsStore.packRefs([], {
        all: true,
        deleteLoose: true,
        ...(this._auto && this.hooks.compatibility !== "2.43" ? { auto: true } : {}),
        onError: (line) => {
          errors.push(line);
          this.hooks.append(`${line}\n`);
        },
      });
      refsPacked = true;
    };

    // `worktree prune --expire <gc.worktreePruneExpire>`
    const worktreesPruned: string[] = [];
    const pruneWorktrees = async () => {
      if (!this.workingCopy.worktrees) return;
      const expire =
        RemoteConfigStore.from(this.workingCopy).value("gc.worktreePruneExpire") ?? "3.months.ago";
      const { pruned } = await new WorktreePruneCommand(this.workingCopy).setExpire(expire).call();
      for (const p of pruned) worktreesPruned.push(p.id);
    };

    const repository = await this.filesRepository();
    if (!repository) {
      // no files backend: refs and worktrees only
      if (this.packRefsConfigured()) await packRefs();
      await pruneWorktrees();
      return {
        objectsRemoved: 0,
        bytesFreed: 0,
        refsPacked,
        durationMs: Date.now() - startTime,
        worktreesPruned,
        ...(this._auto ? { messages } : {}),
        ...(errors.length > 0 || this.alternatesErrors().length > 0
          ? { errors: [...this.alternatesErrors(), ...errors] }
          : {}),
      };
    }

    const environment = hostEnvironmentOf(this.workingCopy);
    const pruneExpireMs = this.pruneExpireMs();
    const details = await storeGc({
      history: repository.history,
      files: repository.files,
      gitDir: repository.gitDir,
      compatibility: this.hooks.compatibility,
      ...(environment ? { environment } : {}),
      packRefs: this.packRefsConfigured(),
      packRefsStep: packRefs,
      beforeObjects: pruneWorktrees,
      afterObjects: pruneWorktrees,
      ...(this._prune === false ? { prune: false } : {}),
      ...(pruneExpireMs !== undefined ? { pruneExpireMs } : {}),
      ...(this._cruft !== undefined ? { cruftPacks: this._cruft } : {}),
      ...(this._maxCruftSize !== undefined ? { maxCruftSize: this._maxCruftSize } : {}),
      ...(this._keepLargestPack !== undefined ? { keepLargestPack: this._keepLargestPack } : {}),
      ...(this._aggressive ? { aggressive: true } : {}),
      ...(this._auto ? { auto: true } : {}),
      ...(this._force ? { force: true } : {}),
    });
    if (details.skipped) {
      // hold_lock_file_for_update(LOCK_DIE_ON_ERROR) dies, --auto too
      if (details.lockFileExists) throw new GitApiError(this.gcLockFileMessage());
      if (this._auto) return skipped("running");
      const holder = details.lockHolder;
      throw new GitApiError(
        `fatal: gc is already running on machine '${holder?.machine}' pid ${holder?.pid} (use --force if not)`,
      );
    }
    const storage = details.storage;
    const allErrors = [...this.alternatesErrors(), ...errors, ...(details.errors ?? [])];
    // the alternates' lines come once (the store's gc repeats them)
    const uniqueErrors = allErrors.filter(
      (line, i) => !this.alternatesErrors().includes(line) || allErrors.indexOf(line) === i,
    );
    return {
      objectsRemoved: storage ? storage.before.objects - storage.after.objects : 0,
      bytesFreed: storage ? storage.before.bytes - storage.after.bytes : 0,
      refsPacked,
      durationMs: Date.now() - startTime,
      worktreesPruned,
      ...(this._auto ? { messages } : {}),
      ...(uniqueErrors.length > 0 ? { errors: uniqueErrors } : {}),
      ...(details.warnings ? { warnings: details.warnings } : {}),
      details,
    };
  }

  /** git's `unable_to_lock_die` for `gc.pid.lock` (2.43's longer advice under its compatibility). */
  private gcLockFileMessage(): string {
    const gitDir = (this.workingCopy as { config?: { hostGitDir?: string } }).config?.hostGitDir;
    const path = gitDir ? `${gitDir.replace(/\/+$/, "")}/gc.pid.lock` : ".git/gc.pid.lock";
    const advice =
      this.hooks.compatibility === "2.43"
        ? "Another git process seems to be running in this repository, e.g.\n" +
          "an editor opened by 'git commit'. Please make sure all processes\n" +
          "are terminated then try again. If it still fails, a git process\n" +
          "may have crashed in this repository earlier:\n" +
          "remove the file manually to continue."
        : "Another git process seems to be running in this repository, or the lock file may be stale";
    return `fatal: Unable to create '${path}': File exists.\n\n${advice}`;
  }
}
