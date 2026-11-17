/**
 * Reading objects from one installed pack, as git's packfile.c and JGit's Pack do:
 *
 *  - open: the whole `.idx` (v2, or v1) is read and validated — magic and version, monotonic
 *    fan-out, exact length (the 64-bit offset table included), its own SHA-1, ids strictly sorted
 *    and inside their fan-out buckets, every large-offset index inside the 64-bit table — and the
 *    pack's trailer must be the pack checksum the idx records (an idx of another pack with the
 *    same object count passes every other check);
 *  - lookup: fan-out range, then binary search over the sorted ids;
 *  - a small entry (an object or a delta of at most 64 KiB) is read from the 64 KiB pack window
 *    holding its start, without looking up where it ends: the one-pass inflater
 *    (`inflateWhole`) stops at the end of its zlib stream, as git's unpack_entry does (an entry
 *    running past the window is read again from the window's tail and the next window). The
 *    windows are kept per pack and found synchronously, so reading an entry whose window is
 *    loaded awaits nothing;
 *  - a larger entry ends where the next one starts in pack order (git's reverse index, built
 *    lazily); it is read with two ranged reads: its header, then exactly its data;
 *  - a declared size above `maxObjectSize`, or above what zlib can expand the entry's compressed
 *    bytes to (~1032:1; checked for entries read with their extent, small ones being at most
 *    64 KiB), is refused before anything is allocated;
 *  - a whole object of at most 1 MiB read in one piece is inflated in one pass straight into its
 *    result and handed out whole (`GitObject.bytes`); larger ones stream from the inflater;
 *  - delta chains are walked down (iteratively) to a whole object or a cached one, then patched
 *    upwards with `applyGitDelta`, through a byte-bounded base cache (git's delta_base_cache)
 *    that keeps checkpoints spread along the chain; the steps in between are written into two
 *    buffers of the read, in turn;
 *  - callers always receive copies, never cached buffers;
 *  - a REF_DELTA base outside the pack resolves through `externalBase`, with the ids being
 *    resolved on this path (`visiting`), so a cycle across packs fails instead of recursing;
 *  - zlib and format errors raise `PackError`; storage errors pass through unchanged.
 */
import {
  CompressionError,
  createInflaterPool,
  InflateOverflowError,
  inflateWhole,
  type StreamInflater,
  TruncatedStreamError,
} from "@statewalker/vcs-utils/compression";
import { applyGitDelta, DeltaError } from "@statewalker/vcs-utils/diff";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { allocBytes } from "@statewalker/vcs-utils/streams";
import type { FilesApi } from "../common/files/index.js";
import type { ObjectId } from "../common/id/index.js";
import { type GitObject, ObjectIdMismatchError } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { PackError } from "./index-pack.js";

/** Pack entry kinds: 1–4 whole objects (commit, tree, blob, tag), 6 OFS_DELTA, 7 REF_DELTA. */
export type PackedEntryKind = 1 | 2 | 3 | 4 | 6 | 7;

/** An object's entry as stored in a pack, for reuse when writing another pack. */
export interface PackedEntry {
  kind: PackedEntryKind;
  /** The size in the entry header: the object's, or the delta data's. */
  size: number;
  /** A delta's base (an OFS_DELTA's base resolved through the idx). */
  baseId?: ObjectId;
  /** CRC-32 of the whole entry (header and compressed data), from the idx. */
  crc32: number;
  /**
   * The entry's compressed data (its zlib stream, without the entry header). The CRC of the
   * whole entry is checked in a first pass, before any byte is yielded (a mismatch throws
   * `PackError` from the first `next()`), and again while streaming, in case the file changed.
   * This reads the entry twice, which doubles the I/O for large reused entries.
   */
  raw(): AsyncIterable<Uint8Array>;
}

