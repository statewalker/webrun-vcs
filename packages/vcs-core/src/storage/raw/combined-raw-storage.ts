/**
 * Combined Raw Storage
 *
 * Combines loose object storage with pack file support.
 * Implements RawStorage interface for Git object storage.
 *
 * - Reads from both loose objects and pack files
 * - Writes to loose objects only
 * - Pack files are read-only (created by GC/pack operations)
 */

import type { DeltaStore } from "../delta/delta-store.js";
import type { RawStorage } from "./raw-storage.js";

/**
 * Combined raw storage that reads from loose objects and pack files
 *
 * @example
 * ```typescript
 * const looseStore = new CompressedRawStorage(new FileRawStorage(files, objectsDir));
 * const packStore = new PackDeltaStore({ files, basePath: "objects/pack" });
 * const combined = new CombinedRawStorage(looseStore, packStore);
 * ```
 */
export class CombinedRawStorage implements RawStorage {
  constructor(
    private readonly loose: RawStorage,
    private readonly packs: DeltaStore,
  ) {}

  /**
   * Store content (always to loose objects)
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    await this.loose.store(key, content);
  }

  /**
   * Load content from loose objects or pack files
   *
   * Checks pack files first (more efficient for large repos),
   * then falls back to loose objects.
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    // Try pack files first (loadObject resolves deltas internally)
    if (this.packs.loadObject) {
      try {
        const content = await this.packs.loadObject(key);
        if (content) {
          if (options?.start !== undefined || options?.end !== undefined) {
            const start = options.start ?? 0;
            const end = options.end ?? content.length;
            yield content.subarray(start, end);
          } else {
            yield content;
          }
          return;
        }
      } catch {
        // Pack load failed, try loose objects
      }
    }

    // Try loose objects
    if (await this.loose.has(key)) {
      yield* this.loose.load(key, options);
      return;
    }

    throw new Error(`Object not found: ${key}`);
  }

  /**
   * Check if object exists in loose objects or pack files
   */
  async has(key: string): Promise<boolean> {
    if (await this.loose.has(key)) {
      return true;
    }

    if (this.packs.hasObject) {
      return this.packs.hasObject(key);
    }

    return false;
  }

  /**
   * Remove from loose objects only
   *
   * Pack files are immutable - objects in packs are not deleted
   * individually; the entire pack is replaced during GC.
   */
  async remove(key: string): Promise<boolean> {
    return this.loose.remove(key);
  }

  /**
   * List all keys from loose objects and pack files
   */
  async *keys(): AsyncIterable<string> {
    const seen = new Set<string>();

    // Loose objects
    for await (const key of this.loose.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        yield key;
      }
    }

    // Pack files (all objects, including bases of deltas)
    for await (const info of this.packs.listDeltas()) {
      if (!seen.has(info.targetKey)) {
        seen.add(info.targetKey);
        yield info.targetKey;
      }
    }
  }

  /**
   * Get object size
   */
  async size(key: string): Promise<number> {
    // Check packs first (getDeltaChainInfo returns originalSize)
    const chainInfo = await this.packs.getDeltaChainInfo(key);
    if (chainInfo) {
      return chainInfo.originalSize;
    }

    // Check loose objects
    if (await this.loose.has(key)) {
      return this.loose.size(key);
    }

    // Check if object exists in pack but not as delta
    if (this.packs.loadObject) {
      const content = await this.packs.loadObject(key);
      if (content) {
        return content.length;
      }
    }

    return -1;
  }
}
