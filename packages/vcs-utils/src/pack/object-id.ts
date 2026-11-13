/**
 * Git object ids: sha1("<type> <size>\0" + content).
 *
 * `computeObjectId` hashes bytes already in memory; `computeObjectIdFromStream`
 * hashes content as it streams past, in one pass and without retaining it. The
 * stream form needs the size up front (from file stats, a pack entry header or
 * Content-Length), because the header that starts the hash carries it.
 */
import { createSha1 } from "../hash/hasher/index.js";
import { sha1 } from "../hash/sha1/index.js";
import { bytesToHex } from "../hash/utils/index.js";

/** Thrown when a stream's length differs from the size declared for it. */
export class SizeMismatchError extends Error {
  /**
   * @param declared the size the caller announced
   * @param actual the bytes the stream produced; above `declared` when it overran
   *   (counted up to the first chunk that crossed the size)
   */
  constructor(
    readonly declared: number,
    readonly actual: number,
  ) {
    super(
      actual > declared
        ? `declared size ${declared} but stream produced more (at least ${actual}) bytes`
        : `declared size ${declared} but stream produced ${actual} bytes`,
    );
    this.name = "SizeMismatchError";
  }
}

const encoder = new TextEncoder();

/**
 * Above this size Web Crypto's native SHA-1 wins even after copying header and
 * content into one buffer (64 MiB: 93 ms against noble's 349 ms on Node 24);
 * below it the async round trip costs more than the hash (100k small objects:
 * noble 443 ms, Web Crypto 3.7 s).
 */
const NATIVE_THRESHOLD = 64 * 1024;

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
  const header = encoder.encode(`${typeStr} ${content.length}\0`);
  if (content.length >= NATIVE_THRESHOLD && hasWebCrypto()) {
    const full = new Uint8Array(header.length + content.length);
    full.set(header, 0);
    full.set(content, header.length);
    return bytesToHex(await sha1(full));
  }
  return bytesToHex(createSha1().update(header).update(content).digest());
}

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === "function";
}

/**
 * Compute a git object id from streamed content of a declared size.
 *
 * Rejects with `SizeMismatchError` when the stream ends early, and as soon as it
 * produces more than `size` bytes (the rest is not pulled).
 *
 * @example
 * ```typescript
 * const size = (await files.stats(path))?.size;
 * if (size === undefined) throw new Error(`no such file: ${path}`);
 * const id = await computeObjectIdFromStream("blob", size, files.read(path));
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
    if (seen > size) throw new SizeMismatchError(size, seen);
    hasher.update(chunk);
  }
  if (seen !== size) throw new SizeMismatchError(size, seen);
  return bytesToHex(hasher.digest());
}
