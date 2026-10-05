import { decompressBlockPartial } from "../compression/compression/index.js";

/**
 * Buffered reader over an async iterator of byte chunks.
 *
 * Provides exact-byte-count reads on top of a chunk-based stream.
 * Buffers only what's needed for the current read — does not accumulate
 * the entire stream.
 *
 * Unlike `readBlock()` (which uses `for await...of` and terminates the
 * iterator on break), this class calls `iterator.next()` directly and
 * preserves leftover bytes in its internal buffer. Safe for repeated
 * sequential reads on a shared iterator.
 */
export class BufferedByteReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private iterator: AsyncIterator<Uint8Array>;
  private done = false;

  constructor(iterator: AsyncIterator<Uint8Array>) {
    this.iterator = iterator;
  }

  /** Pre-fill the buffer with leftover data (e.g., from a previous pipeline stage). */
  seed(data: Uint8Array): void {
    if (data.length === 0) return;
    this.buffer = data;
  }

  /** Ensure at least `n` bytes are in the buffer by reading from the iterator. */
  private async ensureBytes(n: number): Promise<void> {
    while (this.buffer.length < n && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
  }

  /** Read exactly `n` bytes. Throws if stream ends prematurely. */
  async readExact(n: number): Promise<Uint8Array> {
    await this.ensureBytes(n);
    if (this.buffer.length < n) {
      throw new Error(`Unexpected end of stream: wanted ${n} bytes, have ${this.buffer.length}`);
    }
    const result = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return result;
  }

  /**
   * Read one zlib-compressed block from the stream.
   *
   * Accumulates bytes until `decompressBlockPartial` succeeds, which tells
   * exactly how many compressed bytes were consumed. Returns those bytes.
   *
   * @param expectedSize - Expected decompressed size (for validation)
   */
  async readCompressedObject(expectedSize: number): Promise<Uint8Array> {
    const MIN_CHUNK = 64;

    if (this.buffer.length === 0) {
      await this.ensureBytes(MIN_CHUNK);
    }

    while (true) {
      if (this.buffer.length === 0 && this.done) {
        throw new Error("Unexpected end of stream during compressed object");
      }

      try {
        const result = await decompressBlockPartial(this.buffer);

        if (result.data.length !== expectedSize) {
          throw new Error(
            `Decompression size mismatch: expected ${expectedSize}, got ${result.data.length}`,
          );
        }

        const compressed = this.buffer.slice(0, result.bytesRead);
        this.buffer = this.buffer.subarray(result.bytesRead);
        return compressed;
      } catch {
        // Not enough data — read more from the stream
        if (this.done) {
          throw new Error("Incomplete compressed data in stream");
        }
        await this.ensureBytes(this.buffer.length + MIN_CHUNK);
      }
    }
  }

  /**
   * Read one zlib-compressed block from the stream, yield decompressed content.
   *
   * Same incremental accumulation as `readCompressedObject()`, but yields
   * the decompressed data instead of returning compressed bytes.
   *
   * @param expectedSize - Expected decompressed size (for validation)
   */
  async *readDecompressed(expectedSize: number): AsyncGenerator<Uint8Array> {
    const MIN_CHUNK = 64;

    if (this.buffer.length === 0) {
      await this.ensureBytes(MIN_CHUNK);
    }

    while (true) {
      if (this.buffer.length === 0 && this.done) {
        throw new Error("Unexpected end of stream during compressed object");
      }

      let result: Awaited<ReturnType<typeof decompressBlockPartial>>;
      try {
        result = await decompressBlockPartial(this.buffer);
      } catch {
        // Decompression failed — likely not enough data, read more
        if (this.done) {
          throw new Error("Incomplete compressed data in stream");
        }
        await this.ensureBytes(this.buffer.length + MIN_CHUNK);
        continue;
      }

      if (result.data.length !== expectedSize) {
        throw new Error(
          `Decompression size mismatch: expected ${expectedSize}, got ${result.data.length}`,
        );
      }

      this.buffer = this.buffer.subarray(result.bytesRead);
      yield result.data;
      return;
    }
  }

  /** Returns any unread buffered bytes. */
  getLeftover(): Uint8Array {
    return this.buffer;
  }

  /** Whether the underlying iterator has ended. */
  get isExhausted(): boolean {
    return this.done && this.buffer.length === 0;
  }
}
