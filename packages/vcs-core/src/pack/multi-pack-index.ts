/**
 * git's multi-pack-index (`objects/pack/multi-pack-index`, gitformat-pack's MIDX section,
 * midx.c / midx-write.c / chunk-format.c): one sorted object list over several packs.
 *
 * ```typescript
 * const midx = parseMultiPackIndex(bytes, ".git/objects/pack/multi-pack-index");
 * const pos = midx.find(id); // -1 when absent
 * if (pos >= 0) console.log(midx.packNameAt(midx.packIntIdAt(pos)), midx.offsetAt(pos));
 * ```
 *
 * The file is a chunk file: a 12-byte header (`MIDX`, version 1 or 2, hash version 1, the chunk
 * count, a zero byte, the pack count), a table of contents of `(id, offset)` pairs ending with a
 * zero id, the chunks, and the SHA-1 of everything before it. Chunks: `PNAM` (the packs' `.idx`
 * names, NUL-terminated, sorted in version 1), `OIDF` (fan-out), `OIDL` (sorted ids), `OOFF`
 * (pack-int-id and offset per object), `LOFF` (64-bit offsets), `RIDX` (the pseudo-pack order a
 * multi-pack bitmap uses) and `BTMP` (each pack's first bit and bit count, git 2.44+).
 *
 * `parseMultiPackIndex` checks what git's `load_multi_pack_index_one` checks and throws
 * `MultiPackIndexError` with git's message (`fatal` where git dies, else where it prints an
 * error and ignores the file); the trailing checksum is checked only by `checksumValid()`, as
 * git checks it only in `verify` and before reusing a midx in a write. An incremental chain
 * (`multi-pack-index.d/multi-pack-index-chain`, 2.5x) links layers through `base`: positions
 * and pack-int-ids of a layer follow those of its bases.
 *
 * Hardening beyond git (a crafted midx in a served repository must not crash or misdirect us):
 * PNAM entries must be plain `pack-<hex>.idx` names (git joins them into paths unchecked, so its
 * `expire` unlinks `../../x.pack`), lookups walk a chain's layers in a loop (no recursion per
 * layer), `multiPackIndexBitmapPack` refuses an `RIDX` that is not a permutation and `BTMP`
 * ranges that disagree with it (git reads past its arrays there), and `badPackIntId` finds the
 * pack-int-id git dies on (`bad pack-int-id`) before a reader uses the file.
 *
 * `encodeMultiPackIndex` writes git's bytes for given packs (midx-write.c's
 * `write_midx_internal`): entries de-duplicated by preferred pack, then newest pack mtime,
 * then the pack's discovery order; packs named in name order; `RIDX` (and `BTMP` for 2.44+)
 * with a reverse index or bitmap.
 */
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { BitmapPack } from "./pack-bitmap.js";

export const MIDX_SIGNATURE = 0x4d494458; // "MIDX"
const HEADER_SIZE = 12;
const HASH_SIZE = 20;
const TOC_ENTRY = 12;
const CHUNK_PNAM = 0x504e414d;
const CHUNK_OIDF = 0x4f494446;
const CHUNK_OIDL = 0x4f49444c;
const CHUNK_OOFF = 0x4f4f4646;
const CHUNK_LOFF = 0x4c4f4646;
const CHUNK_RIDX = 0x52494458;
const CHUNK_BTMP = 0x42544d50;
const LARGE_OFFSET_NEEDED = 0x80000000;

/** The file name of a midx and the chain of an incremental one, below `objects/pack`. */
export const MIDX_FILE = "multi-pack-index";
export const MIDX_CHAIN_DIR = "multi-pack-index.d";
export const MIDX_CHAIN_FILE = "multi-pack-index-chain";

/**
 * A multi-pack-index git refuses. `fatal` where git dies (a wrong signature or version, a
 * required chunk missing), else where git prints `error: <message>` and goes on without it.
 */
export class MultiPackIndexError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    /** the `error:` line git prints before it dies with `message` */
    readonly prior?: string,
  ) {
    super(message);
    this.name = "MultiPackIndexError";
  }

  /** git's stderr lines for this refusal */
  get lines(): string[] {
    const last = `${this.fatal ? "fatal" : "error"}: ${this.message}`;
    return this.prior ? [`error: ${this.prior}`, last] : [last];
  }
}

