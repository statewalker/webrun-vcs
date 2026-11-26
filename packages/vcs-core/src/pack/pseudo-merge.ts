/**
 * Pseudo-merge bitmaps (`bitmapPseudoMerge.<name>.*`, git 2.46+'s pseudo-merge.c): extra
 * bitmaps in a `.bitmap` file, each the objects a group of ref tips reaches together, as if a
 * merge commit had them as parents. A reader whose roots hold every commit of a pseudo-merge
 * ORs its bitmap in at once instead of walking from each tip.
 *
 * Selection (`select_pseudo_merges`): the refs are visited in name order; a ref whose peeled
 * id is a commit of the bitmapped pack is matched against each group's pattern (a POSIX ERE
 * anchored at the start); the captures (or the whole match when the pattern has none) name
 * the match set within the group. A tip at or before the group's `stableThreshold` is
 * "stable", one at or before `threshold` and without a bitmap of its own "unstable". Each
 * set's tips are sorted by commit date (oldest first, stable sort); stable ones go into merges
 * of `stableSize` tips, unstable ones into at most `maxMerges` merges whose sizes decay as
 * `n^-decay` (the decay truncated to an integer, as git's `gitexp` takes an `int`), keeping
 * one tip in `1 / sampleRate`. Groups come in name order, sets in the order of git's hashmap
 * of their names (strhash, 64 buckets growing fourfold past 80%, new entries first).
 *
 * The section (`write_pseudo_merges`) sits after the selected commits' bitmaps, before the
 * lookup table and the name-hash cache:
 *
 *  - per pseudo-merge: an EWAH bitmap of its parents (pack positions) and one of what they
 *    reach;
 *  - the commit table: per commit in some pseudo-merge, its pack position (u32) and either
 *    the absolute offset of its pseudo-merge (u64) or, with bit 63 set, the offset of an
 *    extended entry (u32 count, then the count's u64 offsets) listing its several ones;
 *  - the extended entries, the absolute offset of each pseudo-merge (u64), then the
 *    pseudo-merge count (u32), the commit count (u32), the commit table's offset from the
 *    section's start (u64) and the section's size including these 8 bytes (u64).
 *
 * git 2.46 to 2.54 sort the commit table by object id and point extended entries 4 bytes per
 * commit too early (8-byte rows counted); 2.55 sorts it by pack position (its readers binary
 * search it so) and counts 12-byte rows: `PseudoMergeLayout`.
 */
import type { EwahBitmap, PosixRegex } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { ObjectId } from "../common/id/index.js";

/** One `bitmapPseudoMerge.<name>` group of the configuration. */
export interface PseudoMergeGroup {
  /** The `<name>` of the configuration (groups are visited in name order). */
  name: string;
  /** The pattern, compiled with a `^` in front (ERE), as git compiles it. */
  pattern: PosixRegex;
  /** `decay` (default 1) */
  decay: number;
  /** `maxMerges` (default 64) */
  maxMerges: number;
  /** `sampleRate` (default 1) */
  sampleRate: number;
  /** `stableSize` (default 512) */
  stableSize: number;
  /** `threshold` in seconds (default one week ago; `now` is Infinity) */
  threshold: number;
  /** `stableThreshold` in seconds (default one month ago; `never` is 0) */
  stableThreshold: number;
}

/** The pseudo-merge table as git 2.46–2.54 (`"2.46"`) or 2.55+ (`"2.55"`) write it. */
export type PseudoMergeLayout = "2.46" | "2.55";

/** A ref considered for pseudo-merges: its name and its fully peeled id. */
export interface PseudoMergeRef {
  name: string;
  id: ObjectId;
}

/** A selected pseudo-merge: its parents, as pack positions, in the order git appends them. */
export interface SelectedPseudoMerge {
  parents: number[];
}

/** What selection needs to know of a commit of the bitmapped pack. */
export interface PseudoMergeCandidate {
  /** Its pack position */
  pos: number;
  /** Its committer date */
  date: number;
  /** Whether it got a bitmap of its own */
  hasBitmap: boolean;
}

const MIN_PSEUDO_MERGE_SIZE = 8;

