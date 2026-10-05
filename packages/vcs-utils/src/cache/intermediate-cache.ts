/**
 * Intermediate cache for delta reconstruction
 *
 * Caches intermediate results during delta chain reconstruction,
 * following Fossil's approach of caching every 8 steps.
 */

/**
 * Cache for intermediate delta reconstruction results
 *
 * Stores partially reconstructed content at regular intervals during
 * delta chain traversal, allowing shared base chains to benefit from
 * cached waypoints.
 */
export class IntermediateCache {
  private cache = new Map<string, Uint8Array>();

  /**
   * Generate cache key from base record ID and depth
   *
   * @param baseRecordId Record ID of the base object
   * @param depth Depth in the delta chain
   * @returns Cache key
   */
  private getKey(baseRecordId: number, depth: number): string {
    return `${baseRecordId}:${depth}`;
  }

  /**
   * Store intermediate result
   *
   * @param baseRecordId Record ID of the base object
   * @param depth Depth in the delta chain
   * @param content Intermediate content
   */
  set(baseRecordId: number, depth: number, content: Uint8Array): void {
    const key = this.getKey(baseRecordId, depth);
    this.cache.set(key, content);
  }

  /**
   * Get intermediate result
   *
   * @param cacheKey Cache key (format: "baseRecordId:depth")
   * @returns Cached content or undefined
   */
  get(cacheKey: string): Uint8Array | undefined {
    return this.cache.get(cacheKey);
  }

  /**
   * Get intermediate result by components
   *
   * @param baseRecordId Record ID of the base object
   * @param depth Depth in the delta chain
   * @returns Cached content or undefined
   */
  getByComponents(baseRecordId: number, depth: number): Uint8Array | undefined {
    const key = this.getKey(baseRecordId, depth);
    return this.cache.get(key);
  }

  /**
   * Clear all intermediate results for chains involving an object
   *
   * @param objectRecordId Record ID to clear
   */
  clear(objectRecordId: number): void {
    // Remove all entries where the base record ID matches
    for (const key of this.cache.keys()) {
      // Keys are formatted as "baseRecordId:depth"
      const baseRecordId = Number.parseInt(key.split(":")[0], 10);
      if (baseRecordId === objectRecordId) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cached intermediate results
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Get number of cached entries
   *
   * @returns Number of cached entries
   */
  size(): number {
    return this.cache.size;
  }
}
