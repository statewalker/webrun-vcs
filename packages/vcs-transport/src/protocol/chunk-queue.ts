/**
 * A byte queue for stream parsers (pkt-line readers).
 */

/**
 * Bytes received but not yet parsed, kept as the chunks they arrived in.
 *
 * Reading from the front copies only the bytes taken, so a stream of many small
 * packets, or one large packet in many small chunks, is decoded in linear time.
 */
export class ChunkQueue {
  private chunks: Uint8Array[] = [];
  /** Bytes of `chunks[0]` already consumed. */
  private offset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Put bytes back at the front, before everything queued. */
  unshift(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.offset > 0) {
      this.chunks[0] = (this.chunks[0] as Uint8Array).subarray(this.offset);
      this.offset = 0;
    }
    this.chunks.unshift(chunk);
    this.length += chunk.length;
  }

  /** Everything queued, as one copy; the queue is left empty. */
  drain(): Uint8Array<ArrayBuffer> {
    return this.take(this.length);
  }

  /** Copies of the first `n` bytes (n <= length), removed from the queue. */
  take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.chunks[0] as Uint8Array;
      const count = Math.min(n - at, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + count), at);
      at += count;
      this.offset += count;
      if (this.offset === head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.length -= n;
    return out;
  }

  /** The first four bytes as a string, without removing them (length >= 4). */
  peekHeader(): string {
    const head = this.chunks[0] as Uint8Array;
    if (head.length - this.offset >= 4) {
      return String.fromCharCode(...head.subarray(this.offset, this.offset + 4));
    }
    let s = "";
    let i = 0;
    let off = this.offset;
    while (s.length < 4) {
      const c = this.chunks[i] as Uint8Array;
      if (off >= c.length) {
        i++;
        off = 0;
        continue;
      }
      s += String.fromCharCode(c[off++] as number);
    }
    return s;
  }
}
