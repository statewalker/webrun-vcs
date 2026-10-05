/**
 * KV-based Tags implementation
 *
 * Stores annotated tag objects using a key-value backend with JSON serialization.
 */

import type { AnnotatedTag, ObjectId, ObjectTypeCode, Tags } from "@statewalker/vcs-core";
import { computeTagHash, ObjectType } from "@statewalker/vcs-core";

import type { KVStore } from "./kv-store.js";

/**
 * Key prefix for tag data
 */
const TAG_PREFIX = "tag:";

/**
 * Maximum depth for following tag chains to prevent infinite loops.
 */
const MAX_TAG_CHAIN_DEPTH = 100;

/**
 * Serialized tag format
 */
interface SerializedTag {
  o: string; // object
  ot: number; // objectType
  t: string; // tag name
  tn?: string; // tagger name
  te?: string; // tagger email
  tt?: number; // tagger timestamp
  tz?: string; // tagger tzOffset
  m: string; // message
  e?: string; // encoding
  g?: string; // gpgSignature
}

/**
 * Text encoder/decoder for JSON serialization
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * KV-based Tags implementation.
 */
export class KVTagStore implements Tags {
  constructor(private kv: KVStore) {}

  /**
   * Store an annotated tag object.
   */
  async store(tag: AnnotatedTag): Promise<ObjectId> {
    const tagId = computeTagHash(tag);

    // Check if tag already exists (deduplication)
    if (await this.kv.has(`${TAG_PREFIX}${tagId}`)) {
      return tagId;
    }

    // Serialize
    const serialized: SerializedTag = {
      o: tag.object,
      ot: tag.objectType,
      t: tag.tag,
      tn: tag.tagger?.name,
      te: tag.tagger?.email,
      tt: tag.tagger?.timestamp,
      tz: tag.tagger?.tzOffset,
      m: tag.message,
      e: tag.encoding,
      g: tag.gpgSignature,
    };

    await this.kv.set(`${TAG_PREFIX}${tagId}`, encoder.encode(JSON.stringify(serialized)));

    return tagId;
  }

  /**
   * Load a tag object by ID.
   * Returns undefined if not found (new API behavior).
   */
  async load(id: ObjectId): Promise<AnnotatedTag | undefined> {
    const data = await this.kv.get(`${TAG_PREFIX}${id}`);
    if (!data) {
      return undefined;
    }

    const s: SerializedTag = JSON.parse(decoder.decode(data));

    return {
      object: s.o,
      objectType: s.ot as ObjectTypeCode,
      tag: s.t,
      tagger:
        s.tn != null
          ? {
              name: s.tn,
              email: s.te || "",
              timestamp: s.tt || 0,
              tzOffset: s.tz || "+0000",
            }
          : undefined,
      message: s.m,
      encoding: s.e,
      gpgSignature: s.g,
    };
  }

  /**
   * Remove a tag object by ID.
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.kv.delete(`${TAG_PREFIX}${id}`);
  }

  /**
   * Get the tagged object ID.
   * Returns undefined if tag doesn't exist.
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
      const data = await this.kv.get(`${TAG_PREFIX}${current}`);
      if (!data) {
        // Not a tag or not found - return current
        return current;
      }

      const innerTag: SerializedTag = JSON.parse(decoder.decode(data));
      if (innerTag.ot !== ObjectType.TAG) {
        // Points to non-tag object
        return innerTag.o;
      }

      current = innerTag.o;
      depth++;
    }

    throw new Error(`Tag chain too deep (> ${MAX_TAG_CHAIN_DEPTH})`);
  }

  /**
   * Check if tag exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    return this.kv.has(`${TAG_PREFIX}${id}`);
  }

  /**
   * Enumerate all tag object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const key of this.kv.list(TAG_PREFIX)) {
      yield key.slice(TAG_PREFIX.length);
    }
  }

  // --- Extended query methods (O(n) scans) ---

  /**
   * Find tags by name pattern
   *
   * Note: This is an O(n) scan through all tags. For better performance,
   * use SQL-backed storage instead.
   *
   * @param pattern Pattern to match (supports * and ? wildcards)
   * @returns Async iterable of matching tag IDs
   */
  async *findByNamePattern(pattern: string): AsyncIterable<ObjectId> {
    // Convert simple wildcards to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`, "i");

    for await (const id of this.keys()) {
      const tag = await this.load(id);
      if (tag && regex.test(tag.tag)) {
        yield id;
      }
    }
  }

  /**
   * Find tags by tagger email
   *
   * Note: This is an O(n) scan through all tags. For better performance,
   * use SQL-backed storage instead.
   *
   * @param email Tagger email to search for
   * @returns Async iterable of matching tag IDs
   */
  async *findByTagger(email: string): AsyncIterable<ObjectId> {
    for await (const id of this.keys()) {
      const tag = await this.load(id);
      if (tag?.tagger?.email === email) {
        yield id;
      }
    }
  }

  /**
   * Find tags by target object type
   *
   * Note: This is an O(n) scan through all tags. For better performance,
   * use SQL-backed storage instead.
   *
   * @param targetType Target object type code (1=commit, 2=tree, 3=blob, 4=tag)
   * @returns Async iterable of matching tag IDs
   */
  async *findByTargetType(targetType: number): AsyncIterable<ObjectId> {
    for await (const id of this.keys()) {
      const tag = await this.load(id);
      if (tag?.objectType === targetType) {
        yield id;
      }
    }
  }

  /**
   * Get tag count
   */
  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this.keys()) {
      count++;
    }
    return count;
  }
}
