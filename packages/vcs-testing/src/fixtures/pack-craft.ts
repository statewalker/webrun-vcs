/**
 * Hand-built pack files for edge cases git never writes (REF on REF, forward
 * references, cycles, duplicates, wrong counts, bombs, deep chains), for tests
 * of pack readers and indexers. Portable: no Node APIs.
 */
import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

/** One pack entry: a whole object (kind 1-4) or a delta (6 OFS_DELTA, 7 REF_DELTA). */
export interface CraftEntry {
  /** 1 commit, 2 tree, 3 blob, 4 tag, 6 OFS_DELTA, 7 REF_DELTA */
  kind: number;
  /** The object's content, or the delta's bytes */
  data: Uint8Array;
  /** REF_DELTA: the base object id */
  baseOid?: string;
  /** OFS_DELTA: the index of an earlier entry */
  baseIdx?: number;
  /** OFS_DELTA: an explicit back-offset (to point anywhere) */
  back?: number;
  /** Explicit zlib bytes instead of compressing `data` */
  rawZ?: Uint8Array;
  /** A header size different from `data.length` */
  sizeOverride?: number;
}

/** The git object id of `data` stored as `type`. */
export function oidOf(type: string, data: Uint8Array): string {
  const h = createSha1();
  h.update(new TextEncoder().encode(`${type} ${data.length}\0`));
  h.update(data);
  return bytesToHex(h.digest());
}

/** git's delta-size varint (7 bits per byte, little-endian). */
export function deltaVarint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/** A delta from its sizes and raw instruction bytes. */
export function craftDelta(baseLen: number, resultLen: number, ops: number[]): Uint8Array {
  return Uint8Array.from([...deltaVarint(baseLen), ...deltaVarint(resultLen), ...ops]);
}

/** The instruction copying [0, n) of the base (1 <= n <= 0xffffff; a size of 0 means 0x10000). */
export function copyAll(n: number): number[] {
  return [0x80 | 0x10 | 0x20 | 0x40, n & 255, (n >> 8) & 255, (n >> 16) & 255];
}

/**
 * A pack (version 2 unless asked) with a correct SHA-1 trailer.
 *
 * @example
 * ```typescript
 * const blob = new TextEncoder().encode("hello\n");
 * const pack = buildPack([
 *   { kind: 3, data: blob },
 *   { kind: 6, baseIdx: 0, data: craftDelta(6, 6, copyAll(6)) },
 * ]);
 * ```
 */
export function buildPack(
  entries: CraftEntry[],
  options: { count?: number; version?: number } = {},
): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  parts.push(
    0x50,
    0x41,
    0x43,
    0x4b,
    ...u32(options.version ?? 2),
    ...u32(options.count ?? entries.length),
  );
  const offsets: number[] = [];
  for (const e of entries) {
    const off = parts.length;
    offsets.push(off);
    let size = e.sizeOverride ?? e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      parts.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    parts.push(b);
    if (e.kind === 6) {
      let back = e.back ?? off - (offsets[e.baseIdx as number] as number);
      const bs = [back & 127];
      back = Math.floor(back / 128);
      while (back) {
        back--;
        bs.unshift(0x80 | (back & 127));
        back = Math.floor(back / 128);
      }
      parts.push(...bs);
    }
    if (e.kind === 7) parts.push(...hexToBytes(e.baseOid as string));
    const z = e.rawZ ?? compressBlockPako(e.data);
    for (const x of z) parts.push(x);
  }
  const body = Uint8Array.from(parts);
  const trailer = createSha1().update(body).digest();
  const out = new Uint8Array(body.length + trailer.length);
  out.set(body);
  out.set(trailer, body.length);
  return out;
}

/** An entry of an idx: object id, entry offset and CRC-32 of the entry. */
export interface CraftedIndexEntry {
  id: string;
  offset: number;
  crc32: number;
}

