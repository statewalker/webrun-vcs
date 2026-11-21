/**
 * GC orchestrator — coordinates garbage collection using a pluggable strategy.
 *
 * The orchestrator owns the algorithms:
 * 1. Collect the roots (refs, HEAD, reflogs, and what the strategy adds: the index, linked
 *    worktrees) → walk reachable objects; a reachable object that is corrupt or missing aborts
 * 2. Compute unreachable = all objects - reachable - recent objects and what they reach
 * 3. Delegate storage operations to the GcStrategy
 */

import type { ObjectId } from "../common/id/index.js";
import { readGraftParents } from "../history/commits/index.js";
import { historyWithoutLazyFetch } from "../history/create-history.js";
import type { History } from "../history/history.js";
import type { CompactResult, GcStrategy, StorageStats } from "./gc-strategy.js";

const ZERO_ID = "0".repeat(40);

/**
 * Options for a GC run.
 */
export interface GcRunOptions {
  /** If true, report what would be done without modifying storage */
  dryRun?: boolean;
  /** If true, also run compaction after pruning */
  compact?: boolean;
  /** If true, run aggressive optimization (deltification) */
  aggressive?: boolean;
  /**
   * Remove leftovers of interrupted writes (temporaries, orphaned chunks) older
   * than this. Default `DEFAULT_STALE_EXPIRY_MS` (two weeks, git's prune expiry).
   * 0 removes every leftover not in use by a write running in this process;
   * use it only when no other process writes to the store.
   */
  staleExpiryMs?: number;
  /**
   * The grace period of unreachable objects (git's `gc.pruneExpire`, `git prune --expire`).
   * Unreachable objects the strategy reports as written more recently than this
   * (`GcStrategy.recentObjects`) are kept, with everything they reach, as git keeps recent
   * objects: they may belong to a write in progress whose ref is not updated yet. Default
   * `DEFAULT_GC_PRUNE_EXPIRE_MS` (two weeks); 0 prunes every unreachable object
   * (`--prune=now`). Strategies that cannot tell an object's age (memory, SQL) keep none.
   */
  pruneExpireMs?: number;
  /**
   * Read every reachable blob to its end and check its length before pruning (default true),
   * so a truncated blob aborts the run. Prune only removes unreachable objects, so turning it
   * off risks no data loss; it only reports such corruption later, as `git gc` does.
   */
  verifyBlobs?: boolean;
  /**
   * Reads the grafts file in place of the repository's `info/grafts` (git's `GIT_GRAFT_FILE`;
   * `graftFileReader(environment)` makes one): what its grafts reach is kept, as native gc
   * run with that variable keeps it. Omit to read `info/grafts` (`refs.readGrafts`).
   */
  readGraftFile?: () => Promise<string | undefined>;
}

/** Default `GcRunOptions.pruneExpireMs`: two weeks, git's `gc.pruneExpire`. */
export const DEFAULT_GC_PRUNE_EXPIRE_MS = 14 * 24 * 60 * 60 * 1000;

/** Default `GcRunOptions.staleExpiryMs`: two weeks, as `git gc` prunes `tmp_obj_*`. */
export const DEFAULT_STALE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Result of a GC run.
 */
export interface GcRunResult {
  /** Number of unreachable objects removed */
  prunedObjects: number;
  /** Number of reachable objects found */
  reachableObjects: number;
  /** Unreachable objects kept as recent (`pruneExpireMs`), with the objects they reach */
  keptRecentObjects?: number;
  /** Compaction result (if compact was requested) */
  compactResult?: CompactResult;
  /** Number of deltas created (if aggressive was requested) */
  deltasCreated?: number;
  /** Storage statistics after GC */
  stats?: StorageStats;
  /** Leftovers of interrupted writes removed (`GitObjects.sweepStale`, `GcStrategy.sweepStale`) */
  removedTemporaries?: number;
}

/**
 * Orchestrates garbage collection using a pluggable GcStrategy.
 *
 * @example
 * ```typescript
 * const orchestrator = new GcOrchestrator(history, fileGcStrategy);
 * const result = await orchestrator.run({ compact: true });
 * console.log(`Pruned ${result.prunedObjects} objects`);
 * ```
 */
export class GcOrchestrator {
  constructor(
    private readonly history: History,
    private readonly strategy: GcStrategy,
  ) {}

