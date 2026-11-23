/**
 * `git pack-objects`: a v2 pack of given objects, streamed, after git's builtin/pack-objects.c
 * and JGit's PackWriter:
 *
 *  - the header (with the object count, known up front), then each entry, then the SHA-1 of
 *    everything before it, computed while streaming. Output is gathered in 64 KiB chunks and
 *    nothing else is buffered: whole objects stream from the store through zlib;
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
import { deflate, deflatePako } from "@statewalker/vcs-utils/compression";
import {
  createGitDeltaIndex,
  encodeGitDelta,
  type GitDeltaIndex,
} from "@statewalker/vcs-utils/diff";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import { DEFAULT_BIG_FILE_THRESHOLD } from "../history/blobs/index.js";

// still available from `@statewalker/vcs-core/pack`, where it used to be defined
export { DEFAULT_BIG_FILE_THRESHOLD };

import { type GitObject, type GitObjects, objectFormatOf } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { MissingObjectError } from "./list-objects.js";
import type { PackedEntry, PackedEntryKind } from "./pack-file.js";

/** What `writePack` reads objects from. */
export type PackObjectSource = Pick<GitObjects, "get" | "header"> &
  Partial<Pick<GitObjects, "objectFormat">>;

/** An object to write: its id, or its id with what is known of it (as `listObjects` yields). */
export type PackObjectRef =
  | ObjectId
  | {
      id: ObjectId;
      type?: ObjectTypeString;
      path?: string;
      /** The path's name hash, when known without the path (a bitmap's name-hash cache) */
      nameHash?: number;
    };

/** A stored entry `writePack` may copy (a `PackSet` is one source of them). */
export type ReusableEntry = Pick<PackedEntry, "kind" | "size" | "baseId" | "raw" | "data"> & {
  /**
   * The pack holding the entry (`PackSet` gives its id): the delta search does not try again a
   * delta between two objects of one pack where the target is stored whole (git's try_delta,
   * with reused deltas: that pack's writer tried it and kept the object whole).
   */
  packId?: string;
};

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
  /**
   * zlib level of the entries written (git's `pack.compression`, else `core.compression`;
   * -1 is zlib's default, 6). Entries copied as stored keep theirs, as git's do without `-F`.
   * Default: the runtime's deflate at its default level.
   */
  compression?: number;
  /**
   * The object format (default: the store's, `objectFormatOf(objects)`): the pack's trailer
   * hash and the width of REF_DELTA base ids
   */
  objectFormat?: ObjectFormat;
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
/** Bytes of output gathered before they are hashed and yielded. */
const OUT_CHUNK = 64 * 1024;

