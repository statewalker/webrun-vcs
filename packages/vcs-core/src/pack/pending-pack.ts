/**
 * Pending pack buffer
 *
 * Buffers objects before writing a complete pack file.
 * Provides threshold-based flushing to control pack sizes.
 *
 * Based on jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/GC.java
 */

import type { ObjectId } from "../common/id/index.js";
import { writePackIndexV2 } from "./pack-index-writer.js";
import { StreamingPackWriter } from "./streaming-pack-writer.js";
import type { PackObjectType } from "./types.js";

/** Default maximum number of objects before auto-flush */
const DEFAULT_MAX_OBJECTS = 100;

/** Default maximum bytes before auto-flush (10MB) */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Options for PendingPack
 */
export interface PendingPackOptions {
  /** Maximum objects before auto-flush (default: 100) */
  maxObjects?: number;
  /** Maximum bytes before auto-flush (default: 10MB) */
  maxBytes?: number;
}

/**
 * Entry type for pending objects
 */
type PendingEntry =
  | {
      type: "full";
      id: ObjectId;
      objectType: PackObjectType;
      content: Uint8Array;
    }
  | {
      type: "delta";
      id: ObjectId;
      baseId: ObjectId;
      delta: Uint8Array;
    };

/**
 * Result of flushing pending objects to a pack
 */
export interface PendingPackFlushData {
  /** Generated pack name (without extension) */
  packName: string;
  /** Complete pack file data */
  packData: Uint8Array;
  /** Pack index data (V2 format) */
  indexData: Uint8Array;
  /** Index entries for each object */
  entries: Array<{ id: ObjectId; offset: number; crc32: number }>;
}

/**
 * Generate unique pack name based on timestamp + random suffix
 */
function generatePackName(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pack-${timestamp}${random}`;
}

/**
 * Pending pack buffer
 *
 * Collects objects until a threshold is reached, then flushes
 * to a complete pack file with index.
 */
export class PendingPack {
  private readonly maxObjects: number;
  private readonly maxBytes: number;
  private entries: PendingEntry[] = [];
  private totalSize = 0;

  constructor(options: PendingPackOptions = {}) {
    this.maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Add a full object to the pending pack
   *
   * @param id Object ID
   * @param type Object type (COMMIT, TREE, BLOB, TAG)
   * @param content Uncompressed object content
   */
  addObject(id: ObjectId, type: PackObjectType, content: Uint8Array): void {
    this.entries.push({
      type: "full",
      id,
      objectType: type,
      content,
    });
    this.totalSize += content.length;
  }

  /**
   * Add a delta object to the pending pack
   *
   * If an entry already exists for this ID (e.g., a full object added earlier),
   * it will be replaced with this delta entry. This supports the pattern of
   * adding all objects as full objects first, then selectively deltifying some.
   *
   * @param id Object ID of the deltified object
   * @param baseId Object ID of the base object
   * @param delta Delta data (Git binary delta format)
   */
  addDelta(id: ObjectId, baseId: ObjectId, delta: Uint8Array): void {
    // Remove existing entry if present (full object being replaced by delta)
    const existingIndex = this.entries.findIndex((e) => e.id === id);
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex];
      this.totalSize -= existing.type === "full" ? existing.content.length : existing.delta.length;
      this.entries.splice(existingIndex, 1);
    }

    this.entries.push({
      type: "delta",
      id,
      baseId,
      delta,
    });
    this.totalSize += delta.length;
  }

  /**
   * Number of pending objects
   */
  get objectCount(): number {
    return this.entries.length;
  }

  /**
   * Total pending data size (approximate, uncompressed)
   */
  get size(): number {
    return this.totalSize;
  }

  /**
   * Check if flush threshold has been reached
   */
  shouldFlush(): boolean {
    return this.entries.length >= this.maxObjects || this.totalSize >= this.maxBytes;
  }

  /**
   * Check if there are any pending entries
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Generate pack file from pending entries
   *
   * Objects are written in the order they were added. Full objects
   * are written first, followed by delta objects.
   *
   * @returns Flush result with pack data and index
   */
  async flush(): Promise<PendingPackFlushData> {
    // Separate full objects and deltas
    const fullObjects = this.entries.filter((e) => e.type === "full");
    const deltaObjects = this.entries.filter((e) => e.type === "delta");

    const writer = new StreamingPackWriter(this.entries.length);
    const chunks: Uint8Array[] = [];

    // Write full objects first (they may be bases for deltas)
    for (const entry of fullObjects) {
      if (entry.type === "full") {
        for await (const chunk of writer.addObject(entry.id, entry.objectType, entry.content)) {
          chunks.push(chunk);
        }
      }
    }

    // Write delta objects
    // Try to use OFS_DELTA if base is in this pack, otherwise use REF_DELTA
    for (const entry of deltaObjects) {
      if (entry.type === "delta") {
        const baseOffset = writer.getObjectOffset(entry.baseId);
        if (baseOffset !== undefined) {
          for await (const chunk of writer.addOfsDelta(entry.id, entry.baseId, entry.delta)) {
            chunks.push(chunk);
          }
        } else {
          for await (const chunk of writer.addRefDelta(entry.id, entry.baseId, entry.delta)) {
            chunks.push(chunk);
          }
        }
      }
    }

    // Finalize: yields the 20-byte checksum
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    // Collect pack data
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const packData = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      packData.set(c, offset);
      offset += c.length;
    }

    // Build index from writer's tracked entries
    const packChecksum = packData.subarray(packData.length - 20);
    const indexEntries = writer.getIndexEntries();
    const sortedEntries = [...indexEntries].sort((a, b) => a.id.localeCompare(b.id));
    const indexData = await writePackIndexV2(sortedEntries, packChecksum);

    // Clear entries after flush
    this.entries = [];
    this.totalSize = 0;

    return {
      packName: generatePackName(),
      packData,
      indexData,
      entries: sortedEntries,
    };
  }

  /**
   * Discard all pending data without flushing
   */
  clear(): void {
    this.entries = [];
    this.totalSize = 0;
  }

  /**
   * Get IDs of all pending objects
   */
  getPendingIds(): ObjectId[] {
    return this.entries.map((e) => e.id);
  }

  /**
   * Check if an object is pending
   */
  hasPending(id: ObjectId): boolean {
    return this.entries.some((e) => e.id === id);
  }

  /**
   * Check if a pending object is a delta
   *
   * @param id Object ID
   * @returns True if pending as delta, false if full or not found
   */
  isDelta(id: ObjectId): boolean {
    const entry = this.entries.find((e) => e.id === id);
    return entry?.type === "delta";
  }

  /**
   * Get base key for a pending delta
   *
   * @param id Object ID
   * @returns Base object ID or undefined
   */
  getDeltaBase(id: ObjectId): ObjectId | undefined {
    const entry = this.entries.find((e) => e.id === id && e.type === "delta");
    if (entry && entry.type === "delta") {
      return entry.baseId;
    }
    return undefined;
  }
}
