/**
 * Reading a pack's reachability bitmap (`pack-<id>.bitmap`, git's bitmap format v1:
 * Documentation/technical/bitmap-format.adoc, pack-bitmap.c):
 *
 *  - the header: `BITM`, version 1, the options (`BITMAP_OPT_FULL_DAG` required,
 *    `BITMAP_OPT_HASH_CACHE`, `BITMAP_OPT_LOOKUP_TABLE`, `BITMAP_OPT_PSEUDO_MERGES`), the entry
 *    count and the checksum of the pack it belongs to;
 *  - four EWAH bitmaps of the objects of each type (commits, trees, blobs, tags);
 *  - one entry per selected commit: its position in the idx, an XOR offset (the entry's
 *    bitmap is stored XORed with the one that many entries before it), flags, the bitmap;
 *  - optional sections at the end, before the trailing SHA-1: pseudo-merges (skipped: their
 *    commits are read as if absent), the lookup table (entries are read in order anyway, which
 *    gives the same bitmaps) and the name-hash cache (one 32-bit path hash per object, in idx
 *    order).
 *
 * Bit `n` stands for the `n`-th object of the pack in pack order (by offset), which comes from
 * the pack's reverse index (`PackFile.packOrder`, computed from the idx's offsets).
 *
 * A file that cannot be used throws `PackBitmapError` with git's message (`corrupted bitmap
 * index file (wrong header)`, ...); callers fall back to walking, as git does. Unlike git, the
 * trailing checksum (git checks it only in fsck) and the pack checksum in the header (git
 * checks it only for multi-pack bitmaps) are checked on open, as a stale or damaged bitmap
 * would silently drop objects from served packs.
 */
import { EwahBitmap } from "@statewalker/vcs-utils";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";

export const BITMAP_OPT_FULL_DAG = 0x1;
export const BITMAP_OPT_HASH_CACHE = 0x4;
export const BITMAP_OPT_LOOKUP_TABLE = 0x10;
export const BITMAP_OPT_PSEUDO_MERGES = 0x20;
/** git's MAX_XOR_OFFSET: an entry is XORed with one of the 160 before it at most. */
export const MAX_BITMAP_XOR_OFFSET = 160;
const HEADER_SIZE = 32;
const HASH_SIZE = 20;
const LOOKUP_TRIPLET = 16;

/** What a bitmap needs of its pack: the idx order, the pack order, lookups. */
export interface BitmapPack {
  readonly packId: string;
  readonly count: number;
  /** For each entry in pack order, its idx position. */
  packOrder(): Uint32Array;
  idAt(i: number): ObjectId;
  indexOf(id: ObjectId): number;
}

/** A bitmap file git would refuse; the message is git's (without `error: `). */
export class PackBitmapError extends Error {
  override name = "PackBitmapError";
}

/** One selected commit of a bitmap file, as stored. */
export interface PackBitmapEntry {
  /** The commit */
  id: ObjectId;
  /** Its position in the idx */
  indexPosition: number;
  /** The entry it is XORed with, as an offset back (0: none) */
  xorOffset: number;
  flags: number;
}

/** A pack's bitmap, read and checked. */
export interface PackBitmapIndex {
  readonly pack: BitmapPack;
  /** The header's options (`BITMAP_OPT_*`). */
  readonly options: number;
  /** The selected commits, in file order. */
  readonly entries: readonly PackBitmapEntry[];
  /** The objects of each type, by pack position. */
  readonly commits: EwahBitmap;
  readonly trees: EwahBitmap;
  readonly blobs: EwahBitmap;
  readonly tags: EwahBitmap;
  /** The name-hash cache, by idx position (with `BITMAP_OPT_HASH_CACHE`). */
  readonly hashes?: Uint32Array;
  /** Objects in the pack. */
  readonly count: number;
  /** The pack position of `id`, -1 when the pack does not hold it. */
  position(id: ObjectId): number;
  /** The id at pack position `pos`. */
  idAt(pos: number): ObjectId;
  /** The name hash of the object at pack position `pos` (0 without a cache). */
  nameHashAt(pos: number): number;
  /** The type of the object at pack position `pos`. */
  typeAt(pos: number): ObjectTypeString | undefined;
  /** Whether `id` has a stored bitmap. */
  has(id: ObjectId): boolean;
  /** The reachability bitmap of a selected commit (XOR chain resolved), or undefined. */
  bitmapFor(id: ObjectId): EwahBitmap | undefined;
}

