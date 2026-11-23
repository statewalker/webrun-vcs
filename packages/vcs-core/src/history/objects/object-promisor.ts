/**
 * Lazy fetching of a partial clone's absent objects, as git's object layer does it
 * (odb.c `do_oid_object_info_extended`, promisor-remote.c `promisor_remote_get_direct`,
 * packfile.c `is_promisor_object`).
 *
 * A read (`get`, `getNow`, `getRaw`) of an object the store lacks asks the repository's
 * {@link PromisorFetcher} for it, once, and reads again; `has` never fetches (git's
 * `odb_has_object` without `HAS_OBJECT_FETCH_PROMISOR`). Commands that read many absent
 * objects fetch them in one batch first ({@link ObjectPromisor.prefetch}, git's
 * `prefetch_cache_entries`, `diff_queued_diff_prefetch`, ...), and walks over promised
 * objects read through the store's view without lazy fetch (`objects.withoutLazyFetch`,
 * `historyWithoutLazyFetch`; git's `fetch_if_missing = 0`). The view is a context the caller
 * passes down, never a store-wide switch: a read elsewhere still fetches.
 *
 * @example
 * ```typescript
 * const { objects } = await createGitFilesBackend({ files });
 * objects.promisor?.setFetcher({
 *   hasPromisorRemote: () => true,
 *   fetch: async (ids) => { await fetchFromOrigin(ids); return []; },
 * });
 * await objects.get(absentBlobId); // fetched from origin, then read
 * ```
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObject, GitObjects } from "./git-objects.js";

/** Fetches absent objects from the promisor remotes (what vcs-commands supplies). */
export interface PromisorFetcher {
  /** Whether the repository has promisor remotes (git's `repo_has_promisor_remote`) */
  hasPromisorRemote(): boolean;
  /**
   * git's `fetch_if_missing` as a command starts: false where single reads never fetch (git
   * 2.45+ under `GIT_NO_LAZY_FETCH`). Unset: true.
   */
  fetchIfMissing?(): boolean;
  /**
   * `promisor_remote_get_direct` before its last check: tries the promisor remotes in git's
   * order (a `git fetch <remote> --filter=blob:none` of the ids each), and resolves with the
   * ids still to report when every remote failed; `[]` once one fetch succeeded, whatever
   * it brought (the read after it tells).
   */
  fetch(ids: readonly ObjectId[]): Promise<readonly ObjectId[]>;
  /**
   * Forgets what the fetcher read of the configuration (git's
   * `repo_promisor_remote_reinit`), after a command registered a promisor remote
   */
  invalidate?(): void;
}

/** git's `could not fetch <id> from promisor remote` (promisor_remote_get_direct dies). */
export class PromisorFetchError extends Error {
  readonly objectId: ObjectId;
  /** The warnings printed before it (`warning: lazy fetching disabled; ...`) */
  readonly warnings: readonly string[];
  constructor(objectId: ObjectId, warnings: readonly string[] = []) {
    super(`could not fetch ${objectId} from promisor remote`);
    this.name = "PromisorFetchError";
    this.objectId = objectId;
    this.warnings = warnings;
  }
}

/**
 * An object of a promisor pack that cannot be read while the promisor objects are listed
 * (git's `add_promisor_object` dies: `packed object <id> (stored in <pack>) is corrupt`).
 */
export class PromisorObjectReadError extends Error {
  readonly objectId: ObjectId;
  /** The promisor pack holding it */
  readonly packId: string;
  constructor(objectId: ObjectId, packId: string, cause: unknown) {
    super(`packed object ${objectId} is corrupt`, { cause });
    this.name = "PromisorObjectReadError";
    this.objectId = objectId;
    this.packId = packId;
  }
}

