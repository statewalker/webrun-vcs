/**
 * Git's object database: pack files and loose objects. Reads try the packs
 * first, then the loose store (git's find_pack_entry before loose objects, JGit's
 * ObjectDirectory). A pack miss rescans the pack directory, at most once per the
 * set's `rescanIntervalMs` (git's reprepare_packed_git, rate-limited), so a pack
 * written by native git is found. Writes and removals go to the loose store, and
 * an object already in a pack is not written again, unless that pack's file is
 * gone or its copy was found corrupt (git's freshen_packed_object, JGit's
 * ObjectDirectoryInserter). Packs are read-only here (repack and gc rewrite them).
 */

import type { PackSet, StagingBlobStore } from "@statewalker/vcs-core";
import {
  type GitObject,
  type GitObjects,
  listObjectsWithPrefix,
  PackError,
  runSteps,
  runStepsAsync,
  type Steps,
} from "@statewalker/vcs-core";

/** A full object id of either format (the packs answer for their own) */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isId = (id: unknown): id is string => typeof id === "string" && OID.test(id);

function closeSource(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): void {
  const it =
    Symbol.asyncIterator in Object(content)
      ? (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (content as Iterable<Uint8Array>)[Symbol.iterator]();
  try {
    const r = it.return?.();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // nothing to close
  }
}

/** Thrown inside `idOf` to cancel a staged write whose object is already packed. */
class AlreadyPacked extends Error {}

/**
 * A staging store that does not keep objects already in `packs`: the bytes are
 * staged as usual, and once their id is known a packed object is dropped (the
 * temporary is removed) and reported as `stored: false`. With `elsewhere` (the
 * repository's alternates: git's `check_and_freshen_nonlocal`), an object it holds and
 * renews is skipped the same way.
 */
export function skipPacked(
  store: StagingBlobStore,
  packs: PackSet,
  elsewhere?: { freshen(id: string): Promise<boolean> },
): StagingBlobStore {
  const looseFresh = store.isFresh?.bind(store);
  const held = async (id: string) =>
    (await packs.freshen(id)) || (elsewhere !== undefined && (await elsewhere.freshen(id)));
  return {
    ...store,
    ...(looseFresh
      ? {
          isFresh: async (id: string) =>
            (await packs.freshen(id)) ||
            (await looseFresh(id)) ||
            (elsewhere !== undefined && (await elsewhere.freshen(id))),
        }
      : {}),
    async putStaged(bytes, idOf, options) {
      // `isFresh` (packs, then loose) said no just before: nothing to look up again
      if (options?.notFresh) return store.putStaged(bytes, idOf, options);
      let packedId: string | undefined;
      try {
        return await store.putStaged(bytes, async () => {
          const id = await idOf();
          if (await held(id)) {
            packedId = id;
            throw new AlreadyPacked(id);
          }
          return id;
        });
      } catch (e) {
        if (e instanceof AlreadyPacked && packedId) return { id: packedId, stored: false };
        throw e;
      }
    },
  };
}

/**
 * Reads packs first, then `loose`; build `loose` over `skipPacked` so writes skip
 * packed objects too (as `createGitFilesBackend` does).
 *
 * @example
 * ```typescript
 * const packs = await openPackSet(files, ".git/objects/pack");
 * const loose = createGitObjects(skipPacked(filesStagingStore(files, ".git/objects"), packs));
 * const objects = withPacks(loose, packs);
 * await objects.get(id); // from .git/objects/pack/*.pack, or a loose object
 * ```
 */
export function withPacks(loose: GitObjects, packs: PackSet): GitObjects {
  /**
   * Packs, then loose objects. A packed copy that fails before `get` returns (a corrupt entry
   * header, a missing delta base, a broken first chunk) gives way to a loose copy; its error is
   * raised only when there is none. A copy failing later in its stream is marked bad by the
   * set, so the next read goes loose.
   */
  const lookup = (id: string, options?: { verify?: boolean }): Promise<GitObject | undefined> =>
    runStepsAsync(lookupSteps(id, options));
  /** `lookup`, without a promise until one is needed: none for a packed object in memory. */
  function* lookupSteps(
    id: string,
    options?: { verify?: boolean },
    first?: { value: GitObject | undefined | Promise<GitObject | undefined> } | { error: unknown },
  ): Steps<GitObject | undefined> {
    // what is not an id is in no pack (the set finds none), and goes to the loose store as is
    let failed: unknown;
    try {
      let packed: GitObject | undefined | Promise<GitObject | undefined>;
      if (first) {
        if ("error" in first) throw first.error;
        packed = first.value;
      } else packed = packs.getNow ? packs.getNow(id, options) : packs.get(id, options);
      if (packed instanceof Promise) packed = (yield packed) as GitObject | undefined;
      if (packed) return packed;
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      failed = e;
    }
    const obj = (yield loose.get(id, options)) as GitObject | undefined;
    if (obj) return obj;
    if (failed) throw failed;
    return undefined;
  }

  return {
    ...(loose.objectFormat ? { objectFormat: loose.objectFormat } : {}),
    put: (type, size, content) => loose.put(type, size, content),

    putUnsized: (type, content) => loose.putUnsized(type, content),

    async putRaw(id, raw) {
      // As JGit's ObjectDirectory.insertUnpackedObject: an object already packed is
      // not written again (git's "freshen" of a packed object is a no-op here).
      if (isId(id) && (await packs.freshen(id))) {
        closeSource(raw);
        return;
      }
      return loose.putRaw(id, raw);
    },

    async *getRaw(id) {
      const obj = await lookup(id);
      if (!obj) return;
      const it = obj.content[Symbol.asyncIterator]();
      try {
        yield new TextEncoder().encode(`${obj.type} ${obj.size}\0`);
        for (;;) {
          const r = await it.next();
          if (r.done) return;
          yield r.value;
        }
      } finally {
        // also when the caller stops after the header: the packed read is released
        await it.return?.();
      }
    },

    get: lookup,

    getNow(id, options) {
      // a packed object in memory needs no generator
      if (!packs.getNow) return runSteps(lookupSteps(id, options));
      let packed: GitObject | undefined | Promise<GitObject | undefined>;
      try {
        packed = packs.getNow(id, options);
      } catch (error) {
        return runSteps(lookupSteps(id, options, { error }));
      }
      if (packed !== undefined && !(packed instanceof Promise)) return packed;
      return runSteps(lookupSteps(id, options, { value: packed }));
    },

    async has(id) {
      if (!isId(id)) return loose.has(id);
      return (await packs.has(id)) || (await loose.has(id));
    },

    // a packed copy's headers (`PackSet.header`); anything else (loose objects, a copy whose
    // headers cannot answer) is read by `objectHeader` through `get`, which falls back as above
    ...(packs.header
      ? { header: (id: string) => (packs.header as NonNullable<PackSet["header"]>)(id) }
      : {}),
    ...(packs.objectType
      ? {
          objectType: (id: string) => (packs.objectType as NonNullable<PackSet["objectType"]>)(id),
        }
      : {}),

    async *list() {
      // one snapshot of the packs, for the packed ids and to skip loose ids already in a pack's
      // idx (no set of every id)
      const held = await packs.packs();
      yield* packs.list({ packs: held });
      for await (const id of loose.list()) if (!held.some((p) => p.has(id))) yield id;
    },

    async *listPrefix(prefix, options) {
      const held = await packs.packs();
      const seen = new Set<string>();
      const packed = packs.listPrefix
        ? packs.listPrefix(prefix, { packs: held })
        : packs.list({ packs: held });
      for await (const id of packed) {
        if (!id.startsWith(prefix)) continue;
        seen.add(id);
        yield id;
      }
      const cache = options?.cache;
      if (!cache || prefix.length < 2) {
        for await (const id of listObjectsWithPrefix(loose, prefix)) if (!seen.has(id)) yield id;
        return;
      }
      // the loose objects of the fan-out directory, listed once while the caller keeps the
      // cache (git's odb_loose_cache)
      const key = `loose:${prefix.slice(0, 2)}`;
      let listed = cache.get(key) as Promise<string[]> | undefined;
      if (!listed) {
        listed = (async () => {
          const ids: string[] = [];
          for await (const id of listObjectsWithPrefix(loose, prefix.slice(0, 2))) ids.push(id);
          return ids;
        })();
        cache.set(key, listed);
      }
      for (const id of await listed) if (id.startsWith(prefix) && !seen.has(id)) yield id;
    },

    async approximateCount() {
      // as git: the objects of the packs, loose objects left out
      let n = 0;
      for (const pack of await packs.packs()) n += pack.count;
      return n;
    },

    remove: (id) => loose.remove(id),
  };
}
