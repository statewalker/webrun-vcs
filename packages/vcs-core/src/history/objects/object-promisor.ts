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
 * objects run with fetching off ({@link ObjectPromisor.withoutLazyFetch}, git's
 * `fetch_if_missing = 0`).
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

/** A pack of the store, as the promisor sees it. */
export interface PromisorPack {
  readonly packId: string;
  /** The ids it holds */
  ids(): Iterable<ObjectId>;
  has(id: ObjectId): boolean;
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
   * Runs `body` with single reads never fetching (git's `fetch_if_missing = 0`): fsck, gc and
   * repack walks, a fetch's own checks. Batches asked for explicitly still fetch.
   */
  withoutLazyFetch<T>(body: () => Promise<T>): Promise<T>;
  /** Whether single reads may fetch now */
  readonly lazyFetchEnabled: boolean;
  /**
   * Fetches, in one batch, those of `ids` the store lacks (git's callers of
   * `promisor_remote_get_direct` after `OBJECT_INFO_FOR_PREFETCH`); nothing without promisor
   * remotes or when none is absent. Throws {@link PromisorFetchError} for an id every remote
   * failed to send that is a promisor object. Resolves with the number of ids asked for.
   */
  prefetch(ids: Iterable<ObjectId>): Promise<number>;
  /** `promisor_remote_get_direct` of `ids` (each absent, not checked here) */
  fetchObjects(ids: readonly ObjectId[]): Promise<void>;
  /**
   * git's `is_promisor_object`: held by a promisor pack, or named by an object one holds (a
   * tree's entries, a commit's tree and parents, a tag's object)
   */
  isPromisorObject(id: ObjectId): Promise<boolean>;
  /** The ids held by promisor packs (git's `FOR_EACH_OBJECT_PROMISOR_ONLY`) */
  promisorPackObjects(): Promise<ReadonlySet<ObjectId>>;
  /** Every promisor object (see {@link isPromisorObject}) */
  promisedObjects(): Promise<ReadonlySet<ObjectId>>;
  /** The promisor packs, in the store's lookup order */
  promisorPacks(): Promise<readonly PromisorPack[]>;
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
}

const OID = /^[0-9a-f]{40}$/;

/** The partial clone side of a store: see {@link ObjectPromisor}. */
export function createObjectPromisor(options: ObjectPromisorOptions): ObjectPromisor {
  let fetcher: PromisorFetcher | undefined;
  let suspended = 0;
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

  const objectSets = async () => {
    const packs = await options.promisorPacks();
    const key = packs.map((p) => p.packId).join(",");
    if (built?.key === key) return built;
    const inPacks = new Set<ObjectId>();
    const promised = new Set<ObjectId>();
    for (const pack of packs) for (const id of pack.ids()) inPacks.add(id);
    // add_promisor_object over every object of the promisor packs (pack order)
    for (const id of inPacks) {
      promised.add(id);
      let obj: GitObject | undefined;
      try {
        obj = await options.objects.get(id);
      } catch {
        continue;
      }
      if (!obj) continue;
      if (obj.type === "blob") {
        if (!obj.bytes) await obj.content[Symbol.asyncIterator]().return?.();
        continue;
      }
      const bytes = obj.bytes ?? (await collect(obj.content));
      for (const named of namedObjects(obj.type, bytes)) promised.add(named);
    }
    built = { key, packs: inPacks, promised };
    return built;
  };

  const fetchObjects = async (ids: readonly ObjectId[]) => {
    if (ids.length === 0) return;
    const current = fetcher;
    if (!current) return;
    fetchCount++;
    const before = warnings.length;
    const remaining = await current.fetch(ids);
    for (const id of remaining) {
      if (await isPromisorObject(id)) {
        throw new PromisorFetchError(id, warnings.slice(before));
      }
    }
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
    async withoutLazyFetch(body) {
      suspended++;
      try {
        return await body();
      } finally {
        suspended--;
      }
    },
    get lazyFetchEnabled() {
      if (suspended > 0 || !fetcher) return false;
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
    async promisedObjects() {
      return (await objectSets()).promised;
    },
    promisorPacks: () => options.promisorPacks(),
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
 * the repository has promisor remotes), then reads again. Other methods are `objects`' own,
 * looked up on each call (a layer that replaces them later, as alternates do, is followed).
 */
export function withLazyFetch(objects: GitObjects, promisor: ObjectPromisor): GitObjects {
  const shouldFetch = (id: ObjectId) =>
    OID.test(id) && promisor.lazyFetchEnabled && promisor.hasPromisorRemote();
  const get = async (id: ObjectId, opts?: { verify?: boolean }) => {
    const found = await objects.get(id, opts);
    if (found !== undefined || !shouldFetch(id)) return found;
    await promisor.fetchObjects([id]);
    return objects.get(id, opts);
  };
  const lazy: GitObjects = {
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
  for (const key of ["listPrefix", "approximateCount", "sweepStale", "beginQuarantine"] as const) {
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
        return found.then(async (o) => {
          if (o !== undefined || !shouldFetch(id)) return o;
          await promisor.fetchObjects([id]);
          return objects.get(id, opts);
        });
      }
      if (found !== undefined || !shouldFetch(id)) return found;
      return promisor.fetchObjects([id]).then(() => objects.get(id, opts));
    },
    async *getRaw(id: ObjectId) {
      let any = false;
      for await (const chunk of objects.getRaw(id)) {
        any = true;
        yield chunk;
      }
      if (any || !shouldFetch(id)) return;
      await promisor.fetchObjects([id]);
      yield* objects.getRaw(id);
    },
  });
  return lazy;
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
