import type { DeltaRange } from "./types.js";

export function* createDeltaRanges(
  source: Uint8Array,
  target: Uint8Array,
  blockSize = 16,
  minMatch = blockSize,
): Generator<DeltaRange> {
  if (blockSize < 1) {
    throw new Error("blockSize must be >= 1");
  }

  const sourceLen = source.length;
  const targetLen = target.length;

  if (sourceLen === 0 || targetLen === 0) {
    if (targetLen > 0) {
      yield { from: "target", start: 0, len: targetLen };
    }
    return;
  }

  // Rolling hash base
  const BASE = 257 >>> 0;

  // Precompute BASE^(blockSize-1)
  let basePow = 1 >>> 0;
  for (let i = 1; i < blockSize; i++) {
    basePow = (basePow * BASE) >>> 0;
  }

  const computeHash = (buf: Uint8Array, offset: number, len: number): number => {
    let h = 0 >>> 0;
    for (let i = offset, end = offset + len; i < end; i++) {
      h = (h * BASE + buf[i]) >>> 0;
    }
    return h >>> 0;
  };

  const updateHash = (oldHash: number, outByte: number, inByte: number): number => {
    let h = (oldHash - ((outByte * basePow) >>> 0)) >>> 0;
    h = (h * BASE) >>> 0;
    h = (h + inByte) >>> 0;
    return h >>> 0;
  };

  // ---- Build the rolling-hash index of source ----
  const index = {} as { [key: number]: number[] };
  if (sourceLen >= blockSize) {
    let h = computeHash(source, 0, blockSize);
    index[h] = [0];

    for (let i = 1; i <= sourceLen - blockSize; i++) {
      const outByte = source[i - 1];
      const inByte = source[i + blockSize - 1];

      h = updateHash(h, outByte, inByte);

      const arr = index[h];
      if (arr) arr.push(i);
      else index[h] = [i];
    }
  }

  // ---- emitRange generator ----
  let lastRange: DeltaRange | null = null;

  function* emitRange(range: DeltaRange): Generator<DeltaRange> {
    if (
      lastRange &&
      lastRange.from === range.from &&
      lastRange.start + lastRange.len === range.start
    ) {
      // merge in-place
      lastRange.len += range.len;
    } else {
      if (lastRange) {
        yield lastRange;
      }
      lastRange = { ...range };
    }
  }

  // ---- Scan target ----
  let lastLiteralStart = 0;
  let t = 0;

  // Track rolling hash for target blocks
  let targetHash = 0 >>> 0;
  let targetHashPos = -1; // Position where targetHash is valid

  // Initialize hash at position 0 if possible
  if (targetLen >= blockSize) {
    targetHash = computeHash(target, 0, blockSize);
    targetHashPos = 0;
  }

  while (t < targetLen) {
    const remaining = targetLen - t;

    if (remaining >= blockSize && sourceLen >= blockSize) {
      // Update hash efficiently based on movement
      if (targetHashPos === t - 1 && t > 0) {
        // Moving forward by 1 byte - use rolling hash update
        const outByte = target[targetHashPos];
        const inByte = target[t + blockSize - 1];
        targetHash = updateHash(targetHash, outByte, inByte);
        targetHashPos = t;
      } else if (targetHashPos !== t) {
        // Position jumped (after a match) - recompute hash
        targetHash = computeHash(target, t, blockSize);
        targetHashPos = t;
      }
      // else: targetHashPos === t, hash already valid

      const h = targetHash;
      const candidates = index[h];

      let bestLen = 0;
      let bestSourcePos = -1;
      let bestTargetPos = t;

      if (candidates) {
        for (const s0 of candidates) {
          let s = s0;
          let tt = t;

          // extend backward (but not before lastLiteralStart to avoid overlap)
          while (s > 0 && tt > lastLiteralStart && source[s - 1] === target[tt - 1]) {
            s--;
            tt--;
          }

          // extend forward
          let L = 0;
          const max = Math.min(sourceLen - s, targetLen - tt);
          while (L < max && source[s + L] === target[tt + L]) {
            L++;
          }

          if (L > bestLen) {
            bestLen = L;
            bestSourcePos = s;
            bestTargetPos = tt;
          }
        }
      }

      if (bestLen >= minMatch) {
        // flush literal before match
        if (bestTargetPos > lastLiteralStart) {
          yield* emitRange({
            from: "target",
            start: lastLiteralStart,
            len: bestTargetPos - lastLiteralStart,
          });
        }

        // emit copy block
        yield* emitRange({
          from: "source",
          start: bestSourcePos,
          len: bestLen,
        });

        const newT = bestTargetPos + bestLen;
        t = newT;
        lastLiteralStart = newT;
        continue;
      }
    }

    // no match → literal byte
    t++;
  }

  // tail literal
  if (lastLiteralStart < targetLen) {
    yield* emitRange({
      from: "target",
      start: lastLiteralStart,
      len: targetLen - lastLiteralStart,
    });
  }

  // flush final pending range
  if (lastRange) {
    yield lastRange;
  }
}
