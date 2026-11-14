/**
 * `git pack-objects`: a v2 pack of given objects, streamed, after git's builtin/pack-objects.c
 * and JGit's PackWriter:
 *
 *  - the header (with the object count, known up front), then each entry, then the SHA-1 of
 *    everything before it, computed while streaming. Nothing is buffered beyond one entry's
 *    chunk: whole objects stream from the store through zlib;
 *  - reuse (JGit's reuseObjects / reuseDeltas): an object a pack holds is copied as stored,
 *    its compressed bytes untouched (`PackedEntry.raw()`). A reused delta whose base is written
 *    too becomes an OFS delta with the base's new offset (or stays a REF delta); a delta whose
 *    base is neither written nor a have of a thin pack is written whole;
 *  - the delta search (off by default): git's windowed search over the candidates sorted by
 *    type, name hash and size, window 10 and depth 50, with `encodeGitDelta`. Only the window's
 *    objects are held, each under a size cap; blobs over `bigFileThreshold` are not searched;
 *  - the depth limit holds for reused chains too (git's break_delta_chains): a stored chain
 *    deeper than it is broken by writing an object whole, and the search never turns the base
 *    of reused deltas into a delta they would pass the limit on;
 *  - thin packs: deltas against `haves` the receiver has, which are not written;
 *  - a base is always written before its deltas, whatever the order of `ids`.
 */
import { deflate } from "@statewalker/vcs-utils/compression";
import {
  createGitDeltaIndex,
  encodeGitDelta,
  type GitDeltaIndex,
} from "@statewalker/vcs-utils/diff";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import { DEFAULT_BIG_FILE_THRESHOLD } from "../history/blobs/index.js";

// still available from `@statewalker/vcs-core/pack`, where it used to be defined
export { DEFAULT_BIG_FILE_THRESHOLD };

import type { GitObject, GitObjects } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { MissingObjectError } from "./list-objects.js";
import type { PackedEntry, PackedEntryKind } from "./pack-file.js";

/** What `writePack` reads objects from. */
export type PackObjectSource = Pick<GitObjects, "get">;

/** An object to write: its id, or its id with what is known of it (as `listObjects` yields). */
export type PackObjectRef = ObjectId | { id: ObjectId; type?: ObjectTypeString; path?: string };

/** A stored entry `writePack` may copy (a `PackSet` is one source of them). */
export type ReusableEntry = Pick<PackedEntry, "kind" | "size" | "baseId" | "raw">;

/** Where stored entries are looked up for reuse: a `PackSet`, or anything shaped like one. */
export interface PackReuseSource {
  entry(id: ObjectId): Promise<ReusableEntry | undefined>;
}

export interface DeltaSearchOptions {
  /** Objects a candidate is compared with (git's pack.window). Default 10. */
  window?: number;
  /**
   * Longest delta chain (git's pack.depth), reused deltas included: a stored chain longer than
   * this is broken by writing an object whole, and an object with reused deltas on it becomes
   * a delta only if they stay within it. Default 50 (also the limit for reused chains when the
   * search is off).
   */
  depth?: number;
  /** Largest object held in the window; bigger ones are not searched. Default 16 MiB. */
  maxObjectSize?: number;
  /** Bytes the window may hold, objects and their indexes (git's pack.windowMemory). Default 256 MiB. */
  windowMemory?: number;
  /** Bytes of computed deltas kept until written; others are computed again. Default 16 MiB. */
  deltaCacheSize?: number;
}

export interface WritePackOptions {
  /** Stored entries to copy (a `PackSet`). Without it every object is written from `objects`. */
  packs?: PackReuseSource;
  /** Copy whole objects as stored. Default true. */
  reuseObjects?: boolean;
  /** Copy deltas as stored (when their base is written or is a have of a thin pack). Default true. */
  reuseDeltas?: boolean;
  /** Search deltas (git's window search); `true` takes the defaults. Default false. */
  deltaSearch?: boolean | DeltaSearchOptions;
  /** Write deltas on a written base as OFS deltas (git's `ofs-delta`). Default true. */
  ofsDelta?: boolean;
  /** Allow deltas against `haves`, which are not written (git's `--thin`). Default false. */
  thin?: boolean;
  /** Objects the receiver has: delta bases of a thin pack (with a path, for the search). */
  haves?: Iterable<PackObjectRef>;
  /** Blobs larger than this are written whole, never searched (git's core.bigFileThreshold). Default 50 MiB. */
  bigFileThreshold?: number;
  /** Called after each entry is written (for an idx: offsets and CRC-32). */
  onEntry?: (entry: WrittenPackEntry) => void;
}

