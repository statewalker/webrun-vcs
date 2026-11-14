/**
 * Garbage collection for file-backed Git repositories, as `git gc`:
 * pack refs, repack what is reachable into one pack (`git repack -a -d`), prune unreachable
 * loose objects older than a grace period (`git prune --expire`), and sweep temporaries.
 */

import type { FilesApi, GitObjects, History, PackSet } from "@statewalker/vcs-core";
import { joinPath, sweepPackTemporaries } from "@statewalker/vcs-core";

import { listReachableObjects } from "./reachable-objects.js";
import { type RepackResult, repackListed } from "./repack.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** git's gc.pruneExpire (2.weeks.ago), also used for temporaries. */
export const DEFAULT_PRUNE_EXPIRE_MS = 14 * 24 * 60 * 60 * 1000;

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Options for garbage collection.
 */
export interface GcOptions {
  /** History of the repository: its refs are roots; its `objects` and `packs` are repacked */
  history: History;
  /** FilesApi for filesystem operations */
  files: FilesApi;
  /** Path to .git directory (default: ".git") */
  gitDir?: string;
  /** The object kernel (default: `history.objects`, which the files backend sets) */
  objects?: GitObjects;
  /** The installed packs (default: `history.packs`); without them, gc does not repack */
  packs?: PackSet;
  /** If true, report what would be removed without changing anything (default: false) */
  dryRun?: boolean;
  /**
   * Prune unreachable loose objects last modified more than this long ago (git's
   * gc.pruneExpire, default two weeks). 0 prunes every unreachable loose object (`--prune=now`).
   * Younger ones may belong to a write in progress and are kept.
   */
  pruneExpireMs?: number;
  /**
   * Remove `tmp_obj_*` and `objects/pack/tmp_*` temporaries (left by a crashed write) older
   * than this, as `git prune` does (default: two weeks). Not done in a dry run.
   */
  tmpExpiryMs?: number;
  /** Pack loose refs into packed-refs, as `git gc` (`git pack-refs --all`). Default true. */
  packRefs?: boolean;
  /** Repack reachable objects into one pack (`git repack -a -d`). Default true. */
  repack?: boolean;
}

/**
 * Result of garbage collection.
 */
export interface GcResult {
  /** Unreachable loose objects removed (or that would be removed in a dry run) */
  removedObjects: number;
  /** Unreachable loose objects kept because they are younger than `pruneExpireMs` */
  keptRecentObjects: number;
  /** Total number of reachable objects found */
  reachableObjects: number;
  /** Loose objects found before gc started */
  totalLooseObjects: number;
  /** Stale temporaries removed, loose and pack ones (always 0 in a dry run) */
  removedTemporaries: number;
  /** Whether loose refs were packed */
  refsPacked: boolean;
  /** What the repack did; null if it did not run or found nothing to pack */
  repack: RepackResult | null;
}

/**
 * Run garbage collection on a file-backed repository.
 *
 * 1. Packs refs (`history.refs.packRefs`, when the store has it).
 * 2. Lists the objects reachable from every ref, HEAD, the reflogs and the index.
 * 3. Repacks them into one pack and deletes the packs it replaces (`.keep` packs stay) and the
 *    loose copies now packed. Unreachable objects inside the replaced packs are dropped, as
 *    `git repack -a -d` drops them; they are not loosened or kept in a cruft pack.
 * 4. Prunes the remaining unreachable loose objects older than `pruneExpireMs`.
 * 5. Sweeps stale temporaries (`tmp_obj_*`, `objects/pack/tmp_*`).
 *
 * @example
 * ```typescript
 * const { history } = await createGitFilesBackend({ files });
 * const result = await gc({ history, files });
 * console.log(`Pruned ${result.removedObjects}, kept ${result.keptRecentObjects} recent`);
 * ```
 */
export async function gc(options: GcOptions): Promise<GcResult> {
  const {
    history,
    files,
    gitDir = ".git",
    dryRun = false,
    pruneExpireMs = DEFAULT_PRUNE_EXPIRE_MS,
    tmpExpiryMs = DEFAULT_PRUNE_EXPIRE_MS,
  } = options;
  const objects = options.objects ?? history.objects;
  if (!objects)
    throw new Error("gc needs the object kernel: pass objects or a files backend history");
  const packs = options.packs ?? history.packs;
  const objectsDir = joinPath(gitDir, "objects");
  const looseStorage = new FileRawStorage(files, objectsDir);
  const startedAt = Date.now();

  // Step 1: pack refs
  let refsPacked = false;
  if ((options.packRefs ?? true) && !dryRun && history.refs.packRefs) {
    await history.refs.packRefs([], { all: true, deleteLoose: true });
    refsPacked = true;
  }

  const looseBefore: string[] = [];
  for await (const key of looseStorage.keys()) {
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(key)) looseBefore.push(key);
  }

  // Step 2: what is reachable
  const listed = await listReachableObjects({ files, gitDir, refs: history.refs, objects });
  const reachable = new Set<string>(listed.map((o) => o.id));

  // Step 3: repack
  let repackResult: RepackResult | null = null;
  if ((options.repack ?? true) && !dryRun && packs) {
    repackResult = await repackListed(
      { history, objects, packs, looseStorage, files, gitDir },
      listed,
    );
  }

  // Step 4: prune unreachable loose objects older than the grace period
  const cutoff = startedAt - pruneExpireMs;
  let removedObjects = 0;
  let keptRecentObjects = 0;
  for await (const key of looseStorage.keys()) {
    if (!OBJECT_ID.test(key) || reachable.has(key)) continue;
    const path = joinPath(objectsDir, key.slice(0, 2), key.slice(2));
    const modified = (await files.stats(path))?.lastModified;
    // An unknown age is never expired, unless every unreachable object goes (--prune=now)
    const expired = pruneExpireMs <= 0 || (modified !== undefined && modified < cutoff);
    if (!expired) {
      keptRecentObjects++;
      continue;
    }
    if (dryRun || (await looseStorage.remove(key))) removedObjects++;
  }

  // Step 5: temporaries
  let removedTemporaries = 0;
  if (!dryRun) {
    removedTemporaries += await filesStagingStore(files, objectsDir).sweepStaged(tmpExpiryMs);
    removedTemporaries += (
      await sweepPackTemporaries(files, joinPath(objectsDir, "pack"), tmpExpiryMs)
    ).length;
  }

  return {
    removedObjects,
    keptRecentObjects,
    reachableObjects: reachable.size,
    totalLooseObjects: looseBefore.length,
    removedTemporaries,
    refsPacked,
    repack: repackResult,
  };
}
