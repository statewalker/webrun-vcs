/**
 * The object kernel: git objects as the bytes `"<type> <size>\0" + content`,
 * named by the SHA-1 of exactly those bytes and stored as their zlib stream (a
 * git loose object). It never parses commits or trees, so whatever bytes git
 * produced keep their id.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { InstalledPack, InstallPackOptions } from "../../pack/index-pack.js";
import type { PackSet } from "../../pack/pack-set.js";
import type { ObjectPromisor } from "./object-promisor.js";
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
   * own (never a cached one). It may be a view into a larger buffer: respect `byteOffset` and
   * `byteLength` rather than reading `bytes.buffer` whole. Absent for a streamed or verified read.
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
/** Options of `GitObjects.listPrefix` */
export interface ListPrefixOptions {
  /** Listings the store may keep and reuse while the caller holds this map */
  cache?: Map<string, unknown>;
}

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
   *
   * An id already stored (and fresh, or freshened by this call: an old copy's mtime renewed,
   * as git's `odb_freshen_object`) is not written again, and `raw` is then closed without
   * being read: its bytes are not checked against the id. Callers that take objects from
   * elsewhere check them themselves (unpack-objects compares a stored id's bytes with
   * `sameAsStored`, `packs.install` has index-pack check every object); others pass
   * bytes they hashed.
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
  /**
   * `get`, without a promise when no I/O is needed (a packed object in a loaded window or the
   * delta base cache): the object or undefined, else a promise of it. Errors are thrown as
   * `get` rejects with them. Optional: callers fall back to `get`.
   */
  getNow?(
    id: ObjectId,
    options?: { verify?: boolean },
  ): GitObject | undefined | Promise<GitObject | undefined>;
  /** Whether the object is stored; false for anything that is not an id. */
  has(id: ObjectId): Promise<boolean>;
  /** Stored object ids (40 lowercase hex), whatever else the store holds. */
  list(): AsyncIterable<ObjectId>;
  /**
   * The stored ids that start with the lowercase hex `prefix`, each once, in no particular
   * order: what git's `find_short_object_filename` and `find_short_packed_object` find for an
   * abbreviated id (one loose fan-out directory, a binary search in each pack's idx). Optional:
   * `listObjectsWithPrefix` filters `list()` without it.
   *
   * `options.cache` lets the store keep listings made for one operation (the loose objects
   * of a fan-out directory, read once as git's `odb_loose_cache`): the caller makes the map,
   * and objects stored after a listing was kept may not be found through it.
   */
  listPrefix?(prefix: string, options?: ListPrefixOptions): AsyncIterable<ObjectId>;
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
  /**
   * The object directories this store borrows from (git's alternates: `objects/info/alternates`
   * and `$GIT_ALTERNATE_OBJECT_DIRECTORIES`), when the store reads any: present on the files
   * backend. Reads (`get`, `has`, `list`, `listPrefix`, `approximateCount`) see their objects
   * after the store's own; writes and removals never reach them.
   */
  readonly alternates?: ObjectAlternates;
  /**
   * The partial clone side of the store (see `withLazyFetch`): its lazy fetch, batch
   * prefetches and promisor objects. Present on the files backend; reads of absent objects
   * fetch only once a fetcher is installed (vcs-commands installs one).
   */
  readonly promisor?: ObjectPromisor;
  /**
   * The same store with reads that never fetch from a promisor remote (git's
   * `fetch_if_missing = 0`), for walks over promised objects; absent on stores without lazy
   * fetch (see `objectsWithoutLazyFetch`)
   */
  readonly withoutLazyFetch?: GitObjects;
}

/**
 * One borrowed object directory (git's `odb_source` other than the primary one).
 */
export interface AlternateObjectDirectory {
  /** The directory as git names it in messages: its real host path where known */
  readonly path: string;
  /** The directory as a path of the store's FilesApi */
  readonly objectsDir: string;
  /** Its objects, packs first, then loose ones (read-only to the borrowing store) */
  readonly objects: GitObjects;
  /** Its packs */
  readonly packs: PackSet;
}

/**
 * The alternates of an object store (git's `odb->sources->next...`), in git's order: the
 * `$GIT_ALTERNATE_OBJECT_DIRECTORIES` entries, then `objects/info/alternates`, each followed by
 * its own alternates (depth first, at most five levels below the first).
 *
 * @example
 * ```typescript
 * const { objects } = await createGitFilesBackend({ files });
 * for (const alt of await objects.alternates!.list()) console.log(alt.path);
 * await objects.alternates!.add("/srv/shared/objects"); // git clone --shared/--reference
 * ```
 */
export interface ObjectAlternates {
  /** The alternates in use, in git's order */
  list(): Promise<readonly AlternateObjectDirectory[]>;
  /**
   * git's `odb_add_to_alternates_file`: appends `path` (a host path, or relative to the objects
   * directory) to `objects/info/alternates` unless a line holds it already, then links it (and
   * its own alternates) in
   */
  add(path: string): Promise<void>;
  /** Reads the alternates again (after `objects/info/alternates` was changed elsewhere) */
  refresh(): Promise<void>;
  /**
   * Calls `listener` after every later change of the list (each `add()`, `refresh()` and
   * `dissociate()`), so caches of what the alternates hold (the commit-graph) can forget it;
   * returns a function removing the listener. Present on the files backend.
   */
  onChange?(listener: () => void): () => void;
  /**
   * The object ids of the alternates' refs (git's `odb_for_each_alternate_ref`: `for-each-ref
   * --format=%(objectname)` in each alternate that is a repository's `objects` directory with
   * a `refs` directory; `core.alternateRefsPrefixes` limits them), in that order, repeats kept:
   * receive-pack advertises them as `.have`
   */
  refs(): Promise<string[]>;
  /** git's errors while the alternates were read (`error: ...` lines), since the last read */
  readonly errors: readonly string[];
  /**
   * `git clone --dissociate`: when `objects/info/alternates` exists, every reachable object is
   * packed into the store's own objects (`git repack -a -d`), then the file is removed and the
   * alternates are dropped. Present where the store can repack (the files backend).
   */
  dissociate?(): Promise<void>;
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
   * The quarantine's directory, for backends that keep one in their storage (the files
   * backend: `objects/tmp_objdir-incoming-<id>`, a path of its FilesApi): git gives it to the
   * pre-receive hook as `GIT_QUARANTINE_PATH` (and as `GIT_OBJECT_DIRECTORY`), so a hook
   * running native git reads the quarantined objects there. Absent where the objects are
   * not files.
   */
  readonly path?: string;
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