interface Planned {
  id: ObjectId;
  type?: ObjectTypeString;
  size?: number;
  nameHash: number;
  /** a stored entry to copy */
  reuse?: ReusableEntry;
  /** the written object a reused delta is on (undefined: a have of a thin pack) */
  reuseBase?: Planned;
  /** the pack the object is stored whole in, when reused deltas are on (git's IN_PACK) */
  wholeIn?: string;
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
  /** walk marks of breakReuseCycles (1 on the path, 2 done) and limitReusedChains (3 depth known) */
  mark?: number;
  /** the root of the reused chain this delta is on (null: a have of a thin pack) */
  chainRoot?: Planned | null;
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
  const format = options.objectFormat ?? objectFormatOf(objects as GitObjects);
  const reuseObjects = options.reuseObjects ?? true;
  const reuseDeltas = options.reuseDeltas ?? true;
  const ofsDelta = options.ofsDelta ?? true;
  const level = options.compression;
  if (level !== undefined && (!Number.isInteger(level) || level < -1 || level > 9))
    throw new RangeError(`bad pack compression level ${level}`);
  const compress =
    level === undefined
      ? (s: AsyncIterable<Uint8Array>) => deflate(s)
      : (s: AsyncIterable<Uint8Array>) => deflatePako(s, { level });
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
      nameHash: r.nameHash ?? packNameHash(r.path),
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
      haves.set(r.id, {
        id: r.id,
        type: r.type,
        nameHash: r.nameHash ?? packNameHash(r.path),
        depth: 0,
        have: true,
      });
    }
  }

  if (options.packs && (reuseObjects || reuseDeltas)) {
    for (const p of order) {
      const e = await options.packs.entry(p.id);
      if (!e) continue;
      // git turns reuse_delta off without reuse_object (`-F`), and with it the same-pack skip
      if (e.kind <= 4 && reuseDeltas && reuseObjects && e.packId !== undefined)
        p.wholeIn = e.packId;
      if (e.kind <= 4 && reuseObjects) {
        p.reuse = e;
        p.type = TYPE_NAME[e.kind];
        p.size = e.size;
      } else if ((e.kind === OFS_DELTA || e.kind === REF_DELTA) && reuseDeltas && e.baseId) {
        // kept only if its base is written or is a have of a thin pack
        const base = byId.get(e.baseId);
        if (base || haves.has(e.baseId)) {
          p.reuse = e;
          p.reuseBase = base;
        }
      }
    }
    breakReuseCycles(order);
    // git's break_delta_chains: reused chains are kept within the depth limit, here or after
    // the search (which never makes a base of reused deltas so deep that they pass it)
    limitReusedChains(order, search?.depth ?? DEFAULT_DEPTH);
  }

  if (search) {
    await searchDeltas(objects, order, haves, search, bigFileThreshold, format.rawLength);
  }

  // ---- write ----
  // Bases first (an OFS delta points back to its base), each object once: the order the
  // entries are written in, known before the first byte.
  const writeOrder: Planned[] = [];
  const queued = new Set<Planned>();
  const chain: Planned[] = [];
  for (const top of order) {
    let p: Planned | undefined = top;
    while (p && !p.have && !queued.has(p)) {
      queued.add(p);
      chain.push(p);
      p = p.reuse?.baseId ? p.reuseBase : p.deltaBase;
    }
    while (chain.length) writeOrder.push(chain.pop() as Planned);
  }

  // Output goes through one buffer, hashed and yielded when full (or at a streamed object):
  // entries are mostly small, and a chunk (and a hash update) per header costs more than they do.
  const hasher = format.createHasher();
  let offset = 0;
  let crc: CRC32 | undefined;
  let buf = new Uint8Array(OUT_CHUNK);
  let used = 0;
  const emit = (chunk: Uint8Array) => {
    crc?.update(chunk);
    offset += chunk.length;
    if (chunk.length > buf.length - used) {
      if (used > 0) full.push(take());
      if (chunk.length >= buf.length) {
        hasher.update(chunk);
        full.push(chunk);
        return;
      }
    }
    buf.set(chunk, used);
    used += chunk.length;
  };
  const full: Uint8Array[] = [];
  /** The buffered bytes, hashed; a new buffer takes their place. */
  const take = (): Uint8Array => {
    const out = buf.subarray(0, used);
    hasher.update(out);
    buf = new Uint8Array(OUT_CHUNK);
    used = 0;
    return out;
  };

  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(head.buffer).setUint32(8, order.length);
  emit(head);

  for (const p of writeOrder) {
    const start = offset;
    crc = onEntry ? new CRC32() : undefined;
    let kind: PackedEntryKind;
    let baseId: ObjectId | undefined;
    let reused = false;
    if (p.reuse && (p.reuse.kind <= 4 || p.reuse.baseId)) {
      reused = true;
      if (p.reuse.kind <= 4) {
        kind = p.reuse.kind;
        emit(entryHeader(kind, p.reuse.size));
      } else {
        baseId = p.reuse.baseId as ObjectId;
        kind = deltaKind(p.reuseBase, ofsDelta);
        emit(deltaHeader(kind, p.reuse.size, start, p.reuseBase, baseId));
      }
      const data = p.reuse.data?.();
      if (data) {
        // a view into the pack's cached windows: copied before it leaves as a chunk of its own
        const bytes = data instanceof Uint8Array ? data : await data;
        emit(bytes.length >= OUT_CHUNK ? bytes.slice() : bytes);
      } else {
        for await (const c of p.reuse.raw()) {
          emit(c);
          while (full.length) yield full.shift() as Uint8Array;
        }
      }
    } else if (p.deltaBase) {
      const d = p.delta ?? (await recomputeDelta(objects, p));
      p.delta = undefined;
      baseId = p.deltaBase.id;
      kind = deltaKind(p.deltaBase.have ? undefined : p.deltaBase, ofsDelta);
      emit(deltaHeader(kind, d.length, start, p.deltaBase.have ? undefined : p.deltaBase, baseId));
      for await (const c of compress(once(d))) emit(c);
    } else {
      const o = await objects.get(p.id);
      if (!o) throw new MissingObjectError(`object ${p.id} is missing`);
      kind = TYPE_CODE[o.type];
      emit(entryHeader(kind, o.size));
      for await (const c of compress(sized(o, p.id))) {
        emit(c);
        while (full.length) yield full.shift() as Uint8Array;
      }
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
    while (full.length) yield full.shift() as Uint8Array;
  }
  if (used > 0) yield take();
  yield hasher.digest();
}

