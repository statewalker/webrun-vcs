import type { ChunkAccess } from "./chunk-access.js";

/**
 * In-memory ChunkAccess implementation for testing
 *
 * Stores chunks in a Map with key format: `${key}:${index}`
 */
export class MemoryChunkAccess implements ChunkAccess {
  private readonly chunks = new Map<string, Uint8Array>();
  private readonly chunkCounts = new Map<string, number>();

  private chunkKey(key: string, index: number): string {
    return `${key}:${index}`;
  }

  async storeChunk(key: string, index: number, data: Uint8Array): Promise<void> {
    this.chunks.set(this.chunkKey(key, index), data);

    // Update chunk count
    const currentCount = this.chunkCounts.get(key) ?? 0;
    if (index >= currentCount) {
      this.chunkCounts.set(key, index + 1);
    }
  }

  async loadChunk(key: string, index: number): Promise<Uint8Array> {
    const data = this.chunks.get(this.chunkKey(key, index));
    if (!data) {
      throw new Error(`Chunk not found: ${key}[${index}]`);
    }
    return data;
  }

  async getChunkCount(key: string): Promise<number> {
    return this.chunkCounts.get(key) ?? 0;
  }

  async removeChunks(key: string): Promise<boolean> {
    const count = this.chunkCounts.get(key);
    if (!count) return false;

    for (let i = 0; i < count; i++) {
      this.chunks.delete(this.chunkKey(key, i));
    }
    this.chunkCounts.delete(key);
    return true;
  }

  async hasKey(key: string): Promise<boolean> {
    return this.chunkCounts.has(key);
  }

  async *keys(): AsyncIterable<string> {
    yield* this.chunkCounts.keys();
  }

  /** Clear all chunks (for testing) */
  clear(): void {
    this.chunks.clear();
    this.chunkCounts.clear();
  }

  /** Get total number of stored chunks (for testing) */
  get totalChunks(): number {
    return this.chunks.size;
  }

  /** Get number of unique keys (for testing) */
  get keyCount(): number {
    return this.chunkCounts.size;
  }
}
