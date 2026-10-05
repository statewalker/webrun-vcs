/**
 * Git tag store implementation
 *
 * Wraps GitObjectStore with tag serialization/deserialization.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObjectStore } from "../objects/object-store.js";
import { ObjectType } from "../objects/object-types.js";
import { decodeTagEntries, encodeTagEntries, entriesToTag, tagToEntries } from "./tag-format.js";
import type { AnnotatedTag, Tags } from "./tags.js";

/**
 * Git tag store implementation
 *
 * Handles tag serialization and delegates storage to GitObjectStore.
 */
class GitTagStore implements Tags {
  constructor(private readonly objects: GitObjectStore) {}

  // ============ New Tags Interface ============

  /**
   * Store an annotated tag (new interface)
   */
  async store(tag: AnnotatedTag): Promise<ObjectId> {
    const entries = tagToEntries(tag);
    return this.objects.store("tag", encodeTagEntries(entries));
  }

  /**
   * Load a tag by ID (new interface)
   * Returns undefined if tag doesn't exist.
   */
  async load(id: ObjectId): Promise<AnnotatedTag | undefined> {
    if (!(await this.has(id))) {
      return undefined;
    }
    return this.loadTagInternal(id);
  }

  /**
   * Remove tag (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.objects.remove(id);
  }

  /**
   * Load an annotated tag by ID (internal implementation)
   */
  private async loadTagInternal(id: ObjectId): Promise<AnnotatedTag> {
    const [header, content] = await this.objects.loadWithHeader(id);
    try {
      if (header.type !== "tag") {
        throw new Error(`Object ${id} is not a tag (found type: ${header.type})`);
      }
      const entries = decodeTagEntries(content);
      return entriesToTag(entries);
    } catch (err) {
      content?.return?.(void 0);
      throw err;
    }
  }

  // ============ Common Methods ============

  /**
   * Get the tagged object ID
   *
   * Follows tag chains if peel is true.
   * Returns undefined if tag doesn't exist (new interface behavior).
   */
  async getTarget(id: ObjectId, peel = false): Promise<ObjectId | undefined> {
    if (!(await this.has(id))) {
      return undefined;
    }

    const tag = await this.loadTagInternal(id);

    if (!peel || tag.objectType !== ObjectType.TAG) {
      return tag.object;
    }

    // Follow tag chain
    let currentId = tag.object;
    while (true) {
      if (!(await this.objects.has(currentId))) {
        return currentId;
      }
      const header = await this.objects.getHeader(currentId);
      if (header.type !== "tag") {
        return currentId;
      }
      const nextTag = await this.loadTagInternal(currentId);
      currentId = nextTag.object;
    }
  }

  /**
   * Check if tag exists
   */
  async has(id: ObjectId): Promise<boolean> {
    if (!(await this.objects.has(id))) {
      return false;
    }
    try {
      const header = await this.objects.getHeader(id);
      return header.type === "tag";
    } catch {
      return false;
    }
  }

  /**
   * Enumerate all tag object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await this.objects.getHeader(id);
        if (header.type === "tag") {
          yield id;
        }
      } catch {
        // Skip invalid objects
      }
    }
  }
}

/**
 * Create a Tags instance backed by GitObjectStore
 *
 * @param objects GitObjectStore implementation to use for persistence
 * @returns Tags instance
 */
export function createTags(objects: GitObjectStore): Tags {
  return new GitTagStore(objects);
}
