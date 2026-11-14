/**
 * Every installed pack of a pack directory (`objects/pack/pack-*.idx` with its `.pack`), as git's
 * packed_git list and JGit's PackDirectory:
 *
 *  - a pack that cannot be opened (corrupt idx, pack/idx mismatch) is skipped and recorded in
 *    `skipped`, as git warns and skips; the other packs stay readable;
 *  - a lookup miss rescans the directory (git's reprepare_packed_git), at most once per
 *    `rescanIntervalMs`, so a pack written by native git after open is found; packs whose idx
 *    disappeared are dropped;
 *  - a REF_DELTA base outside its pack is looked up in the other packs, then through the set's
 *    `externalBase` (loose objects), carrying the ids being resolved so a cycle fails;
 *  - a copy found corrupt is passed over for another pack's copy (git's mark_bad_packed_object);
 *  - one byte-bounded delta base cache serves every pack of the set.
 */
import type { FilesApi } from "../common/files/index.js";
import type { ObjectId } from "../common/id/index.js";
import type { GitObject } from "../history/objects/git-objects.js";
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
  has(id: ObjectId): Promise<boolean>;
  /**
   * The object from the first pack holding a sound copy, or undefined. With `verify`, the end of
   * the content throws `ObjectIdMismatchError` if it hashes to another id.
   */
  get(id: ObjectId, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /** The object's entry as stored in the first pack holding a sound copy (for reuse). */
  entry(id: ObjectId): Promise<PackedEntry | undefined>;
  /** Every packed id, once. */
  list(): AsyncIterable<ObjectId>;
  /** The packs, in lookup order (newest first). */
  packs(): Promise<readonly Pack[]>;
  /** Installs a pack with `installPack` into the directory and adds it to the set. */
  install(source: AsyncIterable<Uint8Array>, options?: InstallPackOptions): Promise<InstalledPack>;
  /** Removes packs: `.idx` first, then `.pack`, and `.keep`, `.rev`, `.bitmap`… if present. */
  remove(packIds: readonly string[]): Promise<void>;
  /** Rescans the directory now; true if packs were added or dropped. */
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
  const baseCache = new DeltaBaseCache(options.baseCacheBytes ?? 16 * 2 ** 20);
  let packs: PackFile[] = [];
  const byName = new Map<string, PackFile>();
  const skipped: { pack: string; error: string }[] = [];
  /** packs refused as corrupt: not retried by rescans */
  const refused = new Set<string>();
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

  /** Resolves a REF_DELTA base no pack of its own holds: the other packs, then loose objects. */
  const externalBase = async (
    id: ObjectId,
    visiting: ReadonlySet<ObjectId>,
  ): Promise<ResolvedObject | undefined> => {
    const o = (await lookup(id, { visiting }, false)) ?? (await options.externalBase?.(id));
    if (!o) return undefined;
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

  const open = (name: string) =>
    openPack(files, `${dir}/${name}.pack`, `${dir}/${name}.idx`, {
      baseCache,
      maxObjectSize,
      externalBase,
    });

  let scanning: Promise<boolean> | undefined;
  let lastRescan = Number.NEGATIVE_INFINITY;
  const scan = async (): Promise<boolean> => {
    const found: { name: string; lastModified: number }[] = [];
    if (await files.exists(dir)) {
      for await (const e of files.list(dir)) {
        if (e.kind === "file" && PACK_IDX.test(e.name))
          found.push({ name: e.name.slice(0, -4), lastModified: e.lastModified ?? 0 });
      }
    }
    let changed = false;
    const present = new Set(found.map((f) => f.name));
    for (const p of [...packs]) {
      if (!present.has(nameOf(p))) {
        drop(p);
        changed = true;
      }
    }
    // newest first, as git's and JGit's pack lists
    found.sort((a, b) => b.lastModified - a.lastModified || (a.name < b.name ? -1 : 1));
    const added: PackFile[] = [];
    for (const { name } of found) {
      if (byName.has(name) || refused.has(name)) continue;
      // an idx without its pack is ignored (a pack being removed, or not fully installed)
      if (!(await files.exists(`${dir}/${name}.pack`))) continue;
      try {
        const p = await open(name);
        byName.set(name, p);
        added.push(p);
        const i = skipped.findIndex((s) => s.pack === name);
        if (i >= 0) skipped.splice(i, 1);
      } catch (e) {
        // git warns and skips a pack it cannot use; a corrupt one is not retried, a storage
        // failure is retried by the next rescan
        record(name, e);
        if (e instanceof PackError) refused.add(name);
      }
    }
    if (added.length) {
      packs = [...added, ...packs];
      changed = true;
    }
    return changed;
  };
  const refresh = (): Promise<boolean> => {
    lastRescan = Date.now();
    if (!scanning) {
      scanning = scan().finally(() => {
        scanning = undefined;
      });
    }
    return scanning;
  };
  /** A rescan after a miss, unless one ran less than `rescanIntervalMs` ago. */
  const rescanOnMiss = async (): Promise<boolean> => {
    if (Date.now() - lastRescan < rescanInterval) {
      if (scanning) return scanning;
      return false;
    }
    return refresh();
  };

  /**
   * The first sound copy of `id`. A copy that fails before `get` returns (a corrupt header, a
   * bad delta, a missing base) is marked bad and the next pack is tried; the first error is
   * raised only when no copy remains. A pack whose file disappeared is dropped.
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
        return await p.get(id, o);
      } catch (e) {
        if (!(await files.exists(p.packPath))) {
          drop(p);
          continue;
        }
        if (!(e instanceof PackError)) throw e;
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
      if (!p.has(id) || isBad(p, id)) continue;
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

  await scan();

  return {
    skipped,
    refresh,
    async has(id) {
      if (!isId(id)) return false;
      if (packs.some((p) => p.has(id))) return true;
      return (await rescanOnMiss()) && packs.some((p) => p.has(id));
    },
    get: (id, o) => lookup(id, { verify: o?.verify }, true),
    entry: (id) => findEntry(id, true),
    async *list() {
      await rescanOnMiss();
      const seen = new Set<ObjectId>();
      for (const p of [...packs]) {
        for (const id of p.ids()) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
      }
    },
    async packs() {
      return [...packs];
    },
    async install(source, o) {
      const r = await installPack(files, dir, source, { maxObjectSize, ...o });
      const name = `pack-${r.packId}`;
      if (!byName.has(name)) {
        refused.delete(name);
        const p = await open(name);
        byName.set(name, p);
        packs = [p, ...packs];
        const i = skipped.findIndex((s) => s.pack === name);
        if (i >= 0) skipped.splice(i, 1);
      }
      return r;
    },
    async remove(packIds) {
      for (const packId of packIds) {
        const name = `pack-${packId}`;
        const p = byName.get(name);
        if (p) drop(p);
        refused.delete(name);
        const i = skipped.findIndex((s) => s.pack === name);
        if (i >= 0) skipped.splice(i, 1);
        // the idx goes first: a pack without its idx is invisible to every reader
        for (const ext of EXTENSIONS) {
          const path = `${dir}/${name}${ext}`;
          if (await files.exists(path)) await files.remove(path);
        }
      }
    },
  };
}
