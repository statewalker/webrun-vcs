/**
 * Compressed RawStorage wrapper
 *
 * Wraps any RawStorage with zlib deflate/inflate compression.
 * Content is compressed on store() and decompressed on load().
 *
 * This is useful for Git-compatible loose object storage where
 * objects are stored compressed on disk.
 */

import { deflate, inflate, slice } from "@statewalker/vcs-utils";
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
   * The stored zlib stream does not record its length. For a git loose object
   * (`"<type> <size>\0" + content`, what this wrapper holds in a git object
   * directory) the size is the header's length plus the size it declares, so
   * only the start of the stream is inflated. Other content is inflated and
   * counted as it streams (never collected).
   *
   * @param key Storage key
   * @returns Uncompressed content size, or -1 if key not found or unreadable
   */
  async size(key: string): Promise<number> {
    if (!(await this.inner.has(key))) {
      return -1;
    }
    const it = inflate(this.inner.load(key), { raw: this.rawDeflate })[Symbol.asyncIterator]();
    let head: number[] | undefined = [];
    let total = 0;
    try {
      for (let r = await it.next(); !r.done; r = await it.next()) {
        total += r.value.length;
        if (!head) continue;
        for (const b of r.value.subarray(0, GIT_HEADER_MAX - head.length)) head.push(b);
        const header = parseGitHeader(head);
        if (header !== undefined) return header;
        if (head.length >= GIT_HEADER_MAX || head.includes(0)) head = undefined;
      }
      return total;
    } catch {
      return -1;
    } finally {
      await it.return?.();
    }
  }
}

/** "commit " plus 16 digits plus NUL fits. */
const GIT_HEADER_MAX = 32;

/** Header length plus declared size of a git object header in `bytes`, if they start with one. */
function parseGitHeader(bytes: number[]): number | undefined {
  const nul = bytes.indexOf(0);
  if (nul < 0) return undefined;
  const text = String.fromCharCode(...bytes.slice(0, nul));
  const m = /^(blob|tree|commit|tag) (0|[1-9][0-9]{0,15})$/.exec(text);
  if (!m) return undefined;
  return nul + 1 + Number(m[2]);
}
