/**
 * Garbage collection for file-backed Git repositories, as `git gc`: pack refs, expire reflogs,
 * repack what is reachable into one pack (unreachable objects into a cruft pack until they
 * expire), prune unreachable loose objects older than a grace period (`git prune --expire`),
 * sweep temporaries and write the commit-graph. One gc at a time, under `gc.pid`.
 */

import type { FilesApi, GitObjects, History, PackSet } from "@statewalker/vcs-core";
import {
  graftFileBaseDir,
  graftFileReader,
  joinPath,
  objectsWithoutLazyFetch,
  parsePackMtimes,
  sweepPackTemporaries,
} from "@statewalker/vcs-core";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { assertAlternatesReadable } from "./alternates/index.js";
import { readCommitGraphSettings, writeCommitGraph } from "./commit-graph.js";
import { objectLinks } from "./cruft-pack.js";
import { looseFileNamePattern, objectIdPattern, packFilePattern } from "./object-names.js";
import { configBool, parseConfigSize } from "./pack/delta-base-cache-limit.js";
import { promisorExclusions } from "./promisor-objects.js";
import { sweepQuarantines } from "./quarantine/files-quarantine.js";
import { listReachableObjects, rebaseFileRoots } from "./reachable-objects.js";
import { expireReflogs, gcExpiresReflogs, parseExpiryDate } from "./reflog-expire.js";
import { createFilesRefOps } from "./refs/index.js";
import {
  DEFAULT_PRUNE_EXPIRE_MS,
  type PackSnapshot,
  type RepackResult,
  repackListed,
  snapshotPacks,
} from "./repack.js";
import { readRepositoryFormat } from "./repository-format.js";
import { type RerereGcResult, rerereGc } from "./rerere-gc.js";
import { updateServerInfo } from "./server-info.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

