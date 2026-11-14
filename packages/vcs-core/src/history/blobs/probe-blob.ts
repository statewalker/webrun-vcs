/**
 * Size and binary checks for a blob, without loading it whole.
 *
 * Diff, merge and blame need a blob's whole content only for text they can work
 * on. `probeBlob` answers the two questions they ask first, the way git does:
 * is the blob larger than `core.bigFileThreshold`, and is it binary (a NUL byte
 * in its first 8000 bytes). The size comes from `Blobs.size` (an object header),
 * and the binary check reads only that prefix.
 */
import { RawText } from "@statewalker/vcs-utils/diff";
import { readPrefix } from "@statewalker/vcs-utils/streams";
import type { ObjectId } from "../../common/index.js";
import type { Blobs } from "./blobs.js";

/** git's `core.bigFileThreshold`: larger blobs are binary to diff and merge, and never deltified. */
export const DEFAULT_BIG_FILE_THRESHOLD = 50 * 2 ** 20;

/** Options for `probeBlob`. */
export interface ProbeBlobOptions {
  /** Blobs larger than this are binary and are not read at all. Default 50 MiB. */
  bigFileThreshold?: number;
  /**
   * Keep reading a text blob to its end and return it as `content`, so a caller
   * that needs text (diff, merge) reads it once: one stream, one delta
   * resolution for a packed blob. A binary blob is still read only up to the
   * first 8000 bytes. Default false: read only that prefix.
   */
  loadText?: boolean;
}

/** What `probeBlob` found. */
export interface BlobProbe {
  /** Size in bytes. */
  size: number;
  /** Over the threshold, or a NUL byte in the first 8000 bytes. */
  binary: boolean;
  /** Over the threshold (and so binary, and never read). */
  big: boolean;
  /** The whole blob, with `loadText` and only for text. */
  content?: Uint8Array;
}

/**
 * Check a blob's size and whether it is binary, reading at most its first 8000 bytes.
 *
 * @example
 * ```typescript
 * const probe = await probeBlob(history.blobs, id);
 * if (probe.binary) console.log("Binary files differ");
 * else diffText(await collect(await history.blobs.load(id))); // text under the threshold
 *
 * // or read text once:
 * const { binary, content } = await probeBlob(history.blobs, id, { loadText: true });
 * if (!binary) diffText(content);
 * ```
 *
 * @throws Error when the blob is missing
 */
export async function probeBlob(
  blobs: Blobs,
  id: ObjectId,
  options: ProbeBlobOptions = {},
): Promise<BlobProbe> {
  const threshold = options.bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD;
  const size = await blobs.size(id);
  if (size < 0) throw new Error(`Blob not found: ${id}`);
  if (size > threshold) return { size, binary: true, big: true };
  if (size === 0) {
    return options.loadText
      ? { size, binary: false, big: false, content: new Uint8Array(0) }
      : { size, binary: false, big: false };
  }
  const content = await blobs.load(id);
  if (!content) throw new Error(`Blob not found: ${id}`);
  if (!options.loadText) {
    const head = await readPrefix(content, RawText.BINARY_PROBE_LENGTH);
    return { size, binary: RawText.isBinary(head), big: false };
  }
  return readTextOnce(content, size);
}

/**
 * Read to the end, unless the first 8000 bytes show the blob is binary. Those
 * bytes are buffered on their own, so the full `size` is allocated only for text.
 */
async function readTextOnce(content: AsyncIterable<Uint8Array>, size: number): Promise<BlobProbe> {
  const probeLength = Math.min(RawText.BINARY_PROBE_LENGTH, size);
  const head = new Uint8Array(probeLength);
  let out: Uint8Array | undefined;
  let at = 0;
  for await (const chunk of content) {
    if (at + chunk.length > size) throw new Error(`Blob longer than its size ${size}`);
    if (out) {
      out.set(chunk, at);
      at += chunk.length;
      continue;
    }
    const taken = Math.min(chunk.length, probeLength - at);
    head.set(chunk.subarray(0, taken), at);
    at += taken;
    if (at < probeLength) continue;
    if (RawText.isBinary(head)) return { size, binary: true, big: false };
    out = new Uint8Array(size);
    out.set(head, 0);
    out.set(chunk.subarray(taken), at);
    at += chunk.length - taken;
  }
  if (at !== size || !out) {
    throw new Error(`Blob shorter than its size ${size}: ${at} bytes`);
  }
  return { size, binary: false, big: false, content: out };
}
