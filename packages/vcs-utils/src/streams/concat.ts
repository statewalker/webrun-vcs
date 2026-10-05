/**
 * Concatenate two Uint8Arrays into new array.
 *
 * Used by decoders for buffering partial entries at chunk boundaries.
 */
export function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