/** A loose object file name, fan-out directory included. */
/** A pack file name. */
/** git ignores a `gc.pid` older than this (a gc that crashed). */
const GC_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
/** The least age of a `.pack` without an `.idx` that gc removes (one may be being installed). */
const ORPHAN_PACK_MIN_AGE_MS = 60 * 60 * 1000;
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
   * 0 prunes every unreachable object (`--prune=now`), `Infinity` none (`never`). Default:
   * the config's `gc.pruneExpire`, else two weeks.
   */
  pruneExpireMs?: number;
  /**
   * Store the unreachable objects of the replaced packs, and the unreachable loose objects, in
   * a cruft pack (`git repack --cruft --cruft-expiration=<gc.pruneExpire>`) instead of writing
   * them loose: their times go into its `.mtimes`, objects older than the grace period are
   * dropped unless a younger unreachable object reaches them. Default: `gc.cruftPacks` (true
   * when unset, as git since 2.37). Never with `--prune=now` (`pruneExpireMs` 0), where git
   * runs `repack -a` and nothing unreachable is kept.
   */
  cruftPacks?: boolean;
  /** `--max-cruft-size` (bytes): cruft packs no larger. Default: `gc.maxCruftSize`, else no limit. */
  maxCruftSize?: number;
  /**
   * Remove `tmp_obj_*` and `objects/pack/tmp_*` temporaries (left by a crashed write), and
   * (whatever its age, when `packed-refs.lock` is free) a `packed-refs.new`, and
   * `.pack` files whose `.idx` is gone (a crash while a pack was removed; see
   * `orphanPackExpiryMs`), older than this, as `git prune` does (default: two weeks). Not done in
   * a dry run.
   */
  tmpExpiryMs?: number;
  /**
   * Remove `.pack` files whose `.idx` is gone once older than this. Default: `tmpExpiryMs`, but
   * never less than one hour: a pack being installed is moved into place before its `.idx` and
   * keeps its temporary's mtime, so a young orphan may be a pack still being installed. git
   * never removes such files; set this only to clean up after a crash sooner.
   */
  orphanPackExpiryMs?: number;
  /**
   * Expire reflog entries before what is reachable is computed, as `git gc` runs `git reflog
   * expire --all` (`gc.reflogExpire`, default 90 days; `gc.reflogExpireUnreachable`, 30 days;
   * `gc.<pattern>.reflogExpire[Unreachable]`; see `expireReflogs`). Default true unless both
   * settings are `never`. Not done in a dry run.
   */
  expireReflogs?: boolean;
  /** "Now" for the reflog expiry, in seconds since the epoch (default the clock's). */
  now?: number;
  /** Pack loose refs into packed-refs, as `git gc` (`git pack-refs --all`). Default true. */
  packRefs?: boolean;
  /** Repack reachable objects into one pack (`git repack -A -d`). Default true. */
  repack?: boolean;
  /**
   * Write the commit-graph of the commits the refs reach at the end, as `git gc` does
   * (`git commit-graph write --reachable`). Default: the config's `gc.writeCommitGraph`
   * (true when unset). Not done in a dry run.
   */
  writeCommitGraph?: boolean;
  /**
   * The user's environment: `gc.writeCommitGraph` and the commit-graph settings are then read
   * from the system and global config files too, and its grafts file (`GIT_GRAFT_FILE`) is
   * read in place of `info/grafts` unless `readGraftFile` is given.
   */
  environment?: GitHostEnvironment;
  /**
   * Reads the grafts file in place of `info/grafts` (git's `GIT_GRAFT_FILE`): what its grafts
   * reach is kept. Default: the environment's (`graftFileReader(environment)`), else the
   * repository's `info/grafts`.
   */
  readGraftFile?: () => Promise<string | undefined>;
  /**
   * Write a reachability bitmap of the new pack (`repack.writeBitmaps`). Default: the
   * config's, else git's default: written in a bare repository (silently skipped when the
   * pack cannot hold everything, as with `.keep` packs), with git's warning when alternates
   * keep objects out of it.
   */
  writeBitmaps?: boolean;
  /**
   * `git gc --no-prune` (false): nothing unreachable expires (the cruft pack keeps it all, or
   * `-A` loosens it all) and `git prune` does not run. Default true.
   */
  prune?: boolean;
  /**
   * `--aggressive`: `repack -f --depth=<gc.aggressiveDepth> --window=<gc.aggressiveWindow>`
   * (defaults 50 and 250): deltas searched again rather than reused.
   */
  aggressive?: boolean;
  /**
   * `--keep-largest-pack` (true): the largest non-cruft pack is kept (`repack --keep-pack`);
   * false keeps none, whatever `gc.bigPackThreshold` says. Default: every pack of at least
   * `gc.bigPackThreshold` bytes is kept, none when unset.
   */
  keepLargestPack?: boolean;
  /**
   * `--auto`'s object step (git's `odb_optimize` with `ODB_OPTIMIZE_AUTO`): with more packs
   * than `gc.autoPackLimit` (`.keep` ones aside) a full repack keeping the packs over
   * `gc.bigPackThreshold` (only the largest when they are `gc.autoPackLimit` or more, none
   * without a threshold); otherwise an incremental one (`repack -d -l
   * --no-write-bitmap-index`: the reachable loose objects only). The caller decides whether
   * an auto gc is needed (`needsAutoGc`).
   */
  auto?: boolean;
  /**
   * The git version followed where versions differ: 2.5x's prune keeps what the rebase files
   * (`rebase-*\/autostash`, `rebase-*\/orig-head`) name, 2.43's does not. Default "2.56".
   */
  compatibility?: "2.43" | "2.56";
  /**
   * Runs in place of `history.refs.packRefs` when refs are packed (`packRefs`): a command's
   * pack-refs running the reference-transaction hook.
   */
  packRefsStep?: () => Promise<void>;
  /**
   * Runs after the reflog expiry and before the repack: git 2.5x's place of `worktree
   * prune` and `rerere gc` (gc.c runs them before the object step).
   */
  beforeObjects?: () => Promise<void>;
  /** Runs after the prune, before the commit-graph: 2.43's place of the same steps. */
  afterObjects?: () => Promise<void>;
  /** `rerere gc` in git's place (see `beforeObjects`). Default true. */
  rerereGc?: boolean;
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
   * Quarantine directories of received packs (`objects/tmp_objdir-incoming-*`) left by a crash
   * and older than `tmpExpiryMs`, removed (always 0 in a dry run)
   */
  removedQuarantines: number;
  /**
   * True if another gc holds `gc.pid` (git's "gc is already running"): nothing was done. A lock
   * older than 12 hours is taken over, as git does; without `lastModified` from the FilesApi a
   * lock's age is unknown and it is never taken over (remove `gc.pid` by hand after a crash).
   */
  skipped: boolean;
  /** Whether loose refs were packed */
  refsPacked: boolean;
  /** Reflog entries the reflog step removed (absent when it did not run) */
  reflogEntriesPruned?: number;
  /** What the repack did; null if it did not run or found nothing to pack */
  repack: RepackResult | null;
  /** Whether a commit-graph was written */
  commitGraphWritten: boolean;
  /** `--auto`: which repack ran ("full" with too many packs, else "incremental") */
  autoRepack?: "full" | "incremental";
  /** The packs `--keep-largest-pack` or `gc.bigPackThreshold` kept (`pack-<id>`) */
  keptLargePacks?: string[];
  /** What rerere gc removed (absent when it did not run) */
  rerere?: RerereGcResult;
  /** Commits the prune dropped from `shallow` (git prune's `prune_shallow`) */
  shallowPruned?: number;
  /** Lone `.idx` files (and their siblings) removed, as git gc's `clean_pack_garbage` */
  removedPackGarbage?: number;
  /** The repository's own objects and their bytes on storage, before and after */
  storage?: { before: StorageCount; after: StorageCount };
  /** git's warnings (`--auto`: "There are too many unreachable loose objects; ...") */
  warnings?: string[];
  /**
   * Why writing the commit-graph failed, when it did. git's gc reports the error and still
   * succeeds (it ignores what write_commit_graph_reachable returns): what the repack and prune
   * did stands.
   */
  commitGraphError?: string;
  /**
   * git's error lines from reading the alternates (`error: unable to normalize alternate object
   * path: ...`, `error: ...: ignoring alternate object stores, nesting too deep`), which git gc
   * prints to stderr and goes on; absent when there are none
   */
  errors?: string[];
}

