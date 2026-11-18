/**
 * Reading a pack in pack order, as one sequential read: its entries sorted by offset
 * (`packEntryOrder`, git's reverse index), their headers parsed from the bytes read
 * (`parsePackEntryHead`), and the objects of the types asked for unpacked as they come
 * (`scanPackObjects`): each delta's base comes before it, nearly always close, so a small
 * cache of what was unpacked last resolves it from memory. `fsck` checks a pack this way
 * (git's verify_pack), `fsck --connectivity-only` reads its commits and trees, and
 * `writeCommitGraph` its trees for the changed-path filters.
 *
 * In `scanPackObjects` a delta's type is its base's, known since the base comes first, so a
 * blob's delta is skipped unread as a blob is. An entry the scan does not handle as it stands
 * (a REF_DELTA, a base it did not keep, an entry over 1 MiB, one that fails to inflate or whose
 * header or idx entry is not sound) is left out, with every delta built on it: the caller reads
 * those through the store, with the store's errors. Nothing is hash-checked.
 */

import { inflateWhole } from "@statewalker/vcs-utils/compression";
import { applyGitDelta } from "@statewalker/vcs-utils/diff";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { allocBytes } from "@statewalker/vcs-utils/streams";
import type { FilesApi } from "../common/files/index.js";
import type { PackIndex } from "./types.js";

/** Bytes of an entry kept for its header: the longest is a REF_DELTA's (at most 10 + 20). */
export const PACK_ENTRY_HEAD_MAX = 32;
/** The largest object accepted (`openPack`'s default). */
export const PACK_MAX_OBJECT_SIZE = 2 ** 30;
/** zlib's largest expansion. */
const MAX_EXPANSION = 1032;
/** The deepest delta chain git writes. */
export const PACK_MAX_CHAIN = 4095;
/** Entries (and objects) above this size are left to the pack's reader. */
export const PACK_SCAN_MAX = 1024 * 1024;

/** A big-endian 32-bit word (bytes past the end read as 0). */
function u32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) |
      ((b[at + 1] as number) << 16) |
      ((b[at + 2] as number) << 8) |
      (b[at + 3] as number)) >>>
    0
  );
}

/**
 * A pack's entries in pack order: `sorted[k]` is the offset of the `k`th entry, `order[k]` its
 * position in the idx (read as `PackIndex.entries()` reads offsets).
 */
export function packEntryOrder(
  idxBytes: Uint8Array,
  v2: boolean,
  count: number,
): { order: Uint32Array; sorted: Float64Array } {
  const idsAt = v2 ? 8 + 1024 : 1024 + 4;
  const crcAt = idsAt + count * 20;
  const offAt = v2 ? crcAt + count * 4 : 1024;
  const offStride = v2 ? 4 : 24;
  const largeAt = offAt + count * 4;
  const offsets = new Float64Array(count);
  for (let pos = 0; pos < count; pos++) {
    let offset = u32(idxBytes, offAt + pos * offStride);
    if (v2 && offset & 0x80000000) {
      const at = largeAt + (offset & 0x7fffffff) * 8;
      offset = u32(idxBytes, at) * 0x100000000 + u32(idxBytes, at + 4);
    }
    offsets[pos] = offset;
  }
  const order = new Uint32Array(count);
  const sorted = new Float64Array(count);
  if (isSorted(offsets)) {
    for (let i = 0; i < count; i++) order[i] = i;
    sorted.set(offsets);
    return { order, sorted };
  }
  // offset and position in one number, sorted as numbers (a typed array's own sort, without a
  // comparator); ties between equal offsets keep idx order, as a stable sort would
  let max = 0;
  for (let i = 0; i < count; i++) if ((offsets[i] as number) > max) max = offsets[i] as number;
  const bits = Math.max(1, Math.ceil(Math.log2(count + 1)));
  const scale = 2 ** bits;
  if (max * scale + scale <= Number.MAX_SAFE_INTEGER) {
    const keys = new Float64Array(count);
    for (let i = 0; i < count; i++) keys[i] = (offsets[i] as number) * scale + i;
    keys.sort();
    for (let k = 0; k < count; k++) {
      const key = keys[k] as number;
      const pos = key % scale;
      order[k] = pos;
      sorted[k] = (key - pos) / scale;
    }
    return { order, sorted };
  }
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => (offsets[a] as number) - (offsets[b] as number) || a - b);
  for (let k = 0; k < count; k++) sorted[k] = offsets[order[k] as number] as number;
  return { order, sorted };
}

/** Whether `a` is in ascending order already. */
function isSorted(a: Float64Array): boolean {
  for (let i = 1; i < a.length; i++) if ((a[i] as number) < (a[i - 1] as number)) return false;
  return true;
}

