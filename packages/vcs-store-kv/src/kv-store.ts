/**
 * Key-Value Store Interface
 *
 * Minimal interface for key-value storage backends.
 * Implementations can wrap various storage systems:
 * - In-memory Map (for testing)
 * - IndexedDB (browser)
 * - LocalStorage (browser, size-limited)
 * - LevelDB (Node.js)
 * - Redis, etc.
 */

/**
 * Abstract key-value store interface
 *
 * All operations are async to support both sync and async backends.
 * Keys are strings, values are Uint8Array (binary).
 */
export interface KVStore {
  /**
   * Get a value by key
   *
   * @param key The key to look up
   * @returns The value, or undefined if not found
   */
  get(key: string): Promise<Uint8Array | undefined>;

  /**
   * Set a value
   *
   * @param key The key to set
   * @param value The value to store
   */
  set(key: string, value: Uint8Array): Promise<void>;

  /**
   * Delete a key
   *
   * @param key The key to delete
   * @returns True if key was deleted, false if it didn't exist
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists
   *
   * @param key The key to check
   * @returns True if key exists
   */
  has(key: string): Promise<boolean>;

  /**
   * List all keys with a given prefix
   *
   * @param prefix Key prefix to filter by (empty string for all keys)
   * @returns AsyncIterable of matching keys
   */
  list(prefix: string): AsyncIterable<string>;

  /**
   * Get multiple values at once
   *
   * More efficient than multiple get() calls for some backends.
   *
   * @param keys Keys to look up
   * @returns Map of found key-value pairs
   */
  getMany(keys: string[]): Promise<Map<string, Uint8Array>>;

  /**
   * Set multiple values at once
   *
   * More efficient than multiple set() calls for some backends.
   *
   * @param entries Map of key-value pairs to set
   */
  setMany(entries: Map<string, Uint8Array>): Promise<void>;

  /**
   * Compare-and-swap update
   *
   * Atomically updates a key only if its current value matches expected.
   *
   * @param key Key to update
   * @param expected Expected current value (undefined for key not existing)
   * @param newValue New value to set
   * @returns True if update succeeded, false if value didn't match
   */
  compareAndSwap(
    key: string,
    expected: Uint8Array | undefined,
    newValue: Uint8Array,
  ): Promise<boolean>;

  /**
   * Close the store and release resources
   *
   * Optional - some backends don't need explicit cleanup.
   */
  close?(): Promise<void>;
}

/**
 * Helper to compare Uint8Array values
 */
export function uint8ArrayEquals(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }

  return true;
}