/** The objects a repository stores itself (loose and packed) and their bytes. */
export interface StorageCount {
  /** distinct object ids, loose or packed */
  objects: number;
  /** bytes of the loose object files and of the pack directory's files */
  bytes: number;
}

/**
 * Run garbage collection on a file-backed repository.
 *
 * In git gc's order (builtin/gc.c):
 * 1. Takes `gc.pid` with an exclusive create; if another gc holds it, returns `skipped`.
 * 2. Packs refs (`git pack-refs --all --prune`: `packRefsStep`, else `history.refs.packRefs`).
 * 3. Expires reflog entries (`git reflog expire --all`, `expireReflogs`), unless `gc.reflogExpire`
 *    and `gc.reflogExpireUnreachable` are both `never`.
 * 4. Runs `beforeObjects` and `rerere gc` (2.5x's place; under 2.43 compatibility they run
 *    after step 8).
 * 5. Snapshots the installed packs, then lists the objects reachable from every ref, HEAD, the
 *    reflogs, the index and every linked worktree's HEAD, index and reflogs (no pseudo-ref:
 *    git's `rev-list --all` lists none). A ref that cannot be read makes gc throw here.
 * 6. Repacks (`git repack -d -l`): everything reachable into one pack, deleting the snapshot's
 *    packs (`.keep` packs and the `--keep-pack` ones stay; a pack installed during the walk is
 *    never deleted) and the loose copies now packed. Unreachable objects of the deleted packs,
 *    and unreachable loose objects, go into a cruft pack (`gc.cruftPacks`, default; `--cruft`),
 *    dropped once older than `pruneExpireMs` unless a younger one reaches them; with
 *    `gc.cruftPacks=false` they are written loose unless their pack is older than
 *    `pruneExpireMs` (`-A --unpack-unreachable`); `--prune=now` keeps none (`-a`). `auto`
 *    makes it incremental (the reachable loose objects only) unless there are too many packs.
 *    Then `update-server-info`.
 * 7. Prunes (`git prune --expire`, unless `prune: false`): unreachable loose objects older than
 *    `pruneExpireMs` that no younger unreachable object (loose or packed) reaches, the shallow
 *    commits nothing reached (`prune_shallow`), stale temporaries; also `packed-refs.new`,
 *    quarantines and `.pack` files without an `.idx` (beyond git).
 * 8. Removes lone `.idx` files with their siblings (`clean_pack_garbage`), then writes the
 *    commit-graph of what the refs reach (`gc.writeCommitGraph`, default true):
 *    `objects/info/commit-graph`, replacing a split chain.
 *
 * In a repository with `extensions.preciousObjects`, steps 6 and 7 are skipped, as `git gc` skips its
 * repack and prune there. In a partial clone (`extensions.partialClone`, a promisor remote)
 * the walk leaves the promisor objects out (`--exclude-promisor-objects`: the objects of
 * promisor packs, and the absent objects they name), and the repack writes every object of
 * the promisor packs into a promisor pack of its own (git's `repack_promisor_objects`, an
 * empty `.promisor` file). In a repository
 * with alternates (`objects/info/alternates`) what they reach is walked through them, and the
 * repack leaves out what they hold (`git gc` runs `repack -d -l`); only the repository's own
 * objects are ever deleted. An alternate git cannot read either (gone, a path that cannot be
 * normalized, nesting too deep) is reported in `errors` and gc goes on, as git does; a ref, HEAD
 * or index entry whose object is missing aborts it (`MissingRootError`), and so does a missing
 * object under a local commit, as git dies. Alternates git reads and this store does not
 * (`alternates: false`, outside the FilesApi's root) are refused (`AlternatesUnreadableError`).
 *
 * The lock excludes gcs in other processes when the FilesApi has `createExclusive`, and
 * otherwise only gcs over the same FilesApi instance (see `atomicFilesOver`).
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
  // the walks read no absent object of a partial clone (git's fetch_if_missing = 0): they
  // read through the store's view without lazy fetch, not a store-wide switch
  const direct = objectsWithoutLazyFetch((options.objects ?? history.objects) as GitObjects);
  if (dryRun) return collect({ ...options, objects: direct });
  const lock = await acquireGcLock(files, gitDir);
  if (!lock) {
    return {
      removedObjects: 0,
      keptRecentObjects: 0,
      reachableObjects: 0,
      totalLooseObjects: 0,
      removedTemporaries: 0,
      removedQuarantines: 0,
      removedOrphanPacks: 0,
      refsPacked: false,
      repack: null,
      skipped: true,
      commitGraphWritten: false,
    };
  }
  try {
    return await collect({ ...options, objects: direct });
  } finally {
    await lock.release();
  }
}

async function collect(options: GcOptions): Promise<GcResult> {
  const { history, files, gitDir = ".git", dryRun = false } = options;
  const compatibility = options.compatibility ?? "2.56";
  // gc.pruneExpire, gc.cruftPacks, gc.maxCruftSize, ... (git's gc_config)
  const gcSettings = await readGcSettings(files, gitDir, options.environment);
  // --no-prune: nothing unreachable expires, and prune does not run
  const pruneStep = options.prune ?? true;
  const pruneExpireMs = pruneStep
    ? (options.pruneExpireMs ?? gcSettings.pruneExpireMs)
    : Number.POSITIVE_INFINITY;
  // git prune removes `tmp_*` with the prune expiry (prune_tmp_file)
  const tmpExpiryMs = options.tmpExpiryMs ?? pruneExpireMs;
  const objects = (options.objects ?? history.objects) as GitObjects;
  const packs = options.packs ?? history.packs;
  const objectsDir = joinPath(gitDir, "objects");
  const looseStorage = new FileRawStorage(files, objectsDir);
  const warnings: string[] = [];

  // preciousObjects: as git gc, refs are packed, but nothing is repacked or pruned. A partial
  // clone's promisor objects stay out of the walk, its promisor packs are repacked apart
  const format = await readRepositoryFormat(files, gitDir);
  const exclusions = dryRun ? undefined : await promisorExclusions(objects, files, gitDir);
  // git's errors reading the alternates (a directory gone, ...) are printed and gc goes on: the
  // walk below fails on a root or a local commit's object that only they held. Alternates git
  // reads and we cannot (alternates: false, outside the storage) are refused.
  const alternatesErrors = dryRun
    ? (objects.alternates?.errors ?? [])
    : await assertAlternatesReadable({ files, gitDir, objects }, "gc");
  const storageBefore =
    dryRun || !packs
      ? undefined
      : await storageCount(files, objectsDir, looseStorage, packs, format.objectFormat);

  // git gc's foreground tasks: `pack-refs --all --prune`, then `reflog expire --all`
  let refsPacked = false;
  if ((options.packRefs ?? true) && !dryRun) {
    if (options.packRefsStep) {
      await options.packRefsStep();
      refsPacked = true;
    } else if (history.refs.packRefs) {
      await history.refs.packRefs([], { all: true, deleteLoose: true });
      refsPacked = true;
    }
  }
  const reflogErrors: string[] = [];
  let reflogEntriesPruned: number | undefined;
  if (
    !dryRun &&
    (options.expireReflogs ??
      (await gcExpiresReflogs(files, gitDir, {
        ...(options.environment ? { environment: options.environment } : {}),
      })))
  ) {
    const expired = await expireReflogs({
      files,
      gitDir,
      refs: history.refs,
      objects,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    reflogEntriesPruned = expired.pruned;
    reflogErrors.push(...expired.errors);
  }

  // worktree prune and rerere gc: before the object step in 2.5x, after it in 2.43
  let rerere: RerereGcResult | undefined;
  const otherTasks = async () => {
    if (dryRun) return;
    if (compatibility === "2.43") await options.afterObjects?.();
    else await options.beforeObjects?.();
    if (options.rerereGc ?? true)
      rerere = await rerereGc({
        files,
        gitDir,
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
  };
  if (compatibility !== "2.43") await otherTasks();

  const allErrors = [...alternatesErrors, ...reflogErrors];
  const finish = async (
    partial: Omit<GcResult, "commitGraphWritten" | "commitGraphError">,
  ): Promise<GcResult> => {
    if (compatibility === "2.43") await otherTasks();
    // clean_pack_garbage: a lone .idx and the files beside it
    const removedPackGarbage = dryRun ? 0 : await cleanPackGarbage(files, objectsDir);
    const commitGraph = await gcCommitGraph(options, objects);
    const after =
      storageBefore && packs
        ? await storageCount(files, objectsDir, looseStorage, packs, format.objectFormat)
        : undefined;
    return {
      ...partial,
      ...commitGraph,
      ...(allErrors.length > 0 ? { errors: allErrors } : {}),
      ...(reflogEntriesPruned !== undefined ? { reflogEntriesPruned } : {}),
      ...(rerere ? { rerere } : {}),
      ...(removedPackGarbage ? { removedPackGarbage } : {}),
      ...(storageBefore && after ? { storage: { before: storageBefore, after } } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
  if (format.preciousObjects) {
    return finish({
      removedObjects: 0,
      keptRecentObjects: 0,
      reachableObjects: 0,
      totalLooseObjects: 0,
      removedTemporaries: 0,
      removedOrphanPacks: 0,
      removedQuarantines: 0,
      refsPacked,
      repack: null,
      skipped: false,
    });
  }

  // loose objects and packs are named by ids of the repository's format only (git's
  // for_each_loose_file_in_objdir): a name of the other width is no object here
  const OBJECT_ID = objectIdPattern(format.objectFormat);
  const looseBefore: string[] = [];
  for await (const key of looseStorage.keys()) {
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(key)) looseBefore.push(key);
  }

  // The packs a repack may replace, then what is reachable (a pack installed during the walk
  // is not in the snapshot, so it is never removed). A ref that cannot be read throws here,
  // before anything is changed.
  const repacking = (options.repack ?? true) && !dryRun && packs !== undefined;
  let snapshot: PackSnapshot | undefined;
  if (repacking && packs) snapshot = await snapshotPacks(packs);
  const startedAt = snapshot?.walkStartedAt ?? Date.now();

  // the repack's mode (odb_source_files_optimize): -a/-A/--cruft with the packs kept, or
  // --auto's incremental repack while there are not too many packs
  let all = true;
  let autoRepack: GcResult["autoRepack"];
  let keepPacks: string[] = [];
  if (snapshot) {
    const local = await describePacks(files, objectsDir, snapshot.packs);
    const threshold = gcSettings.bigPackThreshold;
    if (options.auto) {
      const limit = gcSettings.autoPackLimit;
      const tooMany = limit > 0 && local.filter((p) => !p.keep).length > limit;
      autoRepack = tooMany ? "full" : "incremental";
      if (!tooMany) all = false;
      else if (threshold) {
        keepPacks = basePacks(local, threshold);
        // keep_pack.nr >= gc_auto_pack_limit: only the largest
        if (keepPacks.length >= limit) keepPacks = basePacks(local, 0);
      }
      // without a threshold git keeps the largest only when repacking it would take more than
      // half the memory (estimate_repack_memory): not estimated here, nothing is kept
    } else if (options.keepLargestPack !== undefined) {
      if (options.keepLargestPack) keepPacks = basePacks(local, 0);
    } else if (threshold) {
      keepPacks = basePacks(local, threshold);
    }
  }

  const readGraftFile =
    options.readGraftFile ??
    graftFileReader(options.environment, { files, dir: graftFileBaseDir(gitDir) });
  const listed = await listReachableObjects({
    files,
    gitDir,
    refs: history.refs,
    objects,
    commitGraph: history.commitGraph,
    ...(readGraftFile ? { readGraftFile } : {}),
    ...(exclusions ? { excludeObjects: exclusions.excluded, extraRoots: exclusions.roots } : {}),
  });
  const reachable = new Set<string>(listed.map((o) => o.id));
  // a promisor object left loose is not pruned (the promisor remote has it, but so may nothing
  // else here)
  for (const id of exclusions?.excluded ?? []) reachable.add(id);

  // repack -d -l (-a | -A | --cruft) [--keep-pack ...] [-f --depth --window]
  let repackResult: RepackResult | null = null;
  // the unreachable objects the repack left loose: the prune below keeps them
  const loosened = new Set<string>();
  if (repacking && packs && snapshot) {
    const aggressive = options.aggressive
      ? {
          reuseDeltas: false,
          deltaSearch: {
            window: gcSettings.aggressiveWindow,
            depth: gcSettings.aggressiveDepth,
          },
        }
      : {};
    repackResult = await repackListed(
      {
        history,
        objects,
        packs,
        looseStorage,
        files,
        gitDir,
        all,
        ...aggressive,
        ...(keepPacks.length ? { keepPacks } : {}),
        // --prune=now: repack -a (nothing unreachable kept); else --cruft, or -A
        ...(!all || pruneExpireMs <= 0
          ? {}
          : (options.cruftPacks ?? gcSettings.cruftPacks)
            ? {
                cruft: true,
                ...(Number.isFinite(pruneExpireMs)
                  ? { cruftExpiration: Math.floor((startedAt - pruneExpireMs) / 1000) }
                  : {}),
                ...((options.maxCruftSize ?? gcSettings.maxCruftSize)
                  ? { maxCruftSize: options.maxCruftSize ?? gcSettings.maxCruftSize }
                  : {}),
              }
            : { unpackUnreachable: true, unpackUnreachableExpireMs: pruneExpireMs }),
        // git gc: repack -d -l, what alternates hold stays theirs
        local: true,
        compatibility,
        // a bare repository's gc writes a bitmap (git's repack default for -a in a bare one);
        // --auto's incremental repack never does
        ...(options.environment ? { environment: options.environment } : {}),
        ...(!all
          ? { writeBitmaps: false }
          : options.writeBitmaps !== undefined
            ? { writeBitmaps: options.writeBitmaps }
            : {}),
      },
      listed,
      snapshot,
      loosened,
      exclusions,
    );
    for (const w of repackResult?.warnings ?? []) warnings.push(w);
    // repack's update_server_info, even when nothing was packed
    await updateServerInfo({ files, gitDir, objects, packs });
  }

  // git prune --expire <gc.pruneExpire>: unreachable loose objects older than the grace
  // period go, keeping what a younger unreachable object (loose or packed) reaches
  // (mark_reachable_objects with mark_recent); 2.5x keeps what the rebase files name too
  let removedObjects = 0;
  let keptRecentObjects = 0;
  let removedTemporaries = 0;
  let removedOrphanPacks = 0;
  let removedQuarantines = 0;
  let shallowPruned: number | undefined;
  if (pruneStep) {
    const kept = new Set(reachable);
    if (compatibility !== "2.43") {
      const pending = [];
      for (const id of await rebaseFileRoots(files, gitDir, format.objectFormat))
        if (!kept.has(id) && (await objects.has(id))) pending.push(id);
      while (pending.length > 0) {
        const id = pending.pop() as string;
        if (kept.has(id)) continue;
        kept.add(id);
        for (const link of await objectLinks(objects, id)) if (!kept.has(link)) pending.push(link);
      }
    }
    const cutoff = startedAt - pruneExpireMs;
    const expiredLoose: string[] = [];
    const recent: string[] = [];
    for await (const key of looseStorage.keys()) {
      if (!OBJECT_ID.test(key) || kept.has(key)) continue;
      // written, renewed or found fresh by the unpack step: its pack was young
      if (loosened.has(key)) {
        keptRecentObjects++;
        recent.push(key);
        continue;
      }
      const path = joinPath(objectsDir, key.slice(0, 2), key.slice(2));
      const modified = (await files.stats(path))?.lastModified;
      // An unknown age is never expired, unless every unreachable object goes (--prune=now)
      const expired = pruneExpireMs <= 0 || (modified !== undefined && modified < cutoff);
      if (!expired) {
        keptRecentObjects++;
        recent.push(key);
        continue;
      }
      expiredLoose.push(key);
    }
    const shallow = (await history.refs.getShallow?.().catch(() => [])) ?? [];
    if ((expiredLoose.length > 0 || shallow.length > 0) && pruneExpireMs > 0 && packs) {
      // add_unseen_recent_objects_to_traversal: recent packed objects seed the walk too
      for (const id of await recentPacked(
        files,
        objectsDir,
        packs,
        cutoff,
        kept,
        format.objectFormat,
      ))
        recent.push(id);
    }
    const walked = new Set<string>();
    if ((expiredLoose.length > 0 || shallow.length > 0) && recent.length > 0) {
      const candidates = new Set(expiredLoose);
      const pending = [...recent];
      while (pending.length > 0) {
        const id = pending.pop() as string;
        if (walked.has(id)) continue;
        walked.add(id);
        for (const link of await objectLinks(objects, id)) {
          if (walked.has(link) || kept.has(link)) continue;
          if (candidates.delete(link)) keptRecentObjects++;
          pending.push(link);
        }
      }
      expiredLoose.length = 0;
      expiredLoose.push(...candidates);
    }
    for (const key of expiredLoose) {
      if (dryRun || (await looseStorage.remove(key))) removedObjects++;
    }
    // prune_shallow: the shallow commits the walks did not reach leave `shallow`
    if (shallow.length > 0 && !dryRun) {
      const stay = shallow.filter((id) => kept.has(id) || walked.has(id));
      if (stay.length < shallow.length) {
        // git's prune_shallow: under shallow.lock, dying when another writer holds it or the
        // file changed since it was read (a concurrent fetch's new boundary is never undone)
        if (history.refs.setShallow) {
          await history.refs.setShallow(stay, shallow);
          shallowPruned = shallow.length - stay.length;
        }
      }
    }

    // temporaries and orphaned packs
    if (!dryRun) {
      const packDir = joinPath(objectsDir, "pack");
      removedTemporaries += await filesStagingStore(files, objectsDir).sweepStaged(tmpExpiryMs);
      removedTemporaries += (await sweepPackTemporaries(files, packDir, tmpExpiryMs)).length;
      removedQuarantines = await sweepQuarantines(files, objectsDir, tmpExpiryMs);
      // packed-refs.new is written only under packed-refs.lock: stale whenever the lock is free
      removedTemporaries += await createFilesRefOps(
        atomicFilesOver(files, gitDir),
      ).sweepTemporaries();
      const orphanExpiry =
        options.orphanPackExpiryMs ?? Math.max(tmpExpiryMs, ORPHAN_PACK_MIN_AGE_MS);
      removedOrphanPacks = await sweepOrphanPacks(
        files,
        packDir,
        orphanExpiry,
        format.objectFormat,
      );
    }
  }

  // --auto: git's warning when the prune left too many loose objects
  if (options.auto && !dryRun && gcSettings.gcAuto > 0) {
    let inSeventeen = 0;
    const fan = joinPath(objectsDir, "17");
    if ((await files.stats(fan))?.kind === "directory")
      for await (const e of files.list(fan))
        if (looseFileNamePattern(format.objectFormat).test(e.name)) inSeventeen++;
    if (inSeventeen > Math.ceil(gcSettings.gcAuto / 256))
      warnings.push(
        "warning: There are too many unreachable loose objects; run 'git prune' to remove them.",
      );
  }

  return finish({
    removedObjects,
    keptRecentObjects,
    reachableObjects: reachable.size,
    totalLooseObjects: looseBefore.length,
    removedTemporaries,
    removedOrphanPacks,
    removedQuarantines,
    refsPacked,
    repack: repackResult,
    skipped: false,
    ...(autoRepack ? { autoRepack } : {}),
    ...(keepPacks.length ? { keptLargePacks: keepPacks.map((p) => p.replace(/\.pack$/, "")) } : {}),
    ...(shallowPruned !== undefined ? { shallowPruned } : {}),
  });
}

/** A local pack as gc's find_base_packs and too_many_packs see it. */
interface PackInfo {
  name: string;
  size: number;
  keep: boolean;
  cruft: boolean;
}

