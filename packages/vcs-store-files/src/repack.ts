/**
 * Repack a file-backed repository, as `git repack -a -d` (or `git repack -d`).
 *
 * One streaming pipeline: `listObjects` lists what is reachable, `writePack` streams the pack
 * (reusing stored entries and searching deltas) and `PackSet.install` indexes it while it is
 * stored. No pack is held in memory. Then the packs and loose objects the new pack replaces are
 * deleted, after it is installed, so a concurrent reader always finds every object.
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
import { joinPath, writePack } from "@statewalker/vcs-core";

import { listReachableObjects } from "./reachable-objects.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

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
 * Unreachable objects of the removed packs are dropped, as `git repack -a -d` drops them;
 * unreachable loose objects stay, for `gc()` to prune after its grace period.
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
 * ```
 */
export async function repack(options: RepackOptions): Promise<RepackResult | null> {
  const listed = await listReachableObjects({
    files: options.files,
    gitDir: options.gitDir,
    refs: options.history.refs,
    objects: options.objects,
  });
  return repackListed(options, listed);
}

/**
 * Repack with the reachable objects already listed (gc lists them once for repack and prune).
 * @internal
 */
export async function repackListed(
  options: RepackOptions,
  reachable: readonly ListedObject[],
): Promise<RepackResult | null> {
  const { files, packs, looseStorage, objects, all = true, dryRun = false } = options;
  const packDir = joinPath(options.gitDir ?? ".git", "objects", "pack");

  await packs.refresh();
  const before = await packs.packs();
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

  const packsRemoved = all
    ? replaced.filter((p) => p.packId !== installed.packId).map((p) => `pack-${p.packId}`)
    : [];
  if (packsRemoved.length) await packs.remove(packsRemoved.map((n) => n.slice(5)));

  const looseObjectsRemoved = await prunePacked(looseStorage, packs);

  return {
    packName: `pack-${installed.packId}`,
    objectCount: installed.count,
    looseObjectsRemoved,
    packsRemoved,
    keptPacks,
  };
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
