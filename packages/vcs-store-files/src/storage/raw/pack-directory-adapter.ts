/**
 * Read-only RawStorage adapter for PackDirectory
 *
 * Wraps a PackDirectory as a RawStorage so it can be used as a
 * fallback in CompositeRawStorage. Store and remove operations
 * are not supported (packs are immutable).
 *
 * PackDirectory.loadRaw() returns content with Git headers
 * ("type size\0content"), which is the same format that
 * GitObjectStore expects from its underlying RawStorage.
 *
 * Note: The PackDirectory must be initialized (scan() called)
 * before the adapter is used.
 */

import type { ObjectId, RawStorage } from "@statewalker/vcs-core";
import type { PackDirectory } from "../../pack/pack-directory.js";

/**
 * Read-only RawStorage backed by pack files
 *
 * @example
 * ```typescript
 * const packDir = new PackDirectory({ files, basePath: "objects/pack" });
 * await packDir.scan();
 * const adapter = new PackDirectoryAdapter(packDir);
 * const composite = new CompositeRawStorage(looseStorage, [adapter]);
 * ```
 */
export class PackDirectoryAdapter implements RawStorage {
  constructor(private readonly packDir: PackDirectory) {}

  /**
   * Not supported — pack files are read-only
   */
  async store(_key: string, _content: AsyncIterable<Uint8Array>): Promise<void> {
    throw new Error("PackDirectoryAdapter is read-only");
  }

  /**
   * Load object from pack files (with Git headers)
   */
  async *load(key: string): AsyncIterable<Uint8Array> {
    const data = await this.packDir.loadRaw(key as ObjectId);
    if (!data) {
      throw new Error(`Key not found: ${key}`);
    }
    yield data;
  }

  /**
   * Check if object exists in any pack
   */
  async has(key: string): Promise<boolean> {
    return this.packDir.has(key as ObjectId);
  }

  /**
   * Not supported — pack objects cannot be individually removed
   */
  async remove(_key: string): Promise<boolean> {
    return false;
  }

  /**
   * List all object IDs across all packs
   */
  async *keys(): AsyncIterable<string> {
    yield* this.packDir.listObjects();
  }

  /**
   * Get object size by loading from pack
   *
   * Returns the full Git object size (header + content) since that's
   * what loadRaw() returns. Returns -1 if not found.
   */
  async size(key: string): Promise<number> {
    const data = await this.packDir.loadRaw(key as ObjectId);
    return data ? data.length : -1;
  }
}
