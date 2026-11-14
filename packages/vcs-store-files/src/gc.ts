/**
 * Garbage collection for file-backed Git repositories, as `git gc`: repack what is reachable
 * into one pack (`git repack -A -d`: unreachable packed objects are loosened, not dropped, until
 * they expire), pack refs, prune unreachable loose objects older than a grace period
 * (`git prune --expire`), and sweep temporaries. One gc at a time, under `gc.pid`.
 */

import type { FilesApi, GitObjects, History, PackSet } from "@statewalker/vcs-core";
import { joinPath, sweepPackTemporaries } from "@statewalker/vcs-core";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";

import { listReachableObjects } from "./reachable-objects.js";
import {
  DEFAULT_PRUNE_EXPIRE_MS,
  type PackSnapshot,
  type RepackResult,
  repackListed,
  snapshotPacks,
} from "./repack.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;
/** A pack file name. */
const PACK_FILE = /^pack-[0-9a-f]{40}\.pack$/;
/** git ignores a `gc.pid` older than this (a gc that crashed). */
const GC_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
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
   * The grace period of unreachable objects (git's gc.pruneExpire, default two weeks). Loose
   * ones last modified longer ago are pruned; younger ones may belong to a write in progress and
   * are kept. Unreachable objects of a replaced pack are written loose unless the pack is older
   * than this (`git repack -A --unpack-unreachable`), and then expire as loose objects; their
   * loose copies get the current time, so they live up to this long beyond git's expiry.
   * 0 prunes every unreachable object (`--prune=now`).
   */
  pruneExpireMs?: number;
  /**
   * Remove `tmp_obj_*` and `objects/pack/tmp_*` temporaries (left by a crashed write), and
   * `.pack` files whose `.idx` is gone (a crash while a pack was removed), older than this, as
   * `git prune` does (default: two weeks). Not done in a dry run.
   */
  tmpExpiryMs?: number;
  /** Pack loose refs into packed-refs, as `git gc` (`git pack-refs --all`). Default true. */
  packRefs?: boolean;
  /** Repack reachable objects into one pack (`git repack -A -d`). Default true. */
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
  /** Stale `.pack` files without an `.idx` removed (always 0 in a dry run) */
  removedOrphanPacks: number;
  /**
   * True if another gc holds `gc.pid` (git's "gc is already running"): nothing was done. A lock
   * older than 12 hours is taken over, as git does.
   */
  skipped: boolean;
  /** Whether loose refs were packed */
  refsPacked: boolean;
  /** What the repack did; null if it did not run or found nothing to pack */
  repack: RepackResult | null;
}

/**
 * Run garbage collection on a file-backed repository.
 *
 * 1. Takes `gc.pid` with an exclusive create; if another gc holds it, returns `skipped`.
 * 2. Snapshots the installed packs, then lists the objects reachable from every ref, HEAD, the
 *    reflogs, the index and every linked worktree's HEAD, index and reflogs. A ref that cannot
 *    be read makes gc throw here, before anything is changed.
 * 3. Packs refs (`history.refs.packRefs`, when the store has it).
 * 4. Repacks what is reachable into one pack and deletes the snapshot's packs (`.keep` packs
 *    stay; a pack installed during the walk is never deleted) and the loose copies now packed.
 *    Unreachable objects of the deleted packs are written loose first, unless their pack is
 *    older than `pruneExpireMs` (`git repack -A -d --unpack-unreachable`).
 * 5. Prunes the unreachable loose objects older than `pruneExpireMs`.
 * 6. Sweeps stale temporaries (`tmp_obj_*`, `objects/pack/tmp_*`) and `.pack` files without
 *    an `.idx`.
 *
 * The lock excludes other gcs over the same FilesApi instance (see `atomicFilesOver`), not
 * native git or another process.
 *
 * @example
 * ```typescript
 * const { history } = await createGitFilesBackend({ files });
 * const result = await gc({ history, files });
 * if (!result.skipped) console.log(`Pruned ${result.removedObjects}, kept ${result.keptRecentObjects} recent`);
 * ```
 */
export async function gc(options: GcOptions): Promise<GcResult> {
  const { history, files, gitDir = ".git", dryRun = false } = options;
  if (!(options.objects ?? history.objects))
    throw new Error("gc needs the object kernel: pass objects or a files backend history");
  if (dryRun) return collect(options);
  const lock = await acquireGcLock(files, gitDir);
  if (!lock) {
    return {
      removedObjects: 0,
      keptRecentObjects: 0,
      reachableObjects: 0,
      totalLooseObjects: 0,
      removedTemporaries: 0,
      removedOrphanPacks: 0,
      refsPacked: false,
      repack: null,
      skipped: true,
    };
  }
  try {
    return await collect(options);
  } finally {
    await lock.release();
  }
}