/**
 * For each idx position, whether `PackFile` finds the id there without an error: its fan-out
 * bucket (the id's first byte) is sorted and holds only its own ids (what a lookup checks
 * before searching it), the position is inside that bucket, and the offset is a 32-bit one
 * (a 64-bit offset is checked against its table when read).
 */
export function packIdxLookups(idx: Uint8Array, v2: boolean, n: number): (pos: number) => boolean {
  const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  const fanAt = v2 ? 8 : 0;
  const idsAt = v2 ? 8 + 1024 : 1024 + 4;
  const stride = v2 ? 20 : 24;
  const offAt = 8 + 1024 + n * 24;
  const fan = (b: number) => (b < 0 ? 0 : view.getUint32(fanAt + b * 4));
  const sound = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const from = fan(b - 1);
    const to = fan(b);
    let ok = from <= to && to <= n;
    for (let i = from; ok && i < to; i++) {
      const at = idsAt + i * stride;
      if (idx[at] !== b) ok = false;
      else if (i > from) {
        let c = 0;
        for (let j = 1; j < 20 && c === 0; j++)
          c = (idx[at + j] as number) - (idx[at - stride + j] as number);
        if (c <= 0) ok = false;
      }
    }
    sound[b] = ok ? 1 : 0;
  }
  return (pos) => {
    const b = idx[idsAt + pos * stride] as number;
    if (!sound[b] || pos < fan(b - 1) || pos >= fan(b)) return false;
    return !v2 || !(view.getUint32(offAt + pos * 4) & 0x80000000);
  };
}

/** Inflates the zlib stream at the start of `input` into exactly `out`; false if it fails. */
export function inflateExactly(input: Uint8Array, out: Uint8Array): boolean {
  try {
    return inflateWhole(input, { into: out }).length === out.length;
  } catch {
    return false;
  }
}

/** An entry's header: kind, declared size, where its data starts, a delta's base. */
export interface ScannedEntryHead {
  kind: number;
  size: number;
  /** offset of the zlib stream from the entry's start */
  dataAt: number;
  /** an OFS_DELTA's base entry (its index in pack order) */
  base: number;
  baseId?: string;
}

/**
 * The header of entry `k` (its first bytes in `h`, the entry ending at `end`), as
 * `PackFile.entry` parses it; undefined when it is not sound in every way `entry` checks (then
 * `entry` reads it and raises its error).
 */
export function parsePackEntryHead(
  h: Uint8Array,
  sorted: Float64Array,
  k: number,
  end: number,
  idOf: (k: number) => string,
): ScannedEntryHead | undefined {
  const offset = sorted[k] as number;
  const len = Math.min(h.length, PACK_ENTRY_HEAD_MAX);
  let p = 0;
  if (p >= len) return undefined;
  let b = h[p++] as number;
  const kind = (b >> 4) & 7;
  let size = b & 0x0f;
  let mul = 16;
  while (b & 0x80) {
    if (p >= len) return undefined;
    b = h[p++] as number;
    size += (b & 0x7f) * mul;
    mul *= 128;
    if (mul > 2 ** 53) return undefined;
  }
  if (size > PACK_MAX_OBJECT_SIZE) return undefined;
  let baseId: string | undefined;
  let base = -1;
  if (kind === 6) {
    if (p >= len) return undefined;
    b = h[p++] as number;
    let back = b & 0x7f;
    while (b & 0x80) {
      if (p >= len) return undefined;
      b = h[p++] as number;
      back = (back + 1) * 128 + (b & 0x7f);
      if (back > offset) break;
    }
    const baseOffset = offset - back;
    if (back === 0 || baseOffset < 12) return undefined;
    // the entry starting there (entries are sorted by offset)
    let lo = 0;
    let hi = k;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sorted[mid] as number) < baseOffset) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= k || sorted[lo] !== baseOffset) return undefined;
    base = lo;
    baseId = idOf(lo);
  } else if (kind === 7) {
    if (p + 20 > len) return undefined;
    baseId = bytesToHex(h.subarray(p, p + 20));
    p += 20;
  } else if (kind < 1 || kind > 4) {
    return undefined;
  }
  if (size > (end - (offset + p)) * MAX_EXPANSION + 1024) return undefined;
  return { kind, size, dataAt: p, base, baseId };
}

/** Bytes of unpacked objects kept as delta bases (the oldest dropped first, in pack order). */
const BASE_BYTES = 32 * 2 ** 20;

/**
 * Reads the pack at `packPath` (its idx `idxBytes`, parsed as `idx`) in pack order and hands
 * each object whose type (1 commit, 2 tree, 3 blob, 4 tag) is set in `wanted` to `visit`, with
 * its idx position and its content (valid during the call only). Returns how many entries were
 * unpacked.
 */
