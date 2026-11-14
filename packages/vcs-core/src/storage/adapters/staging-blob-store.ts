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
import { timestampedId, timestampOfId } from "@statewalker/vcs-utils";
import type { RawStorage, SweepStaleOptions } from "../raw/raw-storage.js";

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
  /**
   * Remove what interrupted writes left behind (temporaries of a crashed
   * process) once older than `olderThanMs`. Optional; gc calls it when present.
   * Never removes the temporary of a write still running in this process.
   *
   * @returns The number of leftovers removed
   */
  sweepStale?(options: SweepStaleOptions): Promise<number>;
}

/** Prefix of the temporary keys `rawStorageStaging` writes (never an object id). */
export const RAW_STAGING_TMP_PREFIX = "tmp_obj_";

/**
 * Content up to this many bytes is collected and stored under its id directly
 * (`has` + `store`), as the chunked KV and SQL stores keep it as one entry
 * anyway; only longer content streams through a temporary key and `move`.
 * Equal to their default chunk size (256 KiB).
 */
export const STAGING_INLINE_THRESHOLD = 256 * 1024;

export interface RawStorageStagingOptions {
  /** Content up to this many bytes skips the temporary key. Default `STAGING_INLINE_THRESHOLD`. */
  inlineThreshold?: number;
}

/** Temporaries of writes running in this process; `sweepStale` leaves them alone. */
const inFlight = new Set<string>();

/** A temporary key that records its creation time, so a sweep can judge its age. */
const tmpKey = () => `${RAW_STAGING_TMP_PREFIX}${timestampedId()}`;

/**
 * Remove the `tmp_obj_*` keys of `raw` older than `olderThanMs`, then let `raw`
 * sweep its own leftovers (`RawStorage.sweepStale`, such as orphaned chunks).
 * A temporary whose name carries no time (written by an older version) is
 * removed only when `olderThanMs <= 0`. Temporaries of writes running in this
 * process are kept; one written by another process sharing the store is safe
 * only through its age, so pick an expiry longer than any write.
 */
export async function sweepStaleRawStaging(
  raw: RawStorage,
  { olderThanMs }: SweepStaleOptions,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const stale: string[] = [];
  for await (const key of raw.keys()) {
    if (!key.startsWith(RAW_STAGING_TMP_PREFIX) || inFlight.has(key)) continue;
    const made = timestampOfId(key.slice(RAW_STAGING_TMP_PREFIX.length));
    if (olderThanMs <= 0 || (made !== undefined && made < cutoff)) stale.push(key);
  }
  let removed = 0;
  for (const key of stale) if (!inFlight.has(key) && (await raw.remove(key))) removed++;
  removed += (await raw.sweepStale?.({ olderThanMs })) ?? 0;
  return removed;
}

/**
 * A `StagingBlobStore` over any `RawStorage`.
 *
 * Content up to `inlineThreshold` bytes (256 KiB; nearly every tree, commit
 * and small blob) is collected, then stored under its id unless that id is
 * already there: two raw operations (`has` + `store`), and none written for a
 * duplicate. When longer content arrives and the raw store can `move`, the
 * write streams into a temporary key and is renamed to its id once the id is
 * known, as git renames `tmp_obj_*`; memory then depends only on the raw store
 * (the chunked KV and SQL stores keep it bounded). Without `move`, the staged
 * bytes (the compressed object) are collected first and stored under their id.
 *
 * An id that is already stored keeps its value: git objects are content
 * addressed, so a second write of the same id never replaces the first.
 *
 * `spool` writes to a temporary key of the same raw store. `sweepStale`
 * removes temporaries left by a crash (see `sweepStaleRawStaging`).
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * ```
 */
export function rawStorageStaging(
  raw: RawStorage,
  options: RawStorageStagingOptions = {},
): StagingBlobStore {
  const inlineThreshold = options.inlineThreshold ?? STAGING_INLINE_THRESHOLD;

  async function putCollected(
    chunks: Uint8Array[],
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }> {
    const id = await idOf();
    if (await raw.has(id)) return { id, stored: false };
    await raw.store(
      id,
      (async function* () {
        yield* chunks;
      })(),
    );
    return { id, stored: true };
  }

  async function putMoving(
    move: NonNullable<RawStorage["move"]>,
    bytes: AsyncIterable<Uint8Array>,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }> {
    const tmp = tmpKey();
    inFlight.add(tmp);
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
      inFlight.delete(tmp);
    }
  }

  return {
    async putStaged(bytes, idOf) {
      // Read up to the threshold; what ends there is stored from memory.
      const it = bytes[Symbol.asyncIterator]();
      const head: Uint8Array[] = [];
      let size = 0;
      let ended = false;
      while (size <= inlineThreshold) {
        const r = await it.next();
        if (r.done) {
          ended = true;
          break;
        }
        head.push(r.value);
        size += r.value.length;
      }
      if (ended) return putCollected(head, idOf);
      async function* rest() {
        let done = false;
        try {
          yield* head.splice(0);
          for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
          done = true;
        } finally {
          // stopped early (a failing store): release the source
          if (!done) await it.return?.();
        }
      }
      if (raw.move) return putMoving(raw.move, rest(), idOf);
      const chunks: Uint8Array[] = [];
      for await (const chunk of rest()) chunks.push(chunk);
      return putCollected(chunks, idOf);
    },
    async spool(content) {
      const key = tmpKey();
      let size = 0;
      inFlight.add(key);
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
        inFlight.delete(key);
        throw e;
      }
      return {
        size,
        read: () => (size === 0 ? (async function* () {})() : raw.load(key)),
        dispose: async () => {
          try {
            await raw.remove(key);
          } finally {
            inFlight.delete(key);
          }
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
    sweepStale: (o) => sweepStaleRawStaging(raw, o),
  };
}
