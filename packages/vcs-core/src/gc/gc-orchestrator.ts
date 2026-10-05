/**
 * GC orchestrator — coordinates garbage collection using a pluggable strategy.
 *
 * The orchestrator owns the algorithms:
 * 1. Collect ref tips → walk reachable objects
 * 2. Compute unreachable = all objects - reachable
 * 3. Delegate storage operations to the GcStrategy
 */

import type { ObjectId } from "../common/id/index.js";
import type { History } from "../history/history.js";
import type { CompactResult, GcStrategy, StorageStats } from "./gc-strategy.js";

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
}

/**
 * Result of a GC run.
 */
export interface GcRunResult {
  /** Number of unreachable objects removed */
  prunedObjects: number;
  /** Number of reachable objects found */
  reachableObjects: number;
  /** Compaction result (if compact was requested) */
  compactResult?: CompactResult;
  /** Number of deltas created (if aggressive was requested) */
  deltasCreated?: number;
  /** Storage statistics after GC */
  stats?: StorageStats;
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
   * 1. Collect ref tips via history.refs.list() + resolve()
   * 2. Walk reachable objects via history.collectReachableObjects()
   * 3. Compute unreachable = allStoredObjects - reachable
   * 4. Call strategy.prune(unreachable)
   * 5. Optionally call strategy.compact()
   * 6. Optionally call strategy.deltify() (aggressive mode)
   */
  async run(options: GcRunOptions = {}): Promise<GcRunResult> {
    const { dryRun = false, compact = false, aggressive = false } = options;

    // Step 1: Collect ref tips
    const refTips = await this.collectRefTips();

    // Step 2: Walk reachable objects
    const reachable = new Set<ObjectId>();
    for await (const oid of this.history.collectReachableObjects(refTips, new Set())) {
      reachable.add(oid);
    }

    // Step 3: Compute unreachable objects
    const unreachable = await this.computeUnreachable(reachable);

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
    };

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
   * Collect all ref tips (resolved to object IDs).
   */
  private async collectRefTips(): Promise<Set<ObjectId>> {
    const tips = new Set<ObjectId>();
    for await (const ref of this.history.refs.list()) {
      const resolved = await this.history.refs.resolve(ref.name);
      if (resolved?.objectId) {
        tips.add(resolved.objectId);
      }
    }
    return tips;
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