async function collect(options: GcOptions): Promise<GcResult> {
  const {
    history,
    files,
    gitDir = ".git",
    dryRun = false,
    pruneExpireMs = DEFAULT_PRUNE_EXPIRE_MS,
    tmpExpiryMs = DEFAULT_PRUNE_EXPIRE_MS,
  } = options;
  const objects = (options.objects ?? history.objects) as GitObjects;
  const packs = options.packs ?? history.packs;
  const objectsDir = joinPath(gitDir, "objects");
  const looseStorage = new FileRawStorage(files, objectsDir);

  const looseBefore: string[] = [];
  for await (const key of looseStorage.keys()) {
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(key)) looseBefore.push(key);
  }

  // Step 2: the packs a repack may replace, then what is reachable (a pack installed during
  // the walk is not in the snapshot, so it is never removed). A ref that cannot be read
  // throws here, before anything is changed.
  const repacking = (options.repack ?? true) && !dryRun && packs !== undefined;
  let snapshot: PackSnapshot | undefined;
  if (repacking && packs) snapshot = await snapshotPacks(packs);
  const startedAt = snapshot?.walkStartedAt ?? Date.now();
  const listed = await listReachableObjects({ files, gitDir, refs: history.refs, objects });
  const reachable = new Set<string>(listed.map((o) => o.id));

  // Step 3: pack refs (reachability does not change)
  let refsPacked = false;
  if ((options.packRefs ?? true) && !dryRun && history.refs.packRefs) {
    await history.refs.packRefs([], { all: true, deleteLoose: true });
    refsPacked = true;
  }

  // Step 4: repack -A -d
  let repackResult: RepackResult | null = null;
  if (repacking && packs && snapshot) {
    repackResult = await repackListed(
      {
        history,
        objects,
        packs,
        looseStorage,
        files,
        gitDir,
        unpackUnreachable: true,
        unpackUnreachableExpireMs: pruneExpireMs,
      },
      listed,
      snapshot,
    );
  }

  // Step 5: prune unreachable loose objects older than the grace period
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

  // Step 6: temporaries and orphaned packs
  let removedTemporaries = 0;
  let removedOrphanPacks = 0;
  if (!dryRun) {
    const packDir = joinPath(objectsDir, "pack");
    removedTemporaries += await filesStagingStore(files, objectsDir).sweepStaged(tmpExpiryMs);
    removedTemporaries += (await sweepPackTemporaries(files, packDir, tmpExpiryMs)).length;
    removedOrphanPacks = await sweepOrphanPacks(files, packDir, tmpExpiryMs);
  }

  return {
    removedObjects,
    keptRecentObjects,
    reachableObjects: reachable.size,
    totalLooseObjects: looseBefore.length,
    removedTemporaries,
    removedOrphanPacks,
    refsPacked,
    repack: repackResult,
    skipped: false,
  };
}

/**
 * Removes `.pack` files whose `.idx` is gone (a crash between the two removals of
 * `PackSet.remove`, which deletes the idx first) once they are older than `expiryMs`. A younger
 * one may be a pack being installed (its idx is written last); an unknown age is kept.
 */
async function sweepOrphanPacks(files: FilesApi, packDir: string, expiryMs: number) {
  if ((await files.stats(packDir))?.kind !== "directory") return 0;
  const cutoff = Date.now() - expiryMs;
  const orphans: string[] = [];
  for await (const e of files.list(packDir)) {
    if (e.kind !== "file" || !PACK_FILE.test(e.name)) continue;
    if (await files.exists(joinPath(packDir, `${e.name.slice(0, -5)}.idx`))) continue;
    const modified = (await files.stats(e.path))?.lastModified;
    if (modified !== undefined && modified < cutoff) orphans.push(e.path);
  }
  let removed = 0;
  for (const path of orphans) if (await files.remove(path)) removed++;
  return removed;
}

/**
 * Takes `gc.pid` with an exclusive create (git's gc lock). Undefined if another gc holds it; a
 * lock older than 12 hours is left by a gc that crashed and is taken over, as git does.
 */
async function acquireGcLock(files: FilesApi, gitDir: string) {
  const atomic = atomicFilesOver(files, gitDir);
  const name = "gc.pid";
  const content = new TextEncoder().encode(`0 webrun-vcs ${Date.now()}\n`);
  let taken = await atomic.createExclusive(name, content);
  if (!taken) {
    const modified = (await files.stats(joinPath(gitDir, name)))?.lastModified;
    if (modified !== undefined && Date.now() - modified > GC_LOCK_STALE_MS) {
      await atomic.remove(name);
      taken = await atomic.createExclusive(name, content);
    }
  }
  if (!taken) return undefined;
  return {
    release: async () => {
      await atomic.remove(name);
    },
  };
}
