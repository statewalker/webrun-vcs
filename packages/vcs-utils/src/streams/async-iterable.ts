/**
 * Check if input is async iterable.
 */
export function isAsyncIterable<T>(input: unknown): input is AsyncIterable<T> {
  return input !== null && typeof input === "object" && Symbol.asyncIterator in input;
}

/**
 * Normalize sync or async iterable to async iterable.
 *
 * Used by encode functions and store implementations to accept both
 * sync and async iterables uniformly.
 */
export function asAsyncIterable<T>(input: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  if (isAsyncIterable(input)) {
    return input;
  }
  // Convert sync iterable to async
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of input as Iterable<T>) {
        yield item;
      }
    },
  };
}
