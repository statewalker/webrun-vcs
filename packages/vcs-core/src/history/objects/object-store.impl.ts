import type { ObjectId } from "../../common/id/index.js";
import type { VolatileStore } from "../../storage/binary/volatile-store.js";
import { MemoryVolatileStore } from "../../storage/binary/volatile-store.memory.js";
import type { RawStorage } from "../../storage/raw/raw-storage.js";
import { handleTypedContent } from "./handle-typed-content.js";
import { loadWithHeader } from "./load-with-header.js";
import type { GitObjectHeader, GitObjectStore, GitObjectStoreOptions } from "./object-store.js";
import type { ObjectTypeString } from "./object-types.js";

/**
 * Git object store implementation using RawStorage
 *
 * This is a header-framing layer only: it prepends "type size\0" on store
 * and parses/strips headers on load. Compression is handled by the
 * underlying RawStorage (e.g. FileRawStorage with compress: true).
 */
class GitObjectStoreImpl implements GitObjectStore {
  private readonly volatile: VolatileStore;
  private readonly storage: RawStorage;

  /**
   * Create a Git object store
   *
   * @param options Configuration options including storage backend
   */
  constructor({ storage, volatile }: GitObjectStoreOptions) {
    this.storage = storage;
    this.volatile = volatile ?? new MemoryVolatileStore();
  }

  /**
   * Store content with unknown size
   *
   * Uses VolatileStore to buffer content and determine size before
   * computing hash and storing the object.
   */
  async store(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId> {
    return await handleTypedContent({
      volatile: this.volatile,
      type,
      content,
      handle: async (id, full) => {
        // Skip write if object already exists — content-addressed objects are
        // immutable, so storing the same ID again is a no-op. This prevents
        // errors when BrowserFilesApi's createWritable() fails on existing files.
        if (!(await this.storage.has(id))) {
          await this.storage.store(id, full.read());
        }

        return id;
      },
    });
  }

  /**
   * Load object content (header stripped)
   */
  async *load(id: ObjectId): AsyncGenerator<Uint8Array> {
    const [, content] = await this.loadWithHeader(id);
    yield* content;
  }

  /**
   * Get object header and content stream
   * @param id ObjectId of the object
   * @returns Tuple of object header and async iterable of content chunks
   * @throws Error if object not found
   */
  async loadWithHeader(id: ObjectId): Promise<[GitObjectHeader, AsyncGenerator<Uint8Array>]> {
    const raw = this.loadRaw(id);
    return await loadWithHeader(raw);
  }

  /**
   * Load raw object including header
   */
  async *loadRaw(id: ObjectId): AsyncGenerator<Uint8Array> {
    yield* this.storage.load(id);
  }

  /**
   * Get object header without loading full content
   */
  async getHeader(id: ObjectId): Promise<GitObjectHeader> {
    const [header, content] = await this.loadWithHeader(id);
    await content?.return?.(void 0); // Close the iterator to free resources
    return header;
  }

  /**
   * Check if object exists
   */
  has(id: ObjectId): Promise<boolean> {
    return this.storage.has(id);
  }

  /**
   * Remove object
   */
  remove(id: ObjectId): Promise<boolean> {
    return this.storage.remove(id);
  }

  /**
   * List all object IDs
   */
  async *list(): AsyncIterable<ObjectId> {
    yield* this.storage.keys();
  }
}

/**
 * Create a Git object store with the given storage backend
 *
 * This is the primary factory function for creating GitObjectStore instances.
 * The object store is a header-framing layer only — compression should be
 * handled by the underlying RawStorage (e.g. FileRawStorage with compress: true).
 *
 * @param storage Raw storage backend for persisted objects
 * @param options Additional options (volatile store)
 * @returns GitObjectStore instance
 *
 * @example
 * ```typescript
 * // Simple in-memory store
 * const store = createGitObjectStore(new MemoryRawStorage());
 *
 * // Git-compatible file store (FileRawStorage compresses by default)
 * const store = createGitObjectStore(new FileRawStorage(files, objectsDir));
 * ```
 */
export function createGitObjectStore(
  storage: RawStorage,
  options?: Omit<GitObjectStoreOptions, "storage">,
): GitObjectStore {
  return new GitObjectStoreImpl({ storage, ...options });
}