/** A pack of the store, as the promisor sees it. */
export interface PromisorPack {
  readonly packId: string;
  /** The ids it holds */
  ids(): Iterable<ObjectId>;
  has(id: ObjectId): boolean;
  /** Each entry's idx position in pack order (by offset), where the pack knows it */
  packOrder?(): Uint32Array;
  /** The id at idx position `i` */
  idAt?(i: number): ObjectId;
}

/** The partial clone side of an object store (see the module documentation). */
export interface ObjectPromisor {
  /** The fetcher in use (none: nothing is ever fetched) */
  readonly fetcher: PromisorFetcher | undefined;
  /** Installs (or removes) the fetcher */
  setFetcher(fetcher: PromisorFetcher | undefined): void;
  /** Whether a fetcher is installed and the repository has promisor remotes */
  hasPromisorRemote(): boolean;
  /**
   * Whether single reads may fetch: a fetcher is installed and it allows them (git's
   * `fetch_if_missing` as the command starts). Walks that must not fetch read through the
   * store's `withoutLazyFetch` view instead of turning this off.
   */
  readonly lazyFetchEnabled: boolean;
  /**
   * Fetches, in one batch, those of `ids` the store lacks (git's callers of
   * `promisor_remote_get_direct` after `OBJECT_INFO_FOR_PREFETCH`); nothing without promisor
   * remotes or when none is absent. Throws {@link PromisorFetchError} for an id every remote
   * failed to send that is a promisor object. Resolves with the number of ids asked for.
   */
  prefetch(ids: Iterable<ObjectId>): Promise<number>;
  /**
   * `promisor_remote_get_direct` of `ids` (each absent, not checked here): resolves with the
   * ids no remote sent (none once a fetch succeeded), throws {@link PromisorFetchError} for
   * the first of them that is a promisor object
   */
  fetchObjects(ids: readonly ObjectId[]): Promise<readonly ObjectId[]>;
  /**
   * git's `is_promisor_object`: held by a promisor pack, or named by an object one holds (a
   * tree's entries, a commit's tree and parents, a tag's object)
   */
  isPromisorObject(id: ObjectId): Promise<boolean>;
  /** The ids held by promisor packs (git's `FOR_EACH_OBJECT_PROMISOR_ONLY`) */
  promisorPackObjects(): Promise<ReadonlySet<ObjectId>>;
  /** Every promisor object (see {@link isPromisorObject}) */
  /**
   * Every promisor object (see {@link isPromisorObject}). An object of a promisor pack that
   * cannot be read throws {@link PromisorObjectReadError} (git 2.5x dies), or with
   * `skipUnreadable` names nothing (git 2.43's `add_promisor_object` skips what it cannot
   * parse)
   */
  promisedObjects(options?: { skipUnreadable?: boolean }): Promise<ReadonlySet<ObjectId>>;
  /** The promisor packs, in the store's lookup order */
  promisorPacks(): Promise<readonly PromisorPack[]>;
  /**
   * What index-pack `--promisor` repacks after a promisor pack came in (git 2.48+
   * `repack_local_links`): `links` are the outgoing links of the received objects (a commit's
   * tree and parents, a tree's subtrees, a tag's object); each one stored outside the promisor
   * packs is a tip of `pack-objects --exclude-promisor-objects-best-effort`, whose walk is
   * returned: every commit it reaches (one in a promisor pack listed, its parents and tree not
   * walked), every tree outside the promisor packs with its present blobs, absent objects
   * skipped. Empty when no link is local.
   */
  localLinkObjects(links: Iterable<ObjectId>): Promise<ObjectId[]>;
  /** The warnings fetches printed (`warning: lazy fetching disabled; ...`), oldest first */
  readonly warnings: string[];
  /** Number of fetches asked of the fetcher so far (tests count git's round trips with it) */
  readonly fetchCount: number;
}

