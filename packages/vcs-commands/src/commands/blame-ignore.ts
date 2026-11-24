/**
 * git's heuristics for the lines of an ignored commit (blame.c): each changed line of the
 * ignored version is matched with a line of its parent's version by fingerprint
 * (`fuzzy_find_matching_lines` within the diff chunk, then `scan_parent_range` over the
 * whole parent), so `git blame --ignore-rev` can blame it on the commit that wrote that line.
 *
 * @example
 * ```typescript
 * const parentFps = lineFingerprints(parentContent);
 * const targetFps = lineFingerprints(targetContent);
 * // a chunk replacing parent lines [3, 5) by target lines [3, 7)
 * const blames = guessLineBlames(parentFps, targetFps, 3, 0, 7, 2);
 * blames[0]; // { isParent: true, sLno: 3 } or { isParent: false, sLno: 3 }
 * ```
 *
 * @module
 */

/**
 * A fingerprint (`struct fingerprint`): the multiset of the lower-cased byte pairs of a line,
 * whitespace (as `\0`) added at both ends, whitespace pairs left out; each pair (`c0 | c1 << 8`)
 * mapped to its count
 */
export type Fingerprint = Map<number, number>;

/** git's isspace: tab, line feed, carriage return and space */
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** git's `find_line_starts`: where each line starts, and the length at the end */
export function lineStartsOf(content: Uint8Array): Int32Array {
  let num = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === 0x0a) num++;
  if (content.length > 0 && content[content.length - 1] !== 0x0a) num++;
  const starts = new Int32Array(num + 1);
  let n = 1;
  for (let i = 0; i < content.length - 1; i++) if (content[i] === 0x0a) starts[n++] = i + 1;
  starts[num] = content.length;
  return starts;
}

/** git's `get_fingerprint` of `content[begin, end]` (`end` itself read as whitespace) */
function fingerprint(content: Uint8Array, begin: number, end: number): Fingerprint {
  const map: Fingerprint = new Map();
  let c0 = 0;
  for (let p = begin; p <= end; p++) {
    let c1 = 0;
    if (p !== end) {
      const c = content[p];
      if (!isSpace(c)) c1 = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
    }
    const hash = c0 | (c1 << 8);
    c0 = c1;
    if (hash === 0) continue;
    map.set(hash, (map.get(hash) ?? 0) + 1);
  }
  return map;
}

