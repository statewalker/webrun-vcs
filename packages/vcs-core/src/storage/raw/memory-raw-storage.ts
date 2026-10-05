import { slice } from "@statewalker/vcs-utils";
import type { RawStorage } from "./raw-storage.js";

/**
 * In-memory RawStorage implementation
 *
 * Stores content in a Map for testing and temporary storage.
 */
export class MemoryRawStorage implements RawStorage {
  private readonly data = new Map<string, Uint8Array[]>();

  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }
    this.data.set(key, chunks);
  }

  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    const chunks = this.data.get(key);
    if (!chunks) {
      throw new Error(`Key not found: ${key}`);
    }

    if (options?.start !== undefined || options?.end !== undefined) {
      const start = options.start ?? 0;
      const length = options.end !== undefined ? options.end - start : undefined;
      yield* slice(chunks, start, length);
    } else {
      yield* chunks;
    }
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async remove(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async *keys(): AsyncIterable<string> {
    yield* this.data.keys();
  }

  async size(key: string): Promise<number> {
    const chunks = this.data.get(key);
    if (!chunks) return -1;
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  /** Clear all stored data (for testing) */
  clear(): void {
    this.data.clear();
  }

  /** Get number of stored items (for testing) */
  get count(): number {
    return this.data.size;
  }
}
