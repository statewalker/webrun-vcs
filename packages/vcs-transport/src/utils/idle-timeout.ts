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
 * come. `ms <= 0` (or undefined) returns `source` unchanged. The source is closed (`return`)
 * on a timeout.
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
