import { FossilChecksum } from "../../hash/fossil-checksum/index.js";
import type { Delta, DeltaRange } from "./types.js";

/**
 * Creates a delta from a source and target using the provided delta ranges.
 * This function converts DeltaRange instances into Delta instances with checksums.
 *
 * @param source - The source byte array
 * @param target - The target byte array
 * @param ranges - An iterable of DeltaRange instances
 * @returns A generator that yields Delta instances
 */
export function* createDelta(
  source: Uint8Array,
  target: Uint8Array,
  ranges: Iterable<DeltaRange>,
): Generator<Delta> {
  const checksumObj = new FossilChecksum();
  yield {
    type: "start",
    sourceLen: source.length,
    targetLen: target.length,
  };
  for (const r of ranges) {
    if (r.from === "source") {
      // COPY from source
      checksumObj.update(source.subarray(r.start, r.start + r.len), 0, r.len);
      yield {
        type: "copy",
        start: r.start,
        len: r.len,
      };
    } else {
      // LITERAL bytes from target
      const chunk = target.subarray(r.start, r.start + r.len);
      checksumObj.update(chunk, 0, chunk.length);
      yield {
        type: "insert",
        data: chunk,
      };
    }
  }

  // Yield checksum as the last message
  yield {
    type: "finish",
    checksum: checksumObj.finalize(),
  };
}