/** One installed pack (`pack-<packId>.pack` and its `.idx`). */
export interface Pack {
  /** hex SHA-1 of the pack (its trailer, recorded in the idx) */
  readonly packId: string;
  /** objects in the pack */
  readonly count: number;
  has(id: ObjectId): boolean;
  /** The ids in idx order (sorted). */
  ids(): Iterable<ObjectId>;
  /**
   * The object, or undefined if the pack does not hold `id`. With `verify`, the content is
   * re-hashed and its end throws `ObjectIdMismatchError` if it hashes to another id.
   */
  get(id: ObjectId, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /** The object's entry as stored, or undefined if the pack does not hold `id`. */
  entry(id: ObjectId): Promise<PackedEntry | undefined>;
}

/** A resolved object held by the base cache, or handed to a pack as an external base. */
export interface ResolvedObject {
  type: ObjectTypeString;
  data: Uint8Array;
}

/**
 * Resolves a REF_DELTA base that is not in the pack. `visiting` holds the ids being resolved on
 * this path (the base included): a lookup that reaches one of them again is a cycle.
 */
export type PackExternalBase = (
  id: ObjectId,
  visiting: ReadonlySet<ObjectId>,
) => Promise<ResolvedObject | undefined>;

/** Options of `get` used inside a pack set: the ids being resolved (cycle detection). */
export interface PackGetOptions {
  verify?: boolean;
  visiting?: ReadonlySet<ObjectId>;
}

export interface OpenPackOptions {
  /** Bytes of resolved delta bases kept across reads (git's core.deltaBaseCacheLimit). Default 16 MiB. */
  baseCacheBytes?: number;
  /** A cache shared with other packs (a pack set's); `baseCacheBytes` is then ignored. */
  baseCache?: DeltaBaseCache;
  /** Largest object accepted, by its header and by delta results. Default 1 GiB. */
  maxObjectSize?: number;
  /** Resolves REF_DELTA bases outside the pack (another pack, a loose object). */
  externalBase?: PackExternalBase;
}

/** Counters, for tests and diagnostics. */
export interface PackStats {
  /** entry inflations performed */
  readonly inflations: number;
  /** bytes the base cache holds, by its accounting */
  readonly cachedBytes: number;
  /** bytes the base cache entries really hold (equal to `cachedBytes`) */
  readonly cachedEntriesBytes: number;
  /** the most bytes the base cache ever held */
  readonly peakCachedBytes: number;
}

/** A pack opened by `openPack`: `Pack`, plus its paths and counters. */
export interface PackFile extends Pack {
  readonly packPath: string;
  readonly idxPath: string;
  readonly stats: PackStats;
  get(id: ObjectId, options?: PackGetOptions): Promise<GitObject | undefined>;
  /** Drops this pack's objects from the base cache. */
  close(): void;
}

const TYPES: (ObjectTypeString | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];
const OFS_DELTA = 6;
const REF_DELTA = 7;
const IDX_MAGIC = 0xff744f63;
/** inflater input per push: real data stays small, a bomb yields at most ~16 MiB per push */
const SLICE = 16 * 1024;
/** git's deepest --depth */
const MAX_CHAIN = 4095;
/** zlib expands at most ~1032:1 */
const MAX_EXPANSION = 1032;
const enc = new TextEncoder();
const hex = bytesToHex;

async function readAll(
  files: FilesApi,
  path: string,
  start?: number,
  length?: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path, start === undefined ? undefined : { start, length })) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Bytes of a pack read and kept at a time (JGit's WindowCache windows). */
const WINDOW = 64 * 1024;
/** Ranges longer than this are read from the file as they stream, never kept. */
const WINDOWED_MAX = 4 * WINDOW;

/** A window of a pack held by the cache, and the pack's map of windows that lists it. */
interface PackWindow {
  readonly bytes: Uint8Array;
  readonly owner: Map<number, PackWindow>;
  readonly index: number;
}

/**
 * Windows of pack files read before, most recently used last, shared by every pack opened
 * (bounded by `limit` bytes). A pack never changes once installed (its name is its
 * content's hash), so a window stays valid while its pack is open; reading an entry from
 * a window saves the file reads of its header and its data (git maps the pack instead).
 * Each pack keeps its loaded windows in its own map, by window index, so a read finds its
 * window synchronously; this cache orders them for eviction.
 */
class PackWindowCache {
  private readonly lru = new Set<PackWindow>();
  private held = 0;
  constructor(private readonly limit: number) {}

  /** the most recently used window (reads mostly stay in one window: no reordering then) */
  private last: PackWindow | undefined;

  /** Marks `w` most recently used. */
  touch(w: PackWindow): void {
    if (w === this.last) return;
    this.last = w;
    this.lru.delete(w);
    this.lru.add(w);
  }

  /** Adds a loaded window to `owner` (replacing one with the same index), evicting the oldest. */
  add(owner: Map<number, PackWindow>, index: number, bytes: Uint8Array): void {
    const old = owner.get(index);
    if (old) this.remove(old);
    const w: PackWindow = { bytes, owner, index };
    owner.set(index, w);
    this.lru.add(w);
    this.last = w;
    this.held += bytes.length;
    for (const x of this.lru) {
      if (this.held <= this.limit) break;
      this.remove(x);
    }
  }

  private remove(w: PackWindow): void {
    if (!this.lru.delete(w)) return;
    if (this.last === w) this.last = undefined;
    this.held -= w.bytes.length;
    if (w.owner.get(w.index) === w) w.owner.delete(w.index);
  }

  /** Forgets the windows of one pack (closed). */
  drop(owner: Map<number, PackWindow>): void {
    for (const w of [...owner.values()]) this.remove(w);
    owner.clear();
  }
}

const windows = new PackWindowCache(32 * 2 ** 20);

async function* once(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

/** Content whose read fails with `err` (a whole object whose stream is broken). */
function failing(err: unknown): AsyncIterable<Uint8Array> {
  let failed = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (failed) return { done: true, value: undefined };
        failed = true;
        throw err;
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        failed = true;
        return { done: true, value: undefined };
      },
    }),
  };
}

/**
 * Whole objects up to this size whose entry is read in one piece (at most `WINDOWED_MAX`
 * compressed bytes) are inflated in one call and handed out in memory (`GitObject.bytes`);
 * larger ones stream from the inflater.
 */
const WHOLE_MAX = 1024 * 1024;
/** Window bytes after an entry's start below which it is read across two windows. */
const OPEN_MIN = 64;
/**
 * Objects (and deltas) up to this size are read `open`, from their window, without the reverse
 * index; larger ones, whose compressed data can run past the next window, with their extent.
 */
const OPEN_MAX = WINDOW;
const EMPTY = new Uint8Array(0);

/** A copy for a caller (small ones share slabs: `allocBytes`). */
function copyOf(b: Uint8Array): Uint8Array {
  const out = allocBytes(b.length);
  out.set(b);
  return out;
}

/** Delta instructions are inflated here (grown as needed), then read once. */
const deltaScratch = new Uint8Array(OPEN_MAX);

/** An entry of the delta base cache, and the map (of its scope) that lists it. */
interface CachedBase<K> {
  readonly key: K;
  readonly value: ResolvedObject;
  readonly map: Map<K, CachedBase<K>>;
}

/** One pack's view of a shared `DeltaBaseCache`: entries keyed by pack offset. */
export interface DeltaBaseCacheScope {
  get(offset: number): ResolvedObject | undefined;
  put(offset: number, v: ResolvedObject): void;
  /** Drops this scope's entries. */
  drop(): void;
}

/**
 * A byte-bounded LRU of resolved objects, keyed by pack and offset (git's delta_base_cache).
 * One cache can serve every pack of a set, so the budget is the set's, not each pack's. A pack
 * reads it through its own `scope()` (numeric keys, no strings built per lookup); `get` and
 * `put` key entries by string (object ids, for unpacking).
 */
