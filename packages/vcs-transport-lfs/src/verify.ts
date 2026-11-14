import { bytesToHex, createSha256 } from "@statewalker/vcs-utils/hash";
import type { ByteStream, ContentStore, ObjectDescriptor } from "@statewalker/webrun-content-store";
import { type ByteSource, chunksOf } from "./sha256.js";
import type { LfsPointer, LfsResolver } from "./types.js";

/** Thrown inside a hashed stream when it runs past the size it was promised. */
class SizeExceeded extends Error {
  constructor(limit: number) {
    super(`content exceeds the expected ${limit} bytes`);
  }
}

/**
 * Passes `content` through unchanged while hashing (SHA-256) and counting it.
 * `pointer()` gives the oid and size once the stream has been read to its end.
 * With `maxSize`, the stream throws as soon as it runs past that many bytes.
 */
export function hashing(
  content: ByteSource,
  maxSize?: number,
): { stream: ByteStream; pointer(): LfsPointer } {
  const h = createSha256();
  let size = 0;
  let result: LfsPointer | undefined;
  async function* stream(): ByteStream {
    for await (const chunk of chunksOf(content)) {
      size += chunk.length;
      if (maxSize !== undefined && size > maxSize) throw new SizeExceeded(maxSize);
      h.update(chunk);
      yield chunk;
    }
    result = { oid: bytesToHex(h.digest()), size };
  }
  return {
    stream: stream(),
    pointer() {
      if (!result) throw new Error("hashed stream was not read to its end");
      return result;
    },
  };
}

/** What {@link storeVerified} did: stored and recorded, or refused with a reason. */
export type LfsStoreResult =
  | { ok: true; descriptor: ObjectDescriptor }
  | { ok: false; reason: "sha256 mismatch" | "size mismatch" };

/**
 * Stores `content` while hashing it, then checks it against `expected`: the
 * SHA-256 must equal `expected.oid` and, when given, the byte count
 * `expected.size`. A stream longer than `expected.size` is cut off as soon as
 * it overruns, so no manifest is written for it (a server passes the request's
 * `content-length` here, so a `PUT` cannot write past what it declared).
 *
 * On a match the mapping is recorded. On a mismatch nothing is recorded and
 * nothing is removed: the refused object (or, after an overrun, its chunks)
 * stays in the store until its `gc` runs with the resolver's values as live
 * roots. It is never removed here because store ids are derived from content:
 * a peer sending the same bytes under a bogus oid gets the very id another,
 * honest transfer of those bytes may be verifying at that moment, and removing
 * it would leave that transfer's mapping pointing at nothing.
 *
 * @example
 * ```typescript
 * const res = await fetch(href);
 * const stored = await storeVerified(store, resolver, res.body, pointer);
 * if (!stored.ok) console.warn(stored.reason); // "sha256 mismatch" | "size mismatch"
 * ```
 */
export async function storeVerified(
  store: ContentStore,
  resolver: LfsResolver,
  content: ByteSource,
  expected: { oid: string; size?: number },
): Promise<LfsStoreResult> {
  const h = hashing(content, expected.size);
  let descriptor: ObjectDescriptor;
  try {
    descriptor = await store.put(h.stream);
  } catch (error) {
    if (error instanceof SizeExceeded) return { ok: false, reason: "size mismatch" };
    throw error;
  }
  const actual = h.pointer();
  const reason =
    expected.size !== undefined && actual.size !== expected.size
      ? "size mismatch"
      : actual.oid !== expected.oid
        ? "sha256 mismatch"
        : undefined;
  // Never removed on a mismatch (see above): the store's gc reclaims it.
  if (reason) return { ok: false, reason };
  await resolver.record(expected.oid, descriptor.id);
  return { ok: true, descriptor };
}
