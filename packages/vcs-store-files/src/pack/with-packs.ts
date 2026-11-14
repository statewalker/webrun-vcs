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
          if (await packs.freshen(id)) {
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
    return undefined;
  };

  return {
    put: (type, size, content) => loose.put(type, size, content),

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
      yield new TextEncoder().encode(`${obj.type} ${obj.size}\0`);
      yield* obj.content;
    },

    get: lookup,

    async has(id) {
      if (!isId(id)) return loose.has(id);
      return (await packs.has(id)) || (await loose.has(id));
    },

    async *list() {
      // no set of every id: loose ids already in a pack's idx are skipped
      yield* packs.list();
      const held = await packs.packs();
      for await (const id of loose.list()) if (!held.some((p) => p.has(id))) yield id;
    },

    remove: (id) => loose.remove(id),
  };
}
