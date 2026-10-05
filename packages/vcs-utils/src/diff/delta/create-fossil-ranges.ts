import { RollingChecksum, StrongChecksum } from "../../hash/index.js";
import type { DeltaRange } from "./types.js";

// Re-export classes from hash for backward compatibility
export { RollingChecksum, StrongChecksum } from "../../hash/index.js";

// ============================================================================
// ---- Build source index ----
// Index for blocks aligned to blockSize boundaries

export interface SourceBlock {
  pos: number; // position in source
  weak: number; // weak rolling checksum
  strong: number; // strong checksum
}

export interface SourceIndex {
  blockSize: number;
  source: Uint8Array;
  map: Map<number, SourceBlock[]>;
}

export const DEFAULT_BLOCK_SIZE = 16;

export function buildSourceIndex(
  source: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): SourceIndex {
  const map = new Map<number, SourceBlock[]>();
  const rc = new RollingChecksum();
  const sc = new StrongChecksum();

  for (let pos = 0; pos + blockSize <= source.length; pos += blockSize) {
    rc.reset();
    sc.reset();
    const weak = rc.init(source, pos, blockSize).value();
    const strong = sc.update(source, pos, blockSize).finalize();
    const block: SourceBlock = { pos, weak, strong };

    const list = map.get(weak);
    if (list) {
      list.push(block);
    } else {
      map.set(weak, [block]);
    }
  }

  return { blockSize, source, map };
}

// ============================================================================
// ---- Delta range definitions ----

interface RangeAccumulator {
  last?: DeltaRange;
}

/**
 * Merge-adjacent range emitter.
 * Keeps state in `acc.last` and yields only when necessary.
 */
export function* emitRange(
  acc: RangeAccumulator,
  next: DeltaRange | undefined,
): Generator<DeltaRange> {
  if (!next) {
    return;
  }

  const prev = acc.last;
  if (prev && prev.from === next.from && prev.start + prev.len === next.start) {
    // Extend previous range
    prev.len += next.len;
    return;
  }

  if (prev) {
    yield prev;
  }

  acc.last = { ...next };
}

// ============================================================================

export function* createFossilLikeRanges(
  source: Uint8Array,
  target: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): Generator<DeltaRange> {
  const index = buildSourceIndex(source, blockSize);
  const acc: RangeAccumulator = {};

  // No block possible => entire target is an insert
  if (target.length < blockSize || index.map.size === 0) {
    if (target.length > 0) {
      yield* emitRange(acc, {
        from: "target",
        start: 0,
        len: target.length,
      });
    }
    if (acc.last) {
      yield acc.last;
    }
    return;
  }

  let tPos = 0; // window start in target
  let insertStart = 0; // beginning of current unmatched region in target
  const rc = new RollingChecksum();
  const sc = new StrongChecksum();
  let rcInitialized = false;

  while (tPos + blockSize <= target.length) {
    // Initialize or slide checksum
    if (!rcInitialized) {
      rc.init(target, tPos, blockSize);
      rcInitialized = true;
    } else {
      const removeByte = target[tPos - 1];
      const addByte = target[tPos + blockSize - 1];
      rc.update(removeByte, addByte);
    }

    const weak = rc.value();
    const candidates = index.map.get(weak);

    let bestSrcPos = -1;
    let bestTgtPos = tPos;
    let bestLen = 0;

    if (candidates && candidates.length > 0) {
      sc.reset();
      const targetStrong = sc.update(target, tPos, blockSize).finalize();

      for (const cand of candidates) {
        if (cand.strong !== targetStrong) continue;

        // We have a candidate block with matching weak + strong.
        let s = cand.pos;
        let tt = tPos;

        // Extend backward (but not before insertStart to avoid overlap)
        while (s > 0 && tt > insertStart && source[s - 1] === target[tt - 1]) {
          s--;
          tt--;
        }

        // Extend match forward as far as possible.
        let len = 0;
        while (
          s + len < source.length &&
          tt + len < target.length &&
          source[s + len] === target[tt + len]
        ) {
          len++;
        }

        if (len > bestLen) {
          bestLen = len;
          bestSrcPos = s;
          bestTgtPos = tt;
        }
      }
    }

    // Decide whether to take the match
    if (bestLen >= blockSize) {
      // Flush pending target-only bytes before the match
      if (bestTgtPos > insertStart) {
        yield* emitRange(acc, {
          from: "target",
          start: insertStart,
          len: bestTgtPos - insertStart,
        });
      }

      // Emit copy from source
      yield* emitRange(acc, {
        from: "source",
        start: bestSrcPos,
        len: bestLen,
      });

      // Advance past the match
      const newTPos = bestTgtPos + bestLen;
      tPos = newTPos;
      insertStart = newTPos;
      rcInitialized = false; // force re-init at the new window position
    } else {
      // No good match, move window by 1 byte
      tPos++;
      // rc stays in place and will be slid next iteration
    }
  }

  // Remaining tail of target that couldn't form a full block window
  if (insertStart < target.length) {
    yield* emitRange(acc, {
      from: "target",
      start: insertStart,
      len: target.length - insertStart,
    });
  }

  // Flush the final accumulated range
  if (acc.last) {
    yield acc.last;
  }
}