  /**
   * Run garbage collection.
   *
   * Flow:
   * 1. Collect the roots: every ref and HEAD (`history.refs`), the old and new ids of their
   *    reflogs (`refs.getReflog`), and the strategy's own (`GcStrategy.collectRoots`: on files,
   *    the index, every reflog file and the linked worktrees)
   * 2. Walk reachable objects via history.collectReachableObjects() with `missing: "throw"`
   *    and the shallow commits: a reachable object that is missing or cannot be read throws
   *    (`MissingObjectError`, `CorruptObjectError`) before anything is pruned, as `git gc` fails.
   *    Blobs are read to their end and their length checked (`verifyBlobs`), so a truncated
   *    blob aborts too; beyond the shallow boundary objects are optional
   * 3. Compute unreachable = allStoredObjects - reachable, then keep the recent ones
   *    (`GcStrategy.recentObjects`, `pruneExpireMs`) and everything they reach
   * 4. Call strategy.prune(unreachable), then sweep stale temporaries
   *    (`history.objects.sweepStale`, `strategy.sweepStale`)
   * 5. Optionally call strategy.compact()
   * 6. Optionally call strategy.deltify() (aggressive mode)
   */
  async run(options: GcRunOptions = {}): Promise<GcRunResult> {
    const {
      dryRun = false,
      compact = false,
      aggressive = false,
      staleExpiryMs = DEFAULT_STALE_EXPIRY_MS,
      pruneExpireMs = DEFAULT_GC_PRUNE_EXPIRE_MS,
    } = options;

    // Step 1: Collect the roots
    const { roots, shallow, grafts, keep } = await this.collectRoots(options.readGraftFile);
    // the walks read no absent object of a partial clone (git's fetch_if_missing = 0)
    const history = historyWithoutLazyFetch(this.history);

    // Step 2: Walk reachable objects; a missing or corrupt one throws before anything changes
    const reachable = new Set<ObjectId>();
    for await (const oid of history.collectReachableObjects(roots, new Set(), {
      missing: "throw",
      shallow,
      grafts,
      verifyBlobs: options.verifyBlobs ?? true,
      known: keep,
    })) {
      reachable.add(oid);
    }

    // Step 3: Compute unreachable objects, less the kept and the recent ones and what they reach
    const unreachable = await this.computeUnreachable(reachable);
    for (const id of keep) unreachable.delete(id);
    let keptRecentObjects = 0;
    if (unreachable.size > 0 && pruneExpireMs > 0 && this.strategy.recentObjects) {
      const recent = await this.strategy.recentObjects(new Set(unreachable), pruneExpireMs);
      if (recent.size > 0) {
        // git's add_unseen_recent_objects_to_traversal: what a recent object reaches stays
        // too; it may lead to objects that are gone (ignore_missing_links)
        const known = new Set([...reachable, ...keep]);
        for await (const oid of history.collectReachableObjects(recent, new Set(), {
          shallow,
          grafts,
          known,
        })) {
          if (unreachable.delete(oid)) keptRecentObjects++;
        }
      }
    }

    // Step 4: Prune
    let prunedObjects = 0;
    if (unreachable.size > 0 && !dryRun) {
      prunedObjects = await this.strategy.prune(unreachable);
    } else {
      prunedObjects = unreachable.size;
    }

    const result: GcRunResult = {
      prunedObjects,
      reachableObjects: reachable.size,
      keptRecentObjects,
    };

    // Step 4b: leftovers of interrupted writes (mem, KV and SQL raw stores; SQL native blobs)
    if (!dryRun) {
      result.removedTemporaries =
        ((await this.history.objects?.sweepStale?.({ olderThanMs: staleExpiryMs })) ?? 0) +
        ((await this.strategy.sweepStale?.(staleExpiryMs)) ?? 0);
    }

    // Step 5: Compact
    if (compact && !dryRun) {
      result.compactResult = await this.strategy.compact();
    }

    // Step 6: Aggressive deltification (placeholder — candidates from Phase 5)
    if (aggressive && !dryRun) {
      result.deltasCreated = await this.strategy.deltify([]);
    }

    // Collect final stats
    result.stats = await this.strategy.getStats();

    return result;
  }

  /**
   * The roots of reachability, as git's `mark_reachable_objects`: every ref, HEAD (detached
   * too), the old and new ids of the reflog entries of those refs and HEAD, and what the
   * strategy adds (`GcStrategy.collectRoots`); and the shallow commits, from the refs and the
   * strategy. Roots that are not stored are skipped by the walk (a reflog may name objects
   * pruned long ago, git ignores a broken ref). And the grafts (`info/grafts`, or the file
   * `readGraftFile` reads): a grafted commit's grafted parents are walked as well as its
   * recorded ones, as git's gc keeps both; a shallow commit's graft is overridden.
   */
  private async collectRoots(readGraftFile?: () => Promise<string | undefined>): Promise<{
    roots: Set<ObjectId>;
    shallow: Set<ObjectId>;
    grafts: Map<ObjectId, ObjectId[]>;
    keep: Set<ObjectId>;
  }> {
    const refs = this.history.refs;
    const roots = new Set<ObjectId>();
    const add = (id: ObjectId | undefined) => {
      if (id && id !== ZERO_ID) roots.add(id);
    };
    const names = new Set<string>(["HEAD"]);
    for await (const ref of refs.list()) names.add(ref.name);
    for (const name of names) {
      add((await refs.resolve(name))?.objectId);
      const log = await refs.getReflog?.(name);
      for (const entry of (await log?.getReverseEntries()) ?? []) {
        add(entry.oldId);
        add(entry.newId);
      }
    }
    const shallow = new Set<ObjectId>((await refs.getShallow?.()) ?? []);
    const extra = await this.strategy.collectRoots?.();
    for (const id of extra?.roots ?? []) add(id);
    for (const id of extra?.shallow ?? []) shallow.add(id);
    const grafts = await readGraftParents(refs, readGraftFile);
    const keep = new Set<ObjectId>(extra?.keep ?? []);
    return { roots, shallow, grafts, keep };
  }

  /**
   * Find all stored objects that are not in the reachable set.
   *
   * Delegates to the strategy's getStats-like enumeration.
   * Uses history stores to list all known objects.
   */
  private async computeUnreachable(reachable: Set<ObjectId>): Promise<Set<ObjectId>> {
    const unreachable = new Set<ObjectId>();

    // Enumerate all objects via history stores
    for await (const id of this.history.blobs.keys()) {
      if (!reachable.has(id)) unreachable.add(id);
    }
    for await (const id of this.history.trees.keys()) {
      if (!reachable.has(id)) unreachable.add(id);
    }
    for await (const id of this.history.commits.keys()) {
      if (!reachable.has(id)) unreachable.add(id);
    }
    for await (const id of this.history.tags.keys()) {
      if (!reachable.has(id)) unreachable.add(id);
    }

    return unreachable;
  }
}