/** One entry as written. */
export interface WrittenPackEntry {
  id: ObjectId;
  /** Offset of the entry's header in the pack. */
  offset: number;
  /** CRC-32 of the entry (header and data), as an idx v2 records it. */
  crc32: number;
  /** 1-4 whole object, 6 OFS delta, 7 REF delta. */
  kind: PackedEntryKind;
  /** The delta's base. */
  baseId?: ObjectId;
  /** Whether the entry was copied as stored. */
  reused: boolean;
}

const TYPE_CODE: Record<ObjectTypeString, PackedEntryKind> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const TYPE_NAME: Record<number, ObjectTypeString> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;
/** git's pack.depth: the longest delta chain written. */
const DEFAULT_DEPTH = 50;
/** git's try_delta: smaller targets are never deltified. */
const MIN_DELTA_TARGET = 50;

interface Planned {
  id: ObjectId;
  type?: ObjectTypeString;
  size?: number;
  nameHash: number;
  /** a stored entry to copy */
  reuse?: ReusableEntry;
  /** a base chosen by the search */
  deltaBase?: Planned;
  delta?: Uint8Array;
  /** length of the delta chain down to a whole object (reused deltas included) */
  depth: number;
  /** longest chain of reused deltas on top of this object (they get deeper if it becomes a delta) */
  reusedAbove?: number;
  /** a have: a base only, never written */
  have: boolean;
  offset?: number;
}

/**
 * Streams a pack of `ids` read from `objects`.
 *
 * @example
 * ```typescript
 * const listed = [];
 * for await (const o of listObjects(objects, { wants, haves })) listed.push(o);
 * for await (const chunk of writePack(objects, listed, { packs, deltaSearch: true })) send(chunk);
 * ```
 */