export async function scanPackObjects(
  files: FilesApi,
  packPath: string,
  idxBytes: Uint8Array,
  idx: PackIndex,
  wanted: (type: number) => boolean,
  visit: (pos: number, type: number, content: Uint8Array) => void,
): Promise<number> {
  const stats = await files.stats(packPath);
  if (stats?.kind !== "file" || stats.size === undefined) return 0;
  const packLength = stats.size;
  const trailerAt = packLength - 20;
  const v2 = idx.version > 1;
  if (!v2) return 0;
  const n = idx.objectCount;
  const lookups = packIdxLookups(idxBytes, v2, n);
  // whether every idx entry is sound (the common case: no check per entry then)
  let sound = true;
  for (let pos = 0; pos < n && sound; pos++) sound = lookups(pos);
  const { order, sorted } = packEntryOrder(idxBytes, v2, n);
  const entryEnd = (k: number) => (k + 1 < n ? (sorted[k + 1] as number) : trailerAt);
  for (let k = 0; k < n; k++) if (entryEnd(k) <= (sorted[k] as number)) return 0;

  /** each entry's type as resolved here, 0 when unknown */
  const types = new Uint8Array(n);
  const depth = new Uint16Array(n);
  /** unpacked objects kept as bases, by entry; `queue` holds their entries, oldest first */
  const kept: (Uint8Array | undefined)[] = new Array(n);
  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;
  let keptBytes = 0;
  let deltaScratch = new Uint8Array(64 * 1024);
  let unpacked = 0;

  const entry = (k: number, bytes: Uint8Array): void => {
    const pos = order[k] as number;
    if ((!sound && !lookups(pos)) || (sorted[k] as number) < 12) return;
    const head = parsePackEntryHead(bytes, sorted, k, entryEnd(k), () => "");
    if (!head) return;
    let type: number;
    if (head.kind <= 4) type = head.kind;
    else if (head.kind === 6) type = types[head.base] as number;
    else return;
    if (type === 0) return;
    types[k] = type;
    if (!wanted(type) || head.size > PACK_SCAN_MAX) return;
    const stream = bytes.subarray(head.dataAt);
    let data: Uint8Array;
    if (head.kind <= 4) {
      data = allocBytes(head.size);
      if (!inflateExactly(stream, data)) {
        types[k] = 0;
        return;
      }
    } else {
      const b = head.base;
      const base = kept[b];
      if (!base || (depth[b] as number) >= PACK_MAX_CHAIN) {
        types[k] = 0;
        return;
      }
      if (deltaScratch.length < head.size) deltaScratch = new Uint8Array(head.size);
      const delta = deltaScratch.subarray(0, head.size);
      if (!inflateExactly(stream, delta)) {
        types[k] = 0;
        return;
      }
      try {
        data = applyGitDelta(base, delta, PACK_MAX_OBJECT_SIZE, allocBytes);
      } catch {
        types[k] = 0;
        return;
      }
      depth[k] = (depth[b] as number) + 1;
    }
    unpacked++;
    kept[k] = data;
    queue[qTail++] = k;
    keptBytes += data.length;
    while (keptBytes > BASE_BYTES && qHead < qTail - 1) {
      const old = queue[qHead++] as number;
      keptBytes -= (kept[old] as Uint8Array).length;
      kept[old] = undefined;
    }
    visit(pos, type, data);
  };

  let k = 0;
  let at = 0;
  let pending = new Uint8Array(64 * 1024);
  let pendingLength = 0;
  let keep = false;
  const startEntry = () => {
    if (k >= n) return;
    const span = entryEnd(k) - (sorted[k] as number);
    keep = span <= PACK_SCAN_MAX + PACK_ENTRY_HEAD_MAX;
    pendingLength = 0;
    if (keep && pending.length < span) pending = new Uint8Array(span);
  };
  startEntry();
  for await (const chunk of files.read(packPath)) {
    let c = 0;
    while (c < chunk.length && k < n && at < trailerAt) {
      const start = sorted[k] as number;
      if (at < start) {
        const skip = Math.min(chunk.length - c, start - at);
        at += skip;
        c += skip;
        continue;
      }
      const end = entryEnd(k);
      const take = Math.min(chunk.length - c, end - at);
      const part = chunk.subarray(c, c + take);
      at += take;
      c += take;
      const done = at === end;
      let bytes: Uint8Array | undefined;
      if (keep) {
        if (done && pendingLength === 0) bytes = part;
        else {
          pending.set(part, pendingLength);
          pendingLength += part.length;
          if (done) bytes = pending.subarray(0, pendingLength);
        }
      }
      if (!done) continue;
      if (bytes) entry(k, bytes);
      k++;
      startEntry();
    }
    if (k >= n || at >= trailerAt) break;
  }
  return unpacked;
}