/** What {@link createObjectPromisor} reads. */
export interface ObjectPromisorOptions {
  /** The store's objects, without lazy fetching (reads of promisor packs' objects) */
  objects: Pick<GitObjects, "get" | "has">;
  /** The store's promisor packs (packs with a `.promisor` file), in lookup order */
  promisorPacks(): Promise<readonly PromisorPack[]>;
  /**
   * Whether the store holds `id` outside its promisor packs too (loose, or in another pack):
   * git's lookup then finds a copy that is no promisor object (`repack_local_links`, and its
   * pack-objects' include check). Unset: never.
   */
  storedOutsidePromisorPacks?(id: ObjectId): Promise<boolean>;
}

const OID = /^[0-9a-f]{40}$/;

/** The partial clone side of a store: see {@link ObjectPromisor}. */
export function createObjectPromisor(options: ObjectPromisorOptions): ObjectPromisor {
  let fetcher: PromisorFetcher | undefined;
  let fetchCount = 0;
  const warnings: string[] = [];
  /** The promisor objects, built for the promisor packs listed in `builtFor` */
  let built: { key: string; packs: Set<ObjectId>; promised: Set<ObjectId> } | undefined;

  const hasPromisorRemote = () => {
    try {
      return fetcher?.hasPromisorRemote() === true;
    } catch {
      return false;
    }
  };

  const objectSets = async (skipUnreadable = false) => {
    const packs = await options.promisorPacks();
    const key = packs.map((p) => p.packId).join(",");
    if (built?.key === key) return built;
    const inPacks = new Set<ObjectId>();
    const promised = new Set<ObjectId>();
    const packOf = new Map<ObjectId, string>();
    for (const pack of packs) {
      // for_each_packed_object(FOR_EACH_OBJECT_PACK_ORDER): by offset where known
      const order = pack.packOrder && pack.idAt ? pack.packOrder() : undefined;
      const ids = order
        ? Array.from(order, (i) => (pack.idAt as (i: number) => ObjectId)(i))
        : pack.ids();
      for (const id of ids) {
        inPacks.add(id);
        if (!packOf.has(id)) packOf.set(id, pack.packId);
      }
    }
    // add_promisor_object over every object of the promisor packs (pack order); an object
    // that cannot be read is an error, as git's for_each_packed_object dies on it
    for (const id of inPacks) {
      promised.add(id);
      try {
        const obj: GitObject | undefined = await options.objects.get(id);
        if (!obj) continue;
        if (obj.type === "blob") {
          if (!obj.bytes) await obj.content[Symbol.asyncIterator]().return?.();
          continue;
        }
        const bytes = obj.bytes ?? (await collect(obj.content));
        for (const named of namedObjects(obj.type, bytes)) promised.add(named);
      } catch (error) {
        if (skipUnreadable) continue;
        throw new PromisorObjectReadError(id, packOf.get(id) ?? "", error);
      }
    }
    built = { key, packs: inPacks, promised };
    return built;
  };

  const fetchObjects = async (ids: readonly ObjectId[]): Promise<readonly ObjectId[]> => {
    if (ids.length === 0) return [];
    const current = fetcher;
    if (!current) return ids;
    fetchCount++;
    const before = warnings.length;
    const remaining = await current.fetch(ids);
    for (const id of remaining) {
      if (await isPromisorObject(id)) {
        throw new PromisorFetchError(id, warnings.slice(before));
      }
    }
    return remaining;
  };

  // git builds the set only with a promisor remote; the promisor packs say as much here
  const isPromisorObject = async (id: ObjectId) => (await objectSets()).promised.has(id);

  const promisor: ObjectPromisor = {
    get fetcher() {
      return fetcher;
    },
    setFetcher(f) {
      fetcher = f;
    },
    hasPromisorRemote,
    get lazyFetchEnabled() {
      if (!fetcher) return false;
      try {
        return fetcher.fetchIfMissing?.() ?? true;
      } catch {
        return true;
      }
    },
    async prefetch(ids) {
      if (!hasPromisorRemote()) return 0;
      const missing: ObjectId[] = [];
      for (const id of ids) {
        if (!OID.test(id)) continue;
        if (!(await options.objects.has(id))) missing.push(id);
      }
      await fetchObjects(missing);
      return missing.length;
    },
    fetchObjects,
    isPromisorObject,
    async promisorPackObjects() {
      return (await objectSets()).packs;
    },
    async promisedObjects(opts) {
      return (await objectSets(opts?.skipUnreadable === true)).promised;
    },
    promisorPacks: () => options.promisorPacks(),
    async localLinkObjects(links) {
      const { packs: inPromisorPacks } = await objectSets();
      // in a promisor pack only: a copy elsewhere is what git's lookup finds first
      const outside = new Map<ObjectId, boolean>();
      const packs = {
        has: (id: ObjectId) => inPromisorPacks.has(id) && outside.get(id) !== true,
      };
      const settle = async (id: ObjectId) => {
        if (!inPromisorPacks.has(id) || outside.has(id)) return;
        outside.set(id, (await options.storedOutsidePromisorPacks?.(id)) ?? false);
      };
      const read = async (id: ObjectId): Promise<GitObject | undefined> => {
        try {
          return await options.objects.get(id);
        } catch {
          return undefined;
        }
      };
      const skip = async (obj: GitObject) => {
        if (!obj.bytes) await obj.content[Symbol.asyncIterator]().return?.();
      };
      const tips: ObjectId[] = [];
      for (const id of new Set(links)) {
        // absent: taken as a promisor object; in a promisor pack: nothing to do
        await settle(id);
        if (!packs.has(id) && (await options.objects.has(id))) tips.push(id);
      }
      if (tips.length === 0) return [];
      const out: ObjectId[] = [];
      const seen = new Set<ObjectId>();
      const walkTree = async (id: ObjectId): Promise<void> => {
        // list-objects' process_tree: include_check_obj stops at a promisor pack's tree
        await settle(id);
        if (seen.has(id) || packs.has(id)) return;
        const obj = await read(id);
        if (!obj) return;
        if (obj.type !== "tree") return skip(obj);
        seen.add(id);
        out.push(id);
        const bytes = obj.bytes ?? (await collect(obj.content));
        for (const entry of treeEntries(bytes)) {
          if (entry.mode === "160000") continue;
          if (entry.mode === "40000") await walkTree(entry.id);
          else if (!seen.has(entry.id) && (await options.objects.has(entry.id))) {
            // process_blob: no include check, absent blobs allowed (MA_ALLOW_ANY)
            seen.add(entry.id);
            out.push(entry.id);
          }
        }
      };
      // the pending objects: tags listed and peeled, commits walked, trees after them
      const pending = [...tips];
      const commits: ObjectId[] = [];
      const trees: ObjectId[] = [];
      while (pending.length > 0) {
        const id = pending.shift() as ObjectId;
        if (seen.has(id)) continue;
        const obj = await read(id);
        if (!obj) continue;
        if (obj.type === "commit" || obj.type === "tree") {
          (obj.type === "commit" ? commits : trees).push(id);
          await skip(obj);
          continue;
        }
        seen.add(id);
        out.push(id);
        if (obj.type === "tag") {
          const bytes = obj.bytes ?? (await collect(obj.content));
          pending.push(...namedObjects("tag", bytes));
        } else await skip(obj);
      }
      // the commit walk (process_parents: a commit in a promisor pack is listed, its parents
      // are not queued), then each listed commit's tree
      const commitTrees: ObjectId[] = [];
      while (commits.length > 0) {
        const id = commits.shift() as ObjectId;
        if (seen.has(id)) continue;
        const obj = await read(id);
        if (!obj) continue;
        if (obj.type !== "commit") {
          await skip(obj);
          continue;
        }
        seen.add(id);
        out.push(id);
        const bytes = obj.bytes ?? (await collect(obj.content));
        const [tree, ...parents] = namedObjects("commit", bytes);
        if (tree) commitTrees.push(tree);
        await settle(id);
        if (!packs.has(id)) for (const p of parents) if (!seen.has(p)) commits.push(p);
      }
      for (const tree of [...commitTrees, ...trees]) await walkTree(tree);
      return out;
    },
    warnings,
    get fetchCount() {
      return fetchCount;
    },
  };
  return promisor;
}

