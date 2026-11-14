/**
 * Git's object database: loose objects and pack files. Reads try the loose
 * store first, then the packs. Writes and removals go to the loose store, and an
 * object already in a pack is not written again (git's freshen_packed_object,
 * JGit's ObjectDirectoryInserter). Packs are read-only here (repack and gc
 * rewrite them).
 */

import type { StagingBlobStore } from "@statewalker/vcs-core";
import {
  type GitObject,
  type GitObjects,
  ObjectIdMismatchError,
  type ObjectTypeString,
  parseHeader,
} from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { PackDirectory } from "./pack-directory.js";

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
export function skipPacked(store: StagingBlobStore, packs: PackDirectory): StagingBlobStore {
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
 * Reads fall back to packs; build `loose` over `skipPacked` so writes skip packed
 * objects too (as `createGitFilesBackend` does).
 *
 * @example
 * ```typescript
 * const loose = createGitObjects(skipPacked(filesStagingStore(files, ".git/objects"), packs));
 * const objects = withPacks(createGitObjects(filesStagingStore(files, ".git/objects")), packs);
 * await objects.get(id); // a loose object, or one from .git/objects/pack/*.pack
 * ```
 */
export function withPacks(loose: GitObjects, packs: PackDirectory): GitObjects {
  /** A packed object, inflated and resolved (header included); undefined if not packed. */
  const packedRaw = async (id: string) => (isId(id) ? packs.loadRaw(id) : undefined);

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
      if (await loose.has(id)) {
        yield* loose.getRaw(id);
        return;
      }
      const raw = await packedRaw(id);
      if (raw) yield raw;
    },

    async get(id, options): Promise<GitObject | undefined> {
      const obj = await loose.get(id, options);
      if (obj) return obj;
      const raw = await packedRaw(id);
      if (!raw) return undefined;
      if (options?.verify) {
        const actual = bytesToHex(createSha1().update(raw).digest());
        if (actual !== id) throw new ObjectIdMismatchError(`object ${id} hashes to ${actual}`);
      }
      const header = parseHeader(raw);
      const body = raw.subarray(header.contentOffset);
      let used = false;
      return {
        type: header.type as ObjectTypeString,
        size: header.size,
        content: {
          async *[Symbol.asyncIterator]() {
            if (used) throw new Error(`content of ${id} was already iterated`);
            used = true;
            yield body;
          },
        },
      };
    },

    async has(id) {
      return (await loose.has(id)) || (isId(id) && (await packs.has(id)));
    },

    async *list() {
      const seen = new Set<string>();
      for await (const id of loose.list()) {
        seen.add(id);
        yield id;
      }
      for await (const id of packs.listObjects()) if (!seen.has(id)) yield id;
    },

    remove: (id) => loose.remove(id),
  };
}
