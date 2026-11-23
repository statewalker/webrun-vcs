/**
 * Every installed pack of a pack directory (`objects/pack/pack-*.idx` with its `.pack`), as git's
 * packed_git list and JGit's PackDirectory:
 *
 *  - a pack that cannot be opened (corrupt idx, pack/idx mismatch) is skipped and recorded in
 *    `skipped`, as git warns and skips; the other packs stay readable. It is opened again by a
 *    later scan only if its `.idx` or `.pack` changed size or mtime (one seen half-written);
 *  - a lookup miss rescans the directory (git's reprepare_packed_git), at most once per
 *    `rescanIntervalMs`, so a pack written by native git after open is found; packs whose idx
 *    disappeared are dropped;
 *  - a REF_DELTA base outside its pack is looked up in the other packs, then through the set's
 *    `externalBase` (loose objects), carrying the ids being resolved so a cycle fails;
 *  - a copy found corrupt is passed over for another pack's copy (git's mark_bad_packed_object),
 *    and counts as absent for `has` and `freshen` (JGit's hasObject), so a repairing write lands;
 *  - one byte-bounded delta base cache serves every pack of the set.
 */
import { isHexObjectId, type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import type { FilesApi } from "../common/files/index.js";
import type { ObjectId } from "../common/id/index.js";
import { CorruptObjectError, type GitObject } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { noteObjectRemoved } from "../storage/raw/object-removals.js";
import {
  type InstalledPack,
  type InstallPackOptions,
  installPack,
  PackError,
} from "./index-pack.js";
import {
  badPackIntId,
  MIDX_CHAIN_DIR,
  MIDX_CHAIN_FILE,
  MIDX_FILE,
  type MultiPackIndex,
  MultiPackIndexError,
  multiPackIndexBitmapPack,
} from "./multi-pack-index.js";
import { clearMultiPackIndexNaming, loadMultiPackIndex } from "./multi-pack-index-files.js";
import { PackBitmapError, type PackBitmapIndex, parsePackBitmap } from "./pack-bitmap.js";
import {
  DEFAULT_DELTA_BASE_CACHE_LIMIT,
  DeltaBaseCache,
  openPack,
  type Pack,
  type PackedEntry,
  type PackFile,
  type ResolvedObject,
} from "./pack-file.js";
import { runSteps, runStepsAsync, type Steps } from "./run-steps.js";

/** Where `lookupSteps` resumes: at pack `at` of `packs`, with what its `getNow` gave. */
type Resume = { packs: readonly PackFile[]; at: number } & (
  | { value: GitObject | undefined | Promise<GitObject | undefined> }
  | { error: unknown }
);

export interface OpenPackSetOptions {
  /**
   * Bytes of resolved delta bases kept across reads, for the whole set (git's
   * core.deltaBaseCacheLimit). Default 96 MiB, as git's.
   */
  baseCacheBytes?: number;
  /** Largest object accepted, by its header, by delta results and for external bases. Default 1 GiB. */
  maxObjectSize?: number;
  /**
   * Minimum time between two rescans of the directory triggered by lookup misses (the first
   * miss always rescans). Default 1000 ms. `refresh()` rescans whatever the interval.
   */
  rescanIntervalMs?: number;
  /** Objects outside the set (loose objects), for REF_DELTA bases no pack holds. */
  externalBase?: (id: ObjectId) => Promise<GitObject | undefined>;
  /**
   * A pack whose `.pack` file was last modified longer ago than this is freshened by a write of
   * an object it holds: its mtime renewed (`FilesApi.touch`), as git's freshen_packed_object
   * touches it, which keeps a gc running at the same time from expiring the object. Where the
   * FilesApi cannot set times, `freshen` is false for such a pack and the object is written
   * loose again, the fresh loose copy playing that part. Default one hour (git's freshen
   * window). A pack whose mtime is unknown is trusted: gc keeps the unreachable objects of
   * such packs loose.
   */
  freshenMaxAgeMs?: number;
  /**
   * Use the directory's multi-pack-index (git's `core.multiPackIndex`, default true): lookups
   * try the pack the midx names for an object first. A midx git would refuse, one whose
   * checksum does not match, or one naming packs that are gone is not used (`midxErrors`).
   */
  multiPackIndex?: boolean;
  /**
   * Write `pack-<id>.rev` beside each pack `install` writes (git's `pack.writeReverseIndex`,
   * default true since 2.41), unless the install says otherwise.
   */
  writeReverseIndex?: boolean;
  /**
   * Take each pack's order from its `.rev` file where one is present and valid (git's
   * `pack.readReverseIndex`, default true); else it is computed from the idx's offsets.
   */
  readReverseIndex?: boolean;
  /**
   * The repository's object format (default SHA-1): the width of the packs' ids, checksums
   * and file names. In a SHA-256 repository the multi-pack-index and the bitmaps (whose
   * readers hold 20-byte ids) are not used: lookups go through each pack's `.idx`, walks
   * without bitmaps.
   */
  objectFormat?: ObjectFormat;
}

/** The packs of one directory, read as one object store. */
export interface PackSet {
  /** Whether a pack holds a copy not found corrupt (a miss rescans, within the rate limit). */
  has(id: ObjectId): Promise<boolean>;
  /**
   * Whether a pack still on storage holds a copy not found corrupt: the check before skipping a
   * write of an object already packed (git's freshen_packed_object). A pack whose file is gone is
   * dropped. A pack whose file was seen less than `rescanIntervalMs` ago (at most 1 s) is trusted
   * without another check (git checks once per pack per process): a write made in that window
   * after the pack was deleted is skipped and not retried. No rescan: a miss only means the
   * object is written loose. A holding pack's file older than `freshenMaxAgeMs` (default one
   * hour) has its mtime renewed (`FilesApi.touch`); where that cannot be done, false: the object
   * is then written loose again, with the current time, so a concurrent gc does not expire it
   * with its old pack. A cruft pack (one with a `.mtimes` file) never counts, whatever its age,
   * as git's `is_cruft` check: gc expires its objects by their times in `.mtimes`.
   */
  freshen(id: ObjectId): Promise<boolean>;
  /**
   * The object from the first pack holding a sound copy, or undefined. The first chunk of the
   * content is read before `get` returns, so a copy whose stream is broken from the start fails
   * here (and the next copy is tried); a failure later in the stream marks the copy bad. With
   * `verify`, the end of the content throws `ObjectIdMismatchError` if it hashes to another id.
   */
  get(id: ObjectId, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /**
   * `get`, without a promise when no I/O is needed (the copy is in a loaded window or the base
   * cache): the object or undefined, else a promise of it. Errors are thrown as `get` rejects
   * with them. Optional: a wrapper of a set may leave it out (callers then use `get`).
   */
  getNow?(
    id: ObjectId,
    options?: { verify?: boolean },
  ): GitObject | undefined | Promise<GitObject | undefined>;
  /**
   * The object's type and size from the entry headers of the copy `get` would read first
   * (`PackFile.header`), without resolving it. Undefined when no pack holds a copy, or when
   * that copy's headers cannot answer: `get` then reads it (and reports its errors). Optional:
   * a wrapper of a set may leave it out.
   */
  header?(id: ObjectId): Promise<{ type: ObjectTypeString; size: number } | undefined>;
  /** `header`'s type alone (`PackFile.objectType`): a delta's size is not read. */
  objectType?(id: ObjectId): Promise<ObjectTypeString | undefined>;
  /**
   * The object's entry as stored in the first pack holding a sound copy (for reuse), with the
   * id of that pack.
   */
  entry(id: ObjectId): Promise<(PackedEntry & { packId: string }) | undefined>;
  /**
   * Every packed id, once (an id is yielded by the first pack holding it). Without `packs`, the
   * directory is rescanned first (within the rate limit) and the current packs are listed; with
   * `packs` (a snapshot from `packs()`), exactly those are.
   */
  list(options?: { packs?: readonly Pack[] }): AsyncIterable<ObjectId>;
  /**
   * The packed ids starting with the lowercase hex `prefix`, once each: a binary search in
   * every idx (git's `find_short_packed_object`). Rescans as `list` does unless given `packs`.
   * Optional for wrappers of a set; `withPacks` filters `list` without it.
   */
  listPrefix?(prefix: string, options?: { packs?: readonly Pack[] }): AsyncIterable<ObjectId>;
  /** The packs, in lookup order (newest first), after a rescan within the rate limit. */
  packs(): Promise<readonly Pack[]>;
  /** Whether `install` writes `.rev` files unless told otherwise (`pack.writeReverseIndex`). */
  readonly writeReverseIndex?: boolean;
  /** Installs a pack with `installPack` into the directory and adds it to the set. */
  install(source: AsyncIterable<Uint8Array>, options?: InstallPackOptions): Promise<InstalledPack>;
  /** Removes packs: `.idx` first, then `.pack`, and `.keep`, `.rev`, `.bitmap`… if present. */
  remove(packIds: readonly string[]): Promise<void>;
  /**
   * Marks an installed pack as a promisor pack (a partial clone's): writes `pack-<id>.promisor`
   * with `content` (git's fetch-pack writes the fetched refs, `<id> <name>` per line, for a
   * kept pack; index-pack `--promisor` an empty file)
   */
  writePromisor?(packId: string, content: string): Promise<void>;
  /**
   * Rescans the directory now, whatever the rate limit: a scan that started before the call is
   * followed by a new one. True if packs were added or dropped.
   */
  refresh(): Promise<boolean>;
  /** Packs that could not be opened, skipped as git does. */
  readonly skipped: readonly { pack: string; error: string }[];
  /**
   * The reachability bitmap git would use: the `.bitmap` of the first pack (lookup order)
   * that has one it can read (`parsePackBitmap`), loaded once per pack; undefined when there
   * is none. Optional for wrappers of a set.
   */
  bitmap?(): Promise<PackBitmapIndex | undefined>;
  /**
   * git's error lines for the bitmap files `bitmap()` could not use (`error: corrupted bitmap
   * index file (wrong header)`, ...), from its last call.
   */
  readonly bitmapErrors?: readonly string[];
  /** The multi-pack-index lookups use, after a rescan within the rate limit; optional. */
  multiPackIndex?(): Promise<MultiPackIndex | undefined>;
  /** Why the directory's multi-pack-index is not used (git's lines), from the last scan. */
  readonly midxErrors?: readonly string[];
}

/**
 * Packs from which on a lookup asks the midx first: measured on 1860 objects, one pack reads
 * 25% slower through a midx, thirty packs two to three times faster.
 */
const MIDX_LOOKUP_MIN_PACKS = 3;
const EXTENSIONS = [".idx", ".pack", ".keep", ".rev", ".bitmap", ".promisor", ".mtimes"];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Opens every pack of `packDir`. A missing directory is an empty set.
 *
 * @example
 * ```typescript
 * const packs = await openPackSet(files, ".git/objects/pack");
 * const obj = await packs.get(id); // { type, size, content } or undefined
 * for (const s of packs.skipped) console.warn(`skipped ${s.pack}: ${s.error}`);
 * ```
 */
export async function openPackSet(
  files: FilesApi,
  packDir: string,
  options: OpenPackSetOptions = {},
): Promise<PackSet> {
  const dir = packDir.replace(/\/+$/, "");
  const maxObjectSize = options.maxObjectSize ?? 2 ** 30;
  const objectFormat = options.objectFormat ?? SHA1_OBJECT_FORMAT;
  const sha1 = objectFormat.name === "sha1";
  const hexLength = objectFormat.hexLength;
  const PACK_IDX = new RegExp(`^pack-[0-9a-f]{${hexLength}}\\.idx$`);
  const isId = (id: unknown): id is ObjectId => isHexObjectId(id, objectFormat);
  const rescanInterval = options.rescanIntervalMs ?? 1000;
  /** how long freshen trusts a pack it saw: capped, as a write it skips is never retried */
  const freshenTrust = Math.min(rescanInterval, 1000);
  const freshenMaxAge = options.freshenMaxAgeMs ?? 60 * 60 * 1000;
  const baseCache = new DeltaBaseCache(options.baseCacheBytes ?? DEFAULT_DELTA_BASE_CACHE_LIMIT);
  let packs: PackFile[] = [];
  const byName = new Map<string, PackFile>();
  /** opens in flight, shared by scans and installs of the same pack */
  const opening = new Map<string, Promise<PackFile>>();
  const skipped: { pack: string; error: string }[] = [];
  /** packs refused as corrupt, with the size and mtime of their files when they were refused */
  const refused = new Map<string, string>();
  /** removals: a scan does not add a pack removed after it started */
  let removals = 0;
  const removedAt = new Map<string, number>();
  /** packs whose files remove() is deleting: scans skip them until the files are gone */
  const removing = new Set<string>();
  /** when freshen last saw each pack's file, and that file's mtime (if the FilesApi gives one) */
  const seenAt = new WeakMap<PackFile, { at: number; modified?: number }>();
  const young = (modified: number | undefined, now: number) =>
    modified === undefined || now - modified <= freshenMaxAge;
  /**
   * Renews the mtime of an old pack's `.pack` file, as git's freshen_packed_object does
   * (`utime`), where the FilesApi can (`touch`); false where it cannot, and the object is then
   * written loose again, which plays that part.
   */
  const renew = async (p: PackFile, now: number): Promise<boolean> => {
    if (!files.touch || !(await files.touch(p.packPath).catch(() => false))) return false;
    seenAt.set(p, { at: now, modified: now });
    return true;
  };
  /**
   * Whether a pack is a cruft pack (it has a `.mtimes` file), looked up once per pack: git's
   * freshen_packed_object refuses those (`is_cruft`), as gc expires their objects by the
   * per-object times in `.mtimes`, which touching the pack does not renew; the object is then
   * written loose, a copy gc keeps until it is old.
   */
  const cruft = new WeakMap<PackFile, Promise<boolean>>();
  const isCruft = (p: PackFile): Promise<boolean> => {
    let c = cruft.get(p);
    if (c === undefined) {
      const mtimes = `${p.packPath.replace(/\.pack$/, "")}.mtimes`;
      c = files.stats(mtimes).then(
        (st) => st !== undefined,
        // unknown: treat as cruft (the object is written loose) and ask again next time
        () => {
          cruft.delete(p);
          return true;
        },
      );
      cruft.set(p, c);
    }
    return c;
  };
  /** copies found corrupt, per pack */
  const bad = new WeakMap<PackFile, Set<ObjectId>>();
  /** copies ever marked bad (none: no lookup in `bad`) */
  let badMarks = 0;
  const isBad = (p: PackFile, id: ObjectId) => badMarks !== 0 && (bad.get(p)?.has(id) ?? false);
  const markBad = (p: PackFile, id: ObjectId) => {
    badMarks++;
    let s = bad.get(p);
    if (!s) {
      s = new Set();
      bad.set(p, s);
    }
    s.add(id);
  };
  const holds = (p: PackFile, id: ObjectId) => p.has(id) && !isBad(p, id);
  const nameOf = (p: PackFile) => `pack-${p.packId}`;
  /** the midx in use and its loaded packs by pack-int-id (undefined: missing) */
  // a SHA-256 repository's midx is not read yet (its reader holds 20-byte ids)
  const useMidx = (options.multiPackIndex ?? true) && sha1;
  let midx: MultiPackIndex | undefined;
  let midxPacks: (PackFile | undefined)[] = [];
  let midxSig = "";
  let midxErrors: string[] = [];
  let midxLoaded: MultiPackIndex | undefined;
  /** The pack the midx names for `id`, when it is loaded (git's midx_fill_entry). */
  const midxPack = (id: ObjectId): PackFile | undefined => {
    const m = midx;
    // with one or two packs their own idx answer faster than a midx search plus the idx's
    if (!m || packs.length < MIDX_LOOKUP_MIN_PACKS) return undefined;
    const pos = m.find(id);
    if (pos < 0) return undefined;
    const p = midxPacks[m.packIntIdAt(pos)];
    return p && byName.get(nameOf(p)) === p ? p : undefined;
  };
  const midxSignature = async () => {
    const [a, b] = await Promise.all([
      files.stats(`${dir}/${MIDX_FILE}`),
      files.stats(`${dir}/${MIDX_CHAIN_DIR}/${MIDX_CHAIN_FILE}`),
    ]);
    return `${a?.size}:${a?.lastModified}:${b?.size}:${b?.lastModified}`;
  };
  /** (Re)loads the midx when its files changed; maps its packs to the loaded ones. */
  const loadMidx = async () => {
    if (!useMidx) return;
    const sig = await midxSignature();
    if (sig !== midxSig) {
      midxSig = sig;
      midxLoaded = undefined;
      const errors: string[] = [];
      if (sig !== "undefined:undefined:undefined:undefined") {
        const loaded = await loadMultiPackIndex(files, dir);
        errors.push(...loaded.errors);
        const bad = loaded.midx && badPackIntId(loaded.midx);
        if (loaded.midx && !loaded.midx.checksumValid()) {
          errors.push("warning: ignoring existing multi-pack-index; checksum mismatch");
        } else if (bad) {
          // git dies on the first lookup of such an object; we search the packs without it
          errors.push(`fatal: ${bad}`);
        } else if (loaded.midx) midxLoaded = loaded.midx;
      }
      midxErrors = errors;
    }
    midx = undefined;
    midxPacks = [];
    const m = midxLoaded;
    if (!m) return;
    const mapped: (PackFile | undefined)[] = [];
    for (let id = 0; id < m.numPacks + m.numPacksInBase; id++) {
      const name = m.packNameAt(id).replace(/\.idx$/, "");
      const p = byName.get(name);
      // a stale midx (naming a pack that is gone or cannot be opened) is not used: every
      // pack is then searched, so no object it would have hidden is missed
      if (!p) return;
      mapped.push(p);
    }
    midx = m;
    midxPacks = mapped;
  };
  const drop = (p: PackFile) => {
    packs = packs.filter((x) => x !== p);
    if (byName.get(nameOf(p)) === p) byName.delete(nameOf(p));
    p.close();
  };
  const record = (pack: string, error: unknown) => {
    const i = skipped.findIndex((s) => s.pack === pack);
    const entry = { pack, error: message(error) };
    if (i >= 0) skipped[i] = entry;
    else skipped.push(entry);
  };
  const unrecord = (pack: string) => {
    const i = skipped.findIndex((s) => s.pack === pack);
    if (i >= 0) skipped.splice(i, 1);
  };
  /**
   * Size and mtime of a pack's files: a refused pack is retried once they change. Taken before
   * the open, so a file completed during the open is retried. Without `lastModified` from the
   * FilesApi the signature is size-only: a rewrite to the same size is not retried.
   */
  const signature = async (name: string) => {
    const [i, p] = await Promise.all([
      files.stats(`${dir}/${name}.idx`),
      files.stats(`${dir}/${name}.pack`),
    ]);
    return `${i?.size}:${i?.lastModified}:${p?.size}:${p?.lastModified}`;
  };

  /** Resolves a REF_DELTA base no pack of its own holds: the other packs, then loose objects. */
  const externalBase = async (
    id: ObjectId,
    visiting: ReadonlySet<ObjectId>,
  ): Promise<ResolvedObject | undefined> => {
    let o: GitObject | undefined;
    let failed: unknown;
    try {
      o = await lookup(id, { visiting }, false);
    } catch (e) {
      // every packed copy is bad: a loose copy (a repaired base) may still serve
      if (!(e instanceof CorruptObjectError)) throw e;
      failed = e;
    }
    o ??= await options.externalBase?.(id);
    if (!o) {
      if (failed) throw failed;
      return undefined;
    }
    // checked before buffering: a loose zlib bomb of a few KB can declare gigabytes
    if (o.size > maxObjectSize) {
      const it = o.content[Symbol.asyncIterator]();
      await it.return?.();
      throw new PackError(
        `REF_DELTA base ${id} is ${o.size} bytes, over the limit of ${maxObjectSize}`,
      );
    }
    if (o.bytes) {
      await o.content[Symbol.asyncIterator]().return?.();
      return { type: o.type, data: o.bytes };
    }
    const data = new Uint8Array(o.size);
    let at = 0;
    for await (const c of o.content) {
      if (at + c.length > data.length)
        throw new PackError(`REF_DELTA base ${id} is longer than its size`);
      data.set(c, at);
      at += c.length;
    }
    if (at !== data.length) throw new PackError(`REF_DELTA base ${id} is shorter than its size`);
    return { type: o.type, data };
  };

  /**
   * Opens a pack; concurrent opens of the same name share one promise. The open checks what
   * git's check_packed_git_idx checks; the rest of the idx is checked as lookups use it.
   */
  const open = (name: string): Promise<PackFile> => {
    let pending = opening.get(name);
    if (!pending) {
      pending = openPack(files, `${dir}/${name}.pack`, `${dir}/${name}.idx`, {
        baseCache,
        maxObjectSize,
        externalBase,
        ...(options.readReverseIndex === false ? { readReverseIndex: false } : {}),
        ...(sha1 ? {} : { objectFormat }),
      }).finally(() => opening.delete(name));
      opening.set(name, pending);
    }
    return pending;
  };
  /** packs an install refused after opening them: a scan sharing that open does not add them */
  const rejected = new WeakSet<PackFile>();

  const scan = async (): Promise<boolean> => {
    const started = removals;
    const removedSince = (name: string) => (removedAt.get(name) ?? -1) > started;
    const before = [...packs];
    const found: { name: string; lastModified: number }[] = [];
    if (await files.exists(dir)) {
      for await (const e of files.list(dir)) {
        if (e.kind === "file" && PACK_IDX.test(e.name))
          found.push({ name: e.name.slice(0, -4), lastModified: e.lastModified ?? 0 });
      }
    }
    let changed = false;
    const present = new Set(found.map((f) => f.name));
    // a skipped or refused pack whose idx is gone (removed by a concurrent gc) is forgotten
    for (const name of refused.keys()) if (!present.has(name)) refused.delete(name);
    for (const s of [...skipped]) if (!present.has(s.pack)) unrecord(s.pack);
    // only packs known before the listing: one installed meanwhile is not in it
    for (const p of before) {
      if (!present.has(nameOf(p)) && packs.includes(p)) {
        drop(p);
        changed = true;
      }
    }
    // newest first, as git's and JGit's pack lists
    found.sort((a, b) => b.lastModified - a.lastModified || (a.name < b.name ? -1 : 1));
    const added: PackFile[] = [];
    const skip = (name: string) => removedSince(name) || removing.has(name);
    for (const { name } of found) {
      if (byName.has(name) || skip(name)) continue;
      let sig: string | undefined;
      try {
        sig = await signature(name);
        const refusedAs = refused.get(name);
        if (refusedAs !== undefined && refusedAs === sig) continue;
        // an idx without its pack is ignored (a pack being removed, or not fully installed)
        if (!(await files.exists(`${dir}/${name}.pack`))) continue;
        const p = await open(name);
        // removed, added by install, or refused by the install that shared this open
        if (skip(name) || byName.has(name) || rejected.has(p)) continue;
        byName.set(name, p);
        added.push(p);
        refused.delete(name);
        unrecord(name);
      } catch (e) {
        if (skip(name)) continue;
        // git warns and skips a pack it cannot use. A corrupt one is retried only once its
        // files change (an idx seen while it was written in place); a storage failure is
        // retried by the next scan. One pack's failure does not stop the scan.
        record(name, e);
        if (e instanceof PackError && sig !== undefined) refused.set(name, sig);
        else refused.delete(name);
      }
    }
    // a pack removed while this scan ran is no longer in `byName`
    const kept = added.filter((p) => byName.get(nameOf(p)) === p);
    if (kept.length) {
      packs = [...kept, ...packs];
      changed = true;
    }
    await loadMidx();
    return changed;
  };

  let scanning: Promise<boolean> | undefined;
  let queued: Promise<boolean> | undefined;
  let lastRescan = Number.NEGATIVE_INFINITY;
  const startScan = (): Promise<boolean> => {
    scanning = scan().finally(() => {
      scanning = undefined;
    });
    return scanning;
  };
  const refresh = (): Promise<boolean> => {
    lastRescan = Date.now();
    if (!scanning) return startScan();
    // the running scan may have listed the directory before this call: one more after it
    if (!queued) {
      const after = scanning.then(
        () => undefined,
        () => undefined,
      );
      queued = after.then(() => {
        queued = undefined;
        return scanning ?? startScan();
      });
    }
    return queued;
  };
  /** A rescan after a miss, unless one ran less than `rescanIntervalMs` ago. */
  const rescanOnMiss = async (): Promise<boolean> => {
    if (Date.now() - lastRescan < rescanInterval) return (await (queued ?? scanning)) ?? false;
    return refresh();
  };

  /**
   * Reads the first chunk before handing the object out, so a stream broken from its start
   * fails `get` itself; a failure later marks the copy bad for the next `get`.
   */
  function* guarded(p: PackFile, id: ObjectId, obj: GitObject): Steps<GitObject> {
    // already in memory: nothing left to fail
    if (obj.bytes) return obj;
    const it = obj.content[Symbol.asyncIterator]();
    let pending: IteratorResult<Uint8Array> | undefined =
      (yield it.next()) as IteratorResult<Uint8Array>;
    let finished = pending.done === true;
    // A custom iterator, not a generator: `return()` must close the inner read (the pack file
    // and the pooled inflater) even before the first `next()`, which a generator's `finally`
    // would not run.
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        if (pending) {
          const r = pending;
          pending = undefined;
          return r;
        }
        if (finished) return { done: true, value: undefined };
        try {
          const r = await it.next();
          if (r.done) finished = true;
          return r;
        } catch (e) {
          finished = true;
          if (e instanceof CorruptObjectError) markBad(p, id);
          throw e;
        }
      },
      async return() {
        pending = undefined;
        if (!finished) {
          finished = true;
          await it.return?.();
        }
        return { done: true, value: undefined };
      },
    };
    return { ...obj, content: { [Symbol.asyncIterator]: () => iterator } };
  }

  /**
   * The first sound copy of `id`. A copy that fails before `get` returns (a corrupt header, a
   * bad delta, a missing base, a broken first chunk) is marked bad and the next pack is tried;
   * the first error is raised only when no copy remains. A pack whose file disappeared is
   * dropped, and the miss then rescans whatever the rate limit: the pack was removed by a
   * repack, which installed its replacement first.
   */
  const lookup = (
    id: ObjectId,
    o: { verify?: boolean; visiting?: ReadonlySet<ObjectId> },
    rescan: boolean,
  ): Promise<GitObject | undefined> => runStepsAsync(lookupSteps(id, o, rescan));
  /** `lookup`, synchronous while the copy it reads is in memory (`PackFile.getNow`). */
  function* lookupSteps(
    id: ObjectId,
    o: { verify?: boolean; visiting?: ReadonlySet<ObjectId> },
    rescan: boolean,
    resume?: Resume,
  ): Steps<GitObject | undefined> {
    // no pack holds what is not an id (`has` parses it): checked only before a rescan
    let failed: unknown;
    let vanished = false;
    // the pack the midx names first (git reads midx-covered packs through it); any failure
    // there is left to the loop below, which tries that copy again and marks it bad
    if (!resume && midx && packs.length >= MIDX_LOOKUP_MIN_PACKS) {
      const p = midxPack(id);
      if (p && holds(p, id)) {
        try {
          let obj = p.getNow(id, o);
          if (obj instanceof Promise) obj = (yield obj) as GitObject | undefined;
          if (obj) return yield* guarded(p, id, obj);
        } catch {
          // the loop reads it again
        }
      }
    }
    // `packs` is replaced, never changed in place: this loop sees one snapshot
    const snapshot = resume?.packs ?? packs;
    for (let k = resume?.at ?? 0; k < snapshot.length; k++) {
      const p = snapshot[k] as PackFile;
      const resumed = resume !== undefined && k === resume.at;
      // `has` is false for an id in a corrupt idx bucket: a pack that cannot say it holds `id`
      // does not stop the rescan, and only held ids are marked bad (`find` remembers the id it
      // searched last, so `getNow` does not search again)
      if (!resumed && !p.has(id)) continue;
      if (!resumed && isBad(p, id)) {
        failed ??= new PackError(`object ${id}: the copy in pack ${p.packId} is corrupt`);
        continue;
      }
      try {
        let obj: GitObject | undefined | Promise<GitObject | undefined>;
        if (resumed) {
          if ("error" in resume) throw resume.error;
          obj = resume.value;
        } else obj = p.getNow(id, o);
        if (obj instanceof Promise) obj = (yield obj) as GitObject | undefined;
        if (obj) return yield* guarded(p, id, obj);
      } catch (e) {
        if (!((yield files.exists(p.packPath)) as boolean)) {
          drop(p);
          vanished = true;
          continue;
        }
        if (!(e instanceof CorruptObjectError)) throw e;
        markBad(p, id);
        failed ??= e;
      }
    }
    if (failed) throw failed;
    if (!isId(id)) return undefined;
    if (rescan && ((yield vanished ? refresh() : rescanOnMiss()) as boolean))
      return yield* lookupSteps(id, o, false);
    return undefined;
  }

  /** The pack `get` reads `id` from first, unless that copy is known corrupt (then none). */
  function firstCopy(id: ObjectId): PackFile | undefined {
    if (!isId(id)) return undefined;
    const snapshot = packs;
    let p: PackFile | undefined;
    if (midx && snapshot.length >= MIDX_LOOKUP_MIN_PACKS) {
      const m = midxPack(id);
      if (m && holds(m, id)) p = m;
    }
    p ??= snapshot.find((q) => q.has(id));
    return p && !isBad(p, id) ? p : undefined;
  }

  async function findEntry(
    id: ObjectId,
    rescan: boolean,
  ): Promise<(PackedEntry & { packId: string }) | undefined> {
    if (!isId(id)) return undefined;
    let vanished = false;
    for (const p of [...packs]) {
      if (!holds(p, id)) continue;
      let stored: PackedEntry | undefined;
      try {
        stored = await p.entry(id);
      } catch (e) {
        if (!(await files.exists(p.packPath))) {
          drop(p);
          vanished = true;
          continue;
        }
        if (!(e instanceof PackError)) throw e;
        markBad(p, id);
        continue;
      }
      if (!stored) continue;
      const entry = stored;
      const data = entry.data?.bind(entry);
      const bad = (e: unknown) => {
        if (e instanceof PackError) markBad(p, id);
        throw e;
      };
      return {
        ...entry,
        packId: p.packId,
        ...(data
          ? {
              data() {
                try {
                  const d = data();
                  return d instanceof Uint8Array ? d : d.catch(bad);
                } catch (e) {
                  return bad(e);
                }
              },
            }
          : {}),
        async *raw() {
          try {
            yield* entry.raw();
          } catch (e) {
            if (e instanceof PackError) markBad(p, id);
            throw e;
          }
        },
      };
    }
    if (rescan && (await (vanished ? refresh() : rescanOnMiss()))) return findEntry(id, false);
    return undefined;
  }

  await startScan();

  /** the loaded bitmap, by the pack it belongs to and its file's size and mtime */
  const loadedBitmaps = new WeakMap<
    PackFile,
    { signature: string; index?: PackBitmapIndex; error?: string }
  >();
  let bitmapErrors: string[] = [];
  /** the loaded midx bitmap, by its path and its file's size and mtime */
  let midxBitmap: { key: string; index?: PackBitmapIndex; error?: string } | undefined;
  const readBytes = async (path: string): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of files.read(path)) {
      chunks.push(c);
      n += c.length;
    }
    if (chunks.length === 1) return chunks[0] as Uint8Array;
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return bytes;
  };
  /**
   * The midx's bitmap (`multi-pack-index-<checksum>.bitmap`), which git prefers over the packs'
   * own: its header must name this midx's checksum (a bitmap left from an older midx is
   * refused), its bits are the midx's pseudo-pack order.
   */
  const loadMidxBitmap = async (errors: string[]): Promise<PackBitmapIndex | undefined> => {
    const m = midx;
    if (!m || m.base || !m.revIndex) return undefined;
    const path = `${dir}/multi-pack-index-${m.checksum}.bitmap`;
    const st = await files.stats(path);
    if (st?.kind !== "file") return undefined;
    const key = `${path}:${st.size}:${st.lastModified}`;
    if (midxBitmap?.key !== key) {
      try {
        midxBitmap = {
          key,
          index: parsePackBitmap(await readBytes(path), multiPackIndexBitmapPack(m), path),
        };
      } catch (e) {
        // a crafted RIDX/BTMP (MultiPackIndexError) refuses the bitmap: the walk answers
        if (!(e instanceof PackBitmapError) && !(e instanceof MultiPackIndexError)) throw e;
        midxBitmap = { key, error: `error: ${e.message}` };
      }
    }
    if (midxBitmap.error) errors.push(midxBitmap.error);
    return midxBitmap.index;
  };
  const bitmap = async (): Promise<PackBitmapIndex | undefined> => {
    // a SHA-256 repository's bitmaps are not read yet (their reader holds 20-byte ids)
    if (!sha1) return undefined;
    await rescanOnMiss();
    const errors: string[] = [];
    try {
      const fromMidx = await loadMidxBitmap(errors);
      if (fromMidx) return fromMidx;
      for (const p of [...packs]) {
        const path = `${dir}/${nameOf(p)}.bitmap`;
        const st = await files.stats(path);
        if (st?.kind !== "file") continue;
        const sig = `${st.size}:${st.lastModified}`;
        const cached = loadedBitmaps.get(p);
        if (cached?.signature === sig) {
          if (cached.index) return cached.index;
          if (cached.error) errors.push(cached.error);
          continue;
        }
        try {
          const chunks: Uint8Array[] = [];
          let n = 0;
          for await (const c of files.read(path)) {
            chunks.push(c);
            n += c.length;
          }
          const bytes = chunks.length === 1 ? (chunks[0] as Uint8Array) : new Uint8Array(n);
          if (chunks.length !== 1) {
            let at = 0;
            for (const c of chunks) {
              bytes.set(c, at);
              at += c.length;
            }
          }
          // the pack order from its .rev where valid (git's load_pack_revindex)
          await p.loadReverseIndex?.();
          const index = parsePackBitmap(bytes, p, path);
          loadedBitmaps.set(p, { signature: sig, index });
          return index;
        } catch (e) {
          if (!(e instanceof PackBitmapError)) throw e;
          const error = `error: ${e.message}`;
          errors.push(error);
          loadedBitmaps.set(p, { signature: sig, error });
        }
      }
      return undefined;
    } finally {
      bitmapErrors = errors;
    }
  };

  return {
    skipped,
    refresh,
    bitmap,
    get bitmapErrors() {
      return bitmapErrors;
    },
    get midxErrors() {
      return midxErrors;
    },
    async multiPackIndex() {
      await rescanOnMiss();
      return midx;
    },
    async has(id) {
      if (!isId(id)) return false;
      if (midx && packs.length >= MIDX_LOOKUP_MIN_PACKS) {
        const p = midxPack(id);
        if (p && holds(p, id)) return true;
      }
      if (packs.some((p) => holds(p, id))) return true;
      return (await rescanOnMiss()) && packs.some((p) => holds(p, id));
    },
    async freshen(id) {
      if (!isId(id)) return false;
      for (const p of [...packs]) {
        if (!holds(p, id)) continue;
        if (await isCruft(p)) continue; // its times are in .mtimes: written loose
        const now = Date.now();
        const seen = seenAt.get(p);
        if (seen !== undefined && now - seen.at < freshenTrust) {
          if (young(seen.modified, now)) return true;
          if (await renew(p, now)) return true;
          continue; // too old to rely on: written loose again
        }
        const stats = await files.stats(p.packPath);
        if (stats?.kind === "file") {
          seenAt.set(p, { at: now, modified: stats.lastModified });
          if (young(stats.lastModified, now)) return true;
          if (await renew(p, now)) return true;
          continue;
        }
        drop(p); // deleted behind our back (git repack -a -d, gc): the object must be written
      }
      return false;
    },
    get: (id, o) => lookup(id, { verify: o?.verify }, true),
    getNow(id, o) {
      // the common case without a generator: the first pack holding `id` has it in memory
      const snapshot = packs;
      const opts = { verify: o?.verify };
      if (midx && snapshot.length >= MIDX_LOOKUP_MIN_PACKS)
        return runSteps(lookupSteps(id, opts, true));
      for (let k = 0; k < snapshot.length; k++) {
        const p = snapshot[k] as PackFile;
        if (!p.has(id)) continue;
        if (isBad(p, id)) break;
        let resume: Resume;
        try {
          const obj = p.getNow(id, opts);
          if (obj !== undefined && !(obj instanceof Promise) && obj.bytes) return obj;
          resume = { packs: snapshot, at: k, value: obj };
        } catch (error) {
          resume = { packs: snapshot, at: k, error };
        }
        return runSteps(lookupSteps(id, opts, true, resume));
      }
      return runSteps(lookupSteps(id, opts, true));
    },
    async header(id) {
      const p = firstCopy(id);
      return p?.header ? p.header(id) : undefined;
    },
    async objectType(id) {
      const p = firstCopy(id);
      return p?.objectType ? p.objectType(id) : undefined;
    },
    entry: (id) => findEntry(id, true),
    async *list(o) {
      // an id is yielded by the first pack holding it: no set of every id
      let snapshot = o?.packs;
      if (!snapshot) {
        await rescanOnMiss();
        snapshot = [...packs];
      }
      for (let k = 0; k < snapshot.length; k++) {
        const p = snapshot[k] as Pack;
        for (const id of p.ids()) {
          let earlier = false;
          for (let j = 0; j < k && !earlier; j++) earlier = (snapshot[j] as Pack).has(id);
          if (!earlier) yield id;
        }
      }
    },
    async *listPrefix(prefix, o) {
      let snapshot = o?.packs;
      if (!snapshot) {
        await rescanOnMiss();
        snapshot = [...packs];
      }
      const seen = new Set<ObjectId>();
      for (const p of snapshot) {
        const ids = p.idsWithPrefix
          ? p.idsWithPrefix(prefix)
          : [...p.ids()].filter((id) => id.startsWith(prefix));
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
      }
    },
    async packs() {
      await rescanOnMiss();
      return [...packs];
    },
    writeReverseIndex: options.writeReverseIndex ?? true,
    async install(source, o) {
      const r = await installPack(files, dir, source, {
        maxObjectSize,
        writeReverseIndex: options.writeReverseIndex ?? true,
        ...(sha1 ? {} : { objectFormat }),
        ...o,
      });
      const name = `pack-${r.packId}`;
      if (!byName.has(name)) {
        // taken before the open, as a scan does: the pack is retried once its files change
        const sig = await signature(name);
        // an idx just written is checked whole, as index-pack does. The open may be one a
        // scan started (unverified): it is shared, and the idx checked after it.
        let p: PackFile | undefined;
        try {
          p = await open(name);
          await p.verifyIndex();
        } catch (e) {
          // refused as a scan refuses a pack it cannot open: the set is left as it was (a
          // scan that shared the open and added the pack meanwhile loses it again), and the
          // files stay (they may be a copy installed before, which other readers use)
          if (p) {
            rejected.add(p);
            if (byName.get(name) === p) drop(p);
            else p.close();
          }
          record(name, e);
          if (e instanceof PackError) refused.set(name, sig);
          throw e;
        }
        if (!byName.has(name)) {
          byName.set(name, p);
          packs = [p, ...packs];
          refused.delete(name);
          unrecord(name);
        }
      }
      return r;
    },
    async writePromisor(packId, content) {
      await files.write(`${dir}/pack-${packId}.promisor`, [new TextEncoder().encode(content)]);
    },
    async remove(packIds) {
      // a midx naming a pack about to go is cleared first, as git's repack does
      if (packIds.length)
        await clearMultiPackIndexNaming(
          files,
          dir,
          packIds.map((id) => `pack-${id}.pack`),
        );
      for (const packId of packIds) {
        const name = `pack-${packId}`;
        removedAt.set(name, ++removals);
        removing.add(name);
        const p = byName.get(name);
        if (p) drop(p);
        refused.delete(name);
        unrecord(name);
        try {
          // the idx goes first: a pack without its idx is invisible to every reader
          for (const ext of EXTENSIONS) {
            const path = `${dir}/${name}${ext}`;
            if (await files.exists(path)) await files.remove(path);
          }
        } finally {
          removing.delete(name);
        }
      }
      // objects only in the removed packs are gone: cached parses are checked again
      if (packIds.length) noteObjectRemoved();
      await loadMidx();
    },
  };
}
