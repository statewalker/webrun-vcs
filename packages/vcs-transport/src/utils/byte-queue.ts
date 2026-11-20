/**
 * A bounded queue of byte chunks between a writer that pushes and a reader that pulls: the
 * write side of every stream adapter whose transport takes an iterable (a webrun-streams
 * `Duplex`, a libp2p stream's `sink`).
 *
 * @example
 * ```ts
 * const queue = createByteQueue({ highWaterMark: 1 << 20 });
 * void transport.sink(queue.stream);   // the transport pulls
 * await queue.push(bytes);             // waits while a mebibyte is queued
 * queue.end();                         // the stream ends once drained
 * ```
 */

/** Options of {@link createByteQueue}. */
export interface ByteQueueOptions {
  /**
   * `push` returns a promise that waits once this many bytes are queued, until the reader
   * has taken the queue below it (default 1 MiB). A queue never holds more than this plus
   * one chunk.
   */
  highWaterMark?: number;
  /**
   * Small chunks waiting together leave as one chunk of at most this many bytes (default
   * 64 KiB; 0 keeps every chunk as pushed). A transport that confirms each chunk (one round
   * trip per chunk) then pays for 64 KiB, not for each pkt-line.
   */
  coalesce?: number;
}

/** What {@link createByteQueue} returns. */
export interface ByteQueue {
  /**
   * Queues a chunk (empty ones are dropped). Returns a promise while the queue is at its high
   * water mark, resolved once the reader has drained it below (or the queue ended); nothing
   * otherwise. The chunk is kept, not copied: do not change it afterwards. A push after
   * {@link end}, or once the reader stopped, is refused: a rejected promise (with the error
   * {@link end} was given, if any), never a silent drop. Writers waiting when the queue ends
   * with an error are rejected with it.
   */
  push(chunk: Uint8Array): Promise<void> | undefined;
  /**
   * Ends the stream once what is queued has been read; with `error`, the stream throws it
   * there, and waiting and later pushes reject with it (an error given after a clean end, or
   * after the reader stopped, still becomes the reason later pushes reject with).
   */
  end(error?: Error): void;
  /** The chunks, in order; ends after {@link end} and the queued chunks */
  readonly stream: AsyncGenerator<Uint8Array>;
  /** The bytes queued now */
  readonly queuedBytes: number;
  /** Whether {@link end} was called or the reader stopped */
  readonly ended: boolean;
}

/** Default {@link ByteQueueOptions.highWaterMark}. */
export const DEFAULT_BYTE_QUEUE_HIGH_WATER_MARK = 1 << 20;
/** Default {@link ByteQueueOptions.coalesce}. */
export const DEFAULT_BYTE_QUEUE_COALESCE = 64 * 1024;

/** A bounded push/pull queue of bytes; see {@link ByteQueue}. */
export function createByteQueue(options: ByteQueueOptions = {}): ByteQueue {
  const highWaterMark = Math.max(1, options.highWaterMark ?? DEFAULT_BYTE_QUEUE_HIGH_WATER_MARK);
  const coalesce = options.coalesce ?? DEFAULT_BYTE_QUEUE_COALESCE;
  const chunks: Uint8Array[] = [];
  let head = 0;
  let queued = 0;
  let ended = false;
  let failure: Error | undefined;
  let endCalled = false;
  let wakeReader: (() => void) | undefined;
  let writers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  const releaseWriters = (error?: Error) => {
    const waiting = writers;
    writers = [];
    for (const writer of waiting) {
      if (error) writer.reject(error);
      else writer.resolve();
    }
  };
  const refusal = (): Error =>
    failure ??
    new Error(endCalled ? "write after the end of the stream" : "the stream's reader stopped");
  const notifyReader = () => {
    const wake = wakeReader;
    wakeReader = undefined;
    wake?.();
  };

  const take = (): Uint8Array => {
    const first = chunks[head++] as Uint8Array;
    let out = first;
    if (coalesce > 0 && first.length < coalesce && head < chunks.length) {
      let size = first.length;
      let end = head;
      while (end < chunks.length && size + (chunks[end] as Uint8Array).length <= coalesce) {
        size += (chunks[end] as Uint8Array).length;
        end++;
      }
      if (end > head) {
        out = new Uint8Array(size);
        out.set(first, 0);
        let offset = first.length;
        for (; head < end; head++) {
          const next = chunks[head] as Uint8Array;
          out.set(next, offset);
          offset += next.length;
        }
      }
    }
    if (head > 1024 && head * 2 > chunks.length) {
      chunks.splice(0, head);
      head = 0;
    }
    queued -= out.length;
    if (queued < highWaterMark) releaseWriters();
    return out;
  };

  async function* read(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        if (head < chunks.length) {
          yield take();
          continue;
        }
        if (ended) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wakeReader = resolve;
        });
      }
    } finally {
      // the reader stopped (or the stream is over): nothing will be taken any more
      ended = true;
      const dropped = queued > 0;
      chunks.length = 0;
      head = 0;
      queued = 0;
      // writers whose chunks were thrown away hear so; the others were taken already
      releaseWriters(dropped ? refusal() : undefined);
    }
  }

  return {
    push(chunk) {
      if (ended) return Promise.reject(refusal());
      if (chunk.length === 0) return undefined;
      chunks.push(chunk);
      queued += chunk.length;
      notifyReader();
      if (queued < highWaterMark) return undefined;
      return new Promise<void>((resolve, reject) => writers.push({ resolve, reject }));
    },
    end(error) {
      if (error && !failure) {
        failure = error;
        releaseWriters(error);
      }
      endCalled = true;
      if (ended) return;
      ended = true;
      notifyReader();
      releaseWriters();
    },
    stream: read(),
    get queuedBytes() {
      return queued;
    },
    get ended() {
      return ended;
    },
  };
}
