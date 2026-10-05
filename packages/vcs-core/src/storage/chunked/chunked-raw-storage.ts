import type { RawStorage } from "../raw/raw-storage.js";
import type { ChunkAccess, ChunkMetadata } from "./chunk-access.js";

/**
 * Default chunk size: 1MB
 *
 * This is a reasonable default that:
 * - Fits within most SQL blob column limits
 * - Is small enough to stream efficiently
 * - Is large enough to minimize chunk count overhead
 */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB

/**
 * RawStorage implementation using chunk-based storage
 *
 * Splits large content into fixed-size chunks and stores them
 * via a ChunkAccess backend. This enables storage of arbitrarily
 * large content in backends with value size limits.
 *
 * Metadata (total size, chunk count) is stored as a special chunk
 * at a separate metadata key.
 */
export class ChunkedRawStorage implements RawStorage {
  private readonly chunkSize: number;

  /**
   * Create chunked storage
   *
   * @param access Chunk storage backend
   * @param chunkSize Size of each chunk in bytes (default 1MB)
   */
  constructor(
    private readonly access: ChunkAccess,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {
    if (chunkSize <= 0) {
      throw new Error("Chunk size must be positive");
    }
    this.chunkSize = chunkSize;
  }

  /**
   * Store content by splitting into chunks
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    // First, remove any existing chunks for this key
    await this.access.removeChunks(key);
    await this.access.removeChunks(this.metadataKey(key));

    let chunkIndex = 0;
    let totalSize = 0;
    let buffer = new Uint8Array(this.chunkSize);
    let bufferOffset = 0;

    for await (const inputChunk of content) {
      let inputOffset = 0;

      while (inputOffset < inputChunk.length) {
        // How much can we copy into the current buffer?
        const remaining = this.chunkSize - bufferOffset;
        const toCopy = Math.min(remaining, inputChunk.length - inputOffset);

        // Copy to buffer
        buffer.set(inputChunk.subarray(inputOffset, inputOffset + toCopy), bufferOffset);
        bufferOffset += toCopy;
        inputOffset += toCopy;
        totalSize += toCopy;

        // If buffer is full, store the chunk
        if (bufferOffset === this.chunkSize) {
          await this.access.storeChunk(key, chunkIndex, buffer);
          chunkIndex++;
          buffer = new Uint8Array(this.chunkSize);
          bufferOffset = 0;
        }
      }
    }

    // Store any remaining data in the last chunk
    if (bufferOffset > 0) {
      await this.access.storeChunk(key, chunkIndex, buffer.subarray(0, bufferOffset));
      chunkIndex++;
    }

    // Store metadata
    await this.storeMetadata(key, {
      totalSize,
      chunkCount: chunkIndex,
      chunkSize: this.chunkSize,
    });
  }

  /**
   * Load content, optionally with range
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    const metadata = await this.loadMetadata(key);
    if (!metadata) {
      throw new Error(`Key not found: ${key}`);
    }

    const start = options?.start ?? 0;
    const end = options?.end ?? metadata.totalSize;

    // Validate range
    if (start < 0 || start > metadata.totalSize) {
      throw new Error(`Invalid start offset: ${start}`);
    }
    if (end < start || end > metadata.totalSize) {
      throw new Error(`Invalid end offset: ${end}`);
    }

    // No data to return
    if (start === end) {
      return;
    }

    // Calculate which chunks we need
    const startChunk = Math.floor(start / this.chunkSize);
    const endChunk = Math.floor((end - 1) / this.chunkSize);

    for (let i = startChunk; i <= endChunk; i++) {
      const chunk = await this.access.loadChunk(key, i);

      // Calculate the portion of this chunk to yield
      const chunkStart = i * this.chunkSize;

      // Offset within this chunk
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.length, end - chunkStart);

      if (sliceStart < sliceEnd) {
        yield chunk.subarray(sliceStart, sliceEnd);
      }
    }
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    return this.access.hasKey(this.metadataKey(key));
  }

  /**
   * Remove all chunks for a key
   */
  async remove(key: string): Promise<boolean> {
    const hadMetadata = await this.access.hasKey(this.metadataKey(key));
    // Remove data chunks
    await this.access.removeChunks(key);
    // Remove metadata
    await this.access.removeChunks(this.metadataKey(key));
    return hadMetadata;
  }

  /**
   * List all keys
   */
  async *keys(): AsyncIterable<string> {
    // Return keys that have metadata (filter out metadata keys themselves)
    const metaSuffix = ":meta";
    for await (const key of this.access.keys()) {
      if (key.endsWith(metaSuffix)) {
        yield key.slice(0, -metaSuffix.length);
      }
    }
  }

  /**
   * Get total content size
   */
  async size(key: string): Promise<number> {
    const metadata = await this.loadMetadata(key);
    return metadata?.totalSize ?? -1;
  }

  // --- Metadata handling ---

  private metadataKey(key: string): string {
    return `${key}:meta`;
  }

  private async storeMetadata(key: string, metadata: ChunkMetadata): Promise<void> {
    const json = JSON.stringify(metadata);
    const data = new TextEncoder().encode(json);
    await this.access.storeChunk(this.metadataKey(key), 0, data);
  }

  private async loadMetadata(key: string): Promise<ChunkMetadata | undefined> {
    try {
      const data = await this.access.loadChunk(this.metadataKey(key), 0);
      const json = new TextDecoder().decode(data);
      return JSON.parse(json) as ChunkMetadata;
    } catch {
      return undefined;
    }
  }
}
