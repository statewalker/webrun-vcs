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
  ResolvedObjectFilter,
} from "@statewalker/vcs-core";
import {
  BitmapClosureError,
  clearMultiPackIndexNaming,
  createGitObjects,
  joinPath,
  objectsWithoutLazyFetch,
  type PackFile,
  parseObjectFilter,
  resolveObjectFilter,
  writePack,
  writePackBitmap,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { assertAlternatesReadable } from "./alternates/index.js";
import { type MultiPackIndexWriteOptions, multiPackIndexWrite } from "./multi-pack-index.js";
import {
  type PackWriteSettings,
  packDeltaSearch,
  readPackWriteSettings,
} from "./pack/pack-write-settings.js";
import { type PromisorExclusions, promisorExclusions } from "./promisor-objects.js";
import { listReachableObjects } from "./reachable-objects.js";
import { assertObjectsDeletable, readRepositoryFormat } from "./repository-format.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

/** git's gc.pruneExpire (2.weeks.ago): the grace period of unreachable objects. */
export const DEFAULT_PRUNE_EXPIRE_MS = 14 * 24 * 60 * 60 * 1000;

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

/** The repository a repack works on: the fields of `createGitFilesBackend`'s result. */
export interface RepackTarget {
  /** The repository's refs (`history.refs`): every ref is a root. */
  history: Pick<History, "refs" | "commitGraph">;
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
  /**
   * `git repack --filter=<spec>` (with `all`): the new pack leaves out what the filter omits,
   * and those objects of the replaced packs go into a pack of their own beside it (git's
   * `write_filtered_pack`: pack-objects `--stdin-packs` of the replaced packs, the new ones
   * excluded). A `sparse:oid` filter must come resolved (`resolveObjectFilter`).
   */
  filter?: string | ResolvedObjectFilter;
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
   * `git repack -l` (`pack-objects --local`): leave out the objects an alternate holds, loose
   * or packed (`objects.alternates`). Without it the reachable objects borrowed from
   * alternates are copied into the new pack, as `git repack -a -d` copies them. `gc()` sets
   * it, as `git gc` runs `repack -d -l`.
   */
  local?: boolean;
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
  /**
   * Reads the grafts file in place of `info/grafts` (git's `GIT_GRAFT_FILE`;
   * `graftFileReader(environment)` makes one): what its grafts reach is packed.
   */
  readGraftFile?: () => Promise<string | undefined>;
  /**
   * Write a reachability bitmap of the new pack (`git repack -b`, `repack.writeBitmaps`): true
   * writes one (warning when it cannot: "disabling bitmap writing, ..."), false never does.
   * Default: the config's `repack.writeBitmaps` (or `pack.writeBitmaps`), else git's default:
   * written, silently skipped when it cannot be, when `all` packs everything of a bare
   * repository. With true, `all` is required (git dies: incremental repacks have no bitmap)
   * and the objects of `.keep` packs are packed too (git's `--pack-kept-objects` default), so
   * the new pack is complete.
   */
  writeBitmaps?: boolean;
  /**
   * With `all`, pack the objects of `.keep` packs too (`git repack --pack-kept-objects`).
   * Default: `repack.packKeptObjects`, else true exactly when a bitmap is asked for
   * (`writeBitmaps` true or `repack.writeBitmaps`), as git's repack decides; false keeps them
   * out, and then a bitmap cannot be written ("disabling bitmap writing, ...").
   */
  packKeptObjects?: boolean;
  /** `pack.writeBitmapHashCache`, `pack.writeBitmapLookupTable` and the rest, read from the config when not given. */
  bitmapSettings?: Partial<BitmapSettings>;
  /** Where the system and global config are read for the bitmap settings. */
  environment?: GitHostEnvironment;
  /** Bitmap entry order: 2.5x's (default) or 2.43's. */
  compatibility?: "2.43" | "2.56";
  /**
   * `git repack --write-midx` (`-m`): once the new packs are installed, a multi-pack-index over
   * the packs that stay (`.keep` packs, the new ones, and with `all: false` every existing pack)
   * is written before anything is removed, the new pack preferred (`multiPackIndexWrite` with
   * `--stdin-packs`). A bitmap asked for (`writeBitmaps`) then goes to the midx, not the pack.
   */
  writeMidx?: boolean;
  /**
   * The `pack.*` settings (`readPackWriteSettings`): read from the config (with
   * `environment`'s system, global and command-line config) when not given. `deltaSearch`
   * given as an object overrides their window and depth.
   */
  packSettings?: PackWriteSettings;
  /** @internal writes the midx bitmap (see `MultiPackIndexWriteOptions.writeBitmap`) */
  writeMidxBitmap?: MultiPackIndexWriteOptions["writeBitmap"];
}

/** The bitmap settings of a repository's config. */
export interface BitmapSettings {
  /** `repack.writeBitmaps` / `pack.writeBitmaps`, undefined when unset */
  writeBitmaps?: boolean;
  /** `core.bare` */
  bare: boolean;
  /** `pack.writeBitmapHashCache` (default true) */
  hashCache: boolean;
  /** `pack.writeBitmapLookupTable` (default false) */
  lookupTable: boolean;
  /** `pack.preferBitmapTips`: ref prefixes whose tips get a bitmap when in a window */
  preferredTips: string[];
  /** `repack.packKeptObjects`, undefined when unset */
  packKeptObjects?: boolean;
}

/** git's warning when a bitmap cannot cover every object. */
export const NO_CLOSURE_BITMAP_WARNING =
  "warning: disabling bitmap writing, as some objects are not being packed";
/** git's error for `repack -b` without `-a`. */
export const INCREMENTAL_BITMAP_ERROR =
  "Incremental repacks are incompatible with bitmap indexes.  Use\n--no-write-bitmap-index or disable the pack.writeBitmaps configuration.";

/** git's error when the bitmap of the new pack cannot be built (pack-objects dies). */
export const BITMAP_WRITE_FAILED = "failed to write bitmap index";

/**
 * The new pack's bitmap could not be built: an object a commit reaches is not in it (git's
 * pack-objects warns `Failed to write bitmap index. Packfile doesn't have full closure ...`
 * and dies with `fatal: failed to write bitmap index`). The repack fails before anything is
 * replaced: the new pack is removed again (git leaves it as a `.tmp-*` file nothing reads),
 * no old pack or loose object is deleted. `warnings` holds git's warning lines.
 */
export class BitmapWriteError extends Error {
  override name = "BitmapWriteError";
  constructor(readonly warnings: string[]) {
    super(BITMAP_WRITE_FAILED);
  }
}

/** `git repack -b` without `-a` (git dies with this message). */
export class IncrementalBitmapError extends Error {
  override name = "IncrementalBitmapError";
  constructor() {
    super(INCREMENTAL_BITMAP_ERROR);
  }
}

/**
 * Reads the bitmap settings of a repository (`repack.writeBitmaps`, `pack.writeBitmaps`,
 * `core.bare`, `pack.writeBitmapHashCache`, `pack.writeBitmapLookupTable`,
 * `pack.preferBitmapTips`).
 *
 * @example
 * ```typescript
 * const { writeBitmaps, bare } = await readBitmapSettings(files, "repo.git");
 * ```
 */
export async function readBitmapSettings(
  files: FilesApi,
  gitDir = ".git",
  options: { environment?: GitHostEnvironment } = {},
): Promise<BitmapSettings> {
  const config = await createWorkingCopyConfig(configFilesApiOf(files), gitDir, undefined, {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const bool = (key: string): boolean | undefined => {
    const v = config.get(key);
    return v === undefined ? undefined : (parseGitBool(v) ?? undefined);
  };
  // git reads both in order; the last one set wins
  let writeBitmaps: boolean | undefined;
  for (const entry of config
    .getAllWithOrigin("repack.writeBitmaps")
    .concat(config.getAllWithOrigin("pack.writeBitmaps"))
    .sort((a, b) => originOrder(a) - originOrder(b))) {
    writeBitmaps = parseGitBool(entry.value) ?? writeBitmaps;
  }
  const packKeptObjects = bool("repack.packKeptObjects");
  return {
    ...(writeBitmaps !== undefined ? { writeBitmaps } : {}),
    ...(packKeptObjects !== undefined ? { packKeptObjects } : {}),
    bare: bool("core.bare") ?? false,
    hashCache: bool("pack.writeBitmapHashCache") ?? true,
    lookupTable: bool("pack.writeBitmapLookupTable") ?? false,
    preferredTips: config
      .getAll("pack.preferBitmapTips")
      .filter((v): v is string => typeof v === "string"),
  };
}

/** A config value's place in git's reading order. */
function originOrder(o: { scope?: string; line?: number }): number {
  const scopes = ["system", "global", "local", "worktree", "command"];
  const s = Math.max(0, scopes.indexOf(o.scope ?? "local"));
  return s * 1e9 + (o.line ?? 0);
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
  /** The checksum of the multi-pack-index written (`writeMidx`) */
  midx?: string;
  /** Packs removed (`pack-<id>`): replaced by the new one */
  packsRemoved: string[];
  /** Packs kept because they have a `.keep` file (`pack-<id>`) */
  keptPacks: string[];
  /** Unreachable objects of the removed packs written loose or renewed (`unpackUnreachable`) */
  unpackedObjects: number;
  /** Whether a reachability bitmap of the new pack was written (`pack-<id>.bitmap`) */
  bitmapWritten?: boolean;
  /** git's warnings (`warning: disabling bitmap writing, ...`) */
  warnings?: string[];
  /**
   * A partial clone's `-a`: the promisor pack written besides (every object of the old
   * promisor packs, with an empty `.promisor` file), when it is not the only pack written
   */
  promisorPack?: { packName: string; objectCount: number };
  /** `filter`: the pack of the objects the filter left out (`pack-<id>`), when any was */
  filteredPack?: string;
  /**
   * git's error lines from reading the alternates, which git repack prints to stderr and goes
   * on (`repack()` only; gc reports them in its own result); absent when there are none
   */
  errors?: string[];
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
 * Objects borrowed from alternates (`objects/info/alternates`) are packed too unless `local`
 * (`git repack -l`); a loose copy of an object some pack holds, an alternate's included, is
 * removed (`git prune-packed`). Alternates themselves are never written or deleted.
 *
 * A repository with `extensions.preciousObjects` is refused (`UnsupportedRepositoryFormatError`),
 * unless `dryRun`. In a partial clone the promisor objects stay out of the walk
 * (`--exclude-promisor-objects`) and `all` writes every object of the promisor packs into a
 * promisor pack of its own, with an empty `.promisor` file (git's `repack_promisor_objects`),
 * besides the pack of the rest.
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
  // repack deletes what the new pack replaces: not in a precious-objects repo (git: "cannot
  // delete packs in a precious-objects repo")
  // git's errors reading the alternates are printed and repack goes on (see gc)
  let alternatesErrors: readonly string[] = options.objects.alternates?.errors ?? [];
  if (!options.dryRun) {
    assertObjectsDeletable(await readRepositoryFormat(options.files, options.gitDir), "repack", {
      partialClone: "allow",
    });
    alternatesErrors = await assertAlternatesReadable(options, "repack");
  }
  // pack-objects runs with fetch_if_missing = 0: every read goes through the store's view
  // without lazy fetch
  const run = async (options: RepackOptions) => {
    // a partial clone: its promisor objects stay out of the walk (--exclude-promisor-objects)
    const exclusions = await promisorExclusions(options.objects, options.files, options.gitDir);
    // The snapshot first: a pack installed during the walk is never removed
    const snapshot = await snapshotPacks(options.packs);
    const filter = await repackFilterOf(options);
    const listed = await listReachableObjects({
      files: options.files,
      gitDir: options.gitDir,
      refs: options.history.refs,
      objects: options.objects,
      commitGraph: options.history.commitGraph,
      ...(options.readGraftFile ? { readGraftFile: options.readGraftFile } : {}),
      ...(exclusions ? { excludeObjects: exclusions.excluded, extraRoots: exclusions.roots } : {}),
      ...(filter ? { filter } : {}),
    });
    return repackListed(options, listed, snapshot, undefined, exclusions);
  };
  const result = await run({ ...options, objects: objectsWithoutLazyFetch(options.objects) });
  return result && alternatesErrors.length > 0
    ? { ...result, errors: [...alternatesErrors] }
    : result;
}

/** The filter of a repack, parsed and resolved (a `sparse:oid` one must come resolved). */
async function repackFilterOf(options: RepackOptions): Promise<ResolvedObjectFilter | undefined> {
  if (options.filter === undefined) return undefined;
  if (!(options.all ?? true)) throw new Error("repack --filter needs -a");
  if (typeof options.filter !== "string") return options.filter;
  return resolveObjectFilter(parseObjectFilter(options.filter), async (name) => {
    throw new Error(`unable to access sparse blob in '${name}'`);
  });
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
  /** A partial clone's promisor objects (left out of `reachable` already) */
  exclusions?: PromisorExclusions,
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

  const alternates = (await objects.alternates?.list()) ?? [];
  const warnings: string[] = [];
  // the bitmap: "loud" (-b, repack.writeBitmaps) warns when it cannot be written, "quiet"
  // (git's default for -a in a bare repository) does not
  const bitmaps = await bitmapPlan(options, all, alternates.length > 0, warnings);
  // git's pack_kept_objects: the option, repack.packKeptObjects, else whether a bitmap is
  // asked for (write_bitmaps > 0, git's default for -b) without --write-midx
  const packKeptObjects =
    options.packKeptObjects ??
    bitmaps.settings?.packKeptObjects ??
    (bitmaps.explicit === true && !options.writeMidx);
  // --write-midx: a bitmap asked for is the midx's (pack-objects writes none)
  const midxBitmap = options.writeMidx === true && bitmaps.mode !== "off";
  if (options.writeMidx) bitmaps.mode = "off";

  // -a: everything reachable but what .keep packs hold (all of it with --pack-kept-objects);
  // -d alone: what no pack holds (an alternate's included: pack-objects --unpacked); -l:
  // nothing an alternate holds
  const skip = all ? (packKeptObjects ? [] : kept) : before;
  const borrowed = async (id: ObjectId) => {
    for (const alt of alternates) {
      if (options.local ? await alt.objects.has(id) : !all && (await alt.packs.has(id)))
        return true;
    }
    return false;
  };
  const ids: ListedObject[] = [];
  for (const o of reachable) {
    if (skip.some((p) => p.has(o.id))) continue;
    if (alternates.length > 0 && (await borrowed(o.id))) continue;
    ids.push(o);
  }
  // repack_promisor_objects (-a): every object of the promisor packs goes into a new promisor
  // pack, which the main pack then leaves out (`--keep-pack`)
  const promised: ListedObject[] = [];
  if (all && exclusions) {
    for (const id of exclusions.inPacks) {
      if (skip.some((p) => p.has(id))) continue;
      const o = await objects.get(id);
      if (!o) continue;
      if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
      promised.push({ id, type: o.type });
    }
  }
  if (ids.length === 0 && promised.length === 0) return null;
  if ((exclusions || options.filter) && bitmaps.mode !== "off") {
    // the promisor objects are not packed with the rest: no closure for a bitmap
    if (bitmaps.mode === "loud") warnings.push(NO_CLOSURE_BITMAP_WARNING);
    bitmaps.mode = "off";
  }
  // a bitmap describes a pack holding everything its commits reach (pack-objects'
  // no_closure_warning)
  if (bitmaps.mode !== "off" && ids.length < new Set(reachable.map((o) => o.id)).size) {
    if (bitmaps.mode === "loud") warnings.push(NO_CLOSURE_BITMAP_WARNING);
    bitmaps.mode = "off";
  }

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

  // pack-objects' own settings: pack.window, pack.depth, pack.compression, ...
  const settings =
    options.packSettings ??
    (await readPackWriteSettings(files, gitDir, {
      ...(options.environment ? { environment: options.environment } : {}),
    }));
  const packOptions = {
    packs,
    reuseObjects: options.reuseObjects ?? true,
    reuseDeltas: options.reuseDeltas ?? true,
    deltaSearch: packDeltaSearch(settings, options.deltaSearch),
    bigFileThreshold: options.bigFileThreshold,
    ...(settings.compression !== undefined ? { compression: settings.compression } : {}),
  };
  // pack.writeReverseIndex: a `.rev` beside each pack written (git 2.41+ default)
  const installOptions = { writeReverseIndex: settings.writeReverseIndex };
  // the promisor pack first, with its (empty) `.promisor` file, as repack-promisor.c writes it
  let promisorPack: string | undefined;
  if (promised.length > 0) {
    const written = await packs.install(writePack(objects, promised, packOptions), installOptions);
    promisorPack = written.packId;
    if (packs.writePromisor) await packs.writePromisor(promisorPack, "");
    else await files.write(joinPath(packDir, `pack-${promisorPack}.promisor`), []);
  }
  if (ids.length === 0) {
    await packs.refresh();
    return finishRepack(promisorPack as string, promised.length, false);
  }
  // One stream: objects are read one at a time, the pack goes straight into its temporary file
  const stream = writePack(objects, ids, packOptions);
  const installed = await packs.install(stream, installOptions);
  // Install before remove: every reader finds each object in the new pack from now on
  await packs.refresh();
  let bitmapWritten: boolean;
  try {
    bitmapWritten = await installBitmap(options, packDir, installed.packId, ids, bitmaps);
  } catch (e) {
    // pack-objects died before naming the pack: repack replaces nothing, and the new pack is
    // not left installed (unless it is one of the packs already there, which stays)
    if (e instanceof BitmapWriteError && !before.some((p) => p.packId === installed.packId))
      await packs.remove([installed.packId]);
    throw e;
  }

  return finishRepack(installed.packId, installed.count, bitmapWritten);

  /** Removes what the new packs replace (`-d`), then the loose objects now packed. */
  async function finishRepack(
    packId: string,
    count: number,
    bitmapWritten: boolean,
  ): Promise<RepackResult> {
    const newPacks = new Set([packId, ...(promisorPack ? [promisorPack] : [])]);
    // --filter: what the replaced packs hold and the new packs do not, in a pack of its own
    let filteredPack: string | undefined;
    if (options.filter && all) {
      const fresh = (await packs.packs()).filter((p) => newPacks.has(p.packId));
      const sources = packKeptObjects ? replaced.concat(kept) : replaced;
      const left: ListedObject[] = [];
      const seen = new Set<ObjectId>();
      for (const p of sources) {
        for (const id of p.ids()) {
          if (seen.has(id) || fresh.some((f) => f.has(id))) continue;
          seen.add(id);
          const o = await objects.get(id);
          if (!o) continue;
          if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
          left.push({ id, type: o.type });
        }
      }
      if (left.length > 0) {
        filteredPack = (await packs.install(writePack(objects, left, packOptions), installOptions))
          .packId;
        newPacks.add(filteredPack);
        await packs.refresh();
      }
    }
    // Only packs of the snapshot, and none modified since the walk started (defence in depth)
    const removable: { pack: Pack; modified?: number }[] = [];
    if (all) {
      for (const p of replaced) {
        if (newPacks.has(p.packId)) continue;
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
        // the new pack holds only reachable objects; .keep packs and the promisor pack stay
        keep: [
          ...kept,
          ...(await packs.packs()).filter(
            (p) => p.packId === promisorPack || p.packId === filteredPack,
          ),
        ],
        reachable: new Set(reachable.map((o) => o.id)),
        cutoff:
          snapshot.walkStartedAt - (options.unpackUnreachableExpireMs ?? DEFAULT_PRUNE_EXPIRE_MS),
        loosened: loosened ?? new Set(),
      });
    }

    const packsRemoved = removable.map((r) => `pack-${r.pack.packId}`);
    // --write-midx: the midx of what stays, written before anything is removed
    let midxWritten: string | undefined;
    if (options.writeMidx) {
      const removed = new Set(removable.map((r) => r.pack.packId));
      const include = new Set<string>();
      for (const p of kept) include.add(`pack-${p.packId}.idx`);
      for (const id of newPacks) include.add(`pack-${id}.idx`);
      for (const p of replaced) if (!removed.has(p.packId)) include.add(`pack-${p.packId}.idx`);
      const midx = await multiPackIndexWrite({
        files,
        gitDir,
        compatibility: options.compatibility ?? "2.56",
        ...(options.environment ? { environment: options.environment } : {}),
        stdinPacks: [...include].sort(),
        preferredPack: `pack-${packId}.pack`,
        bitmap: midxBitmap,
        ...(options.writeMidxBitmap ? { writeBitmap: options.writeMidxBitmap } : {}),
      });
      if (midx.exitCode !== 0) throw new Error(midx.stderr.join("\n"));
      midxWritten = midx.written;
      // remove_redundant_bitmaps: the packs' own bitmaps give way to the midx's
      if (midxBitmap)
        for (const name of include) {
          const bitmap = joinPath(packDir, name.replace(/\.idx$/, ".bitmap"));
          if (await files.exists(bitmap)) await files.remove(bitmap);
        }
    }
    // git's repack_remove_redundant_pack: a multi-pack-index naming a pack about to go is
    // cleared first (with its bitmaps and an incremental chain), or native git would read a
    // midx whose packs are missing (fsck and `multi-pack-index verify` fail, writes refuse it)
    if (packsRemoved.length)
      await clearMultiPackIndexNaming(
        files,
        packDir,
        packsRemoved.map((name) => `${name}.pack`),
        { wroteIncremental: false },
      );
    if (packsRemoved.length) await packs.remove(removable.map((r) => r.pack.packId));

    const looseObjectsRemoved = await prunePacked(looseStorage, packs, alternates);

    return {
      packName: `pack-${packId}`,
      objectCount: count,
      looseObjectsRemoved,
      packsRemoved,
      keptPacks,
      unpackedObjects,
      bitmapWritten,
      ...(promisorPack && promisorPack !== packId
        ? { promisorPack: { packName: `pack-${promisorPack}`, objectCount: promised.length } }
        : {}),
      ...(filteredPack ? { filteredPack: `pack-${filteredPack}` } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(midxWritten ? { midx: midxWritten } : {}),
    };
  }
}

interface BitmapPlan {
  mode: "loud" | "quiet" | "off";
  settings?: BitmapSettings;
  /** `writeBitmaps` or the config's, undefined when neither says (git's write_bitmaps < 0) */
  explicit?: boolean;
  /** the version whose `pack.preferBitmapTips` matching is followed */
  compatibility?: "2.43" | "2.56";
}

/** Whether and how the repack writes a bitmap: git's repack.c / pack-objects decisions. */
async function bitmapPlan(
  options: RepackOptions,
  all: boolean,
  hasAlternates: boolean,
  warnings: string[],
): Promise<BitmapPlan> {
  // the settings are read for -a even without a bitmap (repack.packKeptObjects)
  if ((options.writeBitmaps === false || options.dryRun) && !all)
    return { mode: "off", explicit: false };
  const read = await readBitmapSettings(options.files, options.gitDir ?? ".git", {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const settings: BitmapSettings = { ...read, ...options.bitmapSettings };
  const explicit = options.writeBitmaps ?? settings.writeBitmaps;
  const base = {
    settings,
    ...(explicit !== undefined ? { explicit } : {}),
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
  };
  if (options.writeBitmaps === false || options.dryRun) return { ...base, mode: "off" };
  let mode: BitmapPlan["mode"] =
    explicit === true
      ? "loud"
      : explicit === false
        ? "off"
        : all && settings.bare
          ? "quiet"
          : "off";
  if (mode === "off") return { ...base, mode };
  if (!all) throw new IncrementalBitmapError();
  if (options.local && hasAlternates) {
    // git warns even for its default (write_bitmaps = -1 is true there)
    warnings.push(NO_CLOSURE_BITMAP_WARNING);
    return { ...base, mode: "off" };
  }
  // a shallow repository's commits lack parents: no bitmap (not git's: its walk grafts them)
  const shallow = (await options.history.refs.getShallow?.().catch(() => [])) ?? [];
  if (shallow.length > 0) mode = "off";
  return { ...base, mode };
}

/**
 * Whether `pack.preferBitmapTips` names a ref: 2.5x (pack-bitmap.c
 * for_each_preferred_bitmap_tip) appends `/` to a value lacking one, so `refs/heads/ma` names
 * nothing and `refs/heads/main` names the refs below `refs/heads/main/`; 2.43 matches the
 * value as a plain prefix (`refs_for_each_ref_in`). 2.43 dies with `BUG: attempt to trim too
 * many characters` when a value is a ref's full name (the iterator trims the whole name); ours
 * matches that ref instead.
 */
export function isPreferredBitmapTip(
  refName: string,
  prefixes: readonly string[],
  compatibility: "2.43" | "2.56" = "2.56",
): boolean {
  return prefixes.some((prefix) =>
    refName.startsWith(compatibility === "2.43" || prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

/**
 * Writes the new pack's bitmap through a temporary file and a rename, or, when none is
 * written, removes a stale `.bitmap` of that pack name (git's generated_pack_install).
 * Throws `BitmapWriteError` when the pack lacks an object its commits reach.
 */
async function installBitmap(
  options: RepackOptions,
  packDir: string,
  packId: string,
  listed: readonly ListedObject[],
  plan: BitmapPlan,
): Promise<boolean> {
  const { files, packs } = options;
  const target = joinPath(packDir, `pack-${packId}.bitmap`);
  const pack = (await packs.packs()).find((p) => p.packId === packId) as PackFile | undefined;
  if (plan.mode === "off" || !plan.settings || !pack || typeof pack.packOrder !== "function") {
    if (await files.exists(target)) await files.remove(target);
    return false;
  }
  const preferred: ObjectId[] = [];
  if (plan.settings.preferredTips.length > 0) {
    for await (const ref of options.history.refs.list()) {
      if (!isPreferredBitmapTip(ref.name, plan.settings.preferredTips, plan.compatibility))
        continue;
      const resolved = await options.history.refs.resolve(ref.name).catch(() => undefined);
      if (resolved?.objectId) preferred.push(resolved.peeledObjectId ?? resolved.objectId);
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = await writePackBitmap({
      pack,
      objects: options.objects,
      listed,
      hashCache: plan.settings.hashCache,
      lookupTable: plan.settings.lookupTable,
      preferredTips: preferred,
      ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    });
  } catch (e) {
    // git warns (even for its quiet default) and pack-objects dies
    if (!(e instanceof BitmapClosureError)) throw e;
    throw new BitmapWriteError([`warning: ${e.message}`]);
  }
  const tmp = joinPath(packDir, `tmp_bitmap_${Math.random().toString(36).slice(2, 8)}`);
  await files.write(tmp, [bytes]);
  if (!(await files.move(tmp, target))) {
    await files.remove(tmp).catch(() => false);
    throw new Error(`unable to rename temporary bitmap file to '${target}'`);
  }
  return true;
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
      // Young (or of unknown age) loose copy: kept as it is; an old one is renewed (touched
      // where the FilesApi can, else written again below)
      const kept = await staging.renew(id);
      if (kept === "renewed") written++;
      if (kept) continue;
      await loose.putRaw(id, o.objects.getRaw(id));
      written++;
    }
  }
  return written;
}

/**
 * Removes the loose objects a pack holds (`git prune-packed`): one of `packs`, or one of an
 * alternate's (git's `has_object_pack` looks in every source's packs). Returns how many.
 */
export async function prunePacked(
  looseStorage: FileRawStorage,
  packs: PackSet,
  alternates: readonly { packs: PackSet }[] = [],
): Promise<number> {
  const packed = async (id: ObjectId) => {
    if (await packs.has(id)) return true;
    for (const alt of alternates) if (await alt.packs.has(id)) return true;
    return false;
  };
  const loose: ObjectId[] = [];
  for await (const id of looseStorage.keys()) {
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(id)) loose.push(id);
  }
  let removed = 0;
  for (const id of loose) {
    if ((await packed(id)) && (await looseStorage.remove(id))) removed++;
  }
  return removed;
}