export class DeltaBaseCache {
  private readonly lru = new Set<CachedBase<unknown>>();
  private readonly byKey = new Map<string, CachedBase<string>>();
  private held = 0;
  private peak = 0;
  constructor(readonly limit: number) {}
  get bytes(): number {
    return this.held;
  }
  get peakBytes(): number {
    return this.peak;
  }
  /** bytes the entries really hold (tests check it equals `bytes`) */
  get entriesBytes(): number {
    let n = 0;
    for (const e of this.lru) n += e.value.data.length;
    return n;
  }
  get(key: string): ResolvedObject | undefined {
    return this.find(this.byKey, key);
  }
  put(key: string, v: ResolvedObject): void {
    this.add(this.byKey, key, v);
  }
  /** Drops every string-keyed entry whose key starts with `prefix`. */
  drop(prefix: string): void {
    for (const [k, e] of [...this.byKey]) if (k.startsWith(prefix)) this.remove(e);
  }
  /** A view keyed by pack offset, for one pack. */
  scope(): DeltaBaseCacheScope {
    const map = new Map<number, CachedBase<number>>();
    return {
      get: (offset) => this.find(map, offset),
      put: (offset, v) => this.add(map, offset, v),
      drop: () => {
        for (const e of [...map.values()]) this.remove(e);
      },
    };
  }

  private find<K>(map: Map<K, CachedBase<K>>, key: K): ResolvedObject | undefined {
    const e = map.get(key);
    if (!e) return undefined;
    this.lru.delete(e as CachedBase<unknown>);
    this.lru.add(e as CachedBase<unknown>);
    return e.value;
  }
  private add<K>(map: Map<K, CachedBase<K>>, key: K, value: ResolvedObject): void {
    if (value.data.length > this.limit || map.has(key)) return;
    const e: CachedBase<K> = { key, value, map };
    map.set(key, e);
    this.lru.add(e as CachedBase<unknown>);
    this.held += value.data.length;
    for (const x of this.lru) {
      if (this.held <= this.limit) break;
      this.remove(x);
    }
    this.peak = Math.max(this.peak, this.held);
  }
  private remove<K>(e: CachedBase<K>): void {
    if (!this.lru.delete(e as CachedBase<unknown>)) return;
    this.held -= e.value.data.length;
    if (e.map.get(e.key) === e) e.map.delete(e.key);
  }
}

/** An entry's header and, for a small entry, its compressed data (the bytes after the header). */
interface LoadedEntry {
  e: EntryHead;
  data?: Uint8Array;
  /**
   * `data` runs past the entry's end: to the end of the window holding its start (1), or of the
   * next window (2); the inflater finds where the entry ends. Absent: `data` is the entry's.
   */
  open?: 1 | 2;
}

interface EntryHead {
  offset: number;
  kind: number;
  size: number;
  dataStart: number;
  end: number;
  baseOffset?: number;
  baseId?: ObjectId;
}

/** The validated `.idx`: accessors over its bytes. */
interface IdxTable {
  version: 1 | 2;
  count: number;
  packId: string;
  idAt(i: number): Uint8Array;
  offsetOf(i: number): number;
  /** the entry's CRC-32 (v2 only) */
  crcOf(i: number): number | undefined;
  find(id: ObjectId): number;
}

/** The value of each hex digit (lowercase only, as object ids), -1 for any other code. */
const HEX_VALUE = new Int8Array(128).fill(-1);
for (let c = 0; c < 10; c++) HEX_VALUE[48 + c] = c;
for (let c = 0; c < 6; c++) HEX_VALUE[97 + c] = 10 + c;
/** The id being looked up, as bytes (lookups are synchronous: one buffer serves all). */
const idKey = new Uint8Array(20);

/** Writes the 40-digit lowercase hex `id` into `out` as 20 bytes; false if it is not an id. */
function parseId(id: unknown, out: Uint8Array): boolean {
  if (typeof id !== "string" || id.length !== 40) return false;
  for (let k = 0; k < 20; k++) {
    const hi = id.charCodeAt(2 * k);
    const lo = id.charCodeAt(2 * k + 1);
    const h = hi < 128 ? (HEX_VALUE[hi] as number) : -1;
    const l = lo < 128 ? (HEX_VALUE[lo] as number) : -1;
    if (h < 0 || l < 0) return false;
    out[k] = (h << 4) | l;
  }
  return true;
}

