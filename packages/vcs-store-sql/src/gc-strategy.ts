/**
 * SQL-backed GC strategy.
 *
 * Implements GcStrategy for SQL-backed repositories:
 * - prune: remove unreachable objects from typed stores
 * - compact: no-op (SQL storage doesn't need pack files)
 * - deltify: no-op (placeholder for Phase 5)
 * - getStats: count objects across stores
 */

import type {
  CompactResult,
  DeltaCandidatePair,
  GcStrategy,
  History,
  StorageStats,
} from "@statewalker/vcs-core";

/**
 * GcStrategy for SQL-backed repositories.
 *
 * Prunes objects through the History's typed stores (blobs, trees,
 * commits, tags). Each store's `remove()` handles the appropriate
 * SQL DELETE operations.
 *
 * @example
 * ```typescript
 * const strategy = new SqlGcStrategy(history);
 * const orchestrator = new GcOrchestrator(history, strategy);
 * await orchestrator.run();
 * ```
 */
export class SqlGcStrategy implements GcStrategy {
  constructor(private readonly history: History) {}

  async prune(unreachableIds: Set<string>): Promise<number> {
    let removed = 0;
    for (const id of unreachableIds) {
      // Try each store — only one will have the object
      if (await this.history.blobs.remove(id)) {
        removed++;
      } else if (await this.history.trees.remove(id)) {
        removed++;
      } else if (await this.history.commits.remove(id)) {
        removed++;
      } else if (await this.history.tags.remove(id)) {
        removed++;
      }
    }
    return removed;
  }

  async compact(): Promise<CompactResult> {
    // SQL storage is already compact — no pack files to consolidate
    return { packsCreated: 0, objectsPacked: 0, packsMerged: 0 };
  }

  async deltify(_candidates: DeltaCandidatePair[]): Promise<number> {
    // Placeholder for Phase 5 delta candidate selection
    return 0;
  }

  async getStats(): Promise<StorageStats> {
    let count = 0;
    for await (const _ of this.history.blobs.keys()) count++;
    for await (const _ of this.history.trees.keys()) count++;
    for await (const _ of this.history.commits.keys()) count++;
    for await (const _ of this.history.tags.keys()) count++;

    return {
      looseObjectCount: count,
      packedObjectCount: 0,
      totalSize: 0, // Would require summing row sizes
      packCount: 0,
    };
  }
}