async function describePacks(
  files: FilesApi,
  objectsDir: string,
  packs: readonly { packId: string }[],
): Promise<PackInfo[]> {
  const out: PackInfo[] = [];
  for (const p of packs) {
    const base = joinPath(objectsDir, "pack", `pack-${p.packId}`);
    out.push({
      name: `pack-${p.packId}.pack`,
      size: (await files.stats(`${base}.pack`))?.size ?? 0,
      keep: await files.exists(`${base}.keep`),
      cruft: await files.exists(`${base}.mtimes`),
    });
  }
  return out;
}

/**
 * find_base_packs: with a limit, every non-cruft pack of at least that size; without, the
 * largest non-cruft pack (the first of the largest, in the order the packs are listed).
 */
function basePacks(packs: readonly PackInfo[], limit: number): string[] {
  const candidates = packs.filter((p) => !p.cruft);
  if (limit) return candidates.filter((p) => p.size >= limit).map((p) => p.name);
  let base: PackInfo | undefined;
  for (const p of candidates) if (!base || base.size < p.size) base = p;
  return base ? [base.name] : [];
}

/**
 * The unreachable packed objects newer than `cutoff` (ms): a cruft pack's by its `.mtimes`,
 * any other pack's by the pack's own time (git's add_recent_packed).
 */
