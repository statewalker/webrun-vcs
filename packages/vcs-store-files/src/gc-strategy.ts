/**
 * File-backed GC strategy.
 *
 * Implements GcStrategy for file-backed repositories:
 * - prune: remove unreachable loose objects
 * - compact: repack loose objects into pack files
 * - deltify: no-op (placeholder for Phase 5)
 * - getStats: count loose + packed objects
 */

import type {
  CompactResult,
  DeltaCandidatePair,
  GcStrategy,
  StorageStats,
} from "@statewalker/vcs-core";

import type { PackDirectory } from "./pack/pack-directory.js";
import { repack } from "./repack.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/**
 * Options for creating a FileGcStrategy.
 */
export interface FileGcStrategyOptions {
  /** Loose object storage */
  looseStorage: FileRawStorage;
  /** Pack directory for pack file management */
  packDirectory: PackDirectory;
}

/**
 * GcStrategy for file-backed Git repositories.
 *
 * @example
 * ```typescript
 * const { history, looseStorage, packDirectory } = await createGitFilesBackend({ files, create: true });
 * const strategy = new FileGcStrategy({ looseStorage, packDirectory });
 * const orchestrator = new GcOrchestrator(history, strategy);
 * await orchestrator.run({ compact: true });
 * ```
 */
export class FileGcStrategy implements GcStrategy {
  private readonly looseStorage: FileRawStorage;
  private readonly packDirectory: PackDirectory;

  constructor(options: FileGcStrategyOptions) {
    this.looseStorage = options.looseStorage;
    this.packDirectory = options.packDirectory;
  }

  async prune(unreachableIds: Set<string>): Promise<number> {
    let removed = 0;
    for (const id of unreachableIds) {
      if (await this.looseStorage.remove(id)) {
        removed++;
      }
    }
    return removed;
  }

  async compact(): Promise<CompactResult> {
    const result = await repack({
      looseStorage: this.looseStorage,
      packDirectory: this.packDirectory,
    });

    if (!result) {
      return { packsCreated: 0, objectsPacked: 0, packsMerged: 0 };
    }

    return {
      packsCreated: 1,
      objectsPacked: result.objectCount,
      packsMerged: 0,
    };
  }

  async deltify(_candidates: DeltaCandidatePair[]): Promise<number> {
    // Placeholder for Phase 5 delta candidate selection
    return 0;
  }

  async getStats(): Promise<StorageStats> {
    // Count loose objects
    let looseCount = 0;
    let looseSize = 0;
    for await (const key of this.looseStorage.keys()) {
      looseCount++;
      const size = await this.looseStorage.size(key);
      if (size >= 0) looseSize += size;
    }

    // Count packed objects
    const packStats = await this.packDirectory.getStats();

    return {
      looseObjectCount: looseCount,
      packedObjectCount: packStats.totalObjects,
      totalSize: looseSize, // Pack sizes would require reading file sizes
      packCount: packStats.packCount,
    };
  }
}