/** Parses and validates an `.idx` v2 or v1 (git's check_packed_git_idx). */
function parseIdx(idx: Uint8Array, idxPath: string, sum: Uint8Array): IdxTable {
  if (idx.length < 1024 + 40) throw new PackError(`${idxPath}: idx too short`);
  const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  const v2 = iv.getUint32(0) === IDX_MAGIC;
  if (v2 && iv.getUint32(4) !== 2)
    throw new PackError(`${idxPath}: unsupported idx version ${iv.getUint32(4)}`);
  const fanAt = v2 ? 8 : 0;
  const fan = (b: number) => iv.getUint32(fanAt + b * 4);
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const f = fan(i);
    if (f < prev) throw new PackError(`${idxPath}: fan-out not monotonic`);
    prev = f;
  }
  const n = prev;
  // layout: v2 ids | crcs | offsets | large offsets; v1 (offset, id) records
  const idsAt = v2 ? 8 + 1024 : 1024 + 4;
  const idStride = v2 ? 20 : 24;
  const crcAt = 8 + 1024 + n * 20;
  const offAt = v2 ? crcAt + n * 4 : 1024;
  const offStride = v2 ? 4 : 24;
  const largeAt = v2 ? offAt + n * 4 : 0;
  let large = 0;
  if (v2) {
    if (idx.length < largeAt + 40) throw new PackError(`${idxPath}: idx truncated`);
    for (let i = 0; i < n; i++) if (iv.getUint32(offAt + i * 4) & 0x80000000) large++;
    if (idx.length !== largeAt + large * 8 + 40)
      throw new PackError(`${idxPath}: idx length does not match its tables`);
  } else if (idx.length !== 1024 + n * 24 + 40) {
    throw new PackError(`${idxPath}: idx length does not match its object count`);
  }
  for (let i = 0; i < n; i++) {
    if (v2) {
      const v = iv.getUint32(offAt + i * 4);
      if (v & 0x80000000 && (v & 0x7fffffff) >= large)
        throw new PackError(`${idxPath}: entry ${i} points past the large-offset table`);
    }
    const at = idsAt + i * idStride;
    const first = idx[at] as number;
    const bucketStart = first ? fan(first - 1) : 0;
    if (i < bucketStart || i >= fan(first))
      throw new PackError(`${idxPath}: id ${i} is outside its fan-out bucket`);
    if (i > 0) {
      let c = 0;
      for (let k = 0; k < 20 && c === 0; k++)
        c = (idx[at + k] as number) - (idx[at - idStride + k] as number);
      if (c <= 0) throw new PackError(`${idxPath}: ids not strictly sorted at ${i}`);
    }
  }
  if (hex(sum) !== hex(idx.subarray(idx.length - 20)))
    throw new PackError(`${idxPath}: idx checksum mismatch`);
  const packId = hex(idx.subarray(idx.length - 40, idx.length - 20));
  return {
    version: v2 ? 2 : 1,
    count: n,
    packId,
    idAt: (i) => idx.subarray(idsAt + i * idStride, idsAt + i * idStride + 20),
    offsetOf(i) {
      const v = iv.getUint32(offAt + i * offStride);
      if (!v2 || !(v & 0x80000000)) return v;
      const li = v & 0x7fffffff;
      return iv.getUint32(largeAt + li * 8) * 2 ** 32 + iv.getUint32(largeAt + li * 8 + 4);
    },
    crcOf: (i) => (v2 ? iv.getUint32(crcAt + i * 4) : undefined),
    find(id) {
      const key = idKey;
      if (!parseId(id, key)) return -1;
      const b = key[0] as number;
      let lo = b ? fan(b - 1) : 0;
      let hi = fan(b);
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const at = idsAt + mid * idStride;
        let c = 0;
        for (let k = 0; k < 20 && c === 0; k++) c = (idx[at + k] as number) - (key[k] as number);
        if (c === 0) return mid;
        if (c < 0) lo = mid + 1;
        else hi = mid;
      }
      return -1;
    },
  };
}

/**
 * Opens one pack: reads and validates its idx and the pack's header and trailer. Refuses a
 * corrupt idx or a pack/idx mismatch with `PackError`.
 *
 * @example
 * ```typescript
 * const pack = await openPack(files, ".git/objects/pack/pack-1234….pack", ".git/objects/pack/pack-1234….idx");
 * const obj = await pack.get(id, { verify: true }); // { type, size, content } or undefined
 * ```
 */
