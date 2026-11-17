/**
 * The object kernel: git objects as the bytes `"<type> <size>\0" + content`,
 * named by the SHA-1 of exactly those bytes and stored as their zlib stream (a
 * git loose object). It never parses commits or trees, so whatever bytes git
 * produced keep their id.
 */
import type { ObjectId } from "../../common/id/index.js";
import type { InstalledPack, InstallPackOptions } from "../../pack/index-pack.js";
import type { ObjectTypeString } from "./object-types.js";

/** `put` rejects with this when the content is not as long as the size given for it. */
export { SizeMismatchError } from "@statewalker/vcs-utils/pack";

/** An object read back: its header and its content. */
export interface GitObject {
  type: ObjectTypeString;
  size: number;
  /**
   * The content after the header. Single-use: consume it, or call its
   * iterator's `return()` to release the read and the pooled inflater.
   */
  content: AsyncIterable<Uint8Array>;
  /**
   * The whole content, when the store already holds it in memory (a small object read in one
   * piece): the bytes `content` yields, for callers that parse a whole object (commits, trees)
   * without iterating. Reading it does not consume `content`, and the buffer is the caller's
   * own (never a cached one). Absent for a streamed or verified read.
   */
  bytes?: Uint8Array;
}

/**
 * Git objects over a byte store.
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * const bytes = new TextEncoder().encode("hello\n");
 * const id = await objects.put("blob", bytes.length, [bytes]);
 * // id === "ce013625030ba8dba906f756967f9e9ca394464a", as `git hash-object`
 * const obj = await objects.get(id); // { type: "blob", size: 6, content }
 * ```
 */
