/**
 * Key-Value based RawStorage implementation
 *
 * Stores binary content in a key-value store.
 * Implements the RawStorage interface.
 */

import type { RawStorage } from "@statewalker/vcs-core";
import type { KVStore } from "../kv-store.js";

/**
 * Key prefix for raw storage
 */
const RAW_PREFIX = "raw:";

/**
 * Key for size metadata
 */
const SIZE_PREFIX = "size:";

/**
 * Collect async iterable to Uint8Array
 */
async function collect(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of input) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Encode size as bytes
 */
function encodeSize(size: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, size, true);
  return new Uint8Array(buffer);
}

/**
 * Decode size from bytes
 */
function decodeSize(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

/**
 * KV-based storage
 *
 * Stores content with prefixed keys:
 * - raw:{key} -> data blob
 * - size:{key} -> size as 4-byte integer
 */
export class KvRawStore implements RawStorage {
  /**
   * Create KV-based storage
   *
   * @param kv Key-value store
   * @param prefix Optional key prefix (default: "raw")
   */
  constructor(
    private readonly kv: KVStore,
    private readonly prefix: string = "raw",
  ) {}

  /**
   * Get prefixed key for data
   */
  private dataKey(key: string): string {
    return `${this.prefix}:${RAW_PREFIX}${key}`;
  }

  /**
   * Get prefixed key for size metadata
   */
  private sizeKey(key: string): string {
    return `${this.prefix}:${SIZE_PREFIX}${key}`;
  }

  /**
   * Store byte stream under key
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const bytes = await collect(content);

    // Store data and size
    const entries = new Map<string, Uint8Array>();
    entries.set(this.dataKey(key), bytes);
    entries.set(this.sizeKey(key), encodeSize(bytes.length));
    await this.kv.setMany(entries);
  }

  /**
   * Load byte stream by key
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    const bytes = await this.kv.get(this.dataKey(key));

    if (!bytes) {
      throw new Error(`Key not found: ${key}`);
    }

    const start = options?.start ?? 0;
    const end = options?.end ?? bytes.length;

    // Handle range
    if (start > 0 || end < bytes.length) {
      yield bytes.slice(start, end);
    } else {
      yield bytes;
    }
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    return this.kv.has(this.dataKey(key));
  }

  /**
   * Remove content by key
   */
  async remove(key: string): Promise<boolean> {
    const existed = await this.kv.has(this.dataKey(key));
    if (existed) {
      await this.kv.delete(this.dataKey(key));
      await this.kv.delete(this.sizeKey(key));
    }
    return existed;
  }

  /**
   * List all keys
   */
  async *keys(): AsyncIterable<string> {
    const dataPrefix = this.dataKey("");
    for await (const fullKey of this.kv.list(dataPrefix)) {
      yield fullKey.substring(dataPrefix.length);
    }
  }

  /**
   * Get content size for a key
   */
  async size(key: string): Promise<number> {
    const sizeData = await this.kv.get(this.sizeKey(key));
    if (!sizeData) {
      return -1;
    }
    return decodeSize(sizeData);
  }
}

/**
 * Create a new KV-based raw store
 */
export function createKvRawStore(kv: KVStore, prefix?: string): KvRawStore {
  return new KvRawStore(kv, prefix);
}
