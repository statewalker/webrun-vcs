/**
 * File-backed GC strategy.
 *
 * Implements GcStrategy for file-backed repositories:
 * - prune: remove unreachable loose objects
 * - compact: pack the reachable loose objects (`git repack -d`)
 * - deltify: no-op (placeholder for Phase 5)
 * - getStats: count loose + packed objects
 */

import type {
  CompactResult,
  DeltaCandidatePair,
  GcStrategy,
  StorageStats,
} from "@statewalker/vcs-core";

import { type RepackTarget, repack } from "./repack.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Options for creating a FileGcStrategy: the repository (`createGitFilesBackend`'s result).
 */
export type FileGcStrategyOptions = RepackTarget;

/**
 * GcStrategy for file-backed Git repositories.
 *
 * @example
 * ```typescript
 * const backend = await createGitFilesBackend({ files, create: true });
 * const strategy = new FileGcStrategy(backend);
 * const orchestrator = new GcOrchestrator(backend.history, strategy);
 * await orchestrator.run({ compact: true });
 * ```
 */
export class FileGcStrategy implements GcStrategy {
  private readonly looseStorage: FileRawStorage;
  private readonly target: RepackTarget;

  constructor(options: FileGcStrategyOptions) {
    this.looseStorage = options.looseStorage;
    this.target = options;
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
    // git repack -d: the reachable loose objects into one pack, existing packs untouched
    const result = await repack({ ...this.target, all: false });

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
      if (!OBJECT_ID.test(key)) continue;
      looseCount++;
      const size = await this.looseStorage.size(key);
      if (size >= 0) looseSize += size;
    }

    // Count packed objects
    const packs = await this.target.packs.packs();

    return {
      looseObjectCount: looseCount,
      packedObjectCount: packs.reduce((n, p) => n + p.count, 0),
      totalSize: looseSize, // Pack sizes would require reading file sizes
      packCount: packs.length,
    };
  }
}
