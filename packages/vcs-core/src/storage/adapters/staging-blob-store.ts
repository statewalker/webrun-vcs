/**
 * Storage for bytes whose id is known only after the last byte: a streamed git
 * object is named by the hash of its own bytes. Git writes `objects/tmp_obj_*`
 * and renames it once the hash is known (`finalize_object_file`); JGit's
 * `ObjectDirectoryInserter` does the same. `putStaged` is that step as a
 * storage method.
 *
 * This is the part of `@statewalker/webrun-storage`'s staging store the object
 * kernel uses; the upstream type is assignable to it.
 */
import type { RawStorage } from "../raw/raw-storage.js";

export interface StagingBlobStore {
  /**
   * Store `bytes` under the id `idOf()` returns once the stream has ended. If
   * the stream or `idOf` throws, nothing is stored. An existing blob with that
   * id is kept (same id, same content). `stored` says whether this call wrote it.
   */
  putStaged(
    bytes: AsyncIterable<Uint8Array>,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }>;
  /** The stored bytes; empty if absent. */
  get(id: string): AsyncIterable<Uint8Array>;
  has(id: string): Promise<boolean>;
  /** True if something was removed. */
  remove(id: string): Promise<boolean>;
  /** Every stored key (the kernel keeps only object ids). */
  list(): AsyncIterable<string>;
}

/**
 * A `StagingBlobStore` over any `RawStorage`: the staged bytes are collected,
 * then stored under their id if it is not there yet. Memory per write is the
 * compressed object, as the memory, KV and SQL raw stores keep each value whole
 * anyway; stores with a rename (git's files) stream instead.
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * ```
 */
export function rawStorageStaging(raw: RawStorage): StagingBlobStore {
  return {
    async putStaged(bytes, idOf) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of bytes) chunks.push(chunk);
      const id = await idOf();
      if (await raw.has(id)) return { id, stored: false };
      await raw.store(
        id,
        (async function* () {
          yield* chunks;
        })(),
      );
      return { id, stored: true };
    },
    async *get(id) {
      if (await raw.has(id)) yield* raw.load(id);
    },
    has: (id) => raw.has(id),
    remove: (id) => raw.remove(id),
    list: () => raw.keys(),
  };
}
