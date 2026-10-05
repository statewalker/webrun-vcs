import { newByteSplitter, readHeader } from "@statewalker/vcs-utils/streams";
import { parseHeader } from "./object-header.js";
import type { GitObjectHeader } from "./object-store.js";

export async function loadWithHeader(
  raw: AsyncIterable<Uint8Array>,
): Promise<[GitObjectHeader, AsyncGenerator<Uint8Array>]> {
  const [firstChunk, it] = await readHeader(raw, newByteSplitter(0x00));
  try {
    if (!firstChunk) {
      // Close the iterator to free resources
      throw new Error(`Object not found or empty`);
    }
    const parsed = parseHeader(firstChunk);
    return [
      {
        type: parsed.type,
        size: parsed.size,
      },
      it,
    ];
  } catch (e) {
    await it?.return?.(void 0);
    throw e;
  }
}
