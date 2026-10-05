/**
 * In-memory GC strategy for testing.
 *
 * Prunes objects from a RawStorage, with no-op compaction and deltification.
 * Used to test GcOrchestrator without file or SQL dependencies.
 */

import type { RawStorage } from "../storage/raw/raw-storage.js";
import type { CompactResult, DeltaCandidatePair, GcStrategy, StorageStats } from "./gc-strategy.js";

/**
 * GcStrategy backed by in-memory RawStorage.
 *
 * @example
 * ```typescript
 * const storage = new MemoryRawStorage();
 * const objects = createGitObjectStore(storage);
 * const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
 * const strategy = new MemoryGcStrategy(storage);
 * const orchestrator = new GcOrchestrator(history, strategy);
 * ```
 */
export class MemoryGcStrategy implements GcStrategy {
  constructor(private readonly storage: RawStorage) {}

  async prune(unreachableIds: Set<string>): Promise<number> {
    let removed = 0;
    for (const id of unreachableIds) {
      if (await this.storage.remove(id)) {
        removed++;
      }
    }
    return removed;
  }

  async compact(): Promise<CompactResult> {
    return { packsCreated: 0, objectsPacked: 0, packsMerged: 0 };
  }

  async deltify(_candidates: DeltaCandidatePair[]): Promise<number> {
    return 0;
  }

  async getStats(): Promise<StorageStats> {
    let count = 0;
    let totalSize = 0;
    for await (const key of this.storage.keys()) {
      count++;
      const size = await this.storage.size(key);
      if (size >= 0) totalSize += size;
    }
    return {
      looseObjectCount: count,
      packedObjectCount: 0,
      totalSize,
      packCount: 0,
    };
  }
}