export async function openPack(
  files: FilesApi,
  packPath: string,
  idxPath: string,
  options: OpenPackOptions = {},
): Promise<PackFile> {
  const cache = options.baseCache ?? new DeltaBaseCache(options.baseCacheBytes ?? 16 * 2 ** 20);
  const cacheLimit = cache.limit;
  const maxObjectSize = options.maxObjectSize ?? 2 ** 30;

  const idx = await readAll(files, idxPath);
  // the idx's own checksum: by Web Crypto where there is one (a large idx takes milliseconds
  // in JavaScript), checked after the tables
  const t = parseIdx(
    idx,
    idxPath,
    idx.length >= 20 ? await sha1(idx.subarray(0, idx.length - 20)) : new Uint8Array(20),
  );
  const n = t.count;
  const packId = t.packId;
  const stats = await files.stats(packPath);
  if (stats?.kind !== "file" || stats.size === undefined || stats.size < 32)
    throw new PackError(`${packPath}: missing or too short`);
  const packLen = stats.size;
  const trailer = hex(await readAll(files, packPath, packLen - 20, 20));
  if (trailer !== packId)
    throw new PackError(`${packPath}: trailer ${trailer} does not match the idx (${packId})`);
  const head = await readAll(files, packPath, 0, 12);
  const pv = new DataView(head.buffer, head.byteOffset, 12);
  if (pv.getUint32(0) !== 0x5041434b || ![2, 3].includes(pv.getUint32(4)))
    throw new PackError(`${packPath}: not a pack`);
  if (pv.getUint32(8) !== n)
    throw new PackError(`${packPath}: ${pv.getUint32(8)} objects, idx lists ${n}`);

  // git's reverse index: offsets in pack order and, for each, its position in the idx
  let sorted: Float64Array | undefined;
  let perm: Uint32Array | undefined;
  const revIndex = (): Float64Array => {
    if (!sorted) {
      const s = new Float64Array(n);
      for (let i = 0; i < n; i++) s[i] = t.offsetOf(i);
      s.sort(); // numeric, without a comparator: a typed array's own sort
      sorted = s;
    }
    return sorted;
  };
  /** For each entry in pack order, its position in the idx (built when first needed). */
  const permutation = (): Uint32Array => {
    if (!perm) {
      const offs = new Float64Array(n);
      for (let i = 0; i < n; i++) offs[i] = t.offsetOf(i);
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => (offs[a] as number) - (offs[b] as number));
      perm = order;
    }
    return perm;
  };
  /** first index in pack order whose offset is > (strict) or >= `offset` */
  const searchRev = (offset: number, strict: boolean): number => {
    const s = revIndex();
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const v = s[mid] as number;
      if (v < offset || (strict && v === offset)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const endOf = (offset: number): number => {
    const k = searchRev(offset, true);
    return k < n ? ((sorted as Float64Array)[k] as number) : packLen - 20;
  };
  /** The idx position of the entry at `offset`, -1 if none starts there. */
  const indexAt = (offset: number): number => {
    const k = searchRev(offset, false);
    return k < n && (sorted as Float64Array)[k] === offset ? (permutation()[k] as number) : -1;
  };

  const pool = createInflaterPool();
  let inflations = 0;

  /** This pack's loaded windows (in the shared cache), and the loads in flight. */
  const loaded = new Map<number, PackWindow>();
  const loading = new Map<number, Promise<Uint8Array>>();
  /** Window `w` if it is loaded, marked used. */
  const peekWindow = (w: number): Uint8Array | undefined => {
    const hit = loaded.get(w);
    if (!hit) return undefined;
    windows.touch(hit);
    return hit.bytes;
  };
  /** Window `w`: loaded, or read once (concurrent reads share the load). */
  const loadWindow = (w: number): Promise<Uint8Array> => {
    const hit = peekWindow(w);
    if (hit) return Promise.resolve(hit);
    let pending = loading.get(w);
    if (!pending) {
      const from = w * WINDOW;
      pending = readAll(files, packPath, from, Math.min(WINDOW, packLen - from));
      const mine = pending;
      loading.set(w, mine);
      mine.then(
        (bytes) => {
          if (loading.get(w) !== mine) return;
          loading.delete(w);
          if (!closed) windows.add(loaded, w, bytes);
        },
        () => {
          if (loading.get(w) === mine) loading.delete(w);
        },
      );
    }
    return pending;
  };
  let closed = false;

  /** The pack's bytes [start, start + length) from cached windows; long ranges streamed. */
  async function* readRange(start: number, length: number): AsyncGenerator<Uint8Array> {
    if (length > WINDOWED_MAX) {
      yield* files.read(packPath, { start, length });
      return;
    }
    const end = Math.min(start + length, packLen);
    for (let at = start; at < end; ) {
      const w = Math.floor(at / WINDOW);
      const from = w * WINDOW;
      const bytes = peekWindow(w) ?? (await loadWindow(w));
      const to = Math.min(end, from + bytes.length);
      if (to <= at) return; // the file is shorter than it was
      yield bytes.subarray(at - from, to - from);
      at = to;
    }
  }
  const readRangeAll = async (start: number, length: number): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const c of readRange(start, length)) {
      parts.push(c);
      total += c.length;
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  /** The bytes [start, start + length) if one loaded window holds them (no await, no copy). */
  const peekRange = (start: number, length: number): Uint8Array | undefined => {
    const w = Math.floor(start / WINDOW);
    const from = w * WINDOW;
    if (start + length > from + WINDOW) return undefined;
    const bytes = peekWindow(w);
    if (!bytes || start + length - from > bytes.length) return undefined;
    return bytes.subarray(start - from, start + length - from);
  };

  /** Parses the entry header at `offset` from `h`, the pack's bytes from `offset` on. */
  const parseHead = (offset: number, end: number, h: Uint8Array): EntryHead => {
    let p = 0;
    const byte = () => {
      if (p >= h.length) throw new PackError(`${packPath}: entry header at ${offset} truncated`);
      return h[p++] as number;
    };
    let b = byte();
    const kind = (b >> 4) & 7;
    let size = b & 0x0f;
    let mul = 16;
    while (b & 0x80) {
      b = byte();
      size += (b & 0x7f) * mul;
      mul *= 128;
      if (mul > 2 ** 53) throw new PackError(`${packPath}: entry size at ${offset} overflows`);
    }
    if (size > maxObjectSize) {
      throw new PackError(
        `${packPath}: entry at ${offset} declares ${size} bytes, over the limit of ${maxObjectSize}`,
      );
    }
    const e: EntryHead = { offset, kind, size, dataStart: 0, end };
    if (kind === OFS_DELTA) {
      b = byte();
      let back = b & 0x7f;
      while (b & 0x80) {
        b = byte();
        back = (back + 1) * 128 + (b & 0x7f);
        if (back > offset) break;
      }
      e.baseOffset = offset - back;
      if (back === 0 || e.baseOffset < 12)
        throw new PackError(`${packPath}: OFS_DELTA at ${offset} points outside the pack`);
    } else if (kind === REF_DELTA) {
      if (p + 20 > h.length) throw new PackError(`${packPath}: REF_DELTA at ${offset} truncated`);
      e.baseId = hex(h.subarray(p, p + 20));
      p += 20;
    } else if (!TYPES[kind]) {
      throw new PackError(`${packPath}: bad object type ${kind} at ${offset}`);
    }
    e.dataStart = offset + p;
    if (e.end >= 0 && e.size > (e.end - e.dataStart) * MAX_EXPANSION + 1024) {
      throw new PackError(
        `${packPath}: entry at ${offset} declares ${e.size} bytes for ${e.end - e.dataStart} compressed`,
      );
    }
    return e;
  };

  const entryEnd = (offset: number): number => {
    const end = endOf(offset);
    if (offset < 12 || end <= offset)
      throw new PackError(`${packPath}: bad entry offset ${offset}`);
    return end;
  };

  const readHead = async (offset: number): Promise<EntryHead> => {
    const end = entryEnd(offset);
    const n = Math.min(32, end - offset);
    return parseHead(offset, end, peekRange(offset, n) ?? (await readRangeAll(offset, n)));
  };

  /** An entry's header and, for a small entry, its compressed bytes (in memory, one read). */
  const withData = (offset: number, end: number, bytes: Uint8Array): LoadedEntry => {
    const e = parseHead(offset, end, bytes);
    return { e, data: bytes.subarray(e.dataStart - offset) };
  };
  /**
   * The entry at `offset`, its extent known (from the reverse index). An entry of at most
   * `WINDOWED_MAX` bytes is read whole, from a loaded window without awaiting anything when one
   * holds it; a longer one gets its header only (its data streams).
   */
  const loadExact = (offset: number): LoadedEntry | Promise<LoadedEntry> => {
    const end = entryEnd(offset);
    const span = end - offset;
    if (span > WINDOWED_MAX) return readHead(offset).then((e) => ({ e }));
    const bytes = peekRange(offset, span);
    if (bytes) return withData(offset, end, bytes);
    return readRangeAll(offset, span).then((b) => withData(offset, end, b));
  };
  /**
   * A small entry read from the window that holds its start, without looking up where it ends
   * (git's unpack_entry inflates until the zlib stream ends): its data runs to the window's end
   * (`open`), and the inflater stops at the end of the stream. An entry starting too close to the
   * window's end is read across two windows (`spanEntry`); one larger than `OPEN_MAX` with its
   * extent (`loadExact`).
   */
  const openEntry = (
    offset: number,
    w: number,
    bytes: Uint8Array,
  ): LoadedEntry | Promise<LoadedEntry> => {
    const at = offset - w * WINDOW;
    if (bytes.length - at < OPEN_MIN)
      return bytes.length === WINDOW ? spanEntry(offset) : loadExact(offset);
    const e = parseHead(offset, -1, bytes.subarray(at));
    if (e.size > OPEN_MAX) return loadExact(offset);
    return { e, data: bytes.subarray(e.dataStart - w * WINDOW), open: 1 };
  };
  /**
   * A small entry crossing the end of its window, read `open` from a copy of the window's tail
   * and the next window (cheaper than the reverse index for a few reads); `loadExact` if that is
   * not enough.
   */
  const spanEntry = async (offset: number): Promise<LoadedEntry> => {
    const w = Math.floor(offset / WINDOW);
    const a = peekWindow(w) ?? (await loadWindow(w));
    const next =
      (w + 1) * WINDOW < packLen ? (peekWindow(w + 1) ?? (await loadWindow(w + 1))) : EMPTY;
    const tail = a.subarray(offset - w * WINDOW);
    if (tail.length + next.length < OPEN_MIN) return loadExact(offset);
    const buf = new Uint8Array(tail.length + next.length);
    buf.set(tail);
    buf.set(next, tail.length);
    const e = parseHead(offset, -1, buf);
    if (e.size > OPEN_MAX) return loadExact(offset);
    return { e, data: buf.subarray(e.dataStart - offset), open: 2 };
  };
  /** An entry read `open` whose stream ran past its data: across windows, then with its extent. */
  const reload = (l: LoadedEntry): LoadedEntry | Promise<LoadedEntry> =>
    l.open === 1 ? spanEntry(l.e.offset) : loadExact(l.e.offset);
  /**
   * The entry at `offset`: from its window when it is small (`openEntry`), else with its extent
   * (`loadExact`). The window is read when not loaded.
   */
  const loadEntry = (offset: number): LoadedEntry | Promise<LoadedEntry> => {
    if (offset < 12 || offset >= packLen - 20)
      throw new PackError(`${packPath}: bad entry offset ${offset}`);
    const w = Math.floor(offset / WINDOW);
    const bytes = peekWindow(w);
    if (bytes) return openEntry(offset, w, bytes);
    return loadWindow(w).then((b) => openEntry(offset, w, b));
  };

  /**
   * Inflates a small entry held in memory in one pass, straight into its result (`into`, or a
   * new buffer of the declared size): the same checks as `inflate` (the stream ends, at exactly
   * the declared size; bytes after it inside the entry are tolerated).
   */
  const inflateExact = (e: EntryHead, data: Uint8Array, into?: Uint8Array): Uint8Array => {
    inflations++;
    const out = into ?? new Uint8Array(e.size);
    let length: number;
    try {
      length = inflateWhole(data, { into: out }).length;
    } catch (err) {
      throw entryError(e, err);
    }
    if (length !== e.size)
      throw new PackError(`${packPath}: entry at ${e.offset} is truncated or corrupt`);
    return out;
  };
  const entryError = (e: EntryHead, err: unknown): unknown => {
    if (err instanceof InflateOverflowError)
      return new PackError(`${packPath}: entry at ${e.offset} inflates past ${e.size} bytes`);
    if (err instanceof TruncatedStreamError)
      return new PackError(`${packPath}: entry at ${e.offset} is truncated or corrupt`);
    if (err instanceof CompressionError)
      return new PackError(`${packPath}: entry at ${e.offset}: ${err.message}`);
    return err;
  };
  /**
   * `inflateExact` of a loaded small entry; for one read `open` (data to the window's end), undefined
   * when its stream runs past the window: the caller reads it again with its extent.
   */
  const inflateLoaded = (
    l: LoadedEntry & { data: Uint8Array },
    into?: Uint8Array,
  ): Uint8Array | undefined => {
    if (!l.open) return inflateExact(l.e, l.data, into);
    const out = into ?? new Uint8Array(l.e.size);
    let length: number;
    try {
      length = inflateWhole(l.data, { into: out }).length;
    } catch (err) {
      if (err instanceof TruncatedStreamError) return undefined;
      inflations++;
      throw entryError(l.e, err);
    }
    inflations++;
    if (length !== l.e.size)
      throw new PackError(`${packPath}: entry at ${l.e.offset} is truncated or corrupt`);
    return out;
  };
  /** The whole data of an entry: in one piece when small, else streamed and collected. */
  const inflateEntry = async (l: LoadedEntry): Promise<Uint8Array> => {
    if (!l.data) return inflateAll(l.e);
    return inflateLoaded(l as LoadedEntry & { data: Uint8Array }) ?? reinflate(l);
  };
  /** An entry read `open` whose stream ran past its window: read again with its extent. */
  const reinflate = async (l: LoadedEntry): Promise<Uint8Array> => {
    let x = reload(l);
    if (x instanceof Promise) x = await x;
    return inflateEntry(x);
  };

  /** A delta's instructions: inflated into a reused buffer when synchronous, read once by `applyGitDelta`. */
  const inflateDelta = (l: LoadedEntry): Uint8Array | Promise<Uint8Array> => {
    if (!l.data) return inflateAll(l.e);
    // the shared buffer stays at `OPEN_MAX`: a larger delta gets a buffer of its own, so one big
    // read does not keep megabytes allocated for the life of the process
    const into =
      l.e.size <= deltaScratch.length
        ? deltaScratch.subarray(0, l.e.size)
        : new Uint8Array(l.e.size);
    // awaited before it is applied, the fallback gets a buffer of its own, not the shared one
    return inflateLoaded(l as LoadedEntry & { data: Uint8Array }, into) ?? reinflate(l);
  };

  /**
   * Streams one entry's inflated data, checking its length and that the zlib stream ends (bytes
   * after it inside the entry are tolerated, as git does when reading).
   */
  async function* inflate(e: EntryHead): AsyncGenerator<Uint8Array> {
    inflations++;
    const inflater: StreamInflater = pool.acquire();
    let got = 0;
    let done = false;
    try {
      for await (const c of readRange(e.dataStart, e.end - e.dataStart)) {
        for (let at = 0; at < c.length && !done; at += SLICE) {
          let r: ReturnType<StreamInflater["push"]>;
          try {
            r = inflater.push(c.subarray(at, at + SLICE));
          } catch (err) {
            if (err instanceof CompressionError)
              throw new PackError(`${packPath}: entry at ${e.offset}: ${err.message}`);
            throw err;
          }
          for (const x of r.out) {
            got += x.length;
            if (got > e.size)
              throw new PackError(
                `${packPath}: entry at ${e.offset} inflates past ${e.size} bytes`,
              );
            yield x;
          }
          done = r.done;
        }
        if (done) break;
      }
      if (!done || got !== e.size)
        throw new PackError(`${packPath}: entry at ${e.offset} is truncated or corrupt`);
    } finally {
      if (!done) inflater.abort();
    }
  }
  const inflateAll = async (e: EntryHead): Promise<Uint8Array> => {
    const out = new Uint8Array(e.size);
    let o = 0;
    for await (const x of inflate(e)) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };

  const cached = cache.scope();
  const cacheGet = (offset: number) => cached.get(offset);
  const cachePut = (offset: number, v: ResolvedObject) => cached.put(offset, v);

  /**
   * Resolves the delta at `offset`: walk down to a base, patch upwards, cache checkpoints.
   * Iterative, and synchronous wherever the entries are in loaded windows.
   */
  const resolve = async (
    offset: number,
    visiting: ReadonlySet<ObjectId>,
    first?: LoadedEntry,
  ): Promise<ResolvedObject> => {
    const chain: LoadedEntry[] = [];
    const seen = new Set<number>();
    let cur = offset;
    let base: ResolvedObject | undefined;
    for (;;) {
      if (seen.has(cur)) throw new PackError(`${packPath}: delta cycle at ${cur}`);
      seen.add(cur);
      if (chain.length > MAX_CHAIN)
        throw new PackError(`${packPath}: delta chain deeper than ${MAX_CHAIN} at ${offset}`);
      const hit = cur === offset && first ? undefined : cacheGet(cur);
      if (hit) {
        base = hit;
        break;
      }
      let l = cur === offset && first ? first : loadEntry(cur);
      if (l instanceof Promise) l = await l;
      const e = l.e;
      const type = TYPES[e.kind];
      if (type) {
        const data =
          (l.data && inflateLoaded(l as LoadedEntry & { data: Uint8Array })) ||
          (l.data ? await reinflate(l) : await inflateAll(e));
        base = { type, data };
        if (chain.length) cachePut(cur, base);
        break;
      }
      chain.push(l);
      if (e.baseOffset !== undefined) {
        cur = e.baseOffset;
        continue;
      }
      const baseId = e.baseId as ObjectId;
      const i = t.find(baseId);
      if (i >= 0) {
        cur = t.offsetOf(i);
        continue;
      }
      if (visiting.has(baseId))
        throw new PackError(`${packPath}: REF_DELTA cycle through ${baseId}`);
      base = await options.externalBase?.(baseId, new Set([...visiting, baseId]));
      if (!base) throw new PackError(`${packPath}: REF_DELTA base ${baseId} not found`);
      if (base.data.length > maxObjectSize)
        throw new PackError(
          `${packPath}: REF_DELTA base ${baseId} is ${base.data.length} bytes, over the limit of ${maxObjectSize}`,
        );
      break;
    }
    // Checkpoints, not every step: caching each object on the way would let the top of the last
    // chain evict everything else. The cache's slots are spread evenly along this chain (and the
    // object asked for is kept), so the next request into the chain stops at a nearby checkpoint.
    let data = base.data;
    const slots = Math.max(1, Math.floor(cacheLimit / Math.max(1, data.length)));
    const stride = Math.max(1, Math.ceil(chain.length / slots));
    // Results neither cached nor returned are written into two buffers of this read, in turn
    // (a result never overwrites its base), instead of a new buffer per step.
    const scratch: [Uint8Array, Uint8Array] = [EMPTY, EMPTY];
    let turn = 0;
    const intoScratch = (size: number): Uint8Array => {
      turn ^= 1;
      if (scratch[turn].length < size) scratch[turn] = new Uint8Array(Math.max(size, 1024));
      return scratch[turn].subarray(0, size);
    };
    const own = (size: number) => new Uint8Array(size);
    for (let k = chain.length - 1; k >= 0; k--) {
      const l = chain[k] as LoadedEntry;
      const keep = k === 0 || (chain.length - k) % stride === 0;
      let d = inflateDelta(l);
      if (d instanceof Promise) d = await d;
      try {
        // the result's declared size is checked before it is allocated
        data = applyGitDelta(data, d, maxObjectSize, keep ? own : intoScratch);
      } catch (err) {
        if (err instanceof DeltaError)
          throw new PackError(`${packPath}: delta at ${l.e.offset}: ${err.message}`);
        throw err;
      }
      if (keep) cachePut(l.e.offset, { type: base.type, data });
    }
    return { type: base.type, data };
  };

  async function* verified(
    id: ObjectId,
    type: ObjectTypeString,
    size: number,
    src: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    const h = createSha1().update(enc.encode(`${type} ${size}\0`));
    for await (const c of src) {
      h.update(c);
      yield c;
    }
    const got = hex(h.digest());
    if (got !== id) throw new ObjectIdMismatchError(`${packPath}: object ${id} hashes to ${got}`);
  }

  /** Reads the entry's bytes once (idx v1 has no CRCs): its CRC, and its zlib stream checked. */
  const checkEntry = async (e: EntryHead): Promise<number> => {
    const crc = new CRC32();
    for await (const c of files.read(packPath, { start: e.offset, length: e.dataStart - e.offset }))
      crc.update(c);
    const inflater = pool.acquire();
    let got = 0;
    let done = false;
    try {
      for await (const c of files.read(packPath, {
        start: e.dataStart,
        length: e.end - e.dataStart,
      })) {
        crc.update(c);
        for (let at = 0; at < c.length && !done; at += SLICE) {
          const r = inflater.push(c.subarray(at, at + SLICE));
          for (const x of r.out) got += x.length;
          if (got > e.size)
            throw new PackError(`${packPath}: entry at ${e.offset} inflates past ${e.size} bytes`);
          done = r.done;
        }
      }
    } catch (err) {
      inflater.abort();
      if (err instanceof CompressionError)
        throw new PackError(`${packPath}: entry at ${e.offset}: ${err.message}`);
      throw err;
    }
    if (!done || got !== e.size) {
      inflater.abort();
      throw new PackError(`${packPath}: entry at ${e.offset} is truncated or corrupt`);
    }
    return crc.getValue();
  };

  /** A whole object in memory: `bytes`, unless the read is verified (the stream's end checks). */
  const whole = (
    id: ObjectId,
    type: ObjectTypeString,
    data: Uint8Array,
    verify: boolean,
  ): GitObject =>
    verify
      ? { type, size: data.length, content: verified(id, type, data.length, once(data)) }
      : { type, size: data.length, bytes: data, content: once(data) };

  return {
    packId,
    count: n,
    packPath,
    idxPath,
    stats: {
      get inflations() {
        return inflations;
      },
      get cachedBytes() {
        return cache.bytes;
      },
      get cachedEntriesBytes() {
        return cache.entriesBytes;
      },
      get peakCachedBytes() {
        return cache.peakBytes;
      },
    },
    close: () => {
      cached.drop();
      closed = true;
      windows.drop(loaded);
    },
    has: (id) => t.find(id) >= 0,
    *ids() {
      for (let i = 0; i < n; i++) yield hex(t.idAt(i));
    },
    async entry(id) {
      const i = t.find(id);
      if (i < 0) return undefined;
      const offset = t.offsetOf(i);
      const e = await readHead(offset);
      let baseId = e.baseId;
      if (e.kind === OFS_DELTA) {
        const bi = indexAt(e.baseOffset as number);
        if (bi < 0) throw new PackError(`${packPath}: OFS_DELTA at ${offset} names no entry`);
        baseId = hex(t.idAt(bi));
      }
      const crc32 = t.crcOf(i) ?? (await checkEntry(e));
      return {
        kind: e.kind as PackedEntryKind,
        size: e.size,
        ...(baseId ? { baseId } : {}),
        crc32,
        async *raw() {
          // Two passes, as JGit's copyAsIs validates before copying: the CRC of the whole entry
          // is checked before a byte is yielded, then again while streaming (the file could
          // change in between). Entries are compressed and usually small.
          const check = (crc: CRC32, at: number) => {
            if (at !== e.end) throw new PackError(`${packPath}: entry at ${offset} truncated`);
            if (crc.getValue() !== crc32)
              throw new PackError(
                `${packPath}: entry ${id} at ${offset} does not match its idx CRC (corrupt)`,
              );
          };
          const first = new CRC32();
          let at = offset;
          for await (const c of files.read(packPath, { start: offset, length: e.end - offset })) {
            first.update(c);
            at += c.length;
          }
          check(first, at);
          const crc = new CRC32();
          at = offset;
          for await (const c of files.read(packPath, { start: offset, length: e.end - offset })) {
            crc.update(c);
            const from = Math.max(0, e.dataStart - at);
            if (from < c.length) yield c.subarray(from);
            at += c.length;
          }
          check(crc, at);
        },
      };
    },
    async get(id, o) {
      const i = t.find(id);
      if (i < 0) return undefined;
      const offset = t.offsetOf(i);
      const verify = o?.verify === true;
      const hit = cacheGet(offset);
      if (hit) {
        // never hand out the cached buffer
        return whole(id, hit.type, copyOf(hit.data), verify);
      }
      let l = loadEntry(offset);
      if (l instanceof Promise) l = await l;
      const type = TYPES[l.e.kind];
      if (!type) {
        const r = await resolve(offset, new Set([...(o?.visiting ?? []), id]), l);
        // the result may be cached: copy it
        return whole(id, r.type, copyOf(r.data), verify);
      }
      let data: Uint8Array | undefined;
      for (;;) {
        const e = l.e;
        if (!l.data || e.size > WHOLE_MAX) {
          // large whole objects stream, never materialised
          const content = inflate(e);
          return {
            type,
            size: e.size,
            content: verify ? verified(id, type, e.size, content) : content,
          };
        }
        try {
          data = inflateLoaded(l as LoadedEntry & { data: Uint8Array }, allocBytes(e.size));
        } catch (err) {
          // as the streamed read: a broken stream fails the content, not the lookup
          if (!(err instanceof PackError)) throw err;
          return { type, size: e.size, content: failing(err) };
        }
        if (data) break;
        // read open, its stream ran past the window: again, with its extent
        const x = reload(l);
        l = x instanceof Promise ? await x : x;
      }
      return whole(id, type, data, verify);
    },
  };
}
