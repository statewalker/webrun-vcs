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
 * `0nnnnnnn` inserts the next n bytes (n = 0 is reserved). A first pass checks
 * every instruction and sums the output; only when that equals the declared
 * result size, and the size is within `maxSize`, is the result allocated. A
 * small delta can still describe a large result (a 1-byte copy yields 64 KiB),
 * so readers of untrusted packs pass `maxSize` (their maximum object size).
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
): Uint8Array {
  let p = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (p >= delta.length) throw new DeltaError("delta header truncated");
      const b = delta[p++] as number;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return v;
      if (mul > 2 ** 49) throw new DeltaError("delta size too large");
    }
  };
  const baseSize = varint();
  const resultSize = varint();
  if (baseSize !== base.length) {
    throw new DeltaError(`delta base length mismatch: expected ${baseSize}, got ${base.length}`);
  }
  if (resultSize > maxSize) {
    throw new DeltaError(`delta result of ${resultSize} bytes exceeds the limit of ${maxSize}`);
  }
  const start = p;
  const run = (out: Uint8Array | undefined): number => {
    p = start;
    let o = 0;
    while (p < delta.length) {
      const cmd = delta[p++] as number;
      if (cmd & 0x80) {
        let off = 0;
        let size = 0;
        for (let i = 0; i < 4; i++) {
          if (cmd & (1 << i)) {
            if (p >= delta.length) throw new DeltaError("copy offset truncated");
            off += (delta[p++] as number) * 2 ** (8 * i);
          }
        }
        for (let i = 0; i < 3; i++) {
          if (cmd & (0x10 << i)) {
            if (p >= delta.length) throw new DeltaError("copy size truncated");
            size += (delta[p++] as number) << (8 * i);
          }
        }
        if (size === 0) size = 0x10000;
        if (off + size > base.length) {
          throw new DeltaError(`copy [${off}, ${off + size}) beyond base of ${base.length}`);
        }
        if (o + size > resultSize) throw new DeltaError("delta result longer than declared");
        out?.set(base.subarray(off, off + size), o);
        o += size;
      } else if (cmd !== 0) {
        if (p + cmd > delta.length) throw new DeltaError("insert truncated");
        if (o + cmd > resultSize) throw new DeltaError("delta result longer than declared");
        out?.set(delta.subarray(p, p + cmd), o);
        p += cmd;
        o += cmd;
      } else {
        throw new DeltaError("delta instruction 0 is reserved");
      }
    }
    return o;
  };
  const produced = run(undefined);
  if (produced !== resultSize) {
    throw new DeltaError(`delta result ${produced} bytes, declared ${resultSize}`);
  }
  const out = new Uint8Array(resultSize);
  run(out);
  return out;
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