/** git's gitexp: `base` to an integer power (the exponent is an `int`, so a decay is truncated). */
function gitexp(base: number, exp: number): number {
  let e = Math.trunc(exp) | 0;
  let b = base;
  let result = 1;
  for (;;) {
    if (e % 2) result *= b;
    e >>= 1;
    if (!e) break;
    b *= b;
  }
  return result;
}

function groupSize(group: PseudoMergeGroup, unstableNr: number, i: number): number {
  let c = 0;
  for (let n = 0; n < group.maxMerges; n++) c += 1.0 / gitexp(n + 1, group.decay);
  c = unstableNr / c;
  return Math.trunc(c / gitexp(i + 1, group.decay) + 0.5) >>> 0;
}

/** git's strhash: 32-bit FNV-1 over the bytes. */
function strhash(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const c of bytes) hash = (Math.imul(hash, 0x01000193) ^ c) >>> 0;
  return hash;
}

/** Keys in the iteration order of git's hashmap they were added to in this order. */
function hashmapOrder<T>(entries: { key: Uint8Array; value: T }[]): T[] {
  let table: { hash: number; value: T }[][] = Array.from({ length: 64 }, () => []);
  let count = 0;
  for (const e of entries) {
    const hash = strhash(e.key);
    table[hash & (table.length - 1)]?.unshift({ hash, value: e.value });
    count++;
    if (count > Math.floor((table.length * 80) / 100)) {
      const size = table.length * 4;
      const old = table;
      table = Array.from({ length: size }, () => []);
      for (const bucket of old) for (const x of bucket) table[x.hash & (size - 1)]?.unshift(x);
    }
  }
  return table.flat().map((x) => x.value);
}

function stableSortByDate(items: PseudoMergeCandidate[]): PseudoMergeCandidate[] {
  return items
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.date - b.v.date || a.i - b.i)
    .map((x) => x.v);
}

/**
 * git's select_pseudo_merges: the pseudo-merges of `groups` (sorted by name here) over `refs`
 * (in name order). `candidate` answers for a peeled ref id that is a commit of the bitmapped
 * pack, undefined otherwise. Returns the pseudo-merges in the order git pushes them and, per
 * commit position, the indexes of the pseudo-merges it is a parent of.
 */
export function selectPseudoMerges(
  groups: readonly PseudoMergeGroup[],
  refs: Iterable<PseudoMergeRef>,
  candidate: (id: ObjectId) => PseudoMergeCandidate | undefined,
): { merges: SelectedPseudoMerge[]; commits: Map<number, number[]> } {
  const sorted = [...groups].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  type Matches = { stable: PseudoMergeCandidate[]; unstable: PseudoMergeCandidate[] };
  const perGroup = sorted.map(() => ({
    byName: new Map<string, Matches>(),
    added: [] as { key: Uint8Array; value: Matches }[],
  }));
  for (const ref of refs) {
    const c = candidate(ref.id);
    if (!c) continue;
    const nameBytes = encodeGitPath(ref.name);
    sorted.forEach((group, g) => {
      const m = group.pattern.exec(nameBytes, nameBytes.length, 16);
      if (!m) return;
      const parts: Uint8Array[] = [];
      if (group.pattern.groupCount === 0) parts.push(nameBytes.subarray(m.start, m.end));
      else {
        for (let j = 0; j < Math.min(15, m.groups.length); j++) {
          const span = m.groups[j];
          if (span) parts.push(nameBytes.subarray(span[0], span[1]));
        }
      }
      const key = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + parts.length - 1);
      let at = 0;
      parts.forEach((p, k) => {
        if (k) key[at++] = 0x2d; // '-'
        key.set(p, at);
        at += p.length;
      });
      const keyText = Array.from(key, (b) => String.fromCharCode(b)).join("");
      const state = perGroup[g] as (typeof perGroup)[number];
      let matches = state.byName.get(keyText);
      if (!matches) {
        matches = { stable: [], unstable: [] };
        state.byName.set(keyText, matches);
        state.added.push({ key, value: matches });
      }
      if (c.date <= group.stableThreshold) matches.stable.push(c);
      else if (c.date <= group.threshold && !c.hasBitmap) matches.unstable.push(c);
    });
  }

  const merges: SelectedPseudoMerge[] = [];
  const commits = new Map<number, number[]>();
  const note = (pos: number) => {
    let list = commits.get(pos);
    if (!list) {
      list = [];
      commits.set(pos, list);
    }
    list.push(merges.length);
  };
  sorted.forEach((group, g) => {
    for (const matches of hashmapOrder((perGroup[g] as (typeof perGroup)[number]).added)) {
      const stable = stableSortByDate(matches.stable);
      const unstable = stableSortByDate(matches.unstable);
      if (!stable.length && !unstable.length) continue;
      const stableSize = group.stableSize;
      const stableMerges = Math.ceil(stable.length / stableSize);
      for (let i = 0, j = 0; i < stableMerges; i++) {
        const parents: number[] = [];
        do {
          if (j >= stable.length) break;
          const c = stable[j++] as PseudoMergeCandidate;
          note(c.pos);
          parents.push(c.pos);
        } while (j % stableSize);
        if (parents.length) merges.push({ parents });
      }
      const every = Math.trunc(1.0 / group.sampleRate);
      for (let i = 0, j = 0; i < group.maxMerges; i++) {
        const size = groupSize(group, unstable.length, i);
        const end = size < MIN_PSEUDO_MERGE_SIZE ? unstable.length : j + size;
        const parents: number[] = [];
        for (; j < end && j < unstable.length; j++) {
          if (!(every > 0) || j % every) continue;
          const c = unstable[j] as PseudoMergeCandidate;
          note(c.pos);
          parents.push(c.pos);
        }
        if (parents.length) merges.push({ parents });
        if (end >= unstable.length) break;
      }
    }
  });
  return { merges, commits };
}