const dieAfter = (prior: string, chunk: string) =>
  new MultiPackIndexError(
    `multi-pack-index required ${chunk} chunk missing or corrupted`,
    true,
    prior,
  );

/** One layer of a multi-pack-index, linked to its bases when it is part of a chain. */
export interface MultiPackIndex {
  readonly path: string;
  readonly version: number;
  /** packs and objects of this layer */
  readonly numPacks: number;
  readonly numObjects: number;
  /** packs and objects of the layers below this one (0 without a chain) */
  readonly numPacksInBase: number;
  readonly numObjectsInBase: number;
  readonly base?: MultiPackIndex;
  /** this layer's `.idx` names, as stored */
  readonly packNames: readonly string[];
  /** hex of the trailing checksum (the name of a chain layer and of a midx bitmap) */
  readonly checksum: string;
  readonly bytes: Uint8Array;
  /** the RIDX chunk: midx positions in pseudo-pack order (this layer's objects) */
  readonly revIndex?: Uint32Array;
  /** the BTMP chunk: per pack of this layer, its first bit and bit count */
  readonly bitmappedPacks?: readonly { pos: number; nr: number }[];
  /** The position of `id` in the chain (bases first), -1 when absent. */
  find(id: ObjectId): number;
  /** The id at chain position `pos`. */
  idAt(pos: number): ObjectId;
  /** The pack-int-id (in the chain) of the object at `pos`. */
  packIntIdAt(pos: number): number;
  /** The offset in its pack of the object at `pos`. */
  offsetAt(pos: number): number;
  /** The `.idx` name of the pack with chain pack-int-id `id`. */
  packNameAt(id: number): string;
  /** Whether a layer of the chain names the pack (`pack-x.idx` or `pack-x.pack`). */
  containsPack(name: string): boolean;
  /** The chain position of `id` in this layer alone, -1 when absent. */
  findInLayer(id: ObjectId): number;
  /** Whether this layer alone names the pack. */
  layerContainsPack(name: string): boolean;
  /** Whether the trailing checksum matches the contents (git's `midx_checksum_valid`). */
  checksumValid(): boolean;
  /** This layer's fan-out entry `i` (objects whose first byte is at most `i`). */
  fanout(i: number): number;
}

