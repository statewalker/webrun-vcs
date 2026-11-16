/**
 * Git tree store implementation
 *
 * Wraps GitObjects with tree serialization/deserialization.
 */

import type { ObjectId } from "../../common/id/index.js";
import {
  CorruptObjectError,
  type GitObjects,
  InvalidObjectIdError,
} from "../objects/git-objects.js";
import {
  hasObjectOfType,
  objectHeader,
  removeObject,
  storeObject,
} from "../objects/typed-object-access.js";
import type { TreeEntry } from "./tree-entry.js";
import { collectTreeBytes, decodeTreeBytes, EMPTY_TREE_ID } from "./tree-format.js";
import type { Trees } from "./trees.js";

/**
 * Git tree store implementation
 *
 * Handles tree entry serialization (sorting, binary format)
 * and delegates storage to GitObjects.
 */
class GitTreeStore implements Trees {
  /**
   * Decoded trees by id, most recently used last. A tree is immutable (its id is its
   * content's hash), so a cached tree never goes stale; a merge or a rebase reads the
   * same trees again and again. Bounded by the entries held.
   */
  private readonly cache = new Map<ObjectId, readonly TreeEntry[]>();
  private cachedEntries = 0;
  /** Reads in flight, by tree id */
  private readonly reading = new Map<ObjectId, Promise<readonly TreeEntry[] | undefined>>();

  constructor(
    private readonly objects: GitObjects,
    private readonly maxCachedEntries = DEFAULT_MAX_CACHED_ENTRIES,
  ) {}

  // ============ New Trees Interface ============

  /**
   * Store tree entries (new interface)
   */
  async store(entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>): Promise<ObjectId> {
    const bytes = await collectTreeBytes(entries);
    const id = await storeObject(this.objects, "tree", [bytes]);
    // a tree just stored is read next (a merge's result, a rebase's next HEAD)
    if (!this.cache.has(id)) this.remember(id, decodeTreeBytes(bytes));
    return id;
  }

  /**
   * Load tree entries (new interface)
   *
   * Returns undefined if tree doesn't exist.
   */
  async load(id: ObjectId): Promise<AsyncIterable<TreeEntry> | undefined> {
    // Handle empty tree specially
    if (id === EMPTY_TREE_ID) {
      return emptyTreeEntries();
    }

    const entries = await this.read(id);
    if (!entries) return undefined;
    return copies(entries);
  }

  /**
   * The decoded entries of tree `id`, from the cache or read and cached; undefined if it is
   * absent or not a tree. Entries are shared with the cache, never to be changed.
   */
  private read(id: ObjectId): Promise<readonly TreeEntry[] | undefined> {
    // as git's parsed objects, a tree read once is kept for the store's life (a prune of an
    // unreachable tree by another process is not seen)
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return Promise.resolve(hit);
    }
    // concurrent reads of one tree (two sides of a merge holding it) read it once
    let reading = this.reading.get(id);
    if (!reading) {
      reading = this.readStored(id).finally(() => this.reading.delete(id));
      this.reading.set(id, reading);
    }
    return reading;
  }

  private async readStored(id: ObjectId): Promise<readonly TreeEntry[] | undefined> {
    let obj: Awaited<ReturnType<GitObjects["get"]>>;
    try {
      obj = await this.objects.get(id);
    } catch (e) {
      if (e instanceof InvalidObjectIdError) return undefined;
      // a stored object whose header cannot be read: as `has` reports it
      if (e instanceof CorruptObjectError) throw e;
      const reason = e instanceof Error ? `: ${e.message}` : "";
      throw new CorruptObjectError(`object ${id} is stored but cannot be read${reason}`, {
        cause: e,
      });
    }
    if (!obj) return undefined;
    const it = obj.content[Symbol.asyncIterator]();
    if (obj.type !== "tree") {
      await it.return?.();
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let r = await it.next(); !r.done; r = await it.next()) {
      chunks.push(r.value);
      size += r.value.length;
    }
    let bytes: Uint8Array;
    if (chunks.length === 1) bytes = chunks[0];
    else {
      bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
    }
    const entries = decodeTreeBytes(bytes);
    this.forget(id);
    this.remember(id, entries);
    return entries;
  }

  private forget(id: ObjectId): void {
    const entries = this.cache.get(id);
    if (!entries) return;
    this.cachedEntries -= entries.length;
    this.cache.delete(id);
  }

  private remember(id: ObjectId, entries: readonly TreeEntry[]): void {
    if (entries.length > this.maxCachedEntries) return;
    this.cache.set(id, entries);
    this.cachedEntries += entries.length;
    while (this.cachedEntries > this.maxCachedEntries) {
      const oldest = this.cache.keys().next().value as ObjectId;
      this.cachedEntries -= this.cache.get(oldest)?.length ?? 0;
      this.cache.delete(oldest);
    }
  }

  /**
   * Remove tree (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    // Git objects are content-addressed and generally immutable
    // This is implemented for interface compliance but shouldn't be used in practice
    this.forget(id);
    return removeObject(this.objects, id);
  }

  // ============ Common Methods ============

  /**
   * Get specific entry from tree
   */
  async getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined> {
    if (treeId === EMPTY_TREE_ID) return undefined;
    const entries = await this.read(treeId);
    const entry = entries?.find((e) => e.name === name);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Check if tree exists
   *
   * The empty tree is always considered to exist.
   */
  async has(id: ObjectId): Promise<boolean> {
    if (id === EMPTY_TREE_ID) {
      return true;
    }
    return hasObjectOfType(this.objects, id, "tree");
  }

  /**
   * Enumerate all tree object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await objectHeader(this.objects, id);
        if (header?.type === "tree") {
          yield id;
        }
      } catch {
        // Skip invalid objects
      }
    }
  }

  /**
   * Get well-known empty tree ID
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }
}

/**
 * Return an empty async iterable of tree entries.
 *
 * Extracted as a named function to prevent rolldown from optimizing
 * away `(async function* () {})()` to a bare `return;`.
 */
/** Decoded entries the cache holds at most, across trees (about 10 MB). */
const DEFAULT_MAX_CACHED_ENTRIES = 100_000;

/** Fresh copies of cached entries, so a caller's change never reaches the cache. */
async function* copies(entries: readonly TreeEntry[]): AsyncGenerator<TreeEntry> {
  for (const e of entries) yield { mode: e.mode, name: e.name, id: e.id };
}

async function* emptyTreeEntries(): AsyncGenerator<TreeEntry> {
  // intentionally yields nothing
}

/**
 * Create a Trees instance backed by GitObjects
 *
 * @param objects GitObjects implementation to use for persistence
 * @returns Trees instance
 */
export function createTrees(objects: GitObjects): Trees {
  return new GitTreeStore(objects);
}