/**
 * `objects` with git's lazy fetch on its reads (see the module documentation): a read that
 * finds nothing asks `promisor` to fetch the object once (when single reads may fetch and
 * the repository has promisor remotes), then reads again. A fetch that succeeded and still
 * left the object absent (a server that answered with other objects) is
 * {@link PromisorFetchError}, never a silent miss that fetches again on every read; a fetch
 * that failed leaves an object nothing promises absent, as git reads it. Other methods are
 * `objects`' own, looked up on each call (a layer that replaces them later, as alternates
 * do, is followed).
 *
 * The result's `withoutLazyFetch` is the same store whose reads never fetch (git's
 * `fetch_if_missing = 0`): walks over promised objects (fsck, gc, repack, a fetch's checks,
 * a served or received pack) read through it, so a read elsewhere, even running alongside,
 * still fetches.
 */
export function withLazyFetch(objects: GitObjects, promisor: ObjectPromisor): GitObjects {
  const shouldFetch = (id: ObjectId) =>
    OID.test(id) && promisor.lazyFetchEnabled && promisor.hasPromisorRemote();
  /** Fetches `id`, then reads it again; absent after a successful fetch: git's death */
  const fetchThenRead = async (id: ObjectId, opts?: { verify?: boolean }) => {
    const before = promisor.warnings.length;
    const remaining = await promisor.fetchObjects([id]);
    const found = await objects.get(id, opts);
    if (found === undefined && remaining.length === 0) {
      throw new PromisorFetchError(id, promisor.warnings.slice(before));
    }
    return found;
  };
  const get = async (id: ObjectId, opts?: { verify?: boolean }) => {
    const found = await objects.get(id, opts);
    if (found !== undefined || !shouldFetch(id)) return found;
    return fetchThenRead(id, opts);
  };
  const lazy: GitObjects = {
    ...(objects.objectFormat ? { objectFormat: objects.objectFormat } : {}),
    put: (...args) => objects.put(...args),
    putUnsized: (...args) => objects.putUnsized(...args),
    putRaw: (...args) => objects.putRaw(...args),
    has: (id) => objects.has(id),
    list: () => objects.list(),
    remove: (id) => objects.remove(id),
    get,
    getRaw: (id) => objects.getRaw(id),
  };
  // the optional methods, as `objects` has them when called
  for (const key of [
    "listPrefix",
    "approximateCount",
    "sweepStale",
    "beginQuarantine",
    "header",
    "objectType",
  ] as const) {
    Object.defineProperty(lazy, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        const fn = (objects as unknown as Record<string, unknown>)[key];
        return typeof fn === "function" ? fn.bind(objects) : undefined;
      },
      set: (value: unknown) => {
        Object.defineProperty(lazy, key, { value, writable: true, configurable: true });
      },
    });
  }
  Object.defineProperty(lazy, "alternates", {
    configurable: true,
    enumerable: true,
    get: () => objects.alternates,
  });
  Object.assign(lazy, {
    promisor,
    getNow(id: ObjectId, opts?: { verify?: boolean }) {
      const found = objects.getNow ? objects.getNow(id, opts) : objects.get(id, opts);
      if (found instanceof Promise) {
        return found.then((o) => {
          if (o !== undefined || !shouldFetch(id)) return o;
          return fetchThenRead(id, opts);
        });
      }
      if (found !== undefined || !shouldFetch(id)) return found;
      return fetchThenRead(id, opts);
    },
    async *getRaw(id: ObjectId) {
      let any = false;
      for await (const chunk of objects.getRaw(id)) {
        any = true;
        yield chunk;
      }
      if (any || !shouldFetch(id)) return;
      const found = await fetchThenRead(id);
      if (!found) return;
      if (!found.bytes) await found.content[Symbol.asyncIterator]().return?.();
      yield* objects.getRaw(id);
    },
  });
  // the view without lazy fetch: everything else (quarantine, optional methods set later on
  // `lazy`, the promisor) is `lazy`'s, through the prototype
  const direct = Object.create(lazy) as GitObjects;
  Object.defineProperties(direct, {
    get: { value: (id: ObjectId, opts?: { verify?: boolean }) => objects.get(id, opts) },
    getNow: {
      value: (id: ObjectId, opts?: { verify?: boolean }) =>
        objects.getNow ? objects.getNow(id, opts) : objects.get(id, opts),
    },
    getRaw: { value: (id: ObjectId) => objects.getRaw(id) },
    withoutLazyFetch: { get: () => direct },
  });
  Object.defineProperty(lazy, "withoutLazyFetch", { get: () => direct, enumerable: false });
  return lazy;
}

