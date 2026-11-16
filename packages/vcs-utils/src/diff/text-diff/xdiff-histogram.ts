/**
 * A port of git's histogram diff (`xdiff/xhistogram.c`). Lines are numbered from 1, as there.
 *
 * @module
 */

import type { XdEnv, XdFile, XdFlags } from "./xdiff.js";

/** xdiff's `xdl_fall_back_diff`, passed in to keep the modules acyclic */
export type FallBackDiff = (
  a: XdFile,
  line1: number,
  count1: number,
  b: XdFile,
  line2: number,
  count2: number,
  flags: XdFlags,
) => void;

const MAX_CHAIN_LENGTH = 64;
const MAX_CNT = 0xffffffff;

function hashbits(size: number): number {
  let val = 1;
  let bits = 0;
  for (; val < size && bits < 32; val *= 2, bits++);
  return bits ? bits : 1;
}

interface Region {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
}

/**
 * `find_lcs`: the longest common region with the fewest occurrences. Returns 1 to fall back
 * to Myers, 0 otherwise (no common region: `lcs.begin1 === 0`).
 */
function findLcs(
  env: XdEnv,
  lcs: Region,
  line1: number,
  count1: number,
  line2: number,
  count2: number,
): number {
  const ha1 = env.xdf1.ha;
  const ha2 = env.xdf2.ha;
  const tableBits = hashbits(count1);
  const tableSize = 2 ** tableBits;
  const mask = tableSize - 1;
  const tableHash = (cls: number) => (cls + Math.floor(cls / tableSize)) & mask;
  // the records: a chain per table slot, one record per distinct line (class)
  const heads = new Int32Array(tableSize).fill(-1);
  const recPtr: number[] = [];
  const recCnt: number[] = [];
  const recNext: number[] = [];
  const ptrShift = line1;
  const lineMap = new Int32Array(count1);
  const nextPtrs = new Int32Array(count1);
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;

  // scanA
  for (let ptr = end1; line1 <= ptr; ptr--) {
    const cls = ha1[ptr - 1];
    const slot = tableHash(cls);
    let rec = heads[slot];
    let chainLen = 0;
    let found = false;
    while (rec >= 0) {
      if (ha1[recPtr[rec] - 1] === cls) {
        nextPtrs[ptr - ptrShift] = recPtr[rec];
        recPtr[rec] = ptr;
        recCnt[rec] = Math.min(MAX_CNT, recCnt[rec] + 1);
        lineMap[ptr - ptrShift] = rec;
        found = true;
        break;
      }
      rec = recNext[rec];
      chainLen++;
    }
    if (found) continue;
    // git fails the diff here; with one record per class this cannot be reached in practice
    if (chainLen === MAX_CHAIN_LENGTH) return 1;
    rec = recPtr.length;
    recPtr.push(ptr);
    recCnt.push(1);
    recNext.push(heads[slot]);
    heads[slot] = rec;
    lineMap[ptr - ptrShift] = rec;
  }

  let cnt = MAX_CHAIN_LENGTH + 1;
  let hasCommon = false;
  const cntAt = (ptr: number) => recCnt[lineMap[ptr - ptrShift]];

  // try_lcs for each line of the second range
  for (let bPtr = line2; bPtr <= end2; ) {
    let bNext = bPtr + 1;
    const bcls = ha2[bPtr - 1];
    for (let rec = heads[tableHash(bcls)]; rec >= 0; rec = recNext[rec]) {
      if (recCnt[rec] > cnt) {
        if (!hasCommon) hasCommon = ha1[recPtr[rec] - 1] === bcls;
        continue;
      }
      let as = recPtr[rec];
      if (ha1[as - 1] !== bcls) continue;
      hasCommon = true;
      for (;;) {
        let np = nextPtrs[as - ptrShift];
        let bs = bPtr;
        let ae = as;
        let be = bs;
        let rc = recCnt[rec];
        while (line1 < as && line2 < bs && ha1[as - 2] === ha2[bs - 2]) {
          as--;
          bs--;
          if (1 < rc) rc = Math.min(rc, cntAt(as));
        }
        while (ae < end1 && be < end2 && ha1[ae] === ha2[be]) {
          ae++;
          be++;
          if (1 < rc) rc = Math.min(rc, cntAt(ae));
        }
        if (bNext <= be) bNext = be + 1;
        if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) {
          lcs.begin1 = as;
          lcs.begin2 = bs;
          lcs.end1 = ae;
          lcs.end2 = be;
          cnt = rc;
        }
        if (np === 0) break;
        let stop = false;
        while (np <= ae) {
          np = nextPtrs[np - ptrShift];
          if (np === 0) {
            stop = true;
            break;
          }
        }
        if (stop) break;
        as = np;
      }
    }
    bPtr = bNext;
  }
  return hasCommon && MAX_CHAIN_LENGTH < cnt ? 1 : 0;
}

/** xdiff's `xdl_do_histogram_diff` */
export function histogramDiff(env: XdEnv, flags: XdFlags, fallBack: FallBackDiff): void {
  const c1 = env.xdf1.changed;
  const c2 = env.xdf2.changed;
  // histogram_diff, its tail recursion a loop and its head recursion a stack
  const stack: number[] = [
    env.xdf1.dstart + 1,
    env.xdf1.dend - env.xdf1.dstart + 1,
    env.xdf2.dstart + 1,
    env.xdf2.dend - env.xdf2.dstart + 1,
  ];
  while (stack.length > 0) {
    let count2 = stack.pop() as number;
    let line2 = stack.pop() as number;
    let count1 = stack.pop() as number;
    let line1 = stack.pop() as number;
    for (;;) {
      if (count1 <= 0 && count2 <= 0) break;
      // changed[i] of xdiff is c[i + 1]: record (line - 1) is c[line]
      if (!count1) {
        while (count2--) c2[line2++] = 1;
        break;
      }
      if (!count2) {
        while (count1--) c1[line1++] = 1;
        break;
      }
      const lcs: Region = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
      if (findLcs(env, lcs, line1, count1, line2, count2)) {
        fallBack(env.xdf1, line1, count1, env.xdf2, line2, count2, flags);
        break;
      }
      if (lcs.begin1 === 0 && lcs.begin2 === 0) {
        while (count1--) c1[line1++] = 1;
        while (count2--) c2[line2++] = 1;
        break;
      }
      // the part before the region is done after this one (the order does not matter)
      stack.push(line1, lcs.begin1 - line1, line2, lcs.begin2 - line2);
      const e1 = line1 + count1 - 1;
      const e2 = line2 + count2 - 1;
      count1 = e1 - lcs.end1;
      line1 = lcs.end1 + 1;
      count2 = e2 - lcs.end2;
      line2 = lcs.end2 + 1;
    }
  }
}