export async function* writePack(
  objects: PackObjectSource,
  ids: readonly PackObjectRef[],
  options: WritePackOptions = {},
): AsyncGenerator<Uint8Array> {
  const reuseObjects = options.reuseObjects ?? true;
  const reuseDeltas = options.reuseDeltas ?? true;
  const ofsDelta = options.ofsDelta ?? true;
  const bigFileThreshold = options.bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD;
  const search =
    options.deltaSearch === true ? {} : options.deltaSearch ? options.deltaSearch : undefined;
  const onEntry = options.onEntry;

  // ---- plan: one record per object, in order, without duplicates ----
  const byId = new Map<ObjectId, Planned>();
  const order: Planned[] = [];
  for (const ref of ids) {
    const r = typeof ref === "string" ? { id: ref } : ref;
    if (byId.has(r.id)) continue;
    const p: Planned = {
      id: r.id,
      type: r.type,
      nameHash: nameHash(r.path),
      depth: 0,
      have: false,
    };
    byId.set(r.id, p);
    order.push(p);
  }
  const haves = new Map<ObjectId, Planned>();
  if (options.thin) {
    for (const ref of options.haves ?? []) {
      const r = typeof ref === "string" ? { id: ref } : ref;
      if (byId.has(r.id) || haves.has(r.id)) continue;
      haves.set(r.id, { id: r.id, type: r.type, nameHash: nameHash(r.path), depth: 0, have: true });
    }
  }

  if (options.packs && (reuseObjects || reuseDeltas)) {
    for (const p of order) {
      const e = await options.packs.entry(p.id);
      if (!e) continue;
      if (e.kind <= 4 && reuseObjects) {
        p.reuse = e;
        p.type = TYPE_NAME[e.kind];
        p.size = e.size;
      } else if ((e.kind === OFS_DELTA || e.kind === REF_DELTA) && reuseDeltas && e.baseId) {
        // kept only if its base is written or is a have of a thin pack
        if (byId.has(e.baseId) || haves.has(e.baseId)) p.reuse = e;
      }
    }
    breakReuseCycles(order, byId);
    // git's break_delta_chains: reused chains are kept within the depth limit, here or after
    // the search (which never makes a base of reused deltas so deep that they pass it)
    limitReusedChains(order, byId, search?.depth ?? DEFAULT_DEPTH);
  }

  if (search) await searchDeltas(objects, order, haves, search, bigFileThreshold);

  // ---- write ----
  const hasher = createSha1();
  let offset = 0;
  let crc: CRC32 | undefined;
  const emit = (chunk: Uint8Array) => {
    hasher.update(chunk);
    crc?.update(chunk);
    offset += chunk.length;
    return chunk;
  };

  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(head.buffer).setUint32(8, order.length);
  yield emit(head);

  async function* writeOne(p: Planned): AsyncGenerator<Uint8Array> {
    if (p.offset !== undefined) return;
    // the base first: an OFS delta points back to it
    const base = p.reuse?.baseId ? byId.get(p.reuse.baseId) : p.deltaBase;
    if (base && !base.have && base.offset === undefined) yield* writeOne(base);
    const start = offset;
    crc = onEntry ? new CRC32() : undefined;
    let kind: PackedEntryKind;
    let baseId: ObjectId | undefined;
    let reused = false;
    if (p.reuse && (p.reuse.kind <= 4 || p.reuse.baseId)) {
      reused = true;
      if (p.reuse.kind <= 4) {
        kind = p.reuse.kind;
        yield emit(entryHeader(kind, p.reuse.size));
      } else {
        baseId = p.reuse.baseId as ObjectId;
        kind = deltaKind(byId.get(baseId), ofsDelta);
        yield emit(deltaHeader(kind, p.reuse.size, start, byId.get(baseId), baseId));
      }
      for await (const c of p.reuse.raw()) yield emit(c);
    } else if (p.deltaBase) {
      const d = p.delta ?? (await recomputeDelta(objects, p));
      p.delta = undefined;
      baseId = p.deltaBase.id;
      kind = deltaKind(p.deltaBase.have ? undefined : p.deltaBase, ofsDelta);
      yield emit(
        deltaHeader(kind, d.length, start, p.deltaBase.have ? undefined : p.deltaBase, baseId),
      );
      for await (const c of deflate(once(d))) yield emit(c);
    } else {
      const o = await objects.get(p.id);
      if (!o) throw new MissingObjectError(`object ${p.id} is missing`);
      kind = TYPE_CODE[o.type];
      yield emit(entryHeader(kind, o.size));
      for await (const c of deflate(sized(o, p.id))) yield emit(c);
    }
    p.offset = start;
    onEntry?.({
      id: p.id,
      offset: start,
      crc32: crc ? crc.getValue() : 0,
      kind,
      ...(baseId ? { baseId } : {}),
      reused,
    });
    crc = undefined;
  }

  for (const p of order) yield* writeOne(p);
  yield hasher.digest();
}

/** OFS when the base is written in this pack and OFS deltas are on; REF otherwise. */
function deltaKind(base: Planned | undefined, ofsDelta: boolean): PackedEntryKind {
  return base && ofsDelta ? OFS_DELTA : REF_DELTA;
}

function deltaHeader(
  kind: PackedEntryKind,
  size: number,
  at: number,
  base: Planned | undefined,
  baseId: ObjectId,
): Uint8Array {
  const h = entryHeader(kind, size);
  const tail = kind === OFS_DELTA ? ofsVarint(at - (base?.offset as number)) : hexToBytes(baseId);
  const out = new Uint8Array(h.length + tail.length);
  out.set(h);
  out.set(tail, h.length);
  return out;
}