/**
 * `objects` as walks that must not fetch read it: its `withoutLazyFetch` view, or `objects`
 * itself (a store without lazy fetch).
 */
export function objectsWithoutLazyFetch<T extends Pick<GitObjects, "withoutLazyFetch">>(
  objects: T,
): T {
  return (objects.withoutLazyFetch as T | undefined) ?? objects;
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of content) {
    chunks.push(c);
    size += c.length;
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const HEX = "0123456789abcdef";

/** A tree's entries: mode (as stored, `40000` for a subtree) and id. */
export function treeEntries(bytes: Uint8Array): { mode: string; id: ObjectId }[] {
  const out: { mode: string; id: ObjectId }[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const nul = bytes.indexOf(0, at);
    if (space < 0 || nul < 0 || nul + 21 > bytes.length) break;
    let mode = "";
    for (let i = at; i < space; i++) mode += String.fromCharCode(bytes[i] as number);
    let id = "";
    for (let i = nul + 1; i < nul + 21; i++) {
      const b = bytes[i] as number;
      id += HEX[b >> 4] + HEX[b & 15];
    }
    out.push({ mode: mode.replace(/^0+/, ""), id });
    at = nul + 21;
  }
  return out;
}

/**
 * The outgoing links index-pack `--promisor` records of a received object (git 2.48+
 * `do_record_outgoing_links`): a commit's tree and parents, a tag's object, a tree's subtrees
 * (not its blobs).
 */
export function outgoingLinks(type: string, bytes: Uint8Array): ObjectId[] {
  if (type === "tree") {
    return treeEntries(bytes)
      .filter((e) => e.mode === "40000")
      .map((e) => e.id);
  }
  return namedObjects(type, bytes);
}

/** The ids an object names (git's add_promisor_object): tree entries, commit tree and parents, tag object. */
export function namedObjects(type: string, bytes: Uint8Array): ObjectId[] {
  const out: ObjectId[] = [];
  if (type === "tree") {
    let at = 0;
    while (at < bytes.length) {
      const nul = bytes.indexOf(0, at);
      if (nul < 0 || nul + 21 > bytes.length) break;
      let id = "";
      for (let i = nul + 1; i < nul + 21; i++) {
        const b = bytes[i] as number;
        id += HEX[b >> 4] + HEX[b & 15];
      }
      out.push(id);
      at = nul + 21;
    }
    return out;
  }
  if (type !== "commit" && type !== "tag") return out;
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  for (const line of text.split("\n")) {
    if (line === "") break;
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (!OID.test(value)) continue;
    if (type === "commit" && (key === "tree" || key === "parent")) out.push(value);
    if (type === "tag" && key === "object") out.push(value);
  }
  return out;
}
