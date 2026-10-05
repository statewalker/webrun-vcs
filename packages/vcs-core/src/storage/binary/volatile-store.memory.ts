/**
 * In-memory volatile content storage
 *
 * Simple implementation that buffers all content in memory.
 * Best for small content or when memory is not constrained.
 */

import type { VolatileContent, VolatileStore } from "./volatile-store.js";

/**
 * Memory-based volatile storage
 *
 * Stores content in memory arrays. The stored content can be
 * re-read multiple times until disposed.
 */
export class MemoryVolatileStore implements VolatileStore {
  /**
   * Store content stream temporarily in memory
   *
   * @param content Async iterable of content chunks
   * @returns Handle with size and ability to re-read content
   */
  async store(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<VolatileContent> {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for await (const chunk of content) {
      chunks.push(chunk);
      size += chunk.length;
    }

    let disposed = false;

    return {
      size,
      read(start = 0) {
        if (disposed) {
          throw new Error("VolatileContent already disposed");
        }
        return (async function* () {
          let skipped = 0;
          for (const c of chunks) {
            if (skipped + c.length <= start) {
              skipped += c.length;
              continue;
            }
            if (skipped < start) {
              const offset = start - skipped;
              yield c.subarray(offset);
              skipped = start;
            } else {
              yield c;
            }
          }
        })();
      },
      async dispose() {
        disposed = true;
        chunks.length = 0;
      },
    };
  }
}
