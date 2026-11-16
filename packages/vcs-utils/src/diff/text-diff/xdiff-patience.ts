/**
 * A port of git's patience diff (`xdiff/xpatience.c`), without `--anchored`. Lines are
 * numbered from 1, as there.
 *
 * @module
 */

import type { XdEnv, XdFlags } from "./xdiff.js";
import type { FallBackDiff } from "./xdiff-histogram.js";

const NON_UNIQUE = -1;

/** `struct hashmap`: lines unique in both ranges, in the order of the first */
interface PatienceMap {
  alloc: number;
  /** class of the entry's line (valid when line1 is set) */
  ha: Int32Array;
  /** 0: unused, else the line in the first range */
  line1: Int32Array;
  /** 0: not in the second range, NON_UNIQUE, else the line there */
  line2: Int32Array;
  next: Int32Array;
  previous: Int32Array;
  first: number;
  last: number;
  nr: number;
  hasMatches: boolean;
}

function fillHashmap(
  env: XdEnv,
  line1: number,
  count1: number,
  line2: number,
  count2: number,
): PatienceMap {
  const alloc = count1 * 2;
  const map: PatienceMap = {
    alloc,
    ha: new Int32Array(alloc),
    line1: new Int32Array(alloc),
    line2: new Int32Array(alloc),
    next: new Int32Array(alloc).fill(-1),
    previous: new Int32Array(alloc).fill(-1),
    first: -1,
    last: -1,
    nr: 0,
    hasMatches: false,
  };
  const insert = (line: number, pass: 1 | 2) => {
    const cls = (pass === 1 ? env.xdf1 : env.xdf2).ha[line - 1];
    let index = (cls * 2) % alloc;
    while (map.line1[index]) {
      if (map.ha[index] !== cls) {
        if (++index >= alloc) index = 0;
        continue;
      }
      if (pass === 2) map.hasMatches = true;
      if (pass === 1 || map.line2[index]) map.line2[index] = NON_UNIQUE;
      else map.line2[index] = line;
      return;
    }
    if (pass === 2) return;
    map.line1[index] = line;
    map.ha[index] = cls;
    if (map.first < 0) map.first = index;
    if (map.last >= 0) {
      map.next[map.last] = index;
      map.previous[index] = map.last;
    }
    map.last = index;
    map.nr++;
  };
  while (count1--) insert(line1++, 1);
  while (count2--) insert(line2++, 2);
  return map;
}

/** `find_longest_common_sequence`: the first entry of the sequence, or -1 */
function findLongestCommonSequence(map: PatienceMap): number {
  const sequence = new Int32Array(Math.max(map.nr, 1));
  let longest = 0;
  for (let entry = map.first; entry >= 0; entry = map.next[entry]) {
    const l2 = map.line2[entry];
    if (!l2 || l2 === NON_UNIQUE) continue;
    let i: number;
    if (longest === 0 || l2 > map.line2[sequence[longest - 1]]) {
      i = longest - 1;
    } else {
      let left = -1;
      let right = longest;
      while (left + 1 < right) {
        const middle = left + ((right - left) >> 1);
        if (map.line2[sequence[middle]] > l2) right = middle;
        else left = middle;
      }
      i = left;
    }
    map.previous[entry] = i < 0 ? -1 : sequence[i];
    ++i;
    sequence[i] = entry;
    if (i === longest) longest++;
  }
  if (!longest) return -1;
  let entry = sequence[longest - 1];
  map.next[entry] = -1;
  while (map.previous[entry] >= 0) {
    map.next[map.previous[entry]] = entry;
    entry = map.previous[entry];
  }
  return entry;
}

/** xdiff's `xdl_do_patience_diff` */
export function patienceDiff(env: XdEnv, flags: XdFlags, fallBack: FallBackDiff): void {
  const ha1 = env.xdf1.ha;
  const ha2 = env.xdf2.ha;
  const c1 = env.xdf1.changed;
  const c2 = env.xdf2.changed;
  const match = (l1: number, l2: number) => ha1[l1 - 1] === ha2[l2 - 1];

  const diff = (line1: number, count1: number, line2: number, count2: number): void => {
    // changed[i] of xdiff is c[i + 1]: record (line - 1) is c[line]
    if (!count1) {
      while (count2--) c2[line2++] = 1;
      return;
    }
    if (!count2) {
      while (count1--) c1[line1++] = 1;
      return;
    }
    const map = fillHashmap(env, line1, count1, line2, count2);
    if (!map.hasMatches) {
      while (count1--) c1[line1++] = 1;
      while (count2--) c2[line2++] = 1;
      return;
    }
    let first = findLongestCommonSequence(map);
    if (first < 0) {
      fallBack(env.xdf1, line1, count1, env.xdf2, line2, count2, flags);
      return;
    }
    // walk_common_sequence
    const end1 = line1 + count1;
    const end2 = line2 + count2;
    for (;;) {
      let next1: number;
      let next2: number;
      if (first >= 0) {
        next1 = map.line1[first];
        next2 = map.line2[first];
        while (next1 > line1 && next2 > line2 && match(next1 - 1, next2 - 1)) {
          next1--;
          next2--;
        }
      } else {
        next1 = end1;
        next2 = end2;
      }
      while (line1 < next1 && line2 < next2 && match(line1, line2)) {
        line1++;
        line2++;
      }
      if (next1 > line1 || next2 > line2) diff(line1, next1 - line1, line2, next2 - line2);
      if (first < 0) return;
      while (
        map.next[first] >= 0 &&
        map.line1[map.next[first]] === map.line1[first] + 1 &&
        map.line2[map.next[first]] === map.line2[first] + 1
      ) {
        first = map.next[first];
      }
      line1 = map.line1[first] + 1;
      line2 = map.line2[first] + 1;
      first = map.next[first];
    }
  };
  diff(1, env.xdf1.nrec, 1, env.xdf2.nrec);
}
