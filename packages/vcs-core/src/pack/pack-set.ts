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
import type { FilesApi } from "../common/files/index.js";
import type { ObjectId } from "../common/id/index.js";
import { CorruptObjectError, type GitObject } from "../history/objects/git-objects.js";
import {
  type InstalledPack,
  type InstallPackOptions,
  installPack,
  PackError,
} from "./index-pack.js";
import {
  DeltaBaseCache,
  openPack,
  type Pack,
  type PackedEntry,
  type PackFile,
  type ResolvedObject,
} from "./pack-file.js";

export interface OpenPackSetOptions {
  /** Bytes of resolved delta bases kept across reads, for the whole set. Default 16 MiB. */
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
   * object is written loose.
   */
  freshen(id: ObjectId): Promise<boolean>;
  /**
   * The object from the first pack holding a sound copy, or undefined. The first chunk of the
   * content is read before `get` returns, so a copy whose stream is broken from the start fails
   * here (and the next copy is tried); a failure later in the stream marks the copy bad. With
   * `verify`, the end of the content throws `ObjectIdMismatchError` if it hashes to another id.
   */
  get(id: ObjectId, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /** The object's entry as stored in the first pack holding a sound copy (for reuse). */
  entry(id: ObjectId): Promise<PackedEntry | undefined>;
  /**
   * Every packed id, once (an id is yielded by the first pack holding it). Without `packs`, the
   * directory is rescanned first (within the rate limit) and the current packs are listed; with
   * `packs` (a snapshot from `packs()`), exactly those are.
   */
  list(options?: { packs?: readonly Pack[] }): AsyncIterable<ObjectId>;
  /** The packs, in lookup order (newest first), after a rescan within the rate limit. */
  packs(): Promise<readonly Pack[]>;
  /** Installs a pack with `installPack` into the directory and adds it to the set. */
  install(source: AsyncIterable<Uint8Array>, options?: InstallPackOptions): Promise<InstalledPack>;
  /** Removes packs: `.idx` first, then `.pack`, and `.keep`, `.rev`, `.bitmap`… if present. */
  remove(packIds: readonly string[]): Promise<void>;
  /**
   * Rescans the directory now, whatever the rate limit: a scan that started before the call is
   * followed by a new one. True if packs were added or dropped.
   */
  refresh(): Promise<boolean>;
  /** Packs that could not be opened, skipped as git does. */
  readonly skipped: readonly { pack: string; error: string }[];
}

const OID = /^[0-9a-f]{40}$/;
const PACK_IDX = /^pack-[0-9a-f]{40}\.idx$/;
const EXTENSIONS = [".idx", ".pack", ".keep", ".rev", ".bitmap", ".promisor", ".mtimes"];
const isId = (id: unknown): id is ObjectId => typeof id === "string" && OID.test(id);
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
  const rescanInterval = options.rescanIntervalMs ?? 1000;
  /** how long freshen trusts a pack it saw: capped, as a write it skips is never retried */
  const freshenTrust = Math.min(rescanInterval, 1000);
  const baseCache = new DeltaBaseCache(options.baseCacheBytes ?? 16 * 2 ** 20);
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
  /** when freshen last saw each pack's file */
  const seenAt = new WeakMap<PackFile, number>();
  /** copies found corrupt, per pack */
  const bad = new WeakMap<PackFile, Set<ObjectId>>();
  const isBad = (p: PackFile, id: ObjectId) => bad.get(p)?.has(id) ?? false;
  const markBad = (p: PackFile, id: ObjectId) => {
    let s = bad.get(p);
    if (!s) {
      s = new Set();
      bad.set(p, s);
    }
    s.add(id);
  };
  const holds = (p: PackFile, id: ObjectId) => p.has(id) && !isBad(p, id);
  const nameOf = (p: PackFile) => `pack-${p.packId}`;
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