/** git's `get_line_fingerprints` over every line (`fill_origin_fingerprints`) */
export function lineFingerprints(content: Uint8Array): Fingerprint[] {
  const starts = lineStartsOf(content);
  const out: Fingerprint[] = new Array(starts.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = fingerprint(content, starts[i], starts[i + 1]);
  return out;
}

/** git's `fingerprint_similarity`: the size of the multisets' intersection */
function similarity(a: Fingerprint, b: Fingerprint): number {
  let n = 0;
  for (const [hash, countB] of b) {
    const countA = a.get(hash);
    if (countA !== undefined) n += countA < countB ? countA : countB;
  }
  return n;
}

/** git's `fingerprint_subtract`: `b`'s pairs taken out of `a`, in place */
function subtract(a: Fingerprint, b: Fingerprint): void {
  for (const [hash, countB] of b) {
    const countA = a.get(hash);
    if (countA === undefined) continue;
    if (countA <= countB) a.delete(hash);
    else a.set(hash, countA - countB);
  }
}

const CERTAIN_NOTHING_MATCHES = -2;
const CERTAINTY_NOT_CALCULATED = -1;

interface Mapping {
  destinationStart: number;
  destinationLength: number;
  sourceStart: number;
  sourceLength: number;
}

/** git's `map_line_number`: a line of B mapped onto the middle of its share of A */
function mapLineNumber(line: number, m: Mapping): number {
  return (
    Math.trunc((((line - m.sourceStart) * 2 + 1) * m.destinationLength) / (m.sourceLength * 2)) +
    m.destinationStart
  );
}

/**
 * git's `fuzzy_find_matching_lines`: for each target line of `[tlno, same)` the parent line
 * of `[parentSlno, parentSlno + parentLen)` it matches (-1 for none), the line order kept;
 * undefined when the parent chunk is empty. The matched parent fingerprints are reduced by
 * what was matched (`parentFps` changes).
 */
export function fuzzyFindMatchingLines(
  parentFps: Fingerprint[],
  targetFps: Fingerprint[],
  tlno: number,
  parentSlno: number,
  same: number,
  parentLen: number,
): Int32Array | undefined {
  const startA0 = parentSlno;
  const lengthA0 = parentLen;
  const startB0 = tlno;
  const lengthB0 = same - tlno;
  const mapping: Mapping = {
    destinationStart: startA0,
    destinationLength: lengthA0,
    sourceStart: startB0,
    sourceLength: lengthB0,
  };
  if (lengthA0 <= 0) return undefined;
  let maxA = 10;
  if (maxA >= lengthA0) maxA = lengthA0 ? lengthA0 - 1 : 0;
  const maxB = Math.trunc(((2 * maxA + 1) * lengthB0 - 1) / lengthA0);
  const width = maxA * 2 + 1;
  const result = new Int32Array(lengthB0).fill(-1);
  const secondBest = new Int32Array(lengthB0).fill(-1);
  const certainties = new Int32Array(lengthB0).fill(CERTAINTY_NOT_CALCULATED);
  const similarities = new Int32Array(lengthB0 * width).fill(-1);

  /** `get_similarity`'s index: `lineA` and `closestA` relative to the chunk of A */
  const simAt = (lineA: number, row: number, closestA: number) =>
    lineA - closestA + maxA + row * width;

  /** `find_best_line_matches` for B's line `row` (`bOff + local`) */
  const findBest = (
    startA: number,
    lengthA: number,
    startB: number,
    local: number,
    row: number,
  ) => {
    if (certainties[row] !== CERTAINTY_NOT_CALCULATED) return;
    const closest = mapLineNumber(local + startB, mapping) - startA;
    const searchStart = Math.max(0, closest - maxA);
    const searchEnd = Math.min(lengthA, closest + maxA + 1);
    let best = 0;
    let secondBestSim = 0;
    let bestIndex = 0;
    let secondBestIndex = 0;
    const fb = targetFps[startB + local];
    for (let i = searchStart; i < searchEnd; i++) {
      const at = simAt(i, row, closest);
      if (similarities[at] === -1) {
        similarities[at] = similarity(parentFps[startA + i], fb) * (1000 - Math.abs(i - closest));
      }
      const sim = similarities[at];
      if (sim > best) {
        secondBestSim = best;
        secondBestIndex = bestIndex;
        best = sim;
        bestIndex = i;
      } else if (sim > secondBestSim) {
        secondBestSim = sim;
        secondBestIndex = i;
      }
    }
    if (best === 0) {
      certainties[row] = CERTAIN_NOTHING_MATCHES;
      result[row] = -1;
    } else {
      certainties[row] = best * 2 - secondBestSim;
      result[row] = startA + bestIndex;
      secondBest[row] = startA + secondBestIndex;
    }
  };

  // fuzzy_find_matching_lines_recurse, its recursion as a stack (first half first)
  const stack: Array<[number, number, number, number, number]> = [
    [startA0, startB0, lengthA0, lengthB0, 0],
  ];
  while (stack.length > 0) {
    const [startA, startB, lengthA, lengthB, bOff] = stack.pop() as [
      number,
      number,
      number,
      number,
      number,
    ];
    let mostCertainLocalB = -1;
    let mostCertainty = -1;
    for (let i = 0; i < lengthB; i++) {
      findBest(startA, lengthA, startB, i, bOff + i);
      if (certainties[bOff + i] > mostCertainty) {
        mostCertainty = certainties[bOff + i];
        mostCertainLocalB = i;
      }
    }
    if (mostCertainLocalB === -1) continue;
    const mostCertainA = result[bOff + mostCertainLocalB];
    subtract(parentFps[mostCertainA], targetFps[startB + mostCertainLocalB]);
    const invalidateMin = Math.max(0, mostCertainLocalB - maxB);
    const invalidateMax = Math.min(lengthB, mostCertainLocalB + maxB + 1);
    for (let i = invalidateMin; i < invalidateMax; i++) {
      const closest = mapLineNumber(i + startB, mapping) - startA;
      if (Math.abs(mostCertainA - startA - closest) > maxA) continue;
      similarities[simAt(mostCertainA - startA, bOff + i, closest)] = -1;
    }
    for (let i = mostCertainLocalB - 1; i >= invalidateMin; i--) {
      const row = bOff + i;
      if (
        certainties[row] >= 0 &&
        (result[row] >= mostCertainA || secondBest[row] >= mostCertainA)
      ) {
        certainties[row] = CERTAINTY_NOT_CALCULATED;
      }
    }
    for (let i = mostCertainLocalB + 1; i < invalidateMax; i++) {
      const row = bOff + i;
      if (
        certainties[row] >= 0 &&
        (result[row] <= mostCertainA || secondBest[row] <= mostCertainA)
      ) {
        certainties[row] = CERTAINTY_NOT_CALCULATED;
      }
    }
    // pushed second half first: the first half (and all it splits into) runs before it
    if (mostCertainLocalB + 1 < lengthB) {
      const offsetB = mostCertainLocalB + 1;
      stack.push([
        mostCertainA,
        startB + offsetB,
        lengthA + startA - mostCertainA,
        lengthB - offsetB,
        bOff + offsetB,
      ]);
    }
    if (mostCertainLocalB > 0) {
      stack.push([startA, startB, mostCertainA + 1 - startA, mostCertainLocalB, bOff]);
    }
  }
  return result;
}

/** git's `scan_parent_range`: the parent line most like a target line (at least 10 pairs) */
function scanParentRange(
  parentFps: Fingerprint[],
  targetFps: Fingerprint[],
  tIdx: number,
  from: number,
  count: number,
): number {
  let bestSim = 10;
  let bestIdx = -1;
  for (let p = from; p < from + count; p++) {
    const sim = similarity(parentFps[p], targetFps[tIdx]);
    if (sim < bestSim) continue;
    if (sim === bestSim && bestIdx !== -1 && Math.abs(bestIdx - tIdx) < Math.abs(p - tIdx)) {
      continue;
    }
    bestSim = sim;
    bestIdx = p;
  }
  return bestIdx;
}

/** Where a changed line of an ignored commit is blamed (`struct blame_line_tracker`) */
export interface LineBlame {
  /** Whether it goes to the parent (else it stays with the ignored commit: unblamable) */
  isParent: boolean;
  /** Its line in the parent, or its own line in the target */
  sLno: number;
}

/**
 * git's `guess_line_blames`: for the target lines `[tlno, same)` of a diff chunk whose parent
 * side is `parentLen` lines at `tlno + offset`, the parent line each came from, by the fuzzy
 * match within the chunk, else the best match in the whole parent.
 */
export function guessLineBlames(
  parentFps: Fingerprint[],
  targetFps: Fingerprint[],
  tlno: number,
  offset: number,
  same: number,
  parentLen: number,
): LineBlame[] {
  const fuzzy = fuzzyFindMatchingLines(parentFps, targetFps, tlno, tlno + offset, same, parentLen);
  const out: LineBlame[] = new Array(same - tlno);
  for (let i = 0; i < same - tlno; i++) {
    const targetIdx = tlno + i;
    const best =
      fuzzy && fuzzy[i] >= 0
        ? fuzzy[i]
        : scanParentRange(parentFps, targetFps, targetIdx, 0, parentFps.length);
    out[i] = best >= 0 ? { isParent: true, sLno: best } : { isParent: false, sLno: targetIdx };
  }
  return out;
}