/** OFS when the base is written in this pack and OFS deltas are on; REF otherwise. */
function deltaKind(base: Planned | undefined, ofsDelta: boolean): PackedEntryKind {
  return base && ofsDelta ? OFS_DELTA : REF_DELTA;
}

/** Where entry headers are built: `emit` copies them out before the next one is. */
const HEADER = new Uint8Array(64);
const OFS_SCRATCH = new Uint8Array(16);

function deltaHeader(
  kind: PackedEntryKind,
  size: number,
  at: number,
  base: Planned | undefined,
  baseId: ObjectId,
): Uint8Array {
  const n = putEntryHeader(kind, size);
  if (kind !== OFS_DELTA) {
    const raw = hexToBytes(baseId);
    HEADER.set(raw, n);
    return HEADER.subarray(0, n + raw.length);
  }
  // the back-offset: big-endian 7-bit groups, each continuation adding one
  let back = at - (base?.offset as number);
  let k = OFS_SCRATCH.length - 1;
  OFS_SCRATCH[k] = back & 127;
  back = Math.floor(back / 128);
  while (back > 0) {
    back--;
    OFS_SCRATCH[--k] = 0x80 | (back & 127);
    back = Math.floor(back / 128);
  }
  HEADER.set(OFS_SCRATCH.subarray(k), n);
  return HEADER.subarray(0, n + OFS_SCRATCH.length - k);
}

/** An entry header: kind and size (4 bits, then 7 per byte). */
function entryHeader(kind: number, size: number): Uint8Array {
  return HEADER.subarray(0, putEntryHeader(kind, size));
}

/** Writes an entry header into `HEADER`; its length. */
function putEntryHeader(kind: number, size: number): number {
  let n = 0;
  let b = (kind << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    HEADER[n++] = b | 0x80;
    b = rest & 127;
    rest = Math.floor(rest / 128);
  }
  HEADER[n++] = b;
  return n;
}

/**
 * Reused deltas whose bases form a cycle (copies from different packs, each a delta on the
 * other) cannot all be written as deltas: the first of each cycle is written whole.
 */
function breakReuseCycles(order: Planned[]) {
  const path: Planned[] = [];
  for (const start of order) {
    let p: Planned | undefined = start;
    while (p && p.mark === undefined) {
      p.mark = 1; // on the path
      path.push(p);
      const b: ObjectId | undefined = p.reuse?.baseId;
      p = b ? p.reuseBase : undefined;
      if (p && p.mark === 1) {
        p.reuse = undefined; // break the cycle here
        break;
      }
    }
    for (const x of path) x.mark = 2; // done
    path.length = 0;
  }
}

/**
 * The depth of each reused delta (its chain down to a whole object or a have); one that would
 * pass `maxDepth` is written whole instead (git's break_delta_chains), starting a new chain.
 * Then each object at the root of reused chains records the longest chain on it (`reusedAbove`),
 * so the search does not make it a delta those chains would pass the limit on.
 */
function limitReusedChains(order: Planned[], maxDepth: number) {
  const depthOf = (p: Planned): number => {
    if (p.mark === 3) return p.depth;
    p.mark = 3;
    const baseId = p.reuse && p.reuse.kind > 4 ? p.reuse.baseId : undefined;
    const base = baseId ? p.reuseBase : undefined;
    let d = baseId ? (base ? depthOf(base) + 1 : 1) : 0; // 1: on a have of a thin pack
    if (d > maxDepth) {
      p.reuse = undefined; // written whole: the chain is broken here
      d = 0;
    }
    p.depth = d;
    return d;
  };
  for (const p of order) depthOf(p);
  // each chain's root found once, for every delta on it
  const path: Planned[] = [];
  for (const p of order) {
    if (!(p.reuse && p.reuse.kind > 4)) continue;
    let root: Planned | undefined | null = p;
    while (root?.reuse && root.reuse.kind > 4 && root.reuse.baseId) {
      if (root.chainRoot !== undefined) {
        root = root.chainRoot;
        break;
      }
      path.push(root);
      root = root.reuseBase;
    }
    for (const x of path) x.chainRoot = root ?? null;
    path.length = 0;
    if (root) root.reusedAbove = Math.max(root.reusedAbove ?? 0, p.depth);
  }
}

