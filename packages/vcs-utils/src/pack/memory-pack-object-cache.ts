/**
 * In-memory PackObjectCache implementation
 *
 * Stores resolved objects in a Map<string, Uint8Array>.
 * Best for small packs where memory is not constrained.
 */

import { collect } from "../streams/collect.js";
import type { PackObjectCache } from "./pack-object-cache.js";

interface CachedObject {
  type: string;
  content: Uint8Array;
}

/**
 * Memory-backed pack object cache.
 *
 * Collects async content to buffer on save, returns subarray on read.
 */
export class MemoryPackObjectCache implements PackObjectCache {
  private objects = new Map<string, CachedObject>();

  async save(key: string, type: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const data = await collect(content);
    this.objects.set(key, { type, content: data });
  }

  getType(key: string): string | undefined {
    return this.objects.get(key)?.type;
  }

  getSize(key: string): number | undefined {
    return this.objects.get(key)?.content.length;
  }

  read(key: string, start = 0): AsyncIterable<Uint8Array> {
    const obj = this.objects.get(key);
    if (!obj) {
      throw new Error(`PackObjectCache: key "${key}" not found`);
    }
    const data = start > 0 ? obj.content.subarray(start) : obj.content;
    return (async function* () {
      yield data;
    })();
  }

  async dispose(): Promise<void> {
    this.objects.clear();
  }
}