/** An entry header: kind and size (4 bits, then 7 per byte). */
function entryHeader(kind: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (kind << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 127;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return Uint8Array.from(out);
}

/** An OFS_DELTA back-offset (big-endian 7-bit groups, each continuation adding one). */
function ofsVarint(n: number): Uint8Array {
  const out = [n & 127];
  let rest = Math.floor(n / 128);
  while (rest > 0) {
    rest--;
    out.unshift(0x80 | (rest & 127));
    rest = Math.floor(rest / 128);
  }
  return Uint8Array.from(out);
}

/**
 * Reused deltas whose bases form a cycle (copies from different packs, each a delta on the
 * other) cannot all be written as deltas: the first of each cycle is written whole.
 */
function breakReuseCycles(order: Planned[], byId: Map<ObjectId, Planned>) {
  const state = new Map<Planned, 1 | 2>(); // 1 on the path, 2 done
  for (const start of order) {
    const path: Planned[] = [];
    let p: Planned | undefined = start;
    while (p && !state.has(p)) {
      state.set(p, 1);
      path.push(p);
      const b: ObjectId | undefined = p.reuse?.baseId;
      p = b ? byId.get(b) : undefined;
      if (p && state.get(p) === 1) {
        p.reuse = undefined; // break the cycle here
        break;
      }
    }
    for (const x of path) state.set(x, 2);
  }
}

/**
 * The depth of each reused delta (its chain down to a whole object or a have); one that would
 * pass `maxDepth` is written whole instead (git's break_delta_chains), starting a new chain.
 * Then each object at the root of reused chains records the longest chain on it (`reusedAbove`),
 * so the search does not make it a delta those chains would pass the limit on.
 */
function limitReusedChains(order: Planned[], byId: Map<ObjectId, Planned>, maxDepth: number) {
  const done = new Set<Planned>();
  const depthOf = (p: Planned): number => {
    if (done.has(p)) return p.depth;
    done.add(p);
    const baseId = p.reuse && p.reuse.kind > 4 ? p.reuse.baseId : undefined;
    const base = baseId ? byId.get(baseId) : undefined;
    let d = baseId ? (base ? depthOf(base) + 1 : 1) : 0; // 1: on a have of a thin pack
    if (d > maxDepth) {
      p.reuse = undefined; // written whole: the chain is broken here
      d = 0;
    }
    p.depth = d;
    return d;
  };
  for (const p of order) depthOf(p);
  for (const p of order) {
    if (!(p.reuse && p.reuse.kind > 4)) continue;
    let root: Planned | undefined = p;
    while (root?.reuse && root.reuse.kind > 4 && root.reuse.baseId) {
      root = byId.get(root.reuse.baseId);
    }
    if (root) root.reusedAbove = Math.max(root.reusedAbove ?? 0, p.depth);
  }
}

/** git's pack_name_hash: the last characters of the path weigh most; spaces are skipped. */
function nameHash(path: string | undefined): number {
  if (!path) return 0;
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i) & 0xff;
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) continue;
    h = ((h >>> 2) + (c << 24)) >>> 0;
  }
  return h;
}

/** The type and size of each searchable object, read from its header. */
async function header(objects: PackObjectSource, p: Planned): Promise<boolean> {
  if (p.type !== undefined && p.size !== undefined) return true;
  const o = await objects.get(p.id);
  if (!o) {
    if (p.have) return false;
    throw new MissingObjectError(`object ${p.id} is missing`);
  }
  await o.content[Symbol.asyncIterator]().return?.();
  p.type = o.type;
  p.size = o.size;
  return true;
}

async function load(objects: PackObjectSource, id: ObjectId): Promise<Uint8Array> {
  const o = await objects.get(id);
  if (!o) throw new MissingObjectError(`object ${id} is missing`);
  const data = new Uint8Array(o.size);
  let at = 0;
  for await (const c of sized(o, id)) {
    data.set(c, at);
    at += c.length;
  }
  return data;
}

async function recomputeDelta(objects: PackObjectSource, p: Planned): Promise<Uint8Array> {
  const base = await load(objects, (p.deltaBase as Planned).id);
  const target = await load(objects, p.id);
  const d = encodeGitDelta(createGitDeltaIndex(base), target);
  if (!d) throw new Error(`delta of ${p.id} could not be computed again`);
  return d;
}

interface WindowEntry {
  p: Planned;
  data: Uint8Array;
  index?: GitDeltaIndex;
  bytes: number;
}

/**
 * git's find_deltas: candidates sorted by type, name hash, haves first and size (largest first), each tried
 * against the previous `window` ones of its type; the smallest delta within git's size limit
 * wins. Objects reused as deltas are neither targets nor bases; an object with reused deltas on
 * it becomes a delta only where their chains stay within the depth limit.
 */