/**
 * git's pack_name_hash (pack-objects.h): over the path's bytes, the last ones weigh most;
 * git's isspace bytes (tab, LF, CR, space: not VT or FF) are skipped. A path that is not ASCII
 * is hashed as its bytes (`encodeGitPath`: UTF-8, escaped bytes of a non-UTF-8 name back as
 * they are stored), so the hash is the one git computes from the tree entry's name.
 */
export function packNameHash(path: string | undefined): number {
  if (!path) return 0;
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c >= 0x80) return packNameHashBytes(encodeGitPath(path));
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    h = ((h >>> 2) + (c << 24)) >>> 0;
  }
  return h;
}

/** git's pack_name_hash over raw name bytes (up to a NUL, as git's C string ends there). */
export function packNameHashBytes(bytes: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] as number;
    if (c === 0) break;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    h = ((h >>> 2) + (c << 24)) >>> 0;
  }
  return h;
}

/** The type and size of each searchable object, read from its header. */
async function header(objects: PackObjectSource, p: Planned): Promise<boolean> {
  if (p.type !== undefined && p.size !== undefined) return true;
  // the entry headers when the store can answer from them (no delta chain applied)
  const h = objects.header ? await objects.header(p.id) : undefined;
  if (h) {
    p.type = h.type;
    p.size = h.size;
    return true;
  }
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
  /** read on first use */
  data?: Uint8Array;
  index?: GitDeltaIndex;
  bytes: number;
}

/**
 * git's find_deltas: candidates sorted by type, name hash, haves first and size (largest first), each tried
 * against the previous `window` ones of its type; the smallest delta within git's size limit
 * wins. Objects reused as deltas are neither targets nor bases; an object with reused deltas on
 * it becomes a delta only where their chains stay within the depth limit. Contents are read
 * when a delta is first tried with them, and a target stored whole in the pack its base is in
 * is not tried again (git's try_delta under reused deltas).
 */
async function searchDeltas(
  objects: PackObjectSource,
  order: Planned[],
  haves: Map<ObjectId, Planned>,
  o: DeltaSearchOptions,
  bigFileThreshold: number,
  rawLength: number,
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
  /** An entry's content, read the first time a delta is tried with it (git's try_delta). */
  const dataOf = async (w: WindowEntry): Promise<Uint8Array> => {
    if (!w.data) {
      w.data = await load(objects, w.p.id);
      w.bytes += w.data.length;
      held += w.data.length;
    }
    return w.data;
  };
  for (const p of candidates) {
    const me: WindowEntry = { p, bytes: 0 };
    if (!p.have) {
      let best: { base: WindowEntry; delta: Uint8Array } | undefined;
      for (let i = window.length - 1; i >= 0; i--) {
        const w = window[i] as WindowEntry;
        if (w.p.type !== p.type) continue;
        // a delta between two objects of one pack, the target stored whole, was tried (and
        // discarded) when that pack was written; a have is always tried
        if (p.wholeIn !== undefined && p.wholeIn === w.p.wholeIn && !w.p.have) continue;
        // the reused deltas on p get as much deeper as p does
        if (w.p.depth + 1 + (p.reusedAbove ?? 0) > maxDepth) continue;
        // git's try_delta size limit, tighter for bases deep in a chain
        const trgSize = p.size as number;
        const srcSize = w.p.size as number;
        let maxSize: number;
        let refDepth: number;
        if (!best) {
          // try_delta: trg_size / 2 - the_hash_algo->rawsz
          maxSize = Math.floor(trgSize / 2) - rawLength;
          refDepth = 1;
        } else {
          maxSize = best.delta.length;
          refDepth = p.depth;
        }
        maxSize = Math.floor((maxSize * (maxDepth - w.p.depth)) / (maxDepth - refDepth + 1));
        if (maxSize <= 0) continue;
        const sizeDiff = srcSize < trgSize ? trgSize - srcSize : 0;
        if (sizeDiff >= maxSize) continue;
        if (trgSize < srcSize / 32) continue;
        const data = await dataOf(me);
        const base = await dataOf(w);
        if (!w.index) {
          w.index = createGitDeltaIndex(base);
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
    window.push(me);
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
