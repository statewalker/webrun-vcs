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

/**
 * Content written to temporary storage so it can be read twice: once to learn
 * its size, once to hash and store it. See `StagingBlobStore.spool`.
 */
export interface SpooledContent {
  /** Bytes spooled. */
  readonly size: number;
  /** The spooled bytes, from the start; may be called more than once before `dispose`. */
  read(): AsyncIterable<Uint8Array>;
  /** Remove the temporary. */
  dispose(): Promise<void>;
}

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
  /**
   * Write `content` to temporary storage next to the objects and report its
   * size. Optional: the object kernel uses it for content whose size is not
   * known up front (a git id needs the size first), so such content need not be
   * held in memory. Without it, the kernel collects that content.
   */
  spool?(content: AsyncIterable<Uint8Array>): Promise<SpooledContent>;
  /** The stored bytes; empty if absent. */
  get(id: string): AsyncIterable<Uint8Array>;
  has(id: string): Promise<boolean>;
  /** True if something was removed. */
  remove(id: string): Promise<boolean>;
  /** Every stored key (the kernel keeps only object ids). */
  list(): AsyncIterable<string>;
}

/** Prefix of the temporary keys `rawStorageStaging` writes (never an object id). */
export const RAW_STAGING_TMP_PREFIX = "tmp_obj_";

const tmpKey = () => `${RAW_STAGING_TMP_PREFIX}${crypto.randomUUID()}`;

/**
 * A `StagingBlobStore` over any `RawStorage`.
 *
 * When the raw store can `move`, a write streams into a temporary key and is
 * renamed to its id once the id is known, as git renames `tmp_obj_*`; memory
 * then depends only on the raw store (the chunked KV and SQL stores keep it
 * bounded). Without `move`, the staged bytes (the compressed object) are
 * collected first and stored under their id.
 *
 * `spool` writes to a temporary key of the same raw store.
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * ```
 */
export function rawStorageStaging(raw: RawStorage): StagingBlobStore {
  async function putMoving(
    move: NonNullable<RawStorage["move"]>,
    bytes: AsyncIterable<Uint8Array>,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }> {
    const tmp = tmpKey();
    let moved = false;
    try {
      await raw.store(tmp, bytes);
      const id = await idOf();
      if (await raw.has(id)) return { id, stored: false };
      moved = await move.call(raw, tmp, id);
      if (!moved) throw new Error(`could not move ${tmp} to ${id}`);
      return { id, stored: true };
    } finally {
      if (!moved) await raw.remove(tmp).catch(() => false);
    }
  }

  return {
    async putStaged(bytes, idOf) {
      if (raw.move) return putMoving(raw.move, bytes, idOf);
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
    async spool(content) {
      const key = tmpKey();
      let size = 0;
      try {
        await raw.store(
          key,
          (async function* () {
            for await (const chunk of content) {
              size += chunk.length;
              yield chunk;
            }
          })(),
        );
      } catch (e) {
        await raw.remove(key).catch(() => false);
        throw e;
      }
      return {
        size,
        read: () => (size === 0 ? (async function* () {})() : raw.load(key)),
        dispose: async () => {
          await raw.remove(key);
        },
      };
    },
    async *get(id) {
      if (!(await raw.has(id))) return;
      let chunks: AsyncIterator<Uint8Array>;
      let first: IteratorResult<Uint8Array>;
      try {
        chunks = raw.load(id)[Symbol.asyncIterator]();
        first = await chunks.next();
      } catch (e) {
        if (!(await raw.has(id))) return; // removed in between: absent
        throw e;
      }
      if (first.done) return;
      yield first.value;
      for (let r = await chunks.next(); !r.done; r = await chunks.next()) yield r.value;
    },
    has: (id) => raw.has(id),
    remove: (id) => raw.remove(id),
    list: () => raw.keys(),
  };
}
