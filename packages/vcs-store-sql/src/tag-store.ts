/**
 * SQL-based TagStore implementation
 *
 * Stores annotated tag objects in a SQL database.
 */

import type { AnnotatedTag, ObjectId, ObjectTypeCode, Tags } from "@statewalker/vcs-core";
import { computeTagHash, ObjectType } from "@statewalker/vcs-core";

import type { DatabaseClient } from "./database-client.js";

/**
 * Maximum depth for following tag chains to prevent infinite loops.
 */
const MAX_TAG_CHAIN_DEPTH = 100;

/**
 * Database row type for tag queries
 */
interface TagRow {
  id: number;
  tag_id: string;
  object_id: string;
  object_type: number;
  tag_name: string;
  tagger_name: string | null;
  tagger_email: string | null;
  tagger_timestamp: number | null;
  tagger_tz: string | null;
  message: string;
  encoding: string | null;
  gpg_signature: string | null;
}

/**
 * SQL-based TagStore implementation.
 */
export class SQLTagStore implements Tags {
  constructor(private db: DatabaseClient) {}

  /**
   * Store an annotated tag object.
   */
  async store(tag: AnnotatedTag): Promise<ObjectId> {
    const tagId = computeTagHash(tag);

    // Check if tag already exists (deduplication)
    const existing = await this.db.query<{ id: number }>(
      "SELECT id FROM vcs_tag WHERE tag_id = ?",
      [tagId],
    );

    if (existing.length > 0) {
      return tagId;
    }

    // Store tag
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO vcs_tag (
        tag_id, object_id, object_type, tag_name,
        tagger_name, tagger_email, tagger_timestamp, tagger_tz,
        message, encoding, gpg_signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tagId,
        tag.object,
        tag.objectType,
        tag.tag,
        tag.tagger?.name || null,
        tag.tagger?.email || null,
        tag.tagger?.timestamp || null,
        tag.tagger?.tzOffset || null,
        tag.message,
        tag.encoding || null,
        tag.gpgSignature || null,
        now,
      ],
    );

    return tagId;
  }

  /**
   * Load a tag object by ID.
   * Returns undefined if not found (new API behavior).
   */
  async load(id: ObjectId): Promise<AnnotatedTag | undefined> {
    const tags = await this.db.query<TagRow>("SELECT * FROM vcs_tag WHERE tag_id = ?", [id]);

    if (tags.length === 0) {
      return undefined;
    }

    const row = tags[0];

    return {
      object: row.object_id,
      objectType: row.object_type as ObjectTypeCode,
      tag: row.tag_name,
      tagger:
        row.tagger_name != null
          ? {
              name: row.tagger_name,
              email: row.tagger_email || "",
              timestamp: row.tagger_timestamp || 0,
              tzOffset: row.tagger_tz || "+0000",
            }
          : undefined,
      message: row.message,
      encoding: row.encoding || undefined,
      gpgSignature: row.gpg_signature || undefined,
    };
  }

  /**
   * Get the tagged object ID.
   * Returns undefined if tag not found.
   *
   * Follows tag chains if the tag points to another tag and peel is true.
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
      const innerTags = await this.db.query<{ object_id: string; object_type: number }>(
        "SELECT object_id, object_type FROM vcs_tag WHERE tag_id = ?",
        [current],
      );

      if (innerTags.length === 0) {
        // Not a tag or not found - return current
        return current;
      }

      const innerTag = innerTags[0];
      if (innerTag.object_type !== ObjectType.TAG) {
        // Points to non-tag object
        return innerTag.object_id;
      }

      current = innerTag.object_id;
      depth++;
    }

    throw new Error(`Tag chain too deep (> ${MAX_TAG_CHAIN_DEPTH})`);
  }

  /**
   * Check if tag exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM vcs_tag WHERE tag_id = ?",
      [id],
    );
    return result[0].cnt > 0;
  }

  /**
   * Remove a tag by ID.
   * @returns True if removed, false if not found
   */
  async remove(id: ObjectId): Promise<boolean> {
    const result = await this.db.execute("DELETE FROM vcs_tag WHERE tag_id = ?", [id]);
    return result.changes > 0;
  }

  /**
   * Enumerate all tag object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    const tags = await this.db.query<{ tag_id: string }>("SELECT tag_id FROM vcs_tag");
    for (const row of tags) {
      yield row.tag_id;
    }
  }
}
