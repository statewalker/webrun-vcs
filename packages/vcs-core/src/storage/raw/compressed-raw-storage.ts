/**
 * Compressed RawStorage wrapper
 *
 * Wraps any RawStorage with zlib deflate/inflate compression.
 * Content is compressed on store() and decompressed on load().
 *
 * This is useful for Git-compatible loose object storage where
 * objects are stored compressed on disk.
 */

import { deflate, inflate, slice, toArray } from "@statewalker/vcs-utils";
import type { RawStorage } from "./raw-storage.js";

/**
 * Options for CompressedRawStorage
 */
export interface CompressedRawStorageOptions {
  /**
   * Use raw DEFLATE (no zlib header) instead of ZLIB format.
   * Git uses ZLIB format (raw: false), which is the default.
   */
  raw?: boolean;
}

/**
 * RawStorage wrapper that adds zlib compression
 *
 * Compresses content before delegating to the underlying store.
 * Decompresses content when loading from the underlying store.
 *
 * Example usage for Git loose objects:
 * ```typescript
 * const files = new FileRawStorage(filesApi, ".git/objects");
 * const compressed = new CompressedRawStorage(files);
 * // Objects are now stored compressed in .git/objects/XX/YYYY...
 * ```
 */
export class CompressedRawStorage implements RawStorage {
  private readonly rawDeflate: boolean;

  /**
   * Create a compressed raw storage wrapper
   *
   * @param inner The underlying store to wrap
   * @param options Compression options
   */
  constructor(
    private readonly inner: RawStorage,
    options?: CompressedRawStorageOptions,
  ) {
    this.rawDeflate = options?.raw ?? false;
  }

  /**
   * Store byte stream with compression
   *
   * Content is deflated before being stored in the underlying store.
   *
   * @param key Storage key
   * @param content Uncompressed content stream
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const compressed = deflate(content, { raw: this.rawDeflate });
    await this.inner.store(key, compressed);
  }

  /**
   * Load byte stream with decompression
   *
   * Content is inflated after loading from the underlying store.
   *
   * @param key Storage key
   * @param options Range options (applied to decompressed content)
   * @returns Decompressed content stream
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    // Load compressed data from underlying store
    const compressed = this.inner.load(key);

    // Decompress
    const decompressed = inflate(compressed, { raw: this.rawDeflate });

    // Apply range if specified
    if (options?.start !== undefined || options?.end !== undefined) {
      const start = options.start ?? 0;
      const length = options.end !== undefined ? options.end - start : undefined;
      yield* slice(decompressed, start, length);
    } else {
      yield* decompressed;
    }
  }

  /**
   * Check if key exists in underlying store
   */
  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  /**
   * Remove content by key from underlying store
   */
  async remove(key: string): Promise<boolean> {
    return this.inner.remove(key);
  }

  /**
   * List all keys from underlying store
   */
  async *keys(): AsyncIterable<string> {
    yield* this.inner.keys();
  }

  /**
   * Get uncompressed content size for a key
   *
   * Note: This requires reading and decompressing the content to get the
   * actual uncompressed size. For performance, consider caching sizes
   * if you need to call this frequently.
   *
   * @param key Storage key
   * @returns Uncompressed content size, or -1 if key not found
   */
  async size(key: string): Promise<number> {
    if (!(await this.inner.has(key))) {
      return -1;
    }
    // Must decompress to get actual size
    try {
      const chunks = await toArray(this.load(key));
      return chunks.reduce((total, chunk) => total + chunk.length, 0);
    } catch {
      return -1;
    }
  }
}
