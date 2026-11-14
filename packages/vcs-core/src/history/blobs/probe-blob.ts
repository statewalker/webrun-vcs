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
}

/** What `probeBlob` found. */
export interface BlobProbe {
  /** Size in bytes. */
  size: number;
  /** Over the threshold, or a NUL byte in the first 8000 bytes. */
  binary: boolean;
  /** Over the threshold (and so binary, and never read). */
  big: boolean;
}

/**
 * Check a blob's size and whether it is binary, reading at most its first 8000 bytes.
 *
 * @example
 * ```typescript
 * const probe = await probeBlob(history.blobs, id);
 * if (probe.binary) console.log("Binary files differ");
 * else diffText(await collect(await history.blobs.load(id))); // text under the threshold
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
  if (size === 0) return { size, binary: false, big: false };
  const content = await blobs.load(id);
  if (!content) throw new Error(`Blob not found: ${id}`);
  const head = await readPrefix(content, RawText.BINARY_PROBE_LENGTH);
  return { size, binary: RawText.isBinary(head), big: false };
}
