/**
 * Repack a file-backed repository, as `git repack -a -d` (or `-A -d`, or `-d`).
 *
 * One streaming pipeline: `listObjects` lists what is reachable, `writePack` streams the pack
 * (reusing stored entries and searching deltas) and `PackSet.install` indexes it while it is
 * stored. No pack is held in memory. Then the packs and loose objects the new pack replaces are
 * deleted, after it is installed, so a concurrent reader always finds every object.
 *
 * Only packs that existed before the reachability walk started are ever deleted: a pack
 * installed during the walk (a push, a fetch) may hold objects the walk did not see.
 */

import type {
  DeltaSearchOptions,
  FilesApi,
  GitObjects,
  History,
  ListedObject,
  ObjectId,
  Pack,
  PackSet,
} from "@statewalker/vcs-core";
import { createGitObjects, joinPath, writePack } from "@statewalker/vcs-core";

import { listReachableObjects } from "./reachable-objects.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** git's gc.pruneExpire (2.weeks.ago): the grace period of unreachable objects. */
export const DEFAULT_PRUNE_EXPIRE_MS = 14 * 24 * 60 * 60 * 1000;

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

/** The repository a repack works on: the fields of `createGitFilesBackend`'s result. */
export interface RepackTarget {
  /** The repository's refs (`history.refs`): every ref is a root. */
  history: Pick<History, "refs">;
  /** The object kernel (packs first, then loose objects). */
  objects: GitObjects;
  /** The installed packs: the new pack is installed here, replaced ones are removed. */
  packs: PackSet;
  /** The loose objects. */
  looseStorage: FileRawStorage;
  /** The FilesApi the repository lives in (reflogs, index, `.keep` files). */
  files: FilesApi;
  /** Path of the `.git` directory within `files` (default ".git"). */
  gitDir?: string;
}

/**
 * Options for the repack operation.
 */
export interface RepackOptions extends RepackTarget {
  /**
   * Pack everything reachable into one pack and delete the packs it replaces (`git repack -a
   * -d`, the default). `false` packs only the reachable objects that are loose and deletes
   * those loose copies (`git repack -d`); existing packs are left alone.
   */
  all?: boolean;
  /** Search deltas (git's window search); an object sets window and depth. Default true. */
  deltaSearch?: boolean | DeltaSearchOptions;
  /** Copy stored deltas (git: no `-f`). Default true. */
  reuseDeltas?: boolean;
  /** Copy stored whole objects (git: no `-F`). Default true. */
  reuseObjects?: boolean;
  /** Blobs larger than this are written whole (git's core.bigFileThreshold). Default 50 MiB. */
  bigFileThreshold?: number;
  /** Report what would be done without writing or deleting anything. */
  dryRun?: boolean;
  /**
   * `git repack -A` (with `all`): before a replaced pack is removed, its unreachable objects are
   * written loose, unless the pack was last modified more than `unpackUnreachableExpireMs` ago
   * (git's `--unpack-unreachable=<expire>`). A pack whose mtime is unknown is loosened. The loose
   * copies get the current time (FilesApi cannot set mtimes), so they live up to the expiry
   * longer than with git, then go through gc's loose prune. An object already loose is rewritten
   * if its loose file is older than an hour (the freshen window), so an old loose copy does not
   * expire once its young pack is gone; `unpackedObjects` counts these too. Default false: unreachable objects of
   * replaced packs are dropped, as `git repack -a -d` drops them. `gc()` sets it.
   */
  unpackUnreachable?: boolean;
  /** The expiry of `unpackUnreachable` (git's gc.pruneExpire). Default two weeks. */
  unpackUnreachableExpireMs?: number;
}

/**
 * Result of the repack operation.
 */
export interface RepackResult {
  /** Name of the created pack (`pack-<id>`, without path or extension); "" in a dry run */
  packName: string;
  /** Number of objects packed */
  objectCount: number;
  /** Number of loose object files removed */
  looseObjectsRemoved: number;
  /** Packs removed (`pack-<id>`): replaced by the new one */
  packsRemoved: string[];
  /** Packs kept because they have a `.keep` file (`pack-<id>`) */
  keptPacks: string[];
  /** Unreachable objects of the removed packs written loose or renewed (`unpackUnreachable`) */
  unpackedObjects: number;
}