/** git's `cmp_idx_or_pack_name`: `foo.idx` against `foo.pack` or `foo.idx`. */
export function cmpIdxOrPackName(idxOrPackName: string, idxName: string): number {
  let i = 0;
  while (i < idxName.length && idxName[i] === idxOrPackName[i]) i++;
  const a = idxOrPackName.slice(i);
  const b = idxName.slice(i);
  if (a === "pack" && b === "idx") return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

const hex32 = (n: number) => n.toString(16);

/**
 * The PNAM entries we accept: `pack-<hex>.idx`, as git writes them. git takes any name and joins
 * it into a path (a crafted `../../victim/pack-v.idx` makes its `expire` unlink files outside the
 * pack directory); we refuse such a midx instead.
 */
const PACK_NAME = /^pack-[0-9a-f]+\.idx$/;

/** one decoded id per lookup, reused (lookups are synchronous) */
const SCRATCH = new Uint8Array(HASH_SIZE);
const nibble = (c: number) =>
  c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
/** Decodes a 40-digit hex id into `out`; false when it is not one. */
function decodeId(id: string, out: Uint8Array): boolean {
  if (id.length !== 40) return false;
  for (let i = 0; i < HASH_SIZE; i++) {
    const hi = nibble(id.charCodeAt(2 * i));
    const lo = nibble(id.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return false;
    out[i] = (hi << 4) | lo;
  }
  return true;
}

function readToc(
  bytes: Uint8Array,
  view: DataView,
  chunkCount: number,
): Map<number, { start: number; size: number }> {
  const chunks = new Map<number, { start: number; size: number }>();
  let at = HEADER_SIZE;
  const big = (o: number) => view.getUint32(o) * 2 ** 32 + view.getUint32(o + 4);
  if (HEADER_SIZE + (chunkCount + 1) * TOC_ENTRY > bytes.length - HASH_SIZE)
    throw new MultiPackIndexError("improper chunk offset(s) 0 and 0");
  for (let k = 0; k < chunkCount; k++) {
    const id = view.getUint32(at);
    const offset = big(at + 4);
    if (!id) throw new MultiPackIndexError("terminating chunk id appears earlier than expected");
    if (offset % 4 !== 0) throw new MultiPackIndexError(`chunk id ${hex32(id)} not 4-byte aligned`);
    at += TOC_ENTRY;
    const next = big(at + 4);
    if (next < offset || next > bytes.length - HASH_SIZE)
      throw new MultiPackIndexError(`improper chunk offset(s) ${hex32(offset)} and ${hex32(next)}`);
    if (chunks.has(id)) throw new MultiPackIndexError(`duplicate chunk ID ${hex32(id)} found`);
    chunks.set(id, { start: offset, size: next - offset });
  }
  const last = view.getUint32(at);
  if (last) throw new MultiPackIndexError(`final chunk has non-zero id ${hex32(last)}`);
  return chunks;
}

/**
 * Parses one midx file (a layer of a chain when `base` is given): git's
 * `load_multi_pack_index_one`. Throws `MultiPackIndexError` where git refuses the file.
 */
export function parseMultiPackIndex(
  bytes: Uint8Array,
  path: string,
  base?: MultiPackIndex,
  options: {
    /** check the fan-out's order on load (2.5x; 2.43 leaves it to `verify`). Default true */
    checkFanoutOrder?: boolean;
    /** accept version 2 files (2.5x; 2.43 dies on them: "version 2 not recognized"). Default true */
    acceptVersion2?: boolean;
  } = {},
): MultiPackIndex {
  if (bytes.length < HEADER_SIZE + HASH_SIZE)
    throw new MultiPackIndexError(`multi-pack-index file ${path} is too small`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);
  if (signature !== MIDX_SIGNATURE)
    throw new MultiPackIndexError(
      `multi-pack-index signature 0x${signature.toString(16).padStart(8, "0")} does not match signature 0x${MIDX_SIGNATURE.toString(16)}`,
      true,
    );
  const version = bytes[4] as number;
  if (version !== 1 && (version !== 2 || options.acceptVersion2 === false))
    throw new MultiPackIndexError(`multi-pack-index version ${version} not recognized`, true);
  const hashVersion = bytes[5] as number;
  if (hashVersion !== 1)
    throw new MultiPackIndexError(
      `multi-pack-index hash version ${hashVersion} does not match version 1`,
    );
  const chunkCount = bytes[6] as number;
  const numPacks = view.getUint32(8);
  const chunks = readToc(bytes, view, chunkCount);

  const pnam = chunks.get(CHUNK_PNAM);
  if (!pnam)
    throw new MultiPackIndexError(
      "multi-pack-index required pack-name chunk missing or corrupted",
      true,
    );
  const oidf = chunks.get(CHUNK_OIDF);
  if (!oidf)
    throw new MultiPackIndexError(
      "multi-pack-index required OID fanout chunk missing or corrupted",
      true,
    );
  if (oidf.size !== 4 * 256)
    throw dieAfter("multi-pack-index OID fanout is of the wrong size", "OID fanout");
  for (let i = 0; i < 255 && (options.checkFanoutOrder ?? true); i++) {
    const a = view.getUint32(oidf.start + 4 * i);
    const b = view.getUint32(oidf.start + 4 * (i + 1));
    if (a > b)
      throw dieAfter(
        `oid fanout out of order: fanout[${i}] = ${hex32(a)} > ${hex32(b)} = fanout[${i + 1}]`,
        "OID fanout",
      );
  }
  const numObjects = view.getUint32(oidf.start + 4 * 255);
  const oidl = chunks.get(CHUNK_OIDL);
  if (!oidl)
    throw new MultiPackIndexError(
      "multi-pack-index required OID lookup chunk missing or corrupted",
      true,
    );
  if (oidl.size !== numObjects * HASH_SIZE)
    throw dieAfter("multi-pack-index OID lookup chunk is the wrong size", "OID lookup");
  const ooff = chunks.get(CHUNK_OOFF);
  if (!ooff)
    throw new MultiPackIndexError(
      "multi-pack-index required object offsets chunk missing or corrupted",
      true,
    );
  if (ooff.size !== numObjects * 8)
    throw dieAfter("multi-pack-index object offset chunk is the wrong size", "object offsets");
  const loff = chunks.get(CHUNK_LOFF);
  const ridx = chunks.get(CHUNK_RIDX);
  const btmp = chunks.get(CHUNK_BTMP);

  const packNames: string[] = [];
  const dec = new TextDecoder();
  let p = pnam.start;
  const pend = pnam.start + pnam.size;
  for (let i = 0; i < numPacks; i++) {
    let e = p;
    while (e < pend && bytes[e] !== 0) e++;
    if (e >= pend)
      throw new MultiPackIndexError("multi-pack-index pack-name chunk is too short", true);
    const name = dec.decode(bytes.subarray(p, e));
    if (!PACK_NAME.test(name))
      throw new MultiPackIndexError(
        `multi-pack-index pack name '${name}' is not a pack index name; ignoring ${path}`,
      );
    if (version === 1 && i > 0 && name <= (packNames[i - 1] as string))
      throw new MultiPackIndexError(
        `multi-pack-index pack names out of order: '${packNames[i - 1]}' before '${name}'`,
        true,
      );
    packNames.push(name);
    p = e + 1;
  }

  const numPacksInBase = base ? base.numPacks + base.numPacksInBase : 0;
  const numObjectsInBase = base ? base.numObjects + base.numObjectsInBase : 0;
  const checksum = bytesToHex(bytes.subarray(bytes.length - HASH_SIZE));
  let revIndex: Uint32Array | undefined;
  if (ridx && ridx.size === numObjects * 4) {
    revIndex = new Uint32Array(numObjects);
    for (let i = 0; i < numObjects; i++) revIndex[i] = view.getUint32(ridx.start + 4 * i);
  }
  let bitmappedPacks: { pos: number; nr: number }[] | undefined;
  if (btmp && btmp.size === numPacks * 8) {
    bitmappedPacks = [];
    for (let i = 0; i < numPacks; i++)
      bitmappedPacks.push({
        pos: view.getUint32(btmp.start + 8 * i),
        nr: view.getUint32(btmp.start + 8 * i + 4),
      });
  }

  const sortedNames = version === 1 ? packNames : [...packNames].sort();
  const layerContains = (name: string) => {
    let lo = 0;
    let hi = sortedNames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = cmpIdxOrPackName(name, sortedNames[mid] as string);
      if (c === 0) return true;
      if (c > 0) lo = mid + 1;
      else hi = mid;
    }
    return false;
  };
  const layerOf = (pos: number): MultiPackIndex => {
    let m: MultiPackIndex = self;
    while (m.base && pos < m.numObjectsInBase) m = m.base;
    return m;
  };
  /** compares the 20 id bytes at `o` with `key` */
  const cmpAt = (o: number, key: Uint8Array) => {
    for (let k = 0; k < HASH_SIZE; k++) {
      const d = (bytes[o + k] as number) - (key[k] as number);
      if (d) return d;
    }
    return 0;
  };
  const findLocal = (key: Uint8Array): number => {
    const first = key[0] as number;
    let lo = first === 0 ? 0 : view.getUint32(oidf.start + 4 * (first - 1));
    let hi = view.getUint32(oidf.start + 4 * first);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = cmpAt(oidl.start + mid * HASH_SIZE, key);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  };

  const self: MultiPackIndex = {
    path,
    version,
    numPacks,
    numObjects,
    numPacksInBase,
    numObjectsInBase,
    ...(base ? { base } : {}),
    packNames,
    checksum,
    bytes,
    ...(revIndex ? { revIndex } : {}),
    ...(bitmappedPacks ? { bitmappedPacks } : {}),
    find(id) {
      if (!decodeId(id, SCRATCH)) return -1;
      // the layers in a loop: a chain of thousands of layers must not grow the stack
      for (let m: MultiPackIndex | undefined = self; m; m = m.base) {
        const local = (LAYER_FIND.get(m) as (key: Uint8Array) => number)(SCRATCH);
        if (local >= 0) return local + m.numObjectsInBase;
      }
      return -1;
    },
    findInLayer(id) {
      if (!decodeId(id, SCRATCH)) return -1;
      const local = findLocal(SCRATCH);
      return local >= 0 ? local + numObjectsInBase : -1;
    },
    layerContainsPack(name) {
      return layerContains(name);
    },
    idAt(pos) {
      const m = layerOf(pos);
      if (m !== self) return m.idAt(pos);
      const o = oidl.start + (pos - numObjectsInBase) * HASH_SIZE;
      return bytesToHex(bytes.subarray(o, o + HASH_SIZE));
    },
    packIntIdAt(pos) {
      const m = layerOf(pos);
      if (m !== self) return m.packIntIdAt(pos);
      return numPacksInBase + view.getUint32(ooff.start + (pos - numObjectsInBase) * 8);
    },
    offsetAt(pos) {
      const m = layerOf(pos);
      if (m !== self) return m.offsetAt(pos);
      const off32 = view.getUint32(ooff.start + (pos - numObjectsInBase) * 8 + 4);
      if (loff && off32 & LARGE_OFFSET_NEEDED) {
        const row = off32 ^ LARGE_OFFSET_NEEDED;
        if (row >= Math.floor(loff.size / 8))
          throw new MultiPackIndexError("multi-pack-index large offset out of bounds", true);
        const at = loff.start + 8 * row;
        return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
      }
      return off32;
    },
    packNameAt(id) {
      let m: MultiPackIndex = self;
      while (m.base && id < m.numPacksInBase) m = m.base;
      return m.packNames[id - m.numPacksInBase] as string;
    },
    containsPack(name) {
      for (let m: MultiPackIndex | undefined = self; m; m = m.base)
        if (m.layerContainsPack(name)) return true;
      return false;
    },
    fanout(i) {
      return view.getUint32(oidf.start + 4 * i);
    },
    checksumValid() {
      const sum = createSha1()
        .update(bytes.subarray(0, bytes.length - HASH_SIZE))
        .digest();
      return bytesToHex(sum) === checksum;
    },
  };
  LAYER_FIND.set(self, findLocal);
  return self;
}

/** each parsed layer's own lookup by decoded id (the chain's `find` walks them in a loop) */
const LAYER_FIND = new WeakMap<MultiPackIndex, (key: Uint8Array) => number>();

/**
 * The first pack-int-id of the chain that names no pack of its layer, with git's message
 * (`bad pack-int-id: N (M total packs)`: git dies when it first reads that object's pack), or
 * undefined when every id is in range.
 */
export function badPackIntId(midx: MultiPackIndex): string | undefined {
  return badPackIntIdAt(midx)?.message;
}

/** `badPackIntId` with the chain position of the object whose pack-int-id is out of range. */
export function badPackIntIdAt(midx: MultiPackIndex): { pos: number; message: string } | undefined {
  for (let m: MultiPackIndex | undefined = midx; m; m = m.base) {
    const total = m.numPacks + m.numPacksInBase;
    for (let i = 0; i < m.numObjects; i++) {
      const pos = m.numObjectsInBase + i;
      const id = m.packIntIdAt(pos);
      if (id >= total) return { pos, message: `bad pack-int-id: ${id} (${total} total packs)` };
    }
  }
  return undefined;
}

/**
 * A midx as the pack a bitmap describes (`writePackBitmap`, `parsePackBitmap`): its checksum
 * in place of a pack's, bit positions in pseudo-pack order (the `RIDX` chunk), "idx" positions
 * the midx's. Throws when the midx has no `RIDX` (git: "could not load reverse index").
 */
export function multiPackIndexBitmapPack(midx: MultiPackIndex): BitmapPack {
  const rev = midx.revIndex;
  if (!rev || midx.base)
    throw new MultiPackIndexError(`could not load reverse index for MIDX ${midx.checksum}`);
  checkBitmapChunks(midx, rev);
  return {
    packId: midx.checksum,
    count: midx.numObjects,
    packOrder: () => rev,
    idAt: (i) => midx.idAt(i),
    indexOf: (id) => midx.find(id),
  };
}

/**
 * What a midx bitmap trusts in `RIDX` and `BTMP`: the reverse index must be a permutation of
 * the midx positions (git indexes its arrays with these values unchecked and crashes on a
 * crafted file; we would read ids as ""), and each pack's bitmapped range must lie inside the
 * pseudo-pack order and hold exactly that pack's objects. Throws `MultiPackIndexError`.
 */
function checkBitmapChunks(midx: MultiPackIndex, rev: Uint32Array): void {
  const n = midx.numObjects;
  const corrupt = (what: string) =>
    new MultiPackIndexError(`multi-pack-index ${what} is corrupt; ignoring its bitmap`);
  if (rev.length !== n) throw corrupt("reverse index (RIDX)");
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const pos = rev[i] as number;
    if (pos >= n || seen[pos]) throw corrupt("reverse index (RIDX)");
    seen[pos] = 1;
  }
  const btmp = midx.bitmappedPacks;
  if (!btmp) return;
  if (btmp.length !== midx.numPacks) throw corrupt("bitmapped packs (BTMP)");
  let covered = 0;
  for (let k = 0; k < btmp.length; k++) {
    const { pos, nr } = btmp[k] as { pos: number; nr: number };
    if (nr === 0) continue;
    if (pos + nr > n) throw corrupt("bitmapped packs (BTMP)");
    for (let i = pos; i < pos + nr; i++)
      if (midx.packIntIdAt(rev[i] as number) !== k) throw corrupt("bitmapped packs (BTMP)");
    covered += nr;
  }
  if (covered !== n) throw corrupt("bitmapped packs (BTMP)");
}

