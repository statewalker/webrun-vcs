import { FossilChecksum } from "../../hash/fossil-checksum/index.js";
import { getGitDeltaBaseSize, getGitDeltaResultSize } from "./git-delta-format.js";
import type { Delta } from "./types.js";

// Re-export Git delta size utilities
export { getGitDeltaBaseSize, getGitDeltaResultSize };

/** A git binary delta that is malformed or does not fit its base. */
export class DeltaError extends Error {
  override name = "DeltaError";
}

/**
 * Apply a git binary delta (pack format) to its base, with the bounds git's
 * patch-delta.c and JGit's BinaryDelta check.
 *
 * The header holds the base size and the result size (7-bit little-endian
 * varints); then come instructions: `1xxxxxxx` copies from the base (offset
 * bytes for bits 0-3, size bytes for bits 4-6, size 0 meaning 0x10000) and
 * `0nnnnnnn` inserts the next n bytes (n = 0 is reserved). The result size must be
 * within `maxSize`, and the instructions must produce exactly that many bytes. A result
 * above 64 KiB is allocated only after a first pass has checked every instruction: a small
 * delta can still describe a large result (a 1-byte copy yields 64 KiB), so readers of
 * untrusted packs pass `maxSize` (their maximum object size). A smaller result is
 * checked while it is written (`allocate` gives its buffer: a new one by default).
 *
 * @example
 * ```typescript
 * const result = applyGitDelta(base, delta); // throws DeltaError on a bad delta
 * ```
 */
export function applyGitDelta(
  base: Uint8Array,
  delta: Uint8Array,
  maxSize = Number.MAX_SAFE_INTEGER,
  allocate: (size: number) => Uint8Array = newBytes,
): Uint8Array {
  let p = 0;
  let baseSize = 0;
  for (let mul = 1; ; ) {
    if (p >= delta.length) throw new DeltaError("delta header truncated");
    const b = delta[p++] as number;
    baseSize += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) break;
    if (mul > 2 ** 49) throw new DeltaError("delta size too large");
  }
  let resultSize = 0;
  for (let mul = 1; ; ) {
    if (p >= delta.length) throw new DeltaError("delta header truncated");
    const b = delta[p++] as number;
    resultSize += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) break;
    if (mul > 2 ** 49) throw new DeltaError("delta size too large");
  }
  if (baseSize !== base.length) {
    throw new DeltaError(`delta base length mismatch: expected ${baseSize}, got ${base.length}`);
  }
  if (resultSize > maxSize) {
    throw new DeltaError(`delta result of ${resultSize} bytes exceeds the limit of ${maxSize}`);
  }
  const checkSize = (produced: number) => {
    if (produced !== resultSize) {
      throw new DeltaError(`delta result ${produced} bytes, declared ${resultSize}`);
    }
  };
  if (resultSize > CHECK_FIRST) checkSize(runDelta(base, delta, p, resultSize, undefined));
  const out = allocate(resultSize);
  checkSize(runDelta(base, delta, p, resultSize, out));
  return out;
}

/**
 * Copies up to this many bytes go byte by byte: below it a loop is cheaper than the view
 * `subarray` allocates for `set`.
 */
const SMALL_COPY = 64;

/** The number of bits set in a 7-bit value. */
function bitCount(v: number): number {
  v = v - ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (v + (v >> 4)) & 0x0f;
}

/** Results above this size are checked by a first pass before they are allocated. */
const CHECK_FIRST = 64 * 1024;

const newBytes = (size: number) => new Uint8Array(size);

/** Runs the instructions from `p`: checks them, writes into `out` if given; returns the bytes produced. */
function runDelta(
  base: Uint8Array,
  delta: Uint8Array,
  p: number,
  resultSize: number,
  out: Uint8Array | undefined,
): number {
  let o = 0;
  const end = delta.length;
  while (p < end) {
    const cmd = delta[p++] as number;
    if (cmd & 0x80) {
      // offset bytes for bits 0-3, size bytes for bits 4-6 (little-endian); integer shifts,
      // the offset's top byte multiplied so that it stays a positive 32-bit number
      if ((cmd & 0x7f) !== 0 && p + bitCount(cmd & 0x7f) > end) {
        throw new DeltaError(
          p + bitCount(cmd & 0x0f) > end ? "copy offset truncated" : "copy size truncated",
        );
      }
      let off = 0;
      let size = 0;
      if (cmd & 0x01) off = delta[p++] as number;
      if (cmd & 0x02) off |= (delta[p++] as number) << 8;
      if (cmd & 0x04) off |= (delta[p++] as number) << 16;
      if (cmd & 0x08) off = (off >>> 0) + (delta[p++] as number) * 0x1000000;
      if (cmd & 0x10) size = delta[p++] as number;
      if (cmd & 0x20) size |= (delta[p++] as number) << 8;
      if (cmd & 0x40) size |= (delta[p++] as number) << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length) {
        throw new DeltaError(`copy [${off}, ${off + size}) beyond base of ${base.length}`);
      }
      if (o + size > resultSize) throw new DeltaError("delta result longer than declared");
      if (out) {
        if (size <= SMALL_COPY) for (let k = 0; k < size; k++) out[o + k] = base[off + k] as number;
        else out.set(base.subarray(off, off + size), o);
      }
      o += size;
    } else if (cmd !== 0) {
      if (p + cmd > end) throw new DeltaError("insert truncated");
      if (o + cmd > resultSize) throw new DeltaError("delta result longer than declared");
      if (out) {
        if (cmd <= SMALL_COPY) for (let k = 0; k < cmd; k++) out[o + k] = delta[p + k] as number;
        else out.set(delta.subarray(p, p + cmd), o);
      }
      p += cmd;
      o += cmd;
    } else {
      throw new DeltaError("delta instruction 0 is reserved");
    }
  }
  return o;
}

/**
 * Apply delta instructions to a source buffer (Fossil format)
 *
 * Generator that yields chunks of the resulting object.
 * Validates target length and checksum.
 *
 * @param source The source/base data
 * @param deltas Delta instructions (Fossil format with start/copy/insert/finish)
 * @yields Chunks of the resulting data
 * @throws Error if target length doesn't match expected
 * @throws Error if checksum doesn't match
 */
export function* applyDelta(source: Uint8Array, deltas: Iterable<Delta>): Generator<Uint8Array> {
  const checksumObj = new FossilChecksum();
  let expectedChecksum: number | undefined;
  let targetLen = 0;
  let expectedTargetLen = 0;
  for (const d of deltas) {
    switch (d.type) {
      case "start": {
        expectedTargetLen = d.targetLen;
        continue;
      }
      case "finish": {
        expectedChecksum = d.checksum;
        continue;
      }
      case "insert": {
        // Literal block
        const chunk = d.data;
        if (chunk.length > 0) {
          targetLen += chunk.length;
          checksumObj.update(chunk, 0, chunk.length);
          yield chunk;
        }
        continue;
      }
      case "copy": {
        // Copy from source
        if (d.len > 0) {
          const chunk = source.subarray(d.start, d.start + d.len);
          checksumObj.update(chunk, 0, chunk.length);
          targetLen += d.len;
          yield chunk;
        }
        continue;
      }
    }
  }

  if (targetLen !== expectedTargetLen) {
    throw new Error(`Target length mismatch: expected ${expectedTargetLen}, got ${targetLen}`);
  }

  // Validate checksum (required for integrity)
  if (expectedChecksum === undefined) {
    throw new Error("No checksum provided in delta");
  }

  const actualChecksum = checksumObj.finalize();
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }
}
