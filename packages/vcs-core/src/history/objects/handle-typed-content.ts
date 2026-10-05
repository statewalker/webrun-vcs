import { Sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../../common/id/index.js";
import type { VolatileContent, VolatileStore } from "../../storage/binary/volatile-store.js";
import { encodeObjectHeader } from "./object-header.js";
import type { ObjectTypeString } from "./object-types.js";

export async function handleTypedContent<T = ObjectId>({
  volatile,
  handle,
  content,
  type,
}: {
  volatile: VolatileStore;
  content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  type: ObjectTypeString;
  handle: (
    id: ObjectId, // Hash of the full content with header
    full: VolatileContent, // Content with header
  ) => Promise<T>;
}): Promise<T> {
  const original = await volatile.store(content);
  try {
    // Build the Git object: header + content, computing hash as we go
    const header = encodeObjectHeader(type, original.size);
    const readFullContent = async function* (offset = 0) {
      // Length of the block from the header
      const headerLen = Math.max(0, header.length - offset);
      if (headerLen > 0) {
        if (headerLen < header.length) {
          yield header.slice(offset, offset + headerLen);
        } else {
          yield header;
        }
      }
      // Shift of the first byte from the content
      const contentOffset = Math.max(0, offset - header.length);
      yield* original.read(contentOffset);
    };
    // ...existing code...
    const id = await getContentId(readFullContent());
    const full: VolatileContent = {
      size: header.length + original.size,
      read: readFullContent,
      dispose: async () => {},
    };
    return await handle(id, full);
  } finally {
    await original.dispose();
  }
}

async function getContentId(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
  const hasher = new Sha1();
  for await (const chunk of content) {
    hasher.update(chunk);
  }
  return bytesToHex(hasher.finalize());
}
