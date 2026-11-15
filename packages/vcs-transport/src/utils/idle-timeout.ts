/**
 * A stalled upload must not hold a server forever: these wrappers fail a read that brings
 * nothing for `ms` milliseconds.
 */

/** A read that brought no byte within the idle timeout. */
export class IdleTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`request idle for ${ms} ms`);
    this.name = "IdleTimeoutError";
  }
}

/**
 * `source`, failing with {@link IdleTimeoutError} when one chunk takes longer than `ms` to
 * come. `ms <= 0` (or undefined) returns `source` unchanged. On a timeout the source is asked
 * to close (`return`), which an async generator only does once its pending read settles: for
 * a `ReadableStream`, use {@link readStreamWithIdleTimeout}, which cancels it at once. There
 * is no overall deadline: a client sending a byte now and then keeps the request alive (the
 * request body limit bounds it).
 *
 * @example
 * ```ts
 * for await (const chunk of withIdleTimeout(body, 60_000)) consume(chunk);
 * ```
 */
export function withIdleTimeout<T>(
  source: AsyncIterable<T>,
  ms: number | undefined,
): AsyncIterable<T> {
  if (!ms || ms <= 0) return source;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const it = source[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<T>> {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, rejectIdle) => {
            timer = setTimeout(() => rejectIdle(new IdleTimeoutError(ms)), ms);
          });
          try {
            return await Promise.race([it.next(), idle]);
          } catch (error) {
            if (error instanceof IdleTimeoutError) {
              // do not wait for the stalled read: close the source in the background
              void Promise.resolve(it.return?.()).catch(() => {});
            }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          await it.return?.(value as never);
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

/** A stream read chunk by chunk, see {@link readStreamWithIdleTimeout}. */
export interface StreamChunks extends AsyncIterableIterator<Uint8Array> {
  /** Reads what is left and drops it (errors, the idle timeout included, end it quietly) */
  discard(): Promise<void>;
}

/**
 * Reads `stream` chunk by chunk; a read that brings nothing for `ms` milliseconds cancels the
 * stream (its source stops) and fails with {@link IdleTimeoutError}. The result iterates
 * itself: every `for await` over it continues where the last one stopped, and `discard()`
 * drains the rest (a request body nobody needs, so the client is not cut off mid-upload).
 *
 * @example
 * ```ts
 * const body = readStreamWithIdleTimeout(request.body, 60_000);
 * for await (const chunk of body) consume(chunk);
 * ```
 */
export function readStreamWithIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  ms: number | undefined,
): StreamChunks {
  const reader = stream.getReader();
  let finished = false;
  const finish = async (reason?: unknown) => {
    if (finished) return;
    finished = true;
    await reader.cancel(reason).catch(() => {});
  };
  const chunks: StreamChunks = {
    [Symbol.asyncIterator]() {
      return chunks;
    },
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (finished) return { done: true, value: undefined };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const read = reader.read();
        const result =
          ms && ms > 0
            ? await Promise.race([
                read,
                new Promise<never>((_, rejectIdle) => {
                  timer = setTimeout(() => rejectIdle(new IdleTimeoutError(ms)), ms);
                }),
              ])
            : await read;
        if (result.done) {
          finished = true;
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      } catch (error) {
        await finish(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      // a consumer that stops early (the pack ended): the rest stays readable for discard()
      return { done: true, value: undefined };
    },
    async discard(): Promise<void> {
      try {
        while (!(await chunks.next()).done) {
          // dropped
        }
      } catch {
        // over the limit, idle, or the client went away
      }
    },
  };
  return chunks;
}

/** A write the peer did not take within the write timeout (it stopped reading). */
export class WriteTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`peer took no data for ${ms} ms`);
    this.name = "WriteTimeoutError";
  }
}

/**
 * `write`, failing with {@link WriteTimeoutError} when one write is not taken within `ms` (a
 * peer that stopped reading: a full pipe or socket). After a timeout the connection is dead:
 * `onTimeout` is called once (to abort the underlying writer, which also fails the stalled
 * write) and every later write fails at once. `ms <= 0` (or undefined) returns `write`.
 *
 * @example
 * ```ts
 * const write = withWriteTimeout((d) => out.write(d), 600_000, (e) => out.abort(e));
 * ```
 */
export function withWriteTimeout(
  write: (data: Uint8Array) => void | Promise<void>,
  ms: number | undefined,
  onTimeout?: (error: WriteTimeoutError) => void,
): (data: Uint8Array) => void | Promise<void> {
  if (!ms || ms <= 0) return write;
  let dead: WriteTimeoutError | undefined;
  return async (data) => {
    if (dead) throw dead;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        dead ??= new WriteTimeoutError(ms);
        try {
          onTimeout?.(dead);
        } catch {
          // the writer is gone either way
        }
        reject(dead);
      }, ms);
    });
    const pending = Promise.resolve().then(() => write(data));
    pending.catch(() => {}); // fails after the timeout when the writer is aborted
    try {
      await Promise.race([pending, stalled]);
    } finally {
      clearTimeout(timer);
    }
  };
}