/** A crafted pack held in memory, with the entries an idx needs (sorted by id). */
export interface CraftedPack {
  packData: Uint8Array;
  packChecksum: Uint8Array;
  indexEntries: CraftedIndexEntry[];
}

/**
 * Lays out a pack entry by entry, deltas as given (REF or OFS), for tests of pack readers and
 * stores that need a chosen layout. Not for production: `writePack` in vcs-core streams packs
 * and finds deltas itself.
 *
 * @example
 * ```typescript
 * const w = new CraftPackWriter();
 * await w.addObject(baseId, 3, base);
 * await w.addOfsDelta(targetId, baseId, delta);
 * const { packData, packChecksum, indexEntries } = await w.finalize();
 * ```
 */
export class CraftPackWriter {
  private readonly entries: CraftEntry[] = [];
  private readonly ids: string[] = [];
  private readonly index = new Map<string, number>();
  private finalized = false;

  /** A whole object (kind 1 commit, 2 tree, 3 blob, 4 tag). */
  async addObject(id: string, type: number, content: Uint8Array): Promise<void> {
    this.add(id, { kind: type, data: content });
  }

  /** A REF_DELTA on `baseId`. */
  async addRefDelta(id: string, baseId: string, delta: Uint8Array): Promise<void> {
    this.add(id, { kind: 7, data: delta, baseOid: baseId });
  }

  /** An OFS_DELTA on `baseId`, which must be an earlier entry. */
  async addOfsDelta(id: string, baseId: string, delta: Uint8Array): Promise<void> {
    const baseIdx = this.index.get(baseId);
    if (baseIdx === undefined) throw new Error(`Base object ${baseId} not found in pack`);
    this.add(id, { kind: 6, data: delta, baseIdx });
  }

  /** Whether `id` was added. */
  getObjectOffset(id: string): number | undefined {
    return this.index.get(id);
  }

  async finalize(): Promise<CraftedPack> {
    if (this.finalized) throw new Error("Pack has already been finalized");
    this.finalized = true;
    return craftPackWithIndex(this.entries, this.ids);
  }

  private add(id: string, entry: CraftEntry) {
    if (this.finalized) throw new Error("Pack has been finalized");
    this.index.set(id, this.entries.length);
    this.entries.push(entry);
    this.ids.push(id);
  }
}

/** A pack of whole objects (and REF deltas when `deltaBaseId`/`deltaData` are given), in memory. */
export async function craftPackFile(
  objects: readonly {
    id: string;
    type: number;
    content: Uint8Array;
    deltaBaseId?: string;
    deltaData?: Uint8Array;
  }[],
): Promise<CraftedPack> {
  const w = new CraftPackWriter();
  for (const o of objects) {
    if (o.deltaBaseId && o.deltaData) await w.addRefDelta(o.id, o.deltaBaseId, o.deltaData);
    else await w.addObject(o.id, o.type, o.content);
  }
  return w.finalize();
}

/** `buildPack` of `entries`, with the offset and CRC-32 of each entry named by `ids`. */
function craftPackWithIndex(entries: CraftEntry[], ids: string[]): CraftedPack {
  const packData = buildPack(entries);
  // walk the entries again to find where each starts (buildPack lays them out in order)
  const indexEntries: CraftedIndexEntry[] = [];
  let at = 12;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as CraftEntry;
    const start = at;
    let size = e.data.length;
    at++;
    size = Math.floor(size / 16);
    while (size) {
      at++;
      size = Math.floor(size / 128);
    }
    if (e.kind === 6) {
      while ((packData[at] as number) & 0x80) at++;
      at++;
    }
    if (e.kind === 7) at += 20;
    at += compressBlockPako(e.data).length;
    indexEntries.push({
      id: ids[i] as string,
      offset: start,
      crc32: crc32Of(packData.subarray(start, at)),
    });
  }
  indexEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packData, packChecksum: packData.slice(packData.length - 20), indexEntries };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Of(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
