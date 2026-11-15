import type { ByteStream, ContentStore } from "@statewalker/webrun-content-store";
import { type ByteSource, chunksOf } from "./sha256.js";
import type { LfsPointer, LfsResolver } from "./types.js";
import { storeVerified } from "./verify.js";

/** What a verified write did: the object is stored (and visible), or why it was refused. */
export type LfsPutResult =
  | { ok: true; size: number }
  | { ok: false; reason: "sha256 mismatch" | "size mismatch" | "too large" };

/**
 * Bytes held for objects whose download has not finished, so it can resume
 * with `Range: bytes=N-`. Optional on an {@link LfsObjectStore}: without it a
 * download that breaks starts again from zero.
 */
export interface LfsPartialStore {
  /** How many bytes are held for `oid` (0 when none). */
  size(oid: string): Promise<number>;
  /**
   * Appends `content` to the bytes held for `oid` and returns the new count.
   * When `content` fails part way, the bytes that arrived are kept and the
   * error is rethrown.
   */
  append(oid: string, content: ByteSource): Promise<number>;
  /**
   * Verifies the held bytes against `pointer` (SHA-256 and size) and makes
   * them the object. Bytes that do not verify are dropped; a failure to read
   * them (an exception) keeps them.
   */
  complete(pointer: LfsPointer): Promise<LfsPutResult>;
  /** Drops the bytes held for `oid`. */
  remove(oid: string): Promise<void>;
  /**
   * Runs `fn` with no other `exclusive` call for the same object running, so
   * two downloads never append to one partial at once. Optional: without it
   * the client serializes per store instance. How far the exclusion reaches is
   * the implementation's to document.
   */
  exclusive?<T>(oid: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The LFS objects a server serves and a client transfers, by LFS oid
 * (SHA-256, bare lowercase hex). Two implementations ship:
 * {@link contentStoreLfsObjects} over a content-store and its resolver, and
 * `createFilesLfsStore` over a `FilesApi` in git-lfs's own layout.
 */
export interface LfsObjectStore {
  /** The object's byte size, or `undefined` when it is not held. */
  size(oid: string): Promise<number | undefined>;
  /** The object's bytes (or a slice of them); empty when it is not held. */
  read(oid: string, range?: { offset?: number; length?: number }): ByteStream;
  /**
   * Stores `content` as the object `expected.oid`, hashing (and counting) it
   * as it streams. It becomes visible only when its SHA-256 equals
   * `expected.oid` and, when given, its size `expected.size`. A stream that
   * runs past `expected.size` or `opts.maxSize` is cut off there.
   */
  put(
    content: ByteSource,
    expected: { oid: string; size?: number },
    opts?: { maxSize?: number },
  ): Promise<LfsPutResult>;
  /** Partial downloads, when this store can keep them. */
  partial?: LfsPartialStore;
}

/** Thrown inside a stream that runs past a size limit. */
export class LfsTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`content exceeds the limit of ${limit} bytes`);
    this.name = "LfsTooLargeError";
  }
}

/** Passes `content` through, throwing {@link LfsTooLargeError} once it exceeds `limit` bytes. */
export async function* limited(content: ByteSource, limit: number | undefined): ByteStream {
  let size = 0;
  for await (const chunk of chunksOf(content)) {
    size += chunk.length;
    if (limit !== undefined && size > limit) throw new LfsTooLargeError(limit);
    yield chunk;
  }
}

/**
 * The {@link LfsObjectStore} view of a content-store whose objects are mapped
 * to LFS oids by `resolver`: what `serveLfs(store, resolver)` and
 * `lfsUpload(store, resolver, …)` use. It keeps no partial downloads. A write
 * that does not verify is not recorded but stays in the store until its `gc`
 * (see `storeVerified`).
 *
 * @example
 * ```typescript
 * const objects = contentStoreLfsObjects(store, resolver);
 * await objects.size(oid); // the manifest's size, or undefined when unmapped
 * ```
 */
export function contentStoreLfsObjects(store: ContentStore, resolver: LfsResolver): LfsObjectStore {
  return {
    async size(oid) {
      const id = await resolver.toObject(oid);
      const manifest = id === undefined ? undefined : await store.getManifest(id);
      return manifest?.size;
    },
    async *read(oid, range) {
      const id = await resolver.toObject(oid);
      if (id === undefined) return;
      yield* store.read(id, range);
    },
    async put(content, expected, opts = {}) {
      try {
        const stored = await storeVerified(
          store,
          resolver,
          limited(content, opts.maxSize),
          expected,
        );
        return stored.ok ? { ok: true, size: stored.descriptor.size } : stored;
      } catch (error) {
        if (error instanceof LfsTooLargeError) return { ok: false, reason: "too large" };
        throw error;
      }
    },
  };
}

/** Whether `store` is a content-store (rather than an {@link LfsObjectStore}). */
export function isContentStore(store: ContentStore | LfsObjectStore): store is ContentStore {
  return typeof (store as ContentStore).getManifest === "function";
}