/** One pack given to `encodeMultiPackIndex`. */
export interface MidxPackSource {
  /** its `.idx` file name (`pack-<id>.idx`) */
  name: string;
  /** the `.pack` file's mtime in seconds (git's `p->mtime`) */
  mtime: number;
  count: number;
  /** the id and offset at idx position `i` */
  idAt(i: number): ObjectId;
  offsetAt(i: number): number;
}

export interface EncodeMultiPackIndexOptions {
  /**
   * The packs in git's `ctx.info` order: those of an existing midx (`existing`) first, in its
   * pack-int-id order, then the pack directory's in readdir order (git's discovery order is the
   * last tie-break between copies of an object in packs of the same mtime).
   */
  packs: readonly MidxPackSource[];
  /**
   * An existing midx whose packs are `packs[0 .. existing.numPacks)`: its entries are copied
   * (as packs of mtime 0, so copies in the other packs win), as git reuses a valid midx.
   */
  existing?: MultiPackIndex;
  /** index into `packs` of the preferred pack (its copies win; first in pseudo-pack order) */
  preferred?: number;
  /** write `RIDX` (a reverse index or bitmap asked for) */
  revIndex?: boolean;
  /** write `BTMP` with `RIDX` (git 2.44+) */
  bitmappedPacks?: boolean;
  /** indexes into `packs` left out (`expire`); none of their objects may be selected */
  dropped?: ReadonlySet<number>;
  /** the version byte (1, git's default) */
  version?: number;
  /** objects of the base layers of an incremental write: `RIDX` and `BTMP` count from there */
  baseObjects?: number;
}

