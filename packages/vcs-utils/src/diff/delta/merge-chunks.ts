/**
 * Merges multiple Uint8Array chunks from a generator into a single Uint8Array
 * @param chunks - Generator or iterable of Uint8Array chunks
 * @returns A single merged Uint8Array containing all chunks
 */
export function mergeChunks(chunks: Iterable<Uint8Array>): Uint8Array {
  const collected: Uint8Array[] = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    collected.push(chunk);
    totalLength += chunk.length;
  }

  if (collected.length === 0) {
    return new Uint8Array(0);
  }

  if (collected.length === 1) {
    return collected[0];
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of collected) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