/**
 * The packs a repack may replace: those installed before its reachability walk started.
 * @internal
 */
export interface PackSnapshot {
  /** The packs, listed after a refresh, before the walk */
  packs: readonly Pack[];
  /** When the walk started (`Date.now()`); a pack modified later is never removed */
  walkStartedAt: number;
}

/**
 * Takes the snapshot of the packs a repack may replace. Call it before listing what is
 * reachable: a pack installed after it is never removed.
 * @internal
 */
export async function snapshotPacks(packs: PackSet): Promise<PackSnapshot> {
  const walkStartedAt = Date.now();
  await packs.refresh();
  return { packs: await packs.packs(), walkStartedAt };
}

/**
 * Repack the repository.
 *
 * With `all` (the default), as `git repack -a -d`:
 *  1. lists every object reachable from the refs, HEAD, the reflogs and the index;
 *  2. leaves out objects held by `.keep` packs (git's `--honor-pack-keep`);
 *  3. streams them into one pack (`writePack` into `PackSet.install`), reusing stored entries;
 *  4. once it is installed and the pack set refreshed, removes the other packs (not the
 *     `.keep` ones), then the loose objects now packed (`git prune-packed`).
 *
 * Unreachable objects of the removed packs are dropped, as `git repack -a -d` drops them, or,
 * with `unpackUnreachable` (`git repack -A -d`), written loose unless their pack is older than
 * `unpackUnreachableExpireMs`. Unreachable loose objects stay, for `gc()` to prune after its
 * grace period.
 *
 * Only packs present before the walk are replaced: the snapshot is taken first, and a pack whose
 * file was modified after the walk started is kept too. A ref that cannot be read aborts the
 * repack before anything is written or deleted (see `collectReachabilityRoots`).
 *
 * Without `all`, as `git repack -d`: the reachable objects that are only loose go into a new
 * pack and their loose copies are removed; existing packs are untouched.
 *
 * @returns the result, or null if there is nothing to pack (then nothing is changed)
 *
 * @example
 * ```typescript
 * const backend = await createGitFilesBackend({ files });
 * const result = await repack(backend); // git repack -a -d
 * await repack({ ...backend, all: false }); // git repack -d: loose objects only
 * await repack({ ...backend, unpackUnreachable: true }); // git repack -A -d
 * ```
 */
export async function repack(options: RepackOptions): Promise<RepackResult | null> {
  // The snapshot first: a pack installed during the walk is never removed
  const snapshot = await snapshotPacks(options.packs);
  const listed = await listReachableObjects({
    files: options.files,
    gitDir: options.gitDir,
    refs: options.history.refs,
    objects: options.objects,
  });
  return repackListed(options, listed, snapshot);
}

/**
 * Repack with the reachable objects already listed (gc lists them once for repack and prune),
 * replacing only packs of `snapshot`, taken before the listing. With `unpackUnreachable`, the
 * ids of the removed packs' unreachable objects left loose (written, renewed, or already loose
 * and fresh) are added to `loosened`: gc's loose prune skips them.
 * @internal
 */