export interface GitObjects {
  /**
   * Store an object in one pass over `content`: frame, hash, deflate and stage
   * together. Memory stays bounded where the store writes as it receives (see
   * `StagingBlobStore`). Returns git's id.
   * Rejects with `SizeMismatchError`, storing nothing, when `content` is not
   * `size` bytes long.
   */
  put(
    type: ObjectTypeString,
    size: number,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId>;
  /**
   * Store an object whose size is not known up front. A git id hashes the size
   * first, so the content is read twice: content up to the kernel's
   * `spoolThreshold` is kept in memory; longer content is written to the
   * store's temporary storage (`StagingBlobStore.spool`) and then stored with
   * `put`. A store without `spool` gets the content collected in memory.
   * Callers that know the size use `put`, which reads the content once.
   */
  putUnsized(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId>;
  /**
   * Store an uncompressed loose object (`"<type> <size>\0" + content`) received
   * with its id, as transport and pack import do. Rejects, storing nothing, with
   * `CorruptObjectError` for a malformed object and `ObjectIdMismatchError` when
   * the bytes hash to another id.
   */
  putRaw(id: ObjectId, raw: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void>;
  /** The inflated loose object, header included. Empty if absent or not an id. */
  getRaw(id: ObjectId): AsyncIterable<Uint8Array>;
  /**
   * The object's header and content, or undefined if absent or not an id.
   * With `verify`, the content is re-hashed and its end throws
   * `ObjectIdMismatchError` if the bytes hash to another id.
   */
  get(id: ObjectId, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /** Whether the object is stored; false for anything that is not an id. */
  has(id: ObjectId): Promise<boolean>;
  /** Stored object ids (40 lowercase hex), whatever else the store holds. */
  list(): AsyncIterable<ObjectId>;
  /**
   * git's approximate object count, from which abbreviated ids get their length
   * (`odb_count_objects` with `ODB_COUNT_OBJECTS_APPROXIMATE`): the objects in the packs for
   * the files backend (git leaves loose objects out of this estimate), every object for the
   * other stores. Present on the stores of this package; see `findAbbrevLengths`.
   */
  approximateCount?(): Promise<number>;
  /** Remove an object; true if one was removed. Throws `InvalidObjectIdError` for a non-id. */
  remove(id: ObjectId): Promise<boolean>;
  /**
   * Remove what interrupted writes left in the store (temporaries, orphaned
   * chunks) once older than `olderThanMs`; present when the store can
   * (`StagingBlobStore.sweepStale`). `GcOrchestrator` calls it.
   *
   * @returns The number of leftovers removed
   */
  sweepStale?(options: { olderThanMs: number }): Promise<number>;
  /**
   * Open a quarantine, as git's receive-pack does with `tmp_objdir`: objects written through
   * `quarantine.objects` stay invisible to every other reader of this store until
   * `quarantine.commit()` publishes them, and `quarantine.discard()` removes them all. Reads
   * through `quarantine.objects` see the quarantined objects and this store's. Present when the
   * store can keep objects aside (the memory, KV and SQL raw stores, the files backend); a store
   * without it (typed stores of parsed objects) cannot quarantine, and `importPack` with
   * `quarantine: true` then writes straight into it and returns no quarantine.
   */
  beginQuarantine?(): Promise<ObjectQuarantine>;
}

/**
 * Objects kept aside until they are accepted (git's `tmp_objdir`): see
 * `GitObjects.beginQuarantine`.
 *
 * @example
 * ```typescript
 * const q = await objects.beginQuarantine!();
 * const id = await q.objects.put("blob", 6, [bytes]); // q.objects.has(id), not objects.has(id)
 * await q.commit(); // now objects.has(id); after q.discard() instead it is gone
 * ```
 */
export interface ObjectQuarantine {
  /**
   * The quarantine's view: writes stay in the quarantine (an object the store already has is
   * not written again), reads see the quarantined objects, then the store's. `remove` removes
   * quarantined objects only.
   */
  readonly objects: GitObjects;
  /**
   * Where a received pack is kept inside the quarantine, for backends that keep packs (the
   * files backend: `objects/tmp_objdir-incoming-<id>/pack`). Its objects are read through
   * `objects`. Without it a quarantined pack is unpacked into `objects`.
   */
  readonly packs?: {
    install(
      source: AsyncIterable<Uint8Array>,
      options?: InstallPackOptions,
    ): Promise<InstalledPack>;
  };
  /**
   * Publish every quarantined object into the store (git's `tmp_objdir_migrate`), then close
   * the quarantine. Objects are moved one by one (renames where the store can), packs before
   * their indexes, so a crash part way leaves some objects published (unreachable until a ref
   * names them, so gc prunes them) and the rest for gc to sweep.
   */
  commit(): Promise<void>;
  /** Remove every quarantined object and close the quarantine. Safe to call more than once. */
  discard(): Promise<void>;
}

/** Options of `createGitObjects`. */
export interface GitObjectsOptions {
  /**
   * `putUnsized` keeps content up to this many bytes in memory and spools longer
   * content to the store's temporary storage. Default `DEFAULT_SPOOL_THRESHOLD`.
   */
  spoolThreshold?: number;
}

/** Default `spoolThreshold`: 1 MiB. */
export const DEFAULT_SPOOL_THRESHOLD = 1024 * 1024;

/** A stored object that is not a valid loose object (bad zlib, header or size). */
export class CorruptObjectError extends Error {
  override name = "CorruptObjectError";
}

/** An object whose bytes hash to another id than the one it is stored or sent under. */
export class ObjectIdMismatchError extends CorruptObjectError {
  override name = "ObjectIdMismatchError";
}

/** A string that is not an object id (40 lowercase hex) where one is required. */
export class InvalidObjectIdError extends Error {
  override name = "InvalidObjectIdError";
}

/** The value of a lowercase hex digit by char code, -1 for anything else. */
const HEX_VALUE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let c = 0; c < 10; c++) table[48 + c] = c;
  for (let c = 0; c < 6; c++) table[97 + c] = 10 + c;
  return table;
})();

/**
 * The 20 bytes of a SHA-1 object id, for the binary formats that store ids raw
 * (tree entries, index entries, pack indexes).
 *
 * @example
 * ```typescript
 * objectIdToBytes("ce013625030ba8dba906f756967f9e9ca394464a").length; // 20
 * objectIdToBytes("ce01362"); // throws InvalidObjectIdError
 * ```
 *
 * @throws InvalidObjectIdError unless `id` is exactly 40 lowercase hex characters
 */
export function objectIdToBytes(id: string): Uint8Array {
  if (typeof id !== "string" || id.length !== 40) {
    throw new InvalidObjectIdError(`not an object id: ${JSON.stringify(id)}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    const hi = HEX_VALUE[id.charCodeAt(i * 2)] ?? -1;
    const lo = HEX_VALUE[id.charCodeAt(i * 2 + 1)] ?? -1;
    if (hi < 0 || lo < 0) throw new InvalidObjectIdError(`not an object id: ${JSON.stringify(id)}`);
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}
