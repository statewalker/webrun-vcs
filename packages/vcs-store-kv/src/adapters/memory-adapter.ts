/**
 * In-memory KVStore adapter
 *
 * Simple Map-based implementation for testing and development.
 * No persistence - data is lost when the instance is garbage collected.
 */

import type { KVStore } from "../kv-store.js";
import { uint8ArrayEquals } from "../kv-store.js";

/**
 * In-memory KVStore implementation using a Map.
 */
export class MemoryKVAdapter implements KVStore {
  private store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.store.get(key);
    // Return a copy to prevent external mutation
    return value ? new Uint8Array(value) : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    // Store a copy to prevent external mutation
    this.store.set(key, new Uint8Array(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async *list(prefix: string): AsyncIterable<string> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }

  async getMany(keys: string[]): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>();
    for (const key of keys) {
      const value = this.store.get(key);
      if (value) {
        result.set(key, new Uint8Array(value));
      }
    }
    return result;
  }

  async setMany(entries: Map<string, Uint8Array>): Promise<void> {
    for (const [key, value] of entries) {
      this.store.set(key, new Uint8Array(value));
    }
  }

  async compareAndSwap(
    key: string,
    expected: Uint8Array | undefined,
    newValue: Uint8Array,
  ): Promise<boolean> {
    const current = this.store.get(key);

    if (!uint8ArrayEquals(current, expected)) {
      return false;
    }

    this.store.set(key, new Uint8Array(newValue));
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  /**
   * Get the number of entries in the store (for testing)
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clear all entries (for testing)
   */
  clear(): void {
    this.store.clear();
  }
}
