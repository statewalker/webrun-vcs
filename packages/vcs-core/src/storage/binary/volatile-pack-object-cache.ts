/**
 * VolatileStore-backed PackObjectCache
 *
 * Stores resolved objects via VolatileStore for large pack streaming.
 * Each object gets its own VolatileContent handle for random-access reads.
 */

import type { PackObjectCache } from "@statewalker/vcs-utils/pack";
import type { VolatileContent, VolatileStore } from "./volatile-store.js";

interface CachedEntry {
  type: string;
  content: VolatileContent;
}

/**
 * PackObjectCache backed by a VolatileStore.
 *
 * Uses VolatileStore.store() to buffer async content, then provides
 * random-access reads via VolatileContent.read(start?). Metadata
 * (type, size) is tracked in an in-memory Map.
 */
export class VolatilePackObjectCache implements PackObjectCache {
  private entries = new Map<string, CachedEntry>();

  constructor(private readonly store: VolatileStore) {}

  async save(key: string, type: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    // Dispose previous entry if overwriting
    const existing = this.entries.get(key);
    if (existing) {
      await existing.content.dispose();
    }

    const volatileContent = await this.store.store(content);
    this.entries.set(key, { type, content: volatileContent });
  }

  getType(key: string): string | undefined {
    return this.entries.get(key)?.type;
  }

  getSize(key: string): number | undefined {
    return this.entries.get(key)?.content.size;
  }

  read(key: string, start = 0): AsyncIterable<Uint8Array> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`PackObjectCache: key "${key}" not found`);
    }
    return entry.content.read(start);
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.content.dispose();
    }
    this.entries.clear();
  }
}
