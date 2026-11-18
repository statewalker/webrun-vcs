/**
 * Git blob store implementation
 *
 * Thin wrapper over GitObjects for blob operations.
 * Blobs are the simplest object type - just raw binary content.
 */

import type { ObjectId } from "../../common/id/index.js";
import {
  CorruptObjectError,
  type GitObject,
  type GitObjects,
  InvalidObjectIdError,
} from "../objects/git-objects.js";
import {
  hasObjectOfType,
  objectHeader,
  removeObject,
  storeObject,
} from "../objects/typed-object-access.js";
import type { BlobRead, Blobs } from "./blobs.js";

/**
 * Git blob store implementation
 *
 * Delegates all operations to GitObjects with "blob" type.
 */
class GitBlobStore implements Blobs {
  constructor(private readonly objects: GitObjects) {}

  /**
   * Store a blob: in one pass with `size`, else through `putUnsized` (small
   * content in memory, longer content spooled).
   */
  store(
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    size?: number,
  ): Promise<ObjectId> {
    if (size !== undefined) return this.objects.put("blob", size, content);
    return storeObject(this.objects, "blob", content);
  }

  /**
   * Load blob content (Blobs interface)
   * Returns undefined if blob doesn't exist.
   */
  async load(id: ObjectId): Promise<AsyncIterable<Uint8Array> | undefined> {
    const blob = await this.read(id);
    if (!blob) return undefined;
    if (blob.bytes) return single(blob.bytes);
    return blob.content;
  }

  /**
   * The blob from one read of the object: its size, and its content (in memory when the
   * store holds it so). Undefined if absent or not a blob; an object that is stored but
   * whose header cannot be read throws `CorruptObjectError`, as `has` reports it.
   */
  open(id: ObjectId): Promise<BlobRead | undefined> {
    return this.read(id);
  }

  /** `open`, which `load` and `size` read through (a view overriding `open` keeps them) */
  private async read(id: ObjectId): Promise<BlobRead | undefined> {
    let obj: GitObject | undefined;
    try {
      obj = await (this.objects.getNow ? this.objects.getNow(id) : this.objects.get(id));
    } catch (e) {
      if (e instanceof InvalidObjectIdError) return undefined;
      if (e instanceof CorruptObjectError) throw e;
      const reason = e instanceof Error ? `: ${e.message}` : "";
      throw new CorruptObjectError(`object ${id} is stored but cannot be read${reason}`, {
        cause: e,
      });
    }
    if (!obj) return undefined;
    if (obj.type !== "blob") {
      if (!obj.bytes) await obj.content[Symbol.asyncIterator]().return?.();
      return undefined;
    }
    return obj.bytes
      ? { size: obj.size, bytes: obj.bytes, content: obj.content }
      : { size: obj.size, content: obj.content };
  }

  /**
   * Remove blob (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    return removeObject(this.objects, id);
  }

  /**
   * Check if blob exists
   */
  async has(id: ObjectId): Promise<boolean> {
    return hasObjectOfType(this.objects, id, "blob");
  }

  /**
   * List all blob object IDs
   *
   * Iterates over all objects in storage and yields only those
   * that are blobs. Used for GC and storage analysis.
   */
  async *keys(): AsyncGenerator<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await objectHeader(this.objects, id);
        if (header?.type === "blob") {
          yield id;
        }
      } catch {
        // Skip objects that can't be read (corrupted, etc.)
      }
    }
  }

  /**
   * Get blob size in bytes
   */
  async size(id: ObjectId): Promise<number> {
    const blob = await this.read(id);
    if (!blob) return -1;
    if (!blob.bytes) await blob.content[Symbol.asyncIterator]().return?.();
    return blob.size;
  }
}

/** One chunk as a stream */
async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export function createBlobs(objects: GitObjects): Blobs {
  return new GitBlobStore(objects);
}
