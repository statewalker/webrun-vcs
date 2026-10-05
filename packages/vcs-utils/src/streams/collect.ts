/**
 * Collect async iterable items into array.
 *
 * Used by tests and helper functions like entriesToCommit.
 */
export async function toArray<T>(input: Iterable<T> | AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

/**
 * Collect async stream chunks into single Uint8Array.
 *
 * Used by storage backends that cannot stream to their underlying storage
 * (e.g., MemoryRawStorage, SqlRawStorage).
 *
 * Use sparingly - prefer streaming where possible.
 */
export async function collect(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
