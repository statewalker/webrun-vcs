/**
 * Delta reverse index for base→targets relationships
 *
 * IMPORTANT: This is NOT Git's .rev file format!
 *
 * Git's .rev file format (RIDX magic) maps offset→position for pack iteration.
 * This DeltaReverseIndex maps base→targets for delta dependency tracking.
 *
 * Provides O(1) lookup for delta relationships in both directions:
 * - target → base (getBase)
 * - base → targets (getTargets)
 *
 * Built by scanning pack headers once. Must be invalidated when
 * packs are added/removed.
 *
 * Implementation note: Like Git/JGit, we keep this in-memory only.
 * Git rebuilds delta relationships during repack operations by
 * scanning pack headers - there is no native persistent format.
 *
 * See: jgit PackReverseIndexComputed (different purpose: offset→position)
 * See: jgit ObjectToPack.deltaBase (in-memory delta base tracking)
 */

import type { ObjectId } from "../common/id/index.js";

/**
 * Delta relationship entry
 */
export interface DeltaRelationship {
  target: ObjectId;
  base: ObjectId;
  depth?: number;
}

/**
 * Interface for objects that can list delta relationships
 */
export interface DeltaRelationshipSource {
  listDeltaRelationships(): AsyncIterable<{ target: ObjectId; base: ObjectId }>;
}

/**
 * In-memory reverse index for delta relationships
 */
export class DeltaReverseIndex {
  /** Map: base → Set of targets */
  private readonly baseToTargets = new Map<ObjectId, Set<ObjectId>>();

  /** Map: target → base */
  private readonly targetToBase = new Map<ObjectId, ObjectId>();

  /**
   * Build reverse index from a delta relationship source
   *
   * Scans all pack files to build the index.
   * O(n) where n = total objects in all packs.
   *
   * @param source Object that can list delta relationships
   * @returns Built reverse index
   */
  static async build(source: DeltaRelationshipSource): Promise<DeltaReverseIndex> {
    const index = new DeltaReverseIndex();

    for await (const { target, base } of source.listDeltaRelationships()) {
      index.add(target, base);
    }

    return index;
  }

  /**
   * Add a delta relationship
   *
   * @param target Target object ID (the delta)
   * @param base Base object ID (delta source)
   */
  add(target: ObjectId, base: ObjectId): void {
    this.targetToBase.set(target, base);

    let targets = this.baseToTargets.get(base);
    if (!targets) {
      targets = new Set();
      this.baseToTargets.set(base, targets);
    }
    targets.add(target);
  }

  /**
   * Remove a delta relationship
   *
   * @param target Target object ID
   * @returns True if removed
   */
  remove(target: ObjectId): boolean {
    const base = this.targetToBase.get(target);
    if (!base) return false;

    this.targetToBase.delete(target);

    const targets = this.baseToTargets.get(base);
    if (targets) {
      targets.delete(target);
      if (targets.size === 0) {
        this.baseToTargets.delete(base);
      }
    }

    return true;
  }

  /**
   * Get all targets that depend on a base (O(1))
   *
   * @param base Base object ID
   * @returns Array of target object IDs
   */
  getTargets(base: ObjectId): ObjectId[] {
    const targets = this.baseToTargets.get(base);
    return targets ? [...targets] : [];
  }

  /**
   * Get base for a target (O(1))
   *
   * @param target Target object ID
   * @returns Base object ID or undefined
   */
  getBase(target: ObjectId): ObjectId | undefined {
    return this.targetToBase.get(target);
  }

  /**
   * Check if base has any dependents (O(1))
   *
   * Critical for GC - can't delete objects with dependents.
   *
   * @param base Base object ID
   * @returns True if has dependents
   */
  hasTargets(base: ObjectId): boolean {
    const targets = this.baseToTargets.get(base);
    return targets !== undefined && targets.size > 0;
  }

  /**
   * Check if target is a delta (O(1))
   *
   * @param target Target object ID
   * @returns True if stored as delta
   */
  isDelta(target: ObjectId): boolean {
    return this.targetToBase.has(target);
  }

  /**
   * Get number of delta relationships
   */
  get size(): number {
    return this.targetToBase.size;
  }

  /**
   * Iterate all relationships
   */
  *entries(): IterableIterator<DeltaRelationship> {
    for (const [target, base] of this.targetToBase) {
      yield { target, base };
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.baseToTargets.clear();
    this.targetToBase.clear();
  }
}
