import type { FilesApi, RawStorage } from "@statewalker/vcs-core";
import { dirname, joinPath } from "@statewalker/vcs-core";
import { deflate, inflate, slice } from "@statewalker/vcs-utils";

/**
 * Options for FileRawStorage
 */
export interface FileRawStorageOptions {
  /**
   * Whether to compress content with zlib before writing to disk.
   *
   * When true, content is ZLIB-deflated on store() and ZLIB-inflated on load().
   * This matches Git's on-disk format for loose objects.
   *
   * Default: true (for backward compatibility with existing Git repos)
   */
  compress?: boolean;
}

/**
 * File-based RawStorage with Git loose object structure
 *
 * Objects are stored in a two-level directory structure:
 * - First 2 characters of key -> directory name
 * - Remaining characters -> filename
 *
 * Example: key "abc123..." is stored at "basePath/ab/c123..."
 *
 * When compress is enabled (default), content is zlib-compressed on disk,
 * matching Git's standard loose object format.
 */
export class FileRawStorage implements RawStorage {
  private readonly compress: boolean;

  constructor(
    private readonly files: FilesApi,
    private readonly basePath: string,
    options?: FileRawStorageOptions,
  ) {
    this.compress = options?.compress ?? true;
  }

  private getPath(key: string): string {
    const prefix = key.substring(0, 2);
    const suffix = key.substring(2);
    return joinPath(this.basePath, prefix, suffix);
  }

  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.getPath(key);
    const dir = dirname(path);
    await this.files.mkdir(dir);
    if (this.compress) {
      await this.files.write(path, deflate(content, { raw: false }));
    } else {
      await this.files.write(path, content);
    }
  }

  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    const path = this.getPath(key);
    const stats = await this.files.stats(path);
    if (!stats) {
      throw new Error(`Key not found: ${key}`);
    }

    if (this.compress) {
      const decompressed = inflate(this.files.read(path), { raw: false });
      if (options?.start !== undefined || options?.end !== undefined) {
        const start = options.start ?? 0;
        const length = options.end !== undefined ? options.end - start : undefined;
        yield* slice(decompressed, start, length);
      } else {
        yield* decompressed;
      }
    } else if (options?.start !== undefined || options?.end !== undefined) {
      const start = options.start ?? 0;
      const end = options.end ?? stats.size ?? Infinity;
      yield* this.files.read(path, {
        start,
        length: end - start,
      });
    } else {
      yield* this.files.read(path);
    }
  }

  async has(key: string): Promise<boolean> {
    const path = this.getPath(key);
    const stats = await this.files.stats(path);
    return stats !== undefined && stats !== null;
  }

  async remove(key: string): Promise<boolean> {
    const path = this.getPath(key);
    const stats = await this.files.stats(path);
    if (!stats) return false;

    try {
      await this.files.remove(path);
      return true;
    } catch {
      return false;
    }
  }

  async *keys(): AsyncIterable<string> {
    try {
      const seenPrefixes = new Set<string>();
      for await (const prefixEntry of this.files.list(this.basePath)) {
        if (prefixEntry.kind !== "directory") continue;
        if (prefixEntry.name.length !== 2) continue;
        if (seenPrefixes.has(prefixEntry.name)) continue;
        seenPrefixes.add(prefixEntry.name);

        const prefixPath = joinPath(this.basePath, prefixEntry.name);
        try {
          for await (const suffixEntry of this.files.list(prefixPath)) {
            if (suffixEntry.kind !== "file") continue;
            yield prefixEntry.name + suffixEntry.name;
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    } catch {
      // Base path doesn't exist
    }
  }

  async size(key: string): Promise<number> {
    const path = this.getPath(key);
    const stats = await this.files.stats(path);
    return stats?.size ?? -1;
  }
}
