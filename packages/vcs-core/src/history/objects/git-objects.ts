/**
 * The object kernel: git objects as the bytes `"<type> <size>\0" + content`,
 * named by the SHA-1 of exactly those bytes and stored as their zlib stream (a
 * git loose object). It never parses commits or trees, so whatever bytes git
 * produced keep their id.
 */
import type { ObjectId } from "../../common/id/index.js";
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
