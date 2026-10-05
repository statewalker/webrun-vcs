/**
 * File-based VolatileStore implementation
 *
 * Stores temporary content in files, allowing for memory-efficient
 * handling of large content that exceeds available memory.
 */

import type { FilesApi, VolatileContent, VolatileStore } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";

/**
 * File-based volatile storage
 *
 * Writes content to temporary files which can be re-read multiple times.
 * Files are deleted when dispose() is called.
 */
export class FileVolatileStore implements VolatileStore {
  private counter = 0;

  /**
   * Create file-based volatile store
   *
   * @param files FilesApi for file operations
   * @param tempDir Directory for temporary files
   */
  constructor(
    private readonly files: FilesApi,
    private readonly tempDir: string,
  ) {}

  /**
   * Store content stream temporarily
   */
  async store(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<VolatileContent> {
    const tempPath = joinPath(this.tempDir, `temp-${Date.now()}-${this.counter++}`);

    // Ensure temp directory exists
    await this.files.mkdir(this.tempDir);

    // Write all chunks to file
    await this.files.write(tempPath, content);
    const stats = await this.files.stats(tempPath);

    let disposed = !stats;
    const files = this.files;

    return {
      size: stats?.size ?? 0,
      read: async function* (start = 0): AsyncIterable<Uint8Array> {
        if (disposed) {
          throw new Error("VolatileContent already disposed");
        }
        if (start > 0) {
          yield* files.read(tempPath, { start });
        } else {
          yield* files.read(tempPath);
        }
      },
      dispose: async () => {
        if (!disposed) {
          disposed = true;
          try {
            await this.files.remove(tempPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      },
    };
  }
}

/**
 * Create a new file-based volatile store
 */
export function createFileVolatileStore(files: FilesApi, tempDir: string): FileVolatileStore {
  return new FileVolatileStore(files, tempDir);
}
