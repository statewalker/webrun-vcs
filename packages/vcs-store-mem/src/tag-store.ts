/**
 * In-memory Tags implementation
 *
 * Provides a pure in-memory tag storage for testing and ephemeral operations.
 * No persistence - data is lost when the instance is garbage collected.
 *
 * Unlike file-based implementations, this does not use Git format serialization.
 * Tags are stored directly as JavaScript objects for simplicity and performance.
 */

import type { AnnotatedTag, ObjectId, Tags } from "@statewalker/vcs-core";
import { computeTagHash, ObjectType } from "@statewalker/vcs-core";

/**
 * Maximum depth for following tag chains to prevent infinite loops.
 */
const MAX_TAG_CHAIN_DEPTH = 100;

/**
 * In-memory Tags implementation.
 */
export class MemoryTagStore implements Tags {
  private tags = new Map<ObjectId, AnnotatedTag>();

  /**
   * Store an annotated tag object.
   */
  async store(tag: AnnotatedTag): Promise<ObjectId> {
    const id = computeTagHash(tag);

    // Store a deep copy to prevent external mutation
    if (!this.tags.has(id)) {
      this.tags.set(id, {
        object: tag.object,
        objectType: tag.objectType,
        tag: tag.tag,
        tagger: tag.tagger ? { ...tag.tagger } : undefined,
        message: tag.message,
        encoding: tag.encoding,
        gpgSignature: tag.gpgSignature,
      });
    }

    return id;
  }

  /**
   * Load a tag object by ID.
   *
   * @returns Tag if found, undefined otherwise
   */
  async load(id: ObjectId): Promise<AnnotatedTag | undefined> {
    const tag = this.tags.get(id);
    if (!tag) {
      return undefined;
    }

    // Return a copy to prevent external mutation
    return {
      object: tag.object,
      objectType: tag.objectType,
      tag: tag.tag,
      tagger: tag.tagger ? { ...tag.tagger } : undefined,
      message: tag.message,
      encoding: tag.encoding,
      gpgSignature: tag.gpgSignature,
    };
  }

  /**
   * Remove a tag by ID.
   *
   * @returns True if removed, false if not found
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.tags.delete(id);
  }

  /**
   * Get the tagged object ID.
   *
   * Follows tag chains if the tag points to another tag and peel is true.
   *
   * @returns Target ID if tag exists, undefined otherwise
   */
  async getTarget(id: ObjectId, peel = false): Promise<ObjectId | undefined> {
    const tag = await this.load(id);
    if (!tag) {
      return undefined;
    }

    if (!peel || tag.objectType !== ObjectType.TAG) {
      return tag.object;
    }

    // Follow tag chain
    let current = tag.object;
    let depth = 0;

    while (depth < MAX_TAG_CHAIN_DEPTH) {
      const innerTag = this.tags.get(current);
      if (!innerTag) {
        // Not a tag or not found - return current
        return current;
      }

      if (innerTag.objectType !== ObjectType.TAG) {
        // Points to non-tag object
        return innerTag.object;
      }

      current = innerTag.object;
      depth++;
    }

    throw new Error(`Tag chain too deep (> ${MAX_TAG_CHAIN_DEPTH})`);
  }

  /**
   * Check if tag exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    return this.tags.has(id);
  }

  /**
   * Enumerate all tag object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    for (const id of this.tags.keys()) {
      yield id;
    }
  }
}