/**
 * The section's bytes, `start` being its absolute offset in the file. `parents[i]` and
 * `bitmaps[i]` are pseudo-merge `i`'s EWAH bitmaps; `commits` maps each commit (pack
 * position) to its pseudo-merges; `idOf` gives a pack position's id (the 2.46 layout sorts
 * by it).
 */
export function encodePseudoMerges(options: {
  start: number;
  parents: readonly EwahBitmap[];
  bitmaps: readonly EwahBitmap[];
  commits: ReadonlyMap<number, readonly number[]>;
  idOf: (pos: number) => ObjectId;
  layout?: PseudoMergeLayout;
}): Uint8Array {
  const { start, parents, bitmaps, commits } = options;
  const legacy = options.layout === "2.46";
  const nr = parents.length;
  let size = 0;
  const offsets: number[] = [];
  for (let i = 0; i < nr; i++) {
    offsets.push(start + size);
    size += (parents[i] as EwahBitmap).serializedSize + (bitmaps[i] as EwahBitmap).serializedSize;
  }
  const tableStart = start + size;
  const positions = [...commits.keys()];
  if (legacy) {
    const ids = new Map(positions.map((p) => [p, options.idOf(p)]));
    positions.sort((a, b) => {
      const x = ids.get(a) as string;
      const y = ids.get(b) as string;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  } else positions.sort((a, b) => a - b);
  let ext = 0;
  for (const p of positions) {
    const n = (commits.get(p) as readonly number[]).length;
    if (n > 1) ext += 4 + 8 * n;
  }
  size += positions.length * 12 + ext + nr * 8 + 24;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < nr; i++) {
    at = (parents[i] as EwahBitmap).writeTo(out, at);
    at = (bitmaps[i] as EwahBitmap).writeTo(out, at);
  }
  let nextExt = tableStart + positions.length * (legacy ? 8 : 12);
  for (const p of positions) {
    const list = commits.get(p) as readonly number[];
    view.setUint32(at, p);
    if (list.length === 1) view.setBigUint64(at + 4, BigInt(offsets[list[0] as number] as number));
    else {
      view.setBigUint64(at + 4, BigInt(nextExt) | (1n << 63n));
      nextExt += 4 + 8 * list.length;
    }
    at += 12;
  }
  for (const p of positions) {
    const list = commits.get(p) as readonly number[];
    if (list.length === 1) continue;
    view.setUint32(at, list.length);
    at += 4;
    for (const m of list) {
      view.setBigUint64(at, BigInt(offsets[m] as number));
      at += 8;
    }
  }
  for (const o of offsets) {
    view.setBigUint64(at, BigInt(o));
    at += 8;
  }
  view.setUint32(at, nr);
  view.setUint32(at + 4, positions.length);
  view.setBigUint64(at + 8, BigInt(tableStart - start));
  view.setBigUint64(at + 16, BigInt(size));
  return out;
}