  /** Opens a pack; concurrent opens of the same name share one promise. */
  const open = (name: string): Promise<PackFile> => {
    let pending = opening.get(name);
    if (!pending) {
      pending = openPack(files, `${dir}/${name}.pack`, `${dir}/${name}.idx`, {
        baseCache,
        maxObjectSize,
        externalBase,
      }).finally(() => opening.delete(name));
      opening.set(name, pending);
    }
    return pending;
  };

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
        if (skip(name) || byName.has(name)) continue; // removed, or added by install
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
  const guarded = async (p: PackFile, id: ObjectId, obj: GitObject): Promise<GitObject> => {
    const it = obj.content[Symbol.asyncIterator]();
    let pending: IteratorResult<Uint8Array> | undefined = await it.next();
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
  };

  /**
   * The first sound copy of `id`. A copy that fails before `get` returns (a corrupt header, a
   * bad delta, a missing base, a broken first chunk) is marked bad and the next pack is tried;
   * the first error is raised only when no copy remains. A pack whose file disappeared is
   * dropped.
   */
  async function lookup(
    id: ObjectId,
    o: { verify?: boolean; visiting?: ReadonlySet<ObjectId> },
    rescan: boolean,
  ): Promise<GitObject | undefined> {
    if (!isId(id)) return undefined;
    let failed: unknown;
    for (const p of [...packs]) {
      if (!p.has(id)) continue;
      if (isBad(p, id)) {
        failed ??= new PackError(`object ${id}: the copy in pack ${p.packId} is corrupt`);
        continue;
      }
      try {
        const obj = await p.get(id, o);
        if (obj) return await guarded(p, id, obj);
      } catch (e) {
        if (!(await files.exists(p.packPath))) {
          drop(p);
          continue;
        }
        if (!(e instanceof CorruptObjectError)) throw e;
        markBad(p, id);
        failed ??= e;
      }
    }
    if (failed) throw failed;
    if (rescan && (await rescanOnMiss())) return lookup(id, o, false);
    return undefined;
  }

  async function findEntry(id: ObjectId, rescan: boolean): Promise<PackedEntry | undefined> {
    if (!isId(id)) return undefined;
    for (const p of [...packs]) {
      if (!holds(p, id)) continue;
      let stored: PackedEntry | undefined;
      try {
        stored = await p.entry(id);
      } catch (e) {
        if (!(await files.exists(p.packPath))) {
          drop(p);
          continue;
        }
        if (!(e instanceof PackError)) throw e;
        markBad(p, id);
        continue;
      }
      if (!stored) continue;
      const entry = stored;
      return {
        ...entry,
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
    if (rescan && (await rescanOnMiss())) return findEntry(id, false);
    return undefined;
  }

  await startScan();

  return {
    skipped,
    refresh,
    async has(id) {
      if (!isId(id)) return false;
      if (packs.some((p) => holds(p, id))) return true;
      return (await rescanOnMiss()) && packs.some((p) => holds(p, id));
    },
    async freshen(id) {
      if (!isId(id)) return false;
      for (const p of [...packs]) {
        if (!holds(p, id)) continue;
        const seen = seenAt.get(p);
        if (seen !== undefined && Date.now() - seen < freshenTrust) return true;
        if (await files.exists(p.packPath)) {
          seenAt.set(p, Date.now());
          return true;
        }
        drop(p); // deleted behind our back (git repack -a -d, gc): the object must be written
      }
      return false;
    },
    get: (id, o) => lookup(id, { verify: o?.verify }, true),
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
    async packs() {
      await rescanOnMiss();
      return [...packs];
    },
    async install(source, o) {
      const r = await installPack(files, dir, source, { maxObjectSize, ...o });
      const name = `pack-${r.packId}`;
      if (!byName.has(name)) {
        const p = await open(name);
        if (!byName.has(name)) {
          byName.set(name, p);
          packs = [p, ...packs];
          refused.delete(name);
          unrecord(name);
        }
      }
      return r;
    },
    async remove(packIds) {
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
    },
  };
}
