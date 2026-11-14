/**
 * Git blob store implementation
 *
 * Thin wrapper over GitObjects for blob operations.
 * Blobs are the simplest object type - just raw binary content.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObjects } from "../objects/git-objects.js";
import { loadTypedObject, objectHeader, storeObject } from "../objects/typed-object-access.js";
import type { Blobs } from "./blobs.js";

/**
 * Git blob store implementation
 *
 * Delegates all operations to GitObjects with "blob" type.
 */
class GitBlobStore implements Blobs {
  constructor(private readonly objects: GitObjects) {}

  /**
   * Store blob with unknown size
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
    if (!(await this.has(id))) {
      return undefined;
    }
    const self = this;
    return (async function* () {
      yield* self.loadContent(id);
    })();
  }

  /**
   * Load blob content (internal implementation)
   */
  private async *loadContent(id: ObjectId): AsyncGenerator<Uint8Array> {
    const { content, release } = await loadTypedObject(this.objects, id, "blob");
    try {
      yield* content;
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Remove blob (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.objects.remove(id);
  }

  /**
   * Check if blob exists
   */
  async has(id: ObjectId): Promise<boolean> {
    if (!(await this.objects.has(id))) {
      return false;
    }
    try {
      const header = await objectHeader(this.objects, id);
      return header?.type === "blob";
    } catch {
      return false;
    }
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
    if (!(await this.objects.has(id))) {
      return -1;
    }
    const header = await objectHeader(this.objects, id);
    if (header?.type !== "blob") {
      return -1;
    }
    return header.size;
  }
}

export function createBlobs(objects: GitObjects): Blobs {
  return new GitBlobStore(objects);
}
