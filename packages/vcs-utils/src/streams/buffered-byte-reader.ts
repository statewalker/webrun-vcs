import { createInflater, TruncatedStreamError } from "../compression/compression/index.js";

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
  /** An error found while skipping the rest of a block the consumer abandoned. */
  private failure: unknown;

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
    this.checkFailure();
    await this.ensureBytes(n);
    if (this.buffer.length < n) {
      throw new Error(`Unexpected end of stream: wanted ${n} bytes, have ${this.buffer.length}`);
    }
    const result = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return result;
  }

  /**
   * Read one zlib-compressed block from the stream and return its compressed
   * bytes, exactly: the reader is left on the first byte after the block.
   *
   * Each chunk is pulled once and inflated once, and nothing past the block's
   * last chunk is pulled. Throws `TruncatedStreamError` if the stream ends inside
   * the block and `InflateError` if the block is corrupt.
   *
   * @param expectedSize - Expected decompressed size (for validation)
   */
  async readCompressedObject(expectedSize: number): Promise<Uint8Array> {
    const compressed: Uint8Array[] = [];
    let size = 0;
    for await (const out of this.inflateBlock(compressed)) {
      for (const piece of out) size += piece.length;
    }
    checkSize(expectedSize, size);
    return concatBytes(compressed);
  }

  /**
   * Read one zlib-compressed block from the stream and yield its content in
   * pieces as it inflates, so a large object is never held whole.
   *
   * Same guarantees as `readCompressedObject()`. Stopping early (`break`) is
   * safe: the rest of the block is read and discarded, so the reader is left on
   * the first byte after it. If that rest turns out truncated or corrupt, the
   * next read throws the error.
   *
   * @param expectedSize - Expected decompressed size (for validation)
   */
  async *readDecompressed(expectedSize: number): AsyncGenerator<Uint8Array> {
    // Output is held back by one push: a stream found short or of the wrong size
    // is rejected before the pieces that belong to the failing push are yielded,
    // so an object that arrives in one chunk is validated before any of it is.
    let held: Uint8Array[] = [];
    let size = 0;
    for await (const out of this.inflateBlock()) {
      yield* held;
      held = out;
      for (const piece of out) size += piece.length;
      if (size > expectedSize) checkSize(expectedSize, size);
    }
    checkSize(expectedSize, size);
    yield* held;
  }

  /**
   * Inflate one zlib stream from the buffer and iterator, yielding the output of
   * each push; collects the stream's compressed bytes if asked.
   */
  private async *inflateBlock(compressed?: Uint8Array[]): AsyncGenerator<Uint8Array[]> {
    this.checkFailure();
    const inf = createInflater();
    let finished = false;
    let failed = false;
    /** Pull the next chunk if needed and push it; returns the push result. */
    const step = async () => {
      while (this.buffer.length === 0) {
        const { value, done } = this.done
          ? { value: undefined, done: true }
          : await this.iterator.next();
        if (done || !value) {
          this.done = true;
          throw new TruncatedStreamError(
            "Incomplete compressed data in stream: it ended before the end of the zlib stream",
          );
        }
        this.buffer = value;
      }
      const r = inf.push(this.buffer);
      compressed?.push(this.buffer.subarray(0, r.consumed));
      this.buffer = this.buffer.subarray(r.consumed);
      finished = r.done;
      return r;
    };
    try {
      while (!finished) yield (await step()).out;
    } catch (e) {
      failed = true;
      inf.abort();
      throw e;
    } finally {
      // The consumer stopped early: read the rest of the block, discarding its
      // output, so the reader still ends up on the first byte after it.
      if (!finished && !failed) {
        try {
          while (!finished) await step();
        } catch (e) {
          // No throw from `finally`: the next read reports it instead.
          inf.abort();
          this.failure = e;
        }
      }
    }
  }

  private checkFailure(): void {
    if (this.failure !== undefined) throw this.failure;
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

function checkSize(expected: number, actual: number): void {
  if (actual !== expected) {
    throw new Error(`Decompression size mismatch: expected ${expected}, got ${actual}`);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0].slice();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
