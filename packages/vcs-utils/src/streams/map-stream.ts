/**
 * Maps items from an async or sync iterable using a transform function.
 */
export async function* mapStream<T, U>(
  iterable: AsyncIterable<T> | Iterable<T>,
  fn: (item: T) => U,
): AsyncGenerator<U> {
  for await (const item of iterable) {
    yield fn(item);
  }
}
