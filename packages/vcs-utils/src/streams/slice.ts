export async function* slice(
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  start = 0,
  length: number = Infinity,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let done = false;
  if (start <= 0 && (length < 0 || length === Infinity)) {
    yield* stream;
  } else {
    for await (const chunk of stream) {
      if (done) {
        break;
      }

      const chunkLength = chunk.length;

      if (offset + chunkLength <= start) {
        // Skip this chunk
        offset += chunkLength;
        continue;
      }

      let sliceStart = 0;
      let sliceEnd = chunkLength;

      if (start !== undefined && offset < start) {
        sliceStart = start - offset;
      }

      if (length !== undefined) {
        const bytesLeft = length - (offset + sliceStart - (start || 0));
        if (bytesLeft <= 0) {
          done = true;
          break;
        }
        if (sliceStart + bytesLeft < chunkLength) {
          sliceEnd = sliceStart + bytesLeft;
          done = true;
        }
      }
      if (sliceStart > 0 || sliceEnd < chunkLength) {
        // Sliced chunk
        yield chunk.subarray(sliceStart, sliceEnd);
      } else {
        // Full chunk
        yield chunk;
      }
      offset += chunkLength;
    }
  }
}