export interface EncodedMultiPackIndex {
  bytes: Uint8Array;
  checksum: string;
  /** the selected entries in id order: chain position, pack (new id), offset */
  ids: ObjectId[];
  packOf: Uint32Array;
  offsets: number[];
  /** the new packs in name order, as indexes into the given `packs` */
  packOrder: number[];
  /** the pseudo-pack order (midx positions), when `revIndex` */
  pseudoOrder?: Uint32Array;
  /** per new pack, its first bit and bit count, when `revIndex` */
  bitmapped?: { pos: number; nr: number }[];
}

interface Entry {
  id: ObjectId;
  pack: number;
  mtime: number;
  offset: number;
  preferred: boolean;
}

/** git's midx_oid_compare: id, preferred first, newest mtime first, then discovery order. */
function entryCompare(a: Entry, b: Entry): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
  if (a.mtime !== b.mtime) return a.mtime > b.mtime ? -1 : 1;
  return a.pack - b.pack;
}

/**
 * The bytes git's `write_midx_internal` writes for these packs (no chain, version 1).
 * Throws `MultiPackIndexError` with git's message when there is nothing to index.
 */
export function encodeMultiPackIndex(options: EncodeMultiPackIndexOptions): EncodedMultiPackIndex {
  const { packs, existing, dropped } = options;
  const preferred = options.preferred;
  const startPack = existing ? existing.numPacks + existing.numPacksInBase : 0;
  const all: Entry[] = [];
  if (existing) {
    const total = existing.numObjects + existing.numObjectsInBase;
    for (let pos = 0; pos < total; pos++) {
      const pack = existing.packIntIdAt(pos);
      if (preferred !== undefined && pack === preferred) continue;
      all.push({
        id: existing.idAt(pos),
        pack,
        mtime: 0,
        offset: existing.offsetAt(pos),
        preferred: false,
      });
    }
  }
  const addPack = (k: number) => {
    const p = packs[k] as MidxPackSource;
    const pref = k === preferred;
    for (let i = 0; i < p.count; i++)
      all.push({ id: p.idAt(i), pack: k, mtime: p.mtime, offset: p.offsetAt(i), preferred: pref });
  };
  for (let k = startPack; k < packs.length; k++) addPack(k);
  if (preferred !== undefined && preferred < startPack) addPack(preferred);
  all.sort(entryCompare);
  const entries: Entry[] = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i] as Entry;
    if (i > 0 && (all[i - 1] as Entry).id === e.id) continue;
    entries.push(e);
  }

  // the packs in name order, the dropped ones left out (pack_perm)
  const byName = packs
    .map((_, k) => k)
    .sort((a, b) => {
      const x = (packs[a] as MidxPackSource).name;
      const y = (packs[b] as MidxPackSource).name;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const perm = new Int32Array(packs.length).fill(-1);
  const packOrder: number[] = [];
  for (const k of byName) {
    if (dropped?.has(k)) continue;
    perm[k] = packOrder.length;
    packOrder.push(k);
  }
  if (packOrder.length === 0) throw new MultiPackIndexError("no pack files to index.");

  const n = entries.length;
  let numLarge = 0;
  let largeNeeded = false;
  for (const e of entries) {
    if (e.offset > 0x7fffffff) numLarge++;
    if (e.offset > 0xffffffff) largeNeeded = true;
  }
  const revIndex = (options.revIndex ?? false) && n > 0;
  const enc = new TextEncoder();
  const names = packOrder.map((k) => enc.encode((packs[k] as MidxPackSource).name));
  let pnamLen = names.reduce((s, b) => s + b.length + 1, 0);
  if (pnamLen % 4) pnamLen += 4 - (pnamLen % 4);

  let pseudoOrder: Uint32Array | undefined;
  let bitmapped: { pos: number; nr: number }[] | undefined;
  if (revIndex) {
    const order = Array.from({ length: n }, (_, i) => i);
    const key = (i: number) => {
      const e = entries[i] as Entry;
      return ((perm[e.pack] as number) | (e.preferred ? 0 : 0x80000000)) >>> 0;
    };
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = key(i);
    order.sort((a, b) => {
      const d = (keys[a] as number) - (keys[b] as number);
      if (d) return d;
      return (entries[a] as Entry).offset - (entries[b] as Entry).offset;
    });
    pseudoOrder = Uint32Array.from(order);
    bitmapped = packOrder.map(() => ({ pos: -1, nr: 0 }));
    for (let i = 0; i < n; i++) {
      const b = bitmapped[perm[(entries[order[i] as number] as Entry).pack] as number] as {
        pos: number;
        nr: number;
      };
      if (b.pos < 0) b.pos = i + (options.baseObjects ?? 0);
      b.nr++;
    }
    for (const b of bitmapped) if (b.pos < 0) b.pos = 0;
  }

  const chunks: {
    id: number;
    size: number;
    write(v: DataView, b: Uint8Array, at: number): void;
  }[] = [];
  chunks.push({
    id: CHUNK_PNAM,
    size: pnamLen,
    write(_v, b, at) {
      for (const name of names) {
        b.set(name, at);
        at += name.length + 1;
      }
    },
  });
  chunks.push({
    id: CHUNK_OIDF,
    size: 1024,
    write(v, _b, at) {
      let count = 0;
      let j = 0;
      for (let i = 0; i < 256; i++) {
        while (j < n && Number.parseInt((entries[j] as Entry).id.slice(0, 2), 16) === i) {
          count++;
          j++;
        }
        v.setUint32(at + 4 * i, count);
      }
    },
  });
  chunks.push({
    id: CHUNK_OIDL,
    size: n * HASH_SIZE,
    write(_v, b, at) {
      for (let i = 0; i < n; i++) b.set(hexToBytes((entries[i] as Entry).id), at + i * HASH_SIZE);
    },
  });
  chunks.push({
    id: CHUNK_OOFF,
    size: n * 8,
    write(v, _b, at) {
      let large = 0;
      for (let i = 0; i < n; i++) {
        const e = entries[i] as Entry;
        v.setUint32(at + 8 * i, perm[e.pack] as number);
        if (largeNeeded && e.offset >= 0x80000000)
          v.setUint32(at + 8 * i + 4, (LARGE_OFFSET_NEEDED | large++) >>> 0);
        else v.setUint32(at + 8 * i + 4, e.offset);
      }
    },
  });
  if (largeNeeded)
    chunks.push({
      id: CHUNK_LOFF,
      size: numLarge * 8,
      write(v, _b, at) {
        let k = 0;
        for (const e of entries) {
          if (e.offset < 0x80000000) continue;
          v.setUint32(at + 8 * k, Math.floor(e.offset / 2 ** 32));
          v.setUint32(at + 8 * k + 4, e.offset >>> 0);
          k++;
        }
      },
    });
  if (pseudoOrder && bitmapped) {
    const order = pseudoOrder;
    const bm = bitmapped;
    chunks.push({
      id: CHUNK_RIDX,
      size: n * 4,
      write(v, _b, at) {
        const nrBase = options.baseObjects ?? 0;
        for (let i = 0; i < n; i++) v.setUint32(at + 4 * i, (order[i] as number) + nrBase);
      },
    });
    if (options.bitmappedPacks)
      chunks.push({
        id: CHUNK_BTMP,
        size: packOrder.length * 8,
        write(v, _b, at) {
          bm.forEach((b, i) => {
            v.setUint32(at + 8 * i, b.pos);
            v.setUint32(at + 8 * i + 4, b.nr);
          });
        },
      });
  }

  const tocSize = (chunks.length + 1) * TOC_ENTRY;
  const bodySize = chunks.reduce((s, c) => s + c.size, 0);
  const total = HEADER_SIZE + tocSize + bodySize + HASH_SIZE;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, MIDX_SIGNATURE);
  out[4] = options.version ?? 1;
  out[5] = 1;
  out[6] = chunks.length;
  out[7] = 0;
  v.setUint32(8, packOrder.length);
  let offset = HEADER_SIZE + tocSize;
  let toc = HEADER_SIZE;
  const setBig = (at: number, value: number) => {
    v.setUint32(at, Math.floor(value / 2 ** 32));
    v.setUint32(at + 4, value >>> 0);
  };
  for (const c of chunks) {
    v.setUint32(toc, c.id);
    setBig(toc + 4, offset);
    c.write(v, out, offset);
    offset += c.size;
    toc += TOC_ENTRY;
  }
  setBig(toc + 4, offset);
  const sum = createSha1().update(out.subarray(0, offset)).digest();
  out.set(sum, offset);
  const packOf = new Uint32Array(n);
  for (let i = 0; i < n; i++) packOf[i] = perm[(entries[i] as Entry).pack] as number;
  return {
    bytes: out,
    checksum: bytesToHex(sum),
    ids: entries.map((e) => e.id),
    packOf,
    offsets: entries.map((e) => e.offset),
    packOrder,
    ...(pseudoOrder ? { pseudoOrder } : {}),
    ...(bitmapped ? { bitmapped } : {}),
  };
}