async function searchDeltas(
  objects: PackObjectSource,
  order: Planned[],
  haves: Map<ObjectId, Planned>,
  o: DeltaSearchOptions,
  bigFileThreshold: number,
) {
  const windowSize = o.window ?? 10;
  const maxDepth = o.depth ?? 50;
  const maxObjectSize = Math.min(o.maxObjectSize ?? 16 * 2 ** 20, bigFileThreshold);
  const windowMemory = o.windowMemory ?? 256 * 2 ** 20;
  let cacheLeft = o.deltaCacheSize ?? 16 * 2 ** 20;
  if (windowSize <= 0 || maxDepth <= 0) return;

  // haves only as bases for objects of the same type and name (git's preferred bases by path)
  const names = new Set(order.map((p) => p.nameHash));
  const bases = [...haves.values()].filter((h) => h.nameHash === 0 || names.has(h.nameHash));
  const candidates: Planned[] = [];
  for (const p of [...order, ...bases]) {
    if (p.reuse && p.reuse.kind > 4) continue; // a reused delta
    if (!(await header(objects, p))) continue;
    const size = p.size as number;
    if (size > maxObjectSize || (!p.have && size < MIN_DELTA_TARGET)) continue;
    candidates.push(p);
  }
  const rank = new Map(candidates.map((p, i) => [p, i]));
  candidates.sort(
    (a, b) =>
      TYPE_CODE[a.type as ObjectTypeString] - TYPE_CODE[b.type as ObjectTypeString] ||
      a.nameHash - b.nameHash ||
      // the receiver's objects first: bases for what follows (git's preferred_base)
      Number(b.have) - Number(a.have) ||
      (b.size as number) - (a.size as number) ||
      (rank.get(a) as number) - (rank.get(b) as number),
  );

  const window: WindowEntry[] = [];
  let held = 0;
  for (const p of candidates) {
    const data = await load(objects, p.id);
    if (!p.have) {
      let best: { base: WindowEntry; delta: Uint8Array } | undefined;
      for (let i = window.length - 1; i >= 0; i--) {
        const w = window[i] as WindowEntry;
        // the reused deltas on p get as much deeper as p does
        if (w.p.type !== p.type || w.p.depth + 1 + (p.reusedAbove ?? 0) > maxDepth) continue;
        // git's try_delta size limit, tighter for bases deep in a chain
        const trgSize = data.length;
        let maxSize: number;
        let refDepth: number;
        if (!best) {
          maxSize = Math.floor(trgSize / 2) - 20;
          refDepth = 1;
        } else {
          maxSize = best.delta.length;
          refDepth = p.depth;
        }
        maxSize = Math.floor((maxSize * (maxDepth - w.p.depth)) / (maxDepth - refDepth + 1));
        if (maxSize <= 0) continue;
        const sizeDiff = w.data.length < trgSize ? trgSize - w.data.length : 0;
        if (sizeDiff >= maxSize) continue;
        if (trgSize < w.data.length / 32) continue;
        if (!w.index) {
          w.index = createGitDeltaIndex(w.data);
          const extra = w.index.start.byteLength + w.index.pos.byteLength * 2;
          w.bytes += extra;
          held += extra;
        }
        const d = encodeGitDelta(w.index, data, maxSize);
        if (d && d.length <= maxSize && (!best || d.length < best.delta.length)) {
          best = { base: w, delta: d };
          p.depth = w.p.depth + 1;
        }
      }
      if (best) {
        // a whole reused copy is replaced by the smaller delta
        p.reuse = undefined;
        p.deltaBase = best.base.p;
        p.depth = best.base.p.depth + 1;
        if (best.delta.length <= cacheLeft) {
          p.delta = best.delta;
          cacheLeft -= best.delta.length;
        }
      }
    }
    window.push({ p, data, bytes: data.length });
    held += data.length;
    while (window.length > windowSize || (held > windowMemory && window.length > 1)) {
      held -= (window.shift() as WindowEntry).bytes;
    }
  }
}

async function* once(d: Uint8Array): AsyncGenerator<Uint8Array> {
  yield d;
}

/** An object's content, checked against its declared size. */
async function* sized(o: GitObject, id: ObjectId): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const c of o.content) {
    n += c.length;
    if (n > o.size) throw new Error(`object ${id} is longer than its size ${o.size}`);
    yield c;
  }
  if (n !== o.size) throw new Error(`object ${id} is shorter than its size ${o.size}`);
}