async function recentPacked(
  files: FilesApi,
  objectsDir: string,
  packs: PackSet,
  cutoffMs: number,
  kept: ReadonlySet<string>,
  objectFormat: ObjectFormat,
): Promise<string[]> {
  const out: string[] = [];
  const cutoff = Math.floor(cutoffMs / 1000);
  await packs.refresh();
  for (const pack of await packs.packs()) {
    const base = joinPath(objectsDir, "pack", `pack-${pack.packId}`);
    let times: Uint32Array | undefined;
    if ((await files.stats(`${base}.mtimes`))?.kind === "file") {
      try {
        const parts: Uint8Array[] = [];
        for await (const c of files.read(`${base}.mtimes`)) parts.push(c);
        times = parsePackMtimes(concatBytes(parts), pack.count, `${base}.mtimes`, objectFormat);
      } catch {
        times = undefined;
      }
    }
    const modified = (await files.stats(`${base}.pack`))?.lastModified;
    const packTime = modified === undefined ? Number.POSITIVE_INFINITY : modified / 1000;
    let at = 0;
    for (const id of pack.ids()) {
      const t = times ? (times[at] as number) : packTime;
      at++;
      if (t > cutoff && !kept.has(id)) out.push(id);
    }
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * git gc's clean_pack_garbage: in `objects/pack`, a pack whose `.idx` has no `.pack` beside
 * it loses every file of its name (`.idx`, `.rev`, `.bitmap`, `.keep`, `.promisor`,
 * `.mtimes`). Returns how many files were removed.
 */
async function cleanPackGarbage(files: FilesApi, objectsDir: string): Promise<number> {
  const packDir = joinPath(objectsDir, "pack");
  if ((await files.stats(packDir))?.kind !== "directory") return 0;
  const known = /\.(idx|rev|pack|bitmap|keep|promisor|mtimes)$/;
  const groups = new Map<string, string[]>();
  for await (const e of files.list(packDir)) {
    if (e.kind !== "file" || !known.test(e.name) || e.name.startsWith("multi-pack-index")) continue;
    const base = e.name.slice(0, e.name.lastIndexOf(".") + 1);
    groups.set(base, [...(groups.get(base) ?? []), e.name]);
  }
  let removed = 0;
  for (const [base, names] of groups) {
    if (!names.includes(`${base}idx`) || names.includes(`${base}pack`)) continue;
    for (const n of names) if (await files.remove(joinPath(packDir, n))) removed++;
  }
  return removed;
}

/** The repository's own objects (distinct ids, loose and packed) and their bytes. */
async function storageCount(
  files: FilesApi,
  objectsDir: string,
  looseStorage: FileRawStorage,
  packs: PackSet,
  objectFormat: ObjectFormat,
): Promise<StorageCount> {
  const OBJECT_ID = objectIdPattern(objectFormat);
  const ids = new Set<string>();
  let bytes = 0;
  for await (const key of looseStorage.keys()) {
    if (!OBJECT_ID.test(key)) continue;
    ids.add(key);
    bytes += (await files.stats(joinPath(objectsDir, key.slice(0, 2), key.slice(2))))?.size ?? 0;
  }
  await packs.refresh();
  for (const p of await packs.packs()) for (const id of p.ids()) ids.add(id);
  const packDir = joinPath(objectsDir, "pack");
  if ((await files.stats(packDir))?.kind === "directory")
    for await (const e of files.list(packDir))
      if (e.kind === "file") bytes += (await files.stats(e.path))?.size ?? 0;
  return { objects: ids.size, bytes };
}

/** git gc's settings (gc_config, odb_source_files_optimize). */
interface GcSettings {
  pruneExpireMs: number;
  cruftPacks: boolean;
  maxCruftSize?: number;
  aggressiveWindow: number;
  aggressiveDepth: number;
  bigPackThreshold: number;
  autoPackLimit: number;
  gcAuto: number;
}

/** git gc's settings of the object step: `gc.pruneExpire`, `gc.cruftPacks`, `gc.maxCruftSize`, ... */
async function readGcSettings(
  files: FilesApi,
  gitDir: string,
  environment?: GitHostEnvironment,
): Promise<GcSettings> {
  const config = await createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "reading the gc settings never writes the config" }),
    gitDir,
    undefined,
    environment ? { environment } : {},
  );
  let pruneExpireMs = DEFAULT_PRUNE_EXPIRE_MS;
  const expire = config.get("gc.pruneExpire");
  if (expire !== undefined && expire !== null) {
    const nowMs = Date.now();
    const cutoff = parseExpiryDate(String(expire), Math.floor(nowMs / 1000), "gc.pruneexpire");
    // never: nothing expires; now: everything does
    pruneExpireMs =
      cutoff === 0
        ? Number.POSITIVE_INFINITY
        : cutoff === Number.POSITIVE_INFINITY
          ? 0
          : Math.max(0, nowMs - cutoff * 1000);
  }
  const cruft = config.get("gc.cruftPacks");
  const maxCruftSize = parseConfigSize(config.get("gc.maxCruftSize"));
  const int = (key: string, fallback: number) => {
    const v = config.get(key);
    if (v === undefined || v === null) return fallback;
    const n = parseConfigSize(String(v).replace(/^-/, ""));
    if (n === undefined) return fallback;
    return String(v).trim().startsWith("-") ? -n : n;
  };
  return {
    pruneExpireMs,
    cruftPacks: configBool(cruft, true),
    ...(maxCruftSize ? { maxCruftSize } : {}),
    aggressiveWindow: int("gc.aggressiveWindow", 250),
    aggressiveDepth: int("gc.aggressiveDepth", 50),
    bigPackThreshold: parseConfigSize(config.get("gc.bigPackThreshold")) ?? 0,
    autoPackLimit: int("gc.autoPackLimit", 50),
    gcAuto: int("gc.auto", 6700),
  };
}

