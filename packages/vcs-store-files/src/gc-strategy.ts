/**
 * File-backed GC strategy.
 *
 * Implements GcStrategy for file-backed repositories:
 * - collectRoots: what git keeps beyond the refs (`collectReachabilityRoots`: HEAD, the index
 *   with its cache-tree and resolve-undo, every reflog, linked worktrees, the rebase files)
 * - recentObjects: unreachable loose objects modified within the grace period (git's
 *   `gc.pruneExpire`), which the orchestrator keeps with what they reach
 * - prune: remove unreachable loose objects
 * - compact: pack the reachable loose objects (`git repack -d`)
 * - deltify: no-op (placeholder for Phase 5)
 * - getStats: count loose + packed objects
 */

import type {
  CompactResult,
  DeltaCandidatePair,
  GcRoots,
  GcStrategy,
  ObjectId,
  StorageStats,
} from "@statewalker/vcs-core";
import { joinPath, objectsWithoutLazyFetch } from "@statewalker/vcs-core";

import { assertAlternatesReadable } from "./alternates/index.js";
import { promisorExclusions } from "./promisor-objects.js";
import { collectReachabilityRoots } from "./reachable-objects.js";

import { type RepackTarget, repack } from "./repack.js";
import { assertObjectsDeletable, readRepositoryFormat } from "./repository-format.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** A loose object file name, fan-out directory included. */
/** A full object id of either format (a repository has one) */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
 * await orchestrator.run({ compact: true }); // unreachable loose objects older than two weeks go
 * ```
 *
 * Where it differs from `gc()` (and `git gc`): the orchestrator prunes loose objects only (a
 * packed unreachable object stays until a full repack), walks through the parents of shallow
 * commits that are stored instead of stopping there, and takes no `gc.pid` lock.
 */
export class FileGcStrategy implements GcStrategy {
  private readonly looseStorage: FileRawStorage;
  private readonly target: RepackTarget;

  constructor(options: FileGcStrategyOptions) {
    this.looseStorage = options.looseStorage;
    this.target = options;
  }

  /**
   * HEAD, the index, every reflog file, linked worktrees and the rebase files; strict, as `gc()`.
   * Called first by the orchestrator, so it also refuses, before anything is pruned, a
   * repository with `extensions.preciousObjects` (git: "cannot prune in a precious-objects
   * repo"): `UnsupportedRepositoryFormatError`. In a partial clone (a promisor remote) the
   * promisor objects (`promisorExclusions`: the objects of promisor packs and the absent
   * objects they name) are kept without being walked (`GcRoots.keep`), and the local objects
   * promisor objects link to are roots (`PromisorExclusions.roots`), as `git gc` keeps them. Alternates are read: only the repository's own loose
   * objects are pruned. git's non-fatal alternates errors (a directory gone, ...) do not stop
   * it, alternates git reads and this store cannot do (`AlternatesUnreadableError`, see gc).
   */
  async collectRoots(): Promise<GcRoots> {
    const { files, gitDir, history } = this.target;
    // the walks read no absent object of a partial clone (git's fetch_if_missing = 0)
    const objects = objectsWithoutLazyFetch(this.target.objects);
    assertObjectsDeletable(await readRepositoryFormat(files, gitDir), "prune", {
      partialClone: "allow",
    });
    await assertAlternatesReadable({ files, gitDir, objects }, "prune");
    // git prune's roots (mark_reachable_objects): 2.5x's rebase files included
    const roots = await collectReachabilityRoots({
      files,
      gitDir,
      refs: history.refs,
      objects,
      rebaseFiles: true,
    });
    // a partial clone: its promisor objects are kept unwalked, the local objects they link to
    // walked as roots (gc's --exclude-promisor-objects and repack_local_links)
    const exclusions = await promisorExclusions(objects, files, gitDir);
    if (!exclusions) return { roots };
    return { roots: [...roots, ...exclusions.roots], keep: exclusions.excluded };
  }

  /**
   * The loose objects among `ids` modified within `pruneExpireMs` (or of unknown age), as
   * `git prune --expire` spares them. A packed object is never recent here: `prune` does not
   * remove packed objects anyway.
   */
  async recentObjects(ids: Set<ObjectId>, pruneExpireMs: number): Promise<Set<ObjectId>> {
    const { files, gitDir = ".git" } = this.target;
    const cutoff = Date.now() - pruneExpireMs;
    const recent = new Set<ObjectId>();
    for (const id of ids) {
      const stats = await files.stats(joinPath(gitDir, "objects", id.slice(0, 2), id.slice(2)));
      if (stats?.kind !== "file") continue;
      if (stats.lastModified === undefined || stats.lastModified >= cutoff) recent.add(id);
    }
    return recent;
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
    const result = await repack({ ...this.target, all: false, local: true });

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
