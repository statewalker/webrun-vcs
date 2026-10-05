/**
 * Composite Raw Storage
 *
 * Combines a primary read/write RawStorage with one or more
 * read-only fallback storages. Writes go to primary only.
 * Reads try primary first, then each fallback in order.
 *
 * Used to layer pack-backed storage behind loose object storage.
 */

import type { RawStorage } from "./raw-storage.js";

/**
 * RawStorage that reads from primary + fallbacks, writes to primary only
 *
 * @example
 * ```typescript
 * const loose = new FileRawStorage(files, objectsDir, { compress: true });
 * const packAdapter = new PackDirectoryAdapter(packDir);
 * const composite = new CompositeRawStorage(loose, [packAdapter]);
 * const objects = createGitObjectStore(composite);
 * ```
 */
export class CompositeRawStorage implements RawStorage {
  constructor(
    private readonly primary: RawStorage,
    private readonly fallbacks: readonly RawStorage[],
  ) {}

  /**
   * Store content in primary storage only
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    await this.primary.store(key, content);
  }

  /**
   * Load from primary, falling back to each fallback in order
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    if (await this.primary.has(key)) {
      yield* this.primary.load(key, options);
      return;
    }

    for (const fallback of this.fallbacks) {
      if (await fallback.has(key)) {
        yield* fallback.load(key, options);
        return;
      }
    }

    throw new Error(`Key not found: ${key}`);
  }

  /**
   * Check if key exists in primary or any fallback
   */
  async has(key: string): Promise<boolean> {
    if (await this.primary.has(key)) return true;
    for (const fallback of this.fallbacks) {
      if (await fallback.has(key)) return true;
    }
    return false;
  }

  /**
   * Remove from primary only (fallbacks are read-only)
   */
  async remove(key: string): Promise<boolean> {
    return this.primary.remove(key);
  }

  /**
   * List all keys from primary and fallbacks, deduplicated
   */
  async *keys(): AsyncIterable<string> {
    const seen = new Set<string>();

    for await (const key of this.primary.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        yield key;
      }
    }

    for (const fallback of this.fallbacks) {
      for await (const key of fallback.keys()) {
        if (!seen.has(key)) {
          seen.add(key);
          yield key;
        }
      }
    }
  }

  /**
   * Get size from primary or first fallback that has the key
   */
  async size(key: string): Promise<number> {
    if (await this.primary.has(key)) {
      return this.primary.size(key);
    }
    for (const fallback of this.fallbacks) {
      if (await fallback.has(key)) {
        return fallback.size(key);
      }
    }
    return -1;
  }
}