/**
 * Writes the commit-graph at the end of a gc when `gc.writeCommitGraph` (or the option) asks.
 * A failure is reported in the result, not thrown, as git's gc goes on after
 * write_commit_graph_reachable fails: the repack and prune before it are done.
 */
async function gcCommitGraph(
  options: GcOptions,
  objects: GitObjects,
): Promise<Pick<GcResult, "commitGraphWritten" | "commitGraphError">> {
  const { history, files, gitDir = ".git", environment } = options;
  if (options.dryRun) return { commitGraphWritten: false };
  try {
    const enabled =
      options.writeCommitGraph ??
      (await readCommitGraphSettings(files, gitDir, { environment })).gcWriteCommitGraph;
    if (!enabled) return { commitGraphWritten: false };
    const result = await writeCommitGraph({
      files,
      gitDir,
      objects,
      refs: history.refs,
      commitGraph: history.commitGraph ?? history.commits.commitGraph,
      // git gc writes in-process with replace refs on: none is written while there are any
      replaceRefs: true,
      environment,
    });
    return { commitGraphWritten: result.written };
  } catch (error) {
    return {
      commitGraphWritten: false,
      commitGraphError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Removes `.pack` files whose `.idx` is gone (a crash between the two removals of
 * `PackSet.remove`, which deletes the idx first) once they are older than `expiryMs`. A younger
 * one may be a pack being installed (its idx is written last); an unknown age is kept.
 */
async function sweepOrphanPacks(
  files: FilesApi,
  packDir: string,
  expiryMs: number,
  objectFormat: ObjectFormat,
) {
  const PACK_FILE = packFilePattern(objectFormat);
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
 * Takes `gc.pid` with an exclusive create (git's gc lock), writing a random token into it.
 * Undefined if another gc holds it. A lock older than 12 hours is left by a gc that crashed and
 * is taken over, as git does: under `gc.pid.takeover` (one takeover at a time), the lock is
 * removed if it is still stale and created again exclusively, then read back to check that it
 * holds our token. Without `lastModified` a lock's age is unknown and it is never taken over.
 * `release` removes the lock only while it still holds our token.
 */
async function acquireGcLock(files: FilesApi, gitDir: string) {
  const atomic = atomicFilesOver(files, gitDir);
  const name = "gc.pid";
  const guard = "gc.pid.takeover";
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const content = new TextEncoder().encode(`0 webrun-vcs ${token} ${Date.now()}\n`);
  const isStale = async (path: string) => {
    const modified = (await files.stats(joinPath(gitDir, path)))?.lastModified;
    return modified !== undefined && Date.now() - modified > GC_LOCK_STALE_MS;
  };
  const holdsToken = async () => {
    const dec = new TextDecoder();
    let text = "";
    for await (const c of atomic.read(name)) text += dec.decode(c, { stream: true });
    return (text + dec.decode()).includes(token);
  };

  let taken = await atomic.createExclusive(name, content);
  if (!taken && (await isStale(name))) {
    // Two gcs that both found the lock stale would each remove it, the second removing the
    // lock the first had just taken: the takeover itself is exclusive.
    if (await isStale(guard)) await atomic.remove(guard); // a takeover that crashed
    if (await atomic.createExclusive(guard, content)) {
      try {
        // Still stale: not a lock a takeover that finished meanwhile has just written
        if (await isStale(name)) {
          await atomic.remove(name);
          taken = await atomic.createExclusive(name, content);
        }
      } finally {
        await atomic.remove(guard);
      }
    }
  }
  if (taken && !(await holdsToken())) taken = false;
  if (!taken) return undefined;
  return {
    release: async () => {
      // Another gc may have taken the lock over (it found ours stale): leave its lock alone
      if (await holdsToken()) await atomic.remove(name);
    },
  };
}