/**
 * Reads a `.bitmap` file of `pack`. Throws `PackBitmapError` (git's message) when it cannot be
 * used; `path` names the file in the checksum message.
 *
 * @example
 * ```typescript
 * const index = parsePackBitmap(bytes, pack, ".git/objects/pack/pack-1234.bitmap");
 * const reach = index.bitmapFor(tipCommit); // positions in pack order
 * ```
 */
export function parsePackBitmap(bytes: Uint8Array, pack: BitmapPack, path = ""): PackBitmapIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.length;
  if (size < HEADER_SIZE + HASH_SIZE)
    throw new PackBitmapError("corrupted bitmap index (too small)");
  if (bytes[0] !== 0x42 || bytes[1] !== 0x49 || bytes[2] !== 0x54 || bytes[3] !== 0x4d)
    throw new PackBitmapError("corrupted bitmap index file (wrong header)");
  const version = view.getUint16(4);
  if (version !== 1)
    throw new PackBitmapError(`unsupported version '${version}' for bitmap index file`);
  const options = view.getUint16(6);
  const entryCount = view.getUint32(8);
  const packChecksum = bytesToHex(bytes.subarray(12, 32));
  if ((options & BITMAP_OPT_FULL_DAG) === 0)
    throw new PackBitmapError(
      "unsupported options for bitmap index file (Git requires BITMAP_OPT_FULL_DAG)",
    );
  const sum = createSha1()
    .update(bytes.subarray(0, size - HASH_SIZE))
    .digest();
  for (let i = 0; i < HASH_SIZE; i++) {
    if (sum[i] !== bytes[size - HASH_SIZE + i])
      throw new PackBitmapError(`bitmap file '${path}' has invalid checksum`);
  }
  if (packChecksum !== pack.packId)
    throw new PackBitmapError("checksum doesn't match in pack and bitmap");

  const count = pack.count;
  let indexEnd = size - HASH_SIZE;
  let hashes: Uint32Array | undefined;
  if (options & BITMAP_OPT_HASH_CACHE) {
    const cacheSize = count * 4;
    if (cacheSize > indexEnd - HEADER_SIZE)
      throw new PackBitmapError("corrupted bitmap index file (too short to fit hash cache)");
    hashes = new Uint32Array(count);
    const at = indexEnd - cacheSize;
    for (let i = 0; i < count; i++) hashes[i] = view.getUint32(at + i * 4);
    indexEnd = at;
  }
  if (options & BITMAP_OPT_LOOKUP_TABLE) {
    const tableSize = entryCount * LOOKUP_TRIPLET;
    if (tableSize > indexEnd - HEADER_SIZE)
      throw new PackBitmapError("corrupted bitmap index file (too short to fit lookup table)");
    indexEnd -= tableSize;
  }
  if (options & BITMAP_OPT_PSEUDO_MERGES) {
    if (8 > indexEnd - HEADER_SIZE)
      throw new PackBitmapError(
        "corrupted bitmap index file (too short to fit pseudo-merge table header)",
      );
    const tableSize = Number(view.getBigUint64(indexEnd - 8));
    if (tableSize > indexEnd - HEADER_SIZE)
      throw new PackBitmapError(
        "corrupted bitmap index file (too short to fit pseudo-merge table)",
      );
    indexEnd -= tableSize;
  }

  let pos = HEADER_SIZE;
  const readEwah = (): EwahBitmap => {
    const r = EwahBitmap.read(bytes, pos, indexEnd);
    if (!r?.bitmap.isWellFormed())
      throw new PackBitmapError("failed to load bitmap index (corrupted?)");
    pos = r.next;
    return r.bitmap;
  };
  const commits = readEwah();
  const trees = readEwah();
  const blobs = readEwah();
  const tags = readEwah();

  const entries: PackBitmapEntry[] = [];
  const stored: EwahBitmap[] = [];
  const byId = new Map<ObjectId, number>();
  for (let i = 0; i < entryCount; i++) {
    if (indexEnd - pos < 6)
      throw new PackBitmapError(`corrupt ewah bitmap: truncated header for entry ${i}`);
    const indexPosition = view.getUint32(pos);
    const xorOffset = bytes[pos + 4] as number;
    const flags = bytes[pos + 5] as number;
    pos += 6;
    if (indexPosition >= count)
      throw new PackBitmapError(`corrupt ewah bitmap: commit index ${indexPosition} out of range`);
    if (xorOffset > MAX_BITMAP_XOR_OFFSET || xorOffset > i)
      throw new PackBitmapError("corrupted bitmap pack index");
    const id = pack.idAt(indexPosition);
    stored.push(readEwah());
    if (byId.has(id)) throw new PackBitmapError(`duplicate entry in bitmap index: '${id}'`);
    byId.set(id, i);
    entries.push({ id, indexPosition, xorOffset, flags });
  }

  // pack position <-> idx position
  const order = pack.packOrder();
  let inverse: Uint32Array | undefined;
  const packPosOf = (indexPos: number): number => {
    if (!inverse) {
      inverse = new Uint32Array(count);
      for (let p = 0; p < count; p++) inverse[order[p] as number] = p;
    }
    return inverse[indexPos] as number;
  };
  const resolved: (EwahBitmap | undefined)[] = new Array(entryCount);
  const resolve = (i: number): EwahBitmap => {
    // iterative down the XOR chain, then composed back up
    const chain: number[] = [];
    let k = i;
    while (resolved[k] === undefined) {
      chain.push(k);
      const off = (entries[k] as PackBitmapEntry).xorOffset;
      if (off === 0) break;
      k -= off;
    }
    let base: EwahBitmap | undefined = resolved[k];
    for (let c = chain.length - 1; c >= 0; c--) {
      const at = chain[c] as number;
      const own = stored[at] as EwahBitmap;
      base = base === undefined ? own : EwahBitmap.xor(own, base);
      resolved[at] = base;
    }
    return resolved[i] as EwahBitmap;
  };
  const typeBitmaps: [EwahBitmap, ObjectTypeString][] = [
    [commits, "commit"],
    [trees, "tree"],
    [blobs, "blob"],
    [tags, "tag"],
  ];
  let types: Uint8Array | undefined;
  const TYPE_NAMES: (ObjectTypeString | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];

  return {
    pack,
    options,
    entries,
    commits,
    trees,
    blobs,
    tags,
    ...(hashes ? { hashes } : {}),
    count,
    position(id) {
      const i = pack.indexOf(id);
      return i < 0 ? -1 : packPosOf(i);
    },
    idAt: (p) => pack.idAt(order[p] as number),
    nameHashAt: (p) => (hashes ? (hashes[order[p] as number] as number) : 0),
    typeAt(p) {
      if (!types) {
        const t = new Uint8Array(count);
        typeBitmaps.forEach(([b], k) => {
          for (const bit of b.bits()) if (bit < count) t[bit] = k + 1;
        });
        types = t;
      }
      return TYPE_NAMES[types[p] as number];
    },
    has: (id) => byId.has(id),
    bitmapFor(id) {
      const i = byId.get(id);
      return i === undefined ? undefined : resolve(i);
    },
  };
}
