import type { ObjectId } from "@statewalker/vcs-core";
import { parseGitInt } from "@statewalker/vcs-utils";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { WorktreePruneCommand } from "./worktree-prune-command.js";

/**
 * Result of garbage collection
 */
export interface GCCommandResult {
  /** Number of objects removed */
  objectsRemoved: number;
  /** Bytes freed by removing objects */
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
   * housekeeping needed (`not-needed`, gc.auto 0 included), or the pre-auto-gc hook refused
   * it (`hook`)
   */
  autoSkipped?: "not-needed" | "hook";
  /** `setAuto(true)` and run: git's "Auto packing the repository ..." lines (its stderr) */
  messages?: string[];
  /**
   * git's error lines (its stderr): first the alternates' (`alternatesErrors()`, once: git's
   * repack and prune children repeat them), then those while packing refs (also in the hook
   * output): a loose ref whose object is missing stays loose, a ref changed before its prune
   * keeps its loose file
   */
  errors?: string[];
}

/** git's defaults: `gc.auto` loose objects, `gc.autoPackLimit` packs. */
const GC_AUTO_DEFAULT = 6700;
const GC_AUTO_PACK_LIMIT_DEFAULT = 50;

/**
 * Run garbage collection on the repository.
 *
 * Equivalent to `git gc`.
 *
 * Garbage collection removes unreachable objects and optimizes
 * repository storage. This includes:
 * - Removing objects not reachable from any ref
 * - Packing loose refs into packed-refs
 * - Repacking objects into pack files (optional)
 *
 * Based on JGit's GarbageCollectCommand.
 *
 * @example
 * ```typescript
 * // Basic garbage collection
 * const result = await git.gc().call();
 * console.log(`Removed ${result.objectsRemoved} objects`);
 *
 * // Aggressive GC with repacking
 * const result = await git.gc()
 *   .setAggressive(true)
 *   .call();
 *
 * // GC with expiration date (keep recent unreachable objects)
 * const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
 * const result = await git.gc()
 *   .setExpire(twoWeeksAgo)
 *   .call();
 * ```
 */
export class GarbageCollectCommand extends GitCommand<GCCommandResult> {
  private _packRefs = true;

  /** git's fsck and gc read the objects as stored, never through replace refs. */
  protected override readsReplacedObjects(): boolean {
    return false;
  }
  private _aggressive = false;
  private _expire?: Date;
  private _auto = false;

  /**
   * `git gc --auto`: housekeeping only when needed (git's `need_to_gc`: more loose objects
   * than `gc.auto`, estimated from `objects/17` as git does, default 6700, or more packs
   * without a `.keep` than `gc.autoPackLimit`, default 50; 0 or less turns either check
   * off, `gc.auto=0` all of auto gc), and only when the pre-auto-gc hook, run first, agrees.
   * No command runs it by itself: callers decide when (git's `maintenance.auto` after a
   * commit, merge or fetch is not reproduced).
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

  /**
   * Whether `gc --auto` has work to do (git's `need_to_gc` / `odb_optimize_required` for the
   * incremental strategy), read from the common directory's `objects/`.
   */
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
    const inSeventeen = (await names("17")).filter((n) => /^[0-9a-f]{38}$/.test(n)).length;
    return inSeventeen * 256 > Math.ceil(gcAuto / 256) * 256;
  }

  /**
   * Set aggressive mode.
   *
   * In aggressive mode, GC will also repack objects for better compression.
   *
   * @param aggressive Whether to run aggressive GC
   */
  setAggressive(aggressive: boolean): this {
    this.checkCallable();
    this._aggressive = aggressive;
    return this;
  }

  /**
   * Set whether to pack refs.
   *
   * When true (default), loose refs are packed into packed-refs.
   *
   * @param packRefs Whether to pack refs
   */
  setPackRefs(packRefs: boolean): this {
    this.checkCallable();
    this._packRefs = packRefs;
    return this;
  }

  /**
   * Set expiration date for unreachable objects.
   *
   * Objects unreachable but modified after this date will not be deleted.
   * This provides a grace period to prevent deleting objects that might
   * still be needed by in-progress operations.
   *
   * @param expire Expiration date (objects older than this may be deleted)
   */
  setExpire(expire: Date): this {
    this.checkCallable();
    this._expire = expire;
    return this;
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
    const objectsRemoved = 0;
    const bytesFreed = 0;
    let refsPacked = false;
    const messages: string[] = [];
    if (this._auto) {
      const skipped = (autoSkipped: "not-needed" | "hook"): GCCommandResult => ({
        objectsRemoved,
        bytesFreed,
        refsPacked,
        durationMs: Date.now() - startTime,
        worktreesPruned: [],
        autoSkipped,
      });
      if (!(await this.needsAutoGc())) return skipped("not-needed");
      // git's `gc --auto`: the pre-auto-gc hook may refuse the housekeeping
      const hook = await this.hooks.run("pre-auto-gc");
      if (hook && hook.exitCode !== 0) return skipped("hook");
      messages.push(
        "Auto packing the repository for optimum performance.",
        'See "git help gc" for manual housekeeping.',
      );
    }

    // Collect all ref roots
    const roots: ObjectId[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      if ("objectId" in ref && ref.objectId) {
        roots.push(ref.objectId);
      }
    }

    // Also include HEAD if it points to a commit
    const head = await this.refsStore.resolve("HEAD");
    if (head?.objectId) {
      roots.push(head.objectId);
    }

    // Run garbage collection if GCController is available
    // Note: This requires access to the Repository's gc property
    // For now, we'll check if the ref store supports the gc operations

    // Check if refs support packRefs
    // (`pack-refs --all --prune`; git 2.5x's `gc --auto` adds `--auto`, should_pack_refs)
    const errors: string[] = [];
    if (this._packRefs && this.refsStore.packRefs) {
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
    }

    // git gc prunes the administrative files of gone worktrees (gc.worktreePruneExpire)
    const worktreesPruned: string[] = [];
    if (this.workingCopy.worktrees) {
      const expire =
        RemoteConfigStore.from(this.workingCopy).value("gc.worktreePruneExpire") ?? "3.months.ago";
      const { pruned } = await new WorktreePruneCommand(this.workingCopy).setExpire(expire).call();
      for (const p of pruned) worktreesPruned.push(p.id);
    }

    // Note: Full GC requires Repository.gc which provides access to
    // GCController with collectGarbage(). This command provides the
    // interface but full implementation requires Repository access.
    // The WorkingCopy interface doesn't expose gc, so we'd need to extend
    // the interface or use a different pattern.

    // For aggressive mode, we could trigger repack here
    // But that also requires access to the GCController
    // Reserved for future implementation:
    // - this._aggressive: trigger full repack with better compression
    // - this._expire: pass to collectGarbage() for expiration filtering
    void this._aggressive;
    void this._expire;

    return {
      objectsRemoved,
      bytesFreed,
      refsPacked,
      durationMs: Date.now() - startTime,
      worktreesPruned,
      ...(this._auto ? { messages } : {}),
      ...(errors.length > 0 || this.alternatesErrors().length > 0
        ? { errors: [...this.alternatesErrors(), ...errors] }
        : {}),
    };
  }
}
