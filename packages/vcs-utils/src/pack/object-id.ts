/**
 * Git object ids: sha1("<type> <size>\0" + content).
 *
 * `computeObjectId` hashes bytes already in memory; `computeObjectIdFromStream`
 * hashes content as it streams past, in one pass and without retaining it. The
 * stream form needs the size up front (from file stats, a pack entry header or
 * Content-Length), because the header that starts the hash carries it.
 */
import { createSha1 } from "../hash/hasher/index.js";
import { bytesToHex } from "../hash/utils/index.js";

/** Thrown when a stream's length differs from the size declared for it. */
export class SizeMismatchError extends Error {
  /**
   * @param declared the size the caller announced
   * @param actual the bytes the stream produced, or -1 when it overran
   */
  constructor(
    readonly declared: number,
    readonly actual: number,
  ) {
    super(`declared size ${declared} but stream produced ${actual === -1 ? "more" : actual} bytes`);
    this.name = "SizeMismatchError";
  }
}

const encoder = new TextEncoder();

/**
 * Compute a git object id from content in memory.
 *
 * @example
 * ```typescript
 * await computeObjectId("blob", new TextEncoder().encode("hello\n"));
 * // "ce013625030ba8dba906f756967f9e9ca394464a"
 * ```
 */
export async function computeObjectId(typeStr: string, content: Uint8Array): Promise<string> {
  return bytesToHex(
    createSha1()
      .update(encoder.encode(`${typeStr} ${content.length}\0`))
      .update(content)
      .digest(),
  );
}

/**
 * Compute a git object id from streamed content of a declared size.
 *
 * Rejects with `SizeMismatchError` when the stream ends early, and as soon as it
 * produces more than `size` bytes (the rest is not pulled).
 *
 * @example
 * ```typescript
 * const stats = await files.stats(path);
 * const id = await computeObjectIdFromStream("blob", stats.size, files.read(path));
 * ```
 */
export async function computeObjectIdFromStream(
  typeStr: string,
  size: number,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`object size must be a non-negative safe integer, got ${size}`);
  }
  const hasher = createSha1().update(encoder.encode(`${typeStr} ${size}\0`));
  let seen = 0;
  for await (const chunk of content) {
    seen += chunk.length;
    if (seen > size) throw new SizeMismatchError(size, -1);
    hasher.update(chunk);
  }
  if (seen !== size) throw new SizeMismatchError(size, seen);
  return bytesToHex(hasher.digest());
}
