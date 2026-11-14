/**
 * Git's object database: pack files and loose objects. Reads try the packs
 * first, then the loose store (git's find_pack_entry before loose objects, JGit's
 * ObjectDirectory); when both miss, the pack directory is rescanned once (git's
 * reprepare_packed_git), so a pack written meanwhile (by native git, or by a
 * repack that removed the loose copies) is found. Writes and removals go to the
 * loose store, and an object already in a pack is not written again (git's
 * freshen_packed_object, JGit's ObjectDirectoryInserter). Packs are read-only
 * here (repack and gc rewrite them).
 */

import type { PackSet, StagingBlobStore } from "@statewalker/vcs-core";
import { type GitObject, type GitObjects, PackError } from "@statewalker/vcs-core";

const OID = /^[0-9a-f]{40}$/;
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
 * temporary is removed) and reported as `stored: false`.
 */
export function skipPacked(store: StagingBlobStore, packs: PackSet): StagingBlobStore {
  return {
    ...store,
    async putStaged(bytes, idOf) {
      let packedId: string | undefined;
      try {
        return await store.putStaged(bytes, async () => {
          const id = await idOf();
          if (await packs.has(id)) {
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
   * Packs, then loose objects, then — when both miss — packs again after a rescan. A packed copy
   * that fails (a corrupt entry, a missing delta base) gives way to a loose copy; its error is
   * raised only when there is none.
   */
  const lookup = async (
    id: string,
    options?: { verify?: boolean },
  ): Promise<GitObject | undefined> => {
    if (!isId(id)) return loose.get(id, options);
    let failed: unknown;
    try {
      const packed = await packs.get(id, options);
      if (packed) return packed;
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      failed = e;
    }
    const obj = await loose.get(id, options);
    if (obj) return obj;
    if (failed) throw failed;
    if (await packs.refresh()) return packs.get(id, options);
    return undefined;
  };

  return {
    put: (type, size, content) => loose.put(type, size, content),

    async putRaw(id, raw) {
      // As JGit's ObjectDirectory.insertUnpackedObject: an object already packed is
      // not written again (git's "freshen" of a packed object is a no-op here).
      if (isId(id) && (await packs.has(id))) {
        closeSource(raw);
        return;
      }
      return loose.putRaw(id, raw);
    },

    async *getRaw(id) {
      const obj = await lookup(id);
      if (!obj) return;
      yield new TextEncoder().encode(`${obj.type} ${obj.size}\0`);
      yield* obj.content;
    },

    get: lookup,

    async has(id) {
      if (!isId(id)) return loose.has(id);
      if ((await packs.has(id)) || (await loose.has(id))) return true;
      return (await packs.refresh()) && (await packs.has(id));
    },

    async *list() {
      const seen = new Set<string>();
      for await (const id of packs.list()) {
        seen.add(id);
        yield id;
      }
      for await (const id of loose.list()) if (!seen.has(id)) yield id;
    },

    remove: (id) => loose.remove(id),
  };
}