export async function repackListed(
  options: RepackOptions,
  reachable: readonly ListedObject[],
  snapshot: PackSnapshot,
  loosened?: Set<ObjectId>,
): Promise<RepackResult | null> {
  const { files, packs, looseStorage, objects, all = true, dryRun = false } = options;
  const gitDir = options.gitDir ?? ".git";
  const packDir = joinPath(gitDir, "objects", "pack");

  const before = snapshot.packs;
  const kept: Pack[] = [];
  const replaced: Pack[] = [];
  for (const p of before) {
    if (await files.exists(joinPath(packDir, `pack-${p.packId}.keep`))) kept.push(p);
    else replaced.push(p);
  }

  // -a: everything reachable but what .keep packs hold; -d alone: what no pack holds
  const skip = all ? kept : before;
  const ids = reachable.filter((o) => !skip.some((p) => p.has(o.id)));
  if (ids.length === 0) return null;

  const keptPacks = kept.map((p) => `pack-${p.packId}`);
  if (dryRun) {
    return {
      packName: "",
      objectCount: ids.length,
      looseObjectsRemoved: 0,
      packsRemoved: all ? replaced.map((p) => `pack-${p.packId}`) : [],
      keptPacks,
      unpackedObjects: 0,
    };
  }

  // One stream: objects are read one at a time, the pack goes straight into its temporary file
  const stream = writePack(objects, ids, {
    packs,
    reuseObjects: options.reuseObjects ?? true,
    reuseDeltas: options.reuseDeltas ?? true,
    deltaSearch: options.deltaSearch ?? true,
    bigFileThreshold: options.bigFileThreshold,
  });
  const installed = await packs.install(stream);
  // Install before remove: every reader finds each object in the new pack from now on
  await packs.refresh();

  // Only packs of the snapshot, and none modified since the walk started (defence in depth)
  const removable: { pack: Pack; modified?: number }[] = [];
  if (all) {
    for (const p of replaced) {
      if (p.packId === installed.packId) continue;
      const modified = (await files.stats(joinPath(packDir, `pack-${p.packId}.pack`)))
        ?.lastModified;
      if (modified !== undefined && modified > snapshot.walkStartedAt) continue;
      removable.push({ pack: p, modified });
    }
  }

  let unpackedObjects = 0;
  if (options.unpackUnreachable && removable.length) {
    unpackedObjects = await unpackUnreachable({
      files,
      gitDir,
      objects,
      removable,
      // the new pack holds only reachable objects; .keep packs stay
      keep: kept,
      reachable: new Set(reachable.map((o) => o.id)),
      cutoff:
        snapshot.walkStartedAt - (options.unpackUnreachableExpireMs ?? DEFAULT_PRUNE_EXPIRE_MS),
      loosened: loosened ?? new Set(),
    });
  }

  const packsRemoved = removable.map((r) => `pack-${r.pack.packId}`);
  if (packsRemoved.length) await packs.remove(removable.map((r) => r.pack.packId));

  const looseObjectsRemoved = await prunePacked(looseStorage, packs);

  return {
    packName: `pack-${installed.packId}`,
    objectCount: installed.count,
    looseObjectsRemoved,
    packsRemoved,
    keptPacks,
    unpackedObjects,
  };
}

/**
 * `--unpack-unreachable`: writes loose the objects of the packs about to be removed that are
 * not reachable and not held by a pack that stays, unless their pack was modified before
 * `cutoff`. Each object is streamed from its pack into a staged loose file (temporary file and
 * rename); none is collected. An object already loose is rewritten when its loose file is older
 * than the freshen window (one hour), which renews its mtime: git gives it the pack's mtime, and
 * an old loose copy of an object of a young pack must not expire with the pack gone. Every id
 * left loose goes into `loosened`. Returns how many were written or renewed.
 */
async function unpackUnreachable(o: {
  files: FilesApi;
  gitDir: string;
  objects: GitObjects;
  removable: readonly { pack: Pack; modified?: number }[];
  keep: readonly Pack[];
  reachable: ReadonlySet<ObjectId>;
  cutoff: number;
  loosened: Set<ObjectId>;
}): Promise<number> {
  // Straight into the loose store: the object kernel would skip an object it finds packed
  const staging = filesStagingStore(o.files, joinPath(o.gitDir, "objects"));
  const loose = createGitObjects(staging);
  let written = 0;
  for (const { pack, modified } of o.removable) {
    // An expired pack's unreachable objects are dropped; an unknown age is never expired
    if (modified !== undefined && modified < o.cutoff) continue;
    for (const id of pack.ids()) {
      if (o.reachable.has(id) || o.keep.some((p) => p.has(id))) continue;
      if (o.loosened.has(id)) continue;
      o.loosened.add(id);
      // Young (or of unknown age) loose copy: kept as it is; an old one is renewed
      if (await staging.isFresh(id)) continue;
      await loose.putRaw(id, o.objects.getRaw(id));
      written++;
    }
  }
  return written;
}

/** Removes the loose objects a pack holds (`git prune-packed`). Returns how many. */
export async function prunePacked(looseStorage: FileRawStorage, packs: PackSet): Promise<number> {
  const loose: ObjectId[] = [];
  for await (const id of looseStorage.keys()) {
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(id)) loose.push(id);
  }
  let removed = 0;
  for (const id of loose) {
    if ((await packs.has(id)) && (await looseStorage.remove(id))) removed++;
  }
  return removed;
}
