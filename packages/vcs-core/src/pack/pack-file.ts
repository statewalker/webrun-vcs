/**
 * Reading objects from one installed pack, as git's packfile.c and JGit's Pack do:
 *
 *  - open: the whole `.idx` (v2, or v1) is read and validated — magic and version, monotonic
 *    fan-out, exact length (the 64-bit offset table included), its own SHA-1, ids strictly sorted
 *    and inside their fan-out buckets, every large-offset index inside the 64-bit table — and the
 *    pack's trailer must be the pack checksum the idx records (an idx of another pack with the
 *    same object count passes every other check);
 *  - lookup: fan-out range, then binary search over the sorted ids;
 *  - an entry ends where the next one starts in pack order (git's reverse index, built lazily);
 *    it is read with two ranged reads: its header, then exactly its data;
 *  - a declared size above `maxObjectSize`, or above what zlib can expand the entry's compressed
 *    bytes to (~1032:1), is refused before anything is allocated;
 *  - whole objects stream straight from the inflater; delta chains are walked down to a whole
 *    object or a cached one, then patched upwards with `applyGitDelta`, through a byte-bounded
 *    base cache (git's delta_base_cache) that keeps checkpoints spread along the chain;
 *  - callers always receive copies, never cached buffers;
 *  - a REF_DELTA base outside the pack resolves through `externalBase`, with the ids being
 *    resolved on this path (`visiting`), so a cycle across packs fails instead of recursing;
 *  - zlib and format errors raise `PackError`; storage errors pass through unchanged.
 */
import {
  CompressionError,
  createInflaterPool,
  type StreamInflater,
} from "@statewalker/vcs-utils/compression";
import { applyGitDelta, DeltaError } from "@statewalker/vcs-utils/diff";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
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
const OID = /^[0-9a-f]{40}$/;
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

async function* once(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

/**
 * A byte-bounded LRU of resolved objects, keyed by pack and offset (git's delta_base_cache).
 * One cache can serve every pack of a set, so the budget is the set's, not each pack's.
 */
export class DeltaBaseCache {
  private readonly map = new Map<string, ResolvedObject>();
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
    for (const v of this.map.values()) n += v.data.length;
    return n;
  }
  get(key: string): ResolvedObject | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  put(key: string, v: ResolvedObject): void {
    if (v.data.length > this.limit || this.map.has(key)) return;
    this.map.set(key, v);
    this.held += v.data.length;
    for (const [k, x] of this.map) {
      if (this.held <= this.limit) break;
      this.map.delete(k);
      this.held -= x.data.length;
    }
    this.peak = Math.max(this.peak, this.held);
  }
  /** Drops every entry whose key starts with `prefix`. */
  drop(prefix: string): void {
    for (const [k, x] of this.map) {
      if (!k.startsWith(prefix)) continue;
      this.map.delete(k);
      this.held -= x.data.length;
    }
  }
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

/** Parses and validates an `.idx` v2 or v1 (git's check_packed_git_idx). */
function parseIdx(idx: Uint8Array, idxPath: string): IdxTable {
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
  const sum = createSha1()
    .update(idx.subarray(0, idx.length - 20))
    .digest();
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
      if (typeof id !== "string" || !OID.test(id)) return -1;
      const key = hexToBytes(id);
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

let packSeq = 0;

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
  const keyPrefix = `${++packSeq}:`;

  const t = parseIdx(await readAll(files, idxPath), idxPath);
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
      const offs = new Float64Array(n);
      for (let i = 0; i < n; i++) offs[i] = t.offsetOf(i);
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => (offs[a] as number) - (offs[b] as number));
      const s = new Float64Array(n);
      for (let k = 0; k < n; k++) s[k] = offs[order[k] as number] as number;
      sorted = s;
      perm = order;
    }
    return sorted;
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
    return k < n && (sorted as Float64Array)[k] === offset
      ? ((perm as Uint32Array)[k] as number)
      : -1;
  };

  const pool = createInflaterPool();
  let inflations = 0;

  const readHead = async (offset: number): Promise<EntryHead> => {
    const end = endOf(offset);
    if (offset < 12 || end <= offset)
      throw new PackError(`${packPath}: bad entry offset ${offset}`);
    const h = await readAll(files, packPath, offset, Math.min(32, end - offset));
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
    if (e.size > (e.end - e.dataStart) * MAX_EXPANSION + 1024) {
      throw new PackError(
        `${packPath}: entry at ${offset} declares ${e.size} bytes for ${e.end - e.dataStart} compressed`,
      );
    }
    return e;
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
      for await (const c of files.read(packPath, {
        start: e.dataStart,
        length: e.end - e.dataStart,
      })) {
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

  const cacheGet = (offset: number) => cache.get(keyPrefix + offset);
  const cachePut = (offset: number, v: ResolvedObject) => cache.put(keyPrefix + offset, v);

  /** Resolves the delta at `offset`: walk down to a base, patch upwards, cache checkpoints. */
  const resolve = async (
    offset: number,
    visiting: ReadonlySet<ObjectId>,
  ): Promise<ResolvedObject> => {
    const chain: EntryHead[] = [];
    const seen = new Set<number>();
    let cur = offset;
    let base: ResolvedObject | undefined;
    for (;;) {
      if (seen.has(cur)) throw new PackError(`${packPath}: delta cycle at ${cur}`);
      seen.add(cur);
      if (chain.length > MAX_CHAIN)
        throw new PackError(`${packPath}: delta chain deeper than ${MAX_CHAIN} at ${offset}`);
      const hit = cacheGet(cur);
      if (hit) {
        base = hit;
        break;
      }
      const e = await readHead(cur);
      const type = TYPES[e.kind];
      if (type) {
        base = { type, data: await inflateAll(e) };
        if (chain.length) cachePut(cur, base);
        break;
      }
      chain.push(e);
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
    for (let k = chain.length - 1; k >= 0; k--) {
      const e = chain[k] as EntryHead;
      const d = await inflateAll(e);
      try {
        // the result's declared size is checked before it is allocated
        data = applyGitDelta(data, d, maxObjectSize);
      } catch (err) {
        if (err instanceof DeltaError)
          throw new PackError(`${packPath}: delta at ${e.offset}: ${err.message}`);
        throw err;
      }
      if (k === 0 || (chain.length - k) % stride === 0)
        cachePut(e.offset, { type: base.type, data });
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
    close: () => cache.drop(keyPrefix),
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
      let type: ObjectTypeString;
      let size: number;
      let content: AsyncIterable<Uint8Array>;
      const hit = cacheGet(offset);
      if (hit) {
        type = hit.type;
        size = hit.data.length;
        content = once(hit.data.slice()); // never hand out the cached buffer
      } else {
        const e = await readHead(offset);
        const whole = TYPES[e.kind];
        if (whole) {
          // whole objects stream, never materialised
          type = whole;
          size = e.size;
          content = inflate(e);
        } else {
          const r = await resolve(offset, new Set([...(o?.visiting ?? []), id]));
          type = r.type;
          size = r.data.length;
          content = once(r.data.slice()); // the result may be cached: copy it
        }
      }
      return { type, size, content: o?.verify ? verified(id, type, size, content) : content };
    },
  };
}
