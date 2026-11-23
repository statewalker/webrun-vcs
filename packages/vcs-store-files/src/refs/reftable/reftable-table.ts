/**
 * One reftable file, read lazily as git's `reftable/reader.c` reads it (`block.c`,
 * `record.c`; the format is `Documentation/technical/reftable.adoc`).
 *
 * @example
 * ```typescript
 * const table = openReftable(bytes, "0x000000000001-0x000000000004-70da100a.ref");
 * table.getRef("refs/heads/main"); // a seek: the index (or the blocks' first keys), restarts
 * for (const ref of table.refs("refs/tags/")) console.log(ref.name, ref.value);
 * for (const log of table.logs("HEAD")) console.log(log.updateIndex, log.update?.message);
 * ```
 *
 * A table is a header, the ref blocks, the ref index, the obj blocks and their index, the log
 * blocks and their index, and a footer that repeats the header, gives where each section
 * starts and ends with a CRC-32. Opening a table checks only the header, the footer (magic,
 * header copy, CRC-32) and the section positions: nothing is decoded until it is asked for,
 * and memory beyond the file's bytes is one block (a log block inflated) per iterator.
 *
 *  - `getRef(name)` seeks as git's reader does: through the ref index when the table has one
 *    (each index record names the block holding keys up to its own), else a walk over the ref
 *    blocks' first keys; then a binary search over the block's restart points and a scan of
 *    one restart interval. Keys are rebuilt in one scratch buffer; only the record returned
 *    gets a name string.
 *  - `refs(prefix)` and `logs(refName)` are generators decoding one block at a time; log
 *    records of one ref share its name string.
 *  - `verify()` walks every block and record in file order (an fsck of the table).
 *
 * Whatever is decoded is checked, so a crafted table is refused (`ReftableFormatError`) rather
 * than read past its bounds: each block's type, length (within its section) and restart table
 * (offsets ascending, inside the record area, each one the start of a record whose key is not
 * prefix compressed); each record's prefix length (at most the previous key's), suffix,
 * varints and value inside the record area; keys strictly ascending; log blocks inflated to
 * exactly the length their header gives (at most 16 MiB: `block_len` is 24 bits); index
 * records naming a block before themselves.
 *
 * Prefix compression and deflate let a small table stand for very many or very long keys
 * (a key repeating its whole predecessor plus one byte costs two file bytes; a deflated log
 * block of tombstones a fraction of a byte per record), so each call gets a
 * {@link ReftableReadBudget}: the bytes it decodes (a fixed cost per record, its key suffix
 * and value, each name it materialises, each log block it inflates) may not exceed
 * {@link REFTABLE_READ_CEILING}. What a call holds is then bounded by what its caller keeps,
 * never by the table's size times an amplification. Version 1 tables (SHA-1) and version 2
 * tables with hash id `sha1` are read; SHA-256 tables (`s256`) are refused
 * (`ReftableUnsupportedError`).
 */

import { inflateWhole } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import { ReftableFormatError, ReftableUnsupportedError } from "./reftable-errors.js";

/** The value of a ref record (`value_type` 0 to 3). */
export type ReftableRefValue =
  | { readonly type: "deletion" }
  | { readonly type: "id"; readonly id: string }
  | { readonly type: "peeled"; readonly id: string; readonly peeled: string }
  | { readonly type: "symref"; readonly target: string };

/** A ref record: the ref's name, the update index that last changed it, its value. */
export interface ReftableRefRecord {
  readonly name: string;
  /** The name's bytes (the record key), for byte-order comparisons */
  readonly key: Uint8Array;
  readonly updateIndex: number;
  readonly value: ReftableRefValue;
}

/** The update a log record holds (`log_type` 1). */
export interface ReftableLogUpdate {
  readonly oldId: string;
  readonly newId: string;
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch */
  readonly time: number;
  /** Minutes east of UTC (`GMT-0800` is -480) */
  readonly tzOffset: number;
  /** The message as stored (git's writer ends it with one newline) */
  readonly message: string;
}

/** A log record: a ref's reflog entry at an update index, or its deletion (`log_type` 0). */
export interface ReftableLogRecord {
  readonly refName: string;
  /** The ref name's bytes, for byte-order comparisons */
  readonly refKey: Uint8Array;
  readonly updateIndex: number;
  /** Undefined for a deletion record, which hides the entry of older tables */
  readonly update?: ReftableLogUpdate;
}

/** A log record whose update is read on demand (`ReftableTable.logHeads`). */
export interface ReftableLogHead {
  readonly refName: string;
  readonly refKey: Uint8Array;
  readonly updateIndex: number;
  /** A deletion record: `read()` gives undefined */
  readonly deletion: boolean;
  /** The update; only once, and only before the generator moves on */
  read(): ReftableLogUpdate | undefined;
}

/** How many blocks of each kind a table holds (ref, index, obj, log). */
export interface ReftableBlockCounts {
  ref: number;
  index: number;
  obj: number;
  log: number;
}

/** An opened reftable: its header, and lazy reads of its records. */
export interface ReftableTable {
  /** The file's name (for messages) */
  readonly name: string;
  /** 1, or 2 (with a hash id) */
  readonly version: 1 | 2;
  /** The header's block size (0 for an unaligned table) */
  readonly blockSize: number;
  readonly minUpdateIndex: number;
  readonly maxUpdateIndex: number;
  /** The footer's `obj_id_len` (0 without obj blocks) */
  readonly objectIdLength: number;
  /** The file's length in bytes (held in memory while the table is open) */
  readonly size: number;
  /** The ref record of `name`, a deletion record included; undefined when the table has none */
  getRef(name: string, budget?: ReftableReadBudget): ReftableRefRecord | undefined;
  /** Ref records whose name starts with `prefix`, in key order, deletions included */
  refs(prefix?: string, budget?: ReftableReadBudget): Generator<ReftableRefRecord>;
  /**
   * Log records in key order (by ref name, then newest update index first), deletions
   * included: of `refName` only when given, else all of them.
   */
  logs(refName?: string, budget?: ReftableReadBudget): Generator<ReftableLogRecord>;
  /**
   * As `logs`, but each record's update is decoded only when `read()` is called, before the
   * generator moves on (a merge reads only the records no newer table hides).
   */
  logHeads(refName?: string, budget?: ReftableReadBudget): Generator<ReftableLogHead>;
  /** Walks every block and record in file order and checks them (fsck); the block counts. */
  verify(budget?: ReftableReadBudget): { blocks: ReftableBlockCounts };
}

/**
 * The most bytes one read (a lookup, a listing, a reflog read, a verify) may decode: 256 MiB,
 * counted as {@link ReftableReadBudget} counts them. Real reads stay far below it (a listing
 * of a million refs charges about 100 MiB); crafted tables meet it instead of exhausting
 * memory.
 */
export const REFTABLE_READ_CEILING = 256 * 1024 * 1024;

/**
 * The most inflated log bytes one read may hold at once: 128 MiB. A walk holds one block, a
 * merge one per table; git's writer keeps a block within the table's block size (4 KiB by
 * default), so real stacks hold far less.
 */
export const REFTABLE_HELD_CEILING = 128 * 1024 * 1024;

/** What each record visited costs besides its key suffix (its decoding). */
const RECORD_COST = 16;
/** Inflating a log block costs its inflated length over this (real logs inflate a few times) */
const INFLATE_COST_DIVISOR = 8;

/**
 * The bytes one read has decoded: `RECORD_COST` plus the key suffix of each record visited,
 * what it materialises (three bytes per byte of each name or text it decodes, for a copy and
 * a string of two bytes a character at worst; 40 per object id in hex), and an eighth of each
 * log block it inflates. Besides, the inflated log blocks a read holds at once (one per
 * iterator; a merge has one per table) are counted whole while held and may not exceed
 * `heldCeiling`. A record passed over (a seek's scan, a value a newer table hides)
 * costs its suffix and `RECORD_COST` only, so a stack of tombstones over a long reflog is
 * read, while the names and values a read returns, and the blocks it inflates, stay bounded.
 * Past `ceiling`, the read is refused with `ReftableFormatError`.
 */
export class ReftableReadBudget {
  used = 0;
  held = 0;
  constructor(
    readonly ceiling = REFTABLE_READ_CEILING,
    readonly heldCeiling = REFTABLE_HELD_CEILING,
  ) {}

  /** Counts `bytes` of an inflated block held until `release`. */
  hold(bytes: number, table: string): void {
    this.held += bytes;
    if (this.held > this.heldCeiling) {
      throw new ReftableFormatError(
        table,
        `one read holds more than ${this.heldCeiling} bytes of inflated log blocks at once`,
      );
    }
  }

  release(bytes: number): void {
    this.held -= bytes;
  }

  charge(bytes: number, table: string): void {
    this.used += bytes;
    if (this.used > this.ceiling) {
      throw new ReftableFormatError(
        table,
        `one read decodes more than ${this.ceiling} bytes (the per-read ceiling)`,
      );
    }
  }
}

const MAGIC = [0x52, 0x45, 0x46, 0x54]; // "REFT"
const HASH_SIZE = 20;
const FORMAT_ID_SHA1 = 0x73686131; // "sha1"
const FORMAT_ID_SHA256 = 0x73323536; // "s256"
const TYPE_REF = 0x72; // 'r'
const TYPE_LOG = 0x67; // 'g'
const TYPE_OBJ = 0x6f; // 'o'
const TYPE_INDEX = 0x69; // 'i'
/** Index levels a seek follows at most (git writes as many as it needs; each is 1/n the last) */
const MAX_INDEX_DEPTH = 32;

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/** The header's length for a version (24, or 28 with the hash id). */
function headerSize(version: number): number {
  return version === 1 ? 24 : 28;
}

/** The footer's length for a version (68, or 72 with the hash id). */
function footerSize(version: number): number {
  return headerSize(version) + 5 * 8 + 4;
}

function be16(b: Uint8Array, at: number): number {
  return ((b[at] as number) << 8) | (b[at + 1] as number);
}

function be24(b: Uint8Array, at: number): number {
  return ((b[at] as number) << 16) | ((b[at + 1] as number) << 8) | (b[at + 2] as number);
}

function be32(b: Uint8Array, at: number): number {
  return (
    ((b[at] as number) * 0x1000000 +
      (((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number))) >>>
    0
  );
}

function be64(b: Uint8Array, at: number): bigint {
  return (BigInt(be32(b, at)) << 32n) | BigInt(be32(b, at + 4));
}

/** Byte-order comparison of two keys (memcmp, then the shorter first). */
export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function fail(table: string, detail: string): never {
  throw new ReftableFormatError(table, detail);
}

/** A block of a section, its records' bytes in hand (a log block inflated). */
interface Block {
  /** Where it starts in the file */
  offset: number;
  type: number;
  /** The block's bytes from its start (the file's start for the first block) */
  data: Uint8Array;
  /** Where its records start: after the file header (first block) and the block header */
  recordsStart: number;
  /** Where the restart table starts: the records end there */
  recordsEnd: number;
  /** How many restart offsets the restart table at `recordsEnd` holds (read by `restartAt`) */
  restartCount: number;
  /** The bytes the block takes in the file, padding included */
  fullSize: number;
}

/** The `i`th restart offset of `block`, read from its bytes (as git's block_reader). */
function restartAt(block: Block, i: number): number {
  return be24(block.data, block.recordsEnd + 3 * i);
}

/** A section of blocks of one type: where it starts, the bound of its blocks, its index. */
interface Section {
  type: number;
  start: number;
  end: number;
  /** The index root's position, 0 without an index */
  index: number;
}

/**
 * Walks the records of blocks: each key rebuilt in one scratch buffer against the previous
 * one (prefix compression), restarts and key order checked, every byte charged to the read's
 * budget. `nextKey` stops at a record's value; the caller reads it (`varint`, `take`) or skips
 * it, then calls `endValue`.
 */
class Cursor {
  key = new Uint8Array(64);
  keyLen = 0;
  /** The key in hand is the previous record's: the next one must sort after it */
  hasPrev = false;
  /** At a block's start: the next key is not prefix compressed */
  fresh = true;
  block!: Block;
  pos = 0;
  nextRestart = 0;
  prefix = 0;
  suffix = 0;
  type = 0;
  valueStart = 0;
  /** The previous log record's ref name, reused while records keep it */
  lastRefName = "";
  lastRefKey: Uint8Array = new Uint8Array(0);
  /** Log heads handed out: a head reads its value only while it is the last one */
  records = 0;

  constructor(
    readonly table: string,
    readonly budget: ReftableReadBudget,
    readonly what: string,
  ) {}

  /** Starts at `pos` of `block`; `keepOrder` checks the first key against the key in hand. */
  enter(block: Block, pos: number, keepOrder: boolean): void {
    this.block = block;
    this.pos = pos;
    this.fresh = true;
    if (!keepOrder) this.hasPrev = false;
    let lo = 0;
    let hi = block.restartCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (restartAt(block, mid) < pos) lo = mid + 1;
      else hi = mid;
    }
    this.nextRestart = lo;
  }

  varint(): number {
    const data = this.block.data;
    const end = this.block.recordsEnd;
    let pos = this.pos;
    if (pos >= end) fail(this.table, "varint past the end of its block");
    let c = data[pos++] as number;
    let value = c & 0x7f;
    while (c & 0x80) {
      value += 1;
      if (value > Math.floor(Number.MAX_SAFE_INTEGER / 128)) fail(this.table, "varint overflow");
      if (pos >= end) fail(this.table, "varint past the end of its block");
      c = data[pos++] as number;
      value = value * 128 + (c & 0x7f);
    }
    this.pos = pos;
    return value;
  }

  take(n: number, what: string): Uint8Array {
    if (this.pos + n > this.block.recordsEnd) fail(this.table, `${what} runs past the records`);
    const out = this.block.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Reads the next record's key; false at the end of the block (checked then). */
  nextKey(): boolean {
    const b = this.block;
    const at = `block at ${b.offset}`;
    if (this.pos >= b.recordsEnd) {
      if (this.pos > b.recordsEnd) fail(this.table, `${at}: record runs past the records`);
      if (this.nextRestart < b.restartCount) {
        fail(this.table, `${at}: a restart offset is not a record start`);
      }
      return false;
    }
    const start = this.pos;
    let isRestart = false;
    if (this.nextRestart < b.restartCount) {
      const r = restartAt(b, this.nextRestart);
      if (start > r) fail(this.table, `${at}: a restart offset is not a record start`);
      if (start === r) {
        isRestart = true;
        this.nextRestart++;
      }
    }
    const prefix = this.varint();
    const suffixAndType = this.varint();
    const suffix = Math.floor(suffixAndType / 8);
    if (isRestart && prefix !== 0) fail(this.table, `${at}: restart record with a compressed key`);
    if (prefix > (this.fresh ? 0 : this.keyLen)) {
      fail(this.table, `${at}: key prefix longer than the last key`);
    }
    const pos = this.pos;
    if (pos + suffix > b.recordsEnd) fail(this.table, `${at}: key runs past the records`);
    const data = b.data;
    let key = this.key;
    if (this.hasPrev) {
      // the new key shares [0, prefix) with the last one: compare from there on
      const n = Math.min(suffix, this.keyLen - prefix);
      let c = 0;
      for (let i = 0; i < n && c === 0; i++) {
        c = (data[pos + i] as number) - (key[prefix + i] as number);
      }
      if (c === 0) c = prefix + suffix - this.keyLen;
      if (c <= 0) fail(this.table, `${this.what} records out of order`);
    }
    const length = prefix + suffix;
    if (length > key.length) {
      const grown = new Uint8Array(Math.max(length, key.length * 2));
      grown.set(key.subarray(0, prefix));
      key = grown;
      this.key = grown;
    }
    key.set(data.subarray(pos, pos + suffix), prefix);
    this.keyLen = length;
    this.hasPrev = true;
    this.fresh = false;
    this.prefix = prefix;
    this.suffix = suffix;
    this.type = suffixAndType % 8;
    this.pos = pos + suffix;
    this.valueStart = this.pos;
    return true;
  }

  /** Charges the record (its cost, key suffix and value) once its value is read. */
  endValue(): void {
    if (this.pos > this.block.recordsEnd) {
      fail(this.table, `block at ${this.block.offset}: record runs past the records`);
    }
    this.budget.charge(RECORD_COST + this.suffix, this.table);
  }

  /** The key in hand against `want`, as `compareKeys`. */
  compareTo(want: Uint8Array): number {
    const key = this.key;
    const n = Math.min(this.keyLen, want.length);
    for (let i = 0; i < n; i++) {
      const d = (key[i] as number) - (want[i] as number);
      if (d !== 0) return d;
    }
    return this.keyLen - want.length;
  }

  startsWith(prefix: Uint8Array): boolean {
    if (this.keyLen < prefix.length) return false;
    const key = this.key;
    for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
    return true;
  }

  /** The key in hand's first `n` bytes, copied, and as a string (charged). */
  materialise(n: number): [Uint8Array, string] {
    this.budget.charge(3 * n, this.table);
    const bytes = this.key.slice(0, n);
    return [bytes, utf8.decode(bytes)];
  }
}

/** Opens a table held whole in memory; see the module's notes. */
export function openReftable(bytes: Uint8Array, name = "<reftable>"): ReftableTable {
  return new Reftable(bytes, name);
}

class Reftable implements ReftableTable {
  readonly version: 1 | 2;
  readonly blockSize: number;
  readonly minUpdateIndex: number;
  readonly maxUpdateIndex: number;
  readonly objectIdLength: number;
  readonly size: number;
  private readonly hSize: number;
  private readonly footerStart: number;
  private readonly firstType: number | undefined;
  private readonly refIndexPos: number;
  private readonly objPos: number;
  private readonly objIndexPos: number;
  private readonly logPos: number;
  private readonly logIndexPos: number;

  constructor(
    private readonly bytes: Uint8Array,
    readonly name: string,
  ) {
    this.size = bytes.length;
    const bad = (detail: string): never => fail(name, detail);
    // header: magic, version, block size, update indexes (and a hash id in version 2)
    if (bytes.length < 24) bad(`truncated: ${bytes.length} bytes, shorter than a header`);
    for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) bad("bad magic (not 'REFT')");
    const version = bytes[4] as number;
    if (version !== 1 && version !== 2) bad(`unknown version ${version}`);
    this.version = version as 1 | 2;
    const hSize = headerSize(version);
    const fSize = footerSize(version);
    this.hSize = hSize;
    if (bytes.length < hSize + fSize) {
      bad(`truncated: ${bytes.length} bytes, shorter than a header and a footer`);
    }
    if (version === 2) {
      const hashId = be32(bytes, 24);
      if (hashId === FORMAT_ID_SHA256) {
        throw new ReftableUnsupportedError(name, "SHA-256 tables (hash id 's256') are not read");
      }
      if (hashId !== FORMAT_ID_SHA1) bad(`unknown hash id 0x${hashId.toString(16)}`);
    }
    this.blockSize = be24(bytes, 5);
    const toIndex = (value: bigint, what: string): number => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) bad(`${what} ${value} out of range`);
      return Number(value);
    };
    this.minUpdateIndex = toIndex(be64(bytes, 8), "min_update_index");
    this.maxUpdateIndex = toIndex(be64(bytes, 16), "max_update_index");

    // footer: the header again, the section positions and a CRC-32 of all that
    const footerStart = bytes.length - fSize;
    this.footerStart = footerStart;
    for (let i = 0; i < hSize; i++) {
      if (bytes[footerStart + i] !== bytes[i]) bad("footer does not repeat the header");
    }
    const crcAt = footerStart + fSize - 4;
    if (crc32(bytes.subarray(footerStart, crcAt)) !== be32(bytes, crcAt)) {
      bad("footer CRC-32 mismatch");
    }
    let at = footerStart + hSize;
    const position = (what: string): number => {
      const value = be64(bytes, at);
      at += 8;
      if (value >= BigInt(footerStart)) bad(`${what} ${value} past the last block`);
      return Number(value);
    };
    this.refIndexPos = position("ref_index_position");
    const objField = be64(bytes, at);
    at += 8;
    this.objectIdLength = Number(objField & 31n);
    const objPosBig = objField >> 5n;
    if (objPosBig >= BigInt(footerStart)) bad(`obj_position ${objPosBig} past the last block`);
    this.objPos = Number(objPosBig);
    if (this.objPos > 0 && this.objectIdLength === 0) bad("obj blocks without an obj_id_len");
    this.objIndexPos = position("obj_index_position");
    this.logPos = position("log_position");
    this.logIndexPos = position("log_index_position");

    const firstType = footerStart > hSize ? (bytes[hSize] as number) : undefined;
    this.firstType = firstType;
    if (firstType !== undefined && firstType !== TYPE_REF && firstType !== TYPE_LOG) {
      bad(`the first block is of type 0x${firstType.toString(16)}, neither ref nor log`);
    }
    if (
      firstType === undefined &&
      (this.refIndexPos || this.objPos || this.objIndexPos || this.logPos || this.logIndexPos)
    ) {
      bad("an empty table names sections");
    }
    if (firstType === TYPE_LOG && this.logPos > 0) bad("a log-only table with a log_position");
    if (this.objPos > 0 && this.logPos > 0 && this.objPos >= this.logPos) {
      bad("obj blocks after the log blocks");
    }
    if (firstType === TYPE_LOG && (this.refIndexPos || this.objPos || this.objIndexPos)) {
      bad("a log-only table names ref or obj sections");
    }
  }

  /** The ref or log section, or undefined when the table has none. */
  private section(type: number): Section | undefined {
    if (type === TYPE_REF) {
      if (this.firstType !== TYPE_REF) return undefined;
      const end = [this.objPos, this.logPos].find((p) => p > 0) ?? this.footerStart;
      return { type, start: 0, end, index: this.refIndexPos };
    }
    const start = this.logPos > 0 ? this.logPos : this.firstType === TYPE_LOG ? 0 : undefined;
    if (start === undefined) return undefined;
    return { type, start, end: this.footerStart, index: this.logIndexPos };
  }

  /** The block at `offset`, whose bytes stay before `end`: any type, checked. */
  private readBlock(offset: number, end: number, budget: ReftableReadBudget): Block {
    const bytes = this.bytes;
    const name = this.name;
    const headerOff = offset === 0 ? this.hSize : 0;
    if (offset + headerOff + 4 > end) fail(name, `block at ${offset} runs past its section`);
    const type = bytes[offset + headerOff] as number;
    if (type !== TYPE_REF && type !== TYPE_LOG && type !== TYPE_OBJ && type !== TYPE_INDEX) {
      fail(name, `block at ${offset} is of unknown type 0x${type.toString(16)}`);
    }
    const blockLen = be24(bytes, offset + headerOff + 1);
    if (blockLen < headerOff + 4 + 2)
      fail(name, `block at ${offset} too short (${blockLen} bytes)`);
    let data: Uint8Array;
    let fullSize: number;
    if (type === TYPE_LOG) {
      // block_len is the inflated length, block header included; the deflated stream follows
      const skip = headerOff + 4;
      // git's writer never fills a block past the table's block size (block.c's
      // block_writer_add), deflated or not
      if (this.blockSize > 0 && blockLen > this.blockSize) {
        fail(
          name,
          `log block at ${offset} of ${blockLen} bytes, past the block size ${this.blockSize}`,
        );
      }
      budget.charge(Math.ceil(blockLen / INFLATE_COST_DIVISOR), name);
      // held whole while it is read: released by `drop` when the reader moves on
      budget.hold(blockLen, name);
      data = new Uint8Array(blockLen);
      data.set(bytes.subarray(offset, offset + skip));
      let consumed: number;
      try {
        const r = inflateWhole(bytes.subarray(offset + skip, end), { into: data.subarray(skip) });
        if (r.length !== blockLen - skip) {
          fail(
            name,
            `log block at ${offset} inflates to ${r.length + skip} bytes, not ${blockLen}`,
          );
        }
        consumed = r.consumed;
      } catch (error) {
        if (error instanceof ReftableFormatError) throw error;
        fail(name, `log block at ${offset} does not inflate: ${(error as Error).message}`);
      }
      fullSize = skip + consumed;
    } else {
      if (offset + blockLen > end) {
        fail(name, `block at ${offset} (${blockLen} bytes) runs past its section`);
      }
      data = bytes.subarray(offset, offset + blockLen);
      // padded to the block size unless the next byte starts another block (git's
      // reftable_block_init)
      fullSize = blockLen;
      if (this.blockSize > 0 && blockLen < this.blockSize && offset + blockLen < bytes.length) {
        if (bytes[offset + blockLen] === 0) fullSize = this.blockSize;
      }
    }
    const restartCount = be16(data, blockLen - 2);
    const recordsStart = headerOff + 4;
    const recordsEnd = blockLen - 2 - 3 * restartCount;
    if (restartCount === 0) fail(name, `block at ${offset} has no restart point`);
    if (recordsEnd < recordsStart) {
      fail(name, `block at ${offset}: restart table overlaps its header`);
    }
    // checked once per read of the block, no copy kept: charged as the bytes it reads
    budget.charge(3 * restartCount, name);
    let previous = -1;
    for (let i = 0; i < restartCount; i++) {
      const r = be24(data, recordsEnd + 3 * i);
      if (r < recordsStart || r >= recordsEnd || r <= previous) {
        fail(name, `block at ${offset}: restart offset ${r} out of range`);
      }
      previous = r;
    }
    return { offset, type, data, recordsStart, recordsEnd, restartCount, fullSize };
  }

  /** Lets go of a block read: an inflated log block no longer counts as held. */
  private drop(block: Block | undefined, budget: ReftableReadBudget): void {
    if (block?.type === TYPE_LOG) budget.release(block.data.length);
  }

  /** The block of `section` at `offset`, or undefined where the section's blocks end. */
  private blockAt(section: Section, offset: number, budget: ReftableReadBudget) {
    if (offset >= section.end) return undefined;
    const headerOff = offset === 0 ? this.hSize : 0;
    if (offset + headerOff >= section.end) return undefined;
    if (this.bytes[offset + headerOff] !== section.type) return undefined;
    return this.readBlock(offset, section.end, budget);
  }

  /** The key of the record at `pos` (a restart: not compressed) against `want`. */
  private keyAtCompare(block: Block, pos: number, want: Uint8Array, budget: ReftableReadBudget) {
    const c = new Cursor(this.name, budget, "");
    c.enter(block, pos, false);
    c.nextRestart = block.restartCount; // checked by the scan that follows, not here
    c.nextKey();
    if (c.prefix !== 0)
      fail(this.name, `block at ${block.offset}: restart record with a compressed key`);
    budget.charge(c.suffix, this.name);
    return c.compareTo(want);
  }

  /**
   * Where a scan for the first key at or after `want` starts in `block`: the last restart
   * whose key is not past `want` (git's block_iter_seek_key), else the records' start.
   */
  private restartBefore(block: Block, want: Uint8Array, budget: ReftableReadBudget): number {
    let lo = 0;
    let hi = block.restartCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.keyAtCompare(block, restartAt(block, mid), want, budget) > 0) hi = mid;
      else lo = mid + 1;
    }
    return lo === 0 ? block.recordsStart : restartAt(block, lo - 1);
  }

  /**
   * The block of `section` where keys at or after `want` start, and where to scan from in it;
   * undefined when every key sorts before `want` (an index says so) or there are no blocks.
   */
  private seek(
    section: Section,
    want: Uint8Array,
    budget: ReftableReadBudget,
  ): { block: Block; start: number } | undefined {
    if (section.index > 0) {
      // the index's top level starts at the footer's position and may span several blocks:
      // walked as a section of its own (git's reader_seek_indexed seeks it linearly)
      const top: Section = { type: TYPE_INDEX, start: section.index, end: section.end, index: 0 };
      if (this.blockAt(top, top.start, budget) === undefined) {
        fail(this.name, `index position ${section.index} starts no index block`);
      }
      let level: { block: Block; start: number } | undefined = this.linearSeek(top, want, budget);
      let levelSection: Section | undefined = top;
      for (let depth = 0; level; depth++) {
        if (depth >= MAX_INDEX_DEPTH) fail(this.name, "index deeper than any table needs");
        // the first index record whose key (its block's last) is not before `want`; on the
        // top level the scan may go on into the next block, below it stays in its block
        const c = new Cursor(this.name, budget, "index");
        let block = level.block;
        c.enter(block, level.start, false);
        let target: number | undefined;
        for (;;) {
          while (target === undefined && c.nextKey()) {
            if (c.type !== 0) {
              fail(this.name, `block at ${block.offset}: index record of value type ${c.type}`);
            }
            const position = c.varint();
            c.endValue();
            if (c.compareTo(want) >= 0) target = position;
          }
          if (target !== undefined || !levelSection) break;
          const next = this.blockAt(levelSection, block.offset + block.fullSize, budget);
          if (!next) break;
          block = next;
          c.enter(block, block.recordsStart, true);
        }
        if (target === undefined) return undefined;
        if (target >= block.offset) {
          fail(this.name, `index block at ${block.offset} names position ${target}, not before it`);
        }
        const found = this.readBlock(target, section.end, budget);
        if (found.type === TYPE_INDEX) {
          level = { block: found, start: this.restartBefore(found, want, budget) };
          levelSection = undefined;
          continue;
        }
        if (found.type !== section.type) {
          fail(this.name, `index block at ${block.offset} names a block of another section`);
        }
        return { block: found, start: this.restartBefore(found, want, budget) };
      }
      return undefined;
    }
    return this.linearSeek(section, want, budget);
  }

  /** The last block of `section` whose first key is not past `want` (git's reader_seek_linear). */
  private linearSeek(
    section: Section,
    want: Uint8Array,
    budget: ReftableReadBudget,
  ): { block: Block; start: number } | undefined {
    let found: Block | undefined;
    for (let offset = section.start; ; ) {
      const block = this.blockAt(section, offset, budget);
      if (!block) break;
      if (found && this.keyAtCompare(block, block.recordsStart, want, budget) > 0) {
        this.drop(block, budget);
        break;
      }
      this.drop(found, budget);
      found = block;
      offset += block.fullSize;
    }
    if (!found) return undefined;
    return { block: found, start: this.restartBefore(found, want, budget) };
  }

  /**
   * Each record of `section` from the first key at or after `want` (or from the start), the
   * cursor at its value; the caller reads the value or leaves it to be skipped. Blocks are
   * read one at a time, in order, while their type is the section's.
   */
  private *walk(
    section: Section | undefined,
    want: Uint8Array | undefined,
    budget: ReftableReadBudget,
    skipValue: (c: Cursor) => void,
  ): Generator<Cursor> {
    if (!section) return;
    const what = section.type === TYPE_REF ? "ref" : "log";
    let block: Block | undefined;
    let start: number;
    if (want) {
      const found = this.seek(section, want, budget);
      if (!found) return;
      block = found.block;
      start = found.start;
    } else {
      block = this.blockAt(section, section.start, budget);
      if (!block) return;
      start = block.recordsStart;
    }
    const c = new Cursor(this.name, budget, what);
    c.enter(block, start, false);
    let seeking = want !== undefined;
    try {
      for (;;) {
        while (c.nextKey()) {
          if (seeking && c.compareTo(want as Uint8Array) < 0) {
            skipValue(c);
            c.endValue();
            continue;
          }
          seeking = false;
          const valueStart = c.pos;
          yield c;
          if (c.pos === valueStart) skipValue(c);
          c.endValue();
        }
        const offset = block.offset + block.fullSize;
        this.drop(block, budget);
        block = undefined;
        const next = this.blockAt(section, offset, budget);
        if (!next) return;
        block = next;
        c.enter(block, block.recordsStart, true);
      }
    } finally {
      this.drop(block, budget);
    }
  }

  getRef(name: string, budget = new ReftableReadBudget()): ReftableRefRecord | undefined {
    const want = encoder.encode(name);
    for (const c of this.walk(this.section(TYPE_REF), want, budget, (c) => this.refValue(c))) {
      if (c.compareTo(want) !== 0) return undefined;
      return this.refRecord(c);
    }
    return undefined;
  }

  *refs(prefix = "", budget = new ReftableReadBudget()): Generator<ReftableRefRecord> {
    const want = prefix ? encoder.encode(prefix) : undefined;
    for (const c of this.walk(this.section(TYPE_REF), want, budget, (c) => this.refValue(c))) {
      if (want && !c.startsWith(want)) return;
      yield this.refRecord(c);
    }
  }

  *logs(refName?: string, budget = new ReftableReadBudget()): Generator<ReftableLogRecord> {
    for (const head of this.logHeads(refName, budget)) {
      const { refName, refKey, updateIndex } = head;
      yield { refName, refKey, updateIndex, update: head.read() };
    }
  }

  *logHeads(refName?: string, budget = new ReftableReadBudget()): Generator<ReftableLogHead> {
    let want: Uint8Array | undefined;
    if (refName !== undefined) {
      const nameBytes = encoder.encode(refName);
      want = new Uint8Array(nameBytes.length + 1);
      want.set(nameBytes);
    }
    let lastRefLen = -1;
    for (const c of this.walk(this.section(TYPE_LOG), want, budget, (c) => this.logValue(c))) {
      const len = c.keyLen;
      if (len < 9 || c.key[len - 9] !== 0) fail(this.name, "log key without its update index");
      const refLen = len - 9;
      // the same ref as the last record when its name is as long and the prefix covers it
      const same = refLen === lastRefLen && c.prefix >= refLen;
      if (want) {
        if (!same && (refLen !== want.length - 1 || !c.startsWith(want))) return;
      }
      if (!same) [c.lastRefKey, c.lastRefName] = c.materialise(refLen);
      lastRefLen = refLen;
      const hi = 0xffffffff - be32(c.key, len - 8);
      const lo = 0xffffffff - be32(c.key, len - 4);
      if (hi >= 0x200000) fail(this.name, "log update index out of range");
      const updateIndex = hi * 0x100000000 + lo;
      const seq = ++c.records;
      yield {
        refName: c.lastRefName,
        refKey: c.lastRefKey,
        updateIndex,
        deletion: c.type === 0,
        read: () => {
          if (c.records !== seq || c.pos !== c.valueStart) {
            throw new Error("reftable: a log head is read once, before its iterator moves on");
          }
          return this.logValue(c, true);
        },
      };
    }
  }

  /** Reads a ref record's value (materialised when asked): its update index and value. */
  private refValue(c: Cursor, materialise = false): [number, ReftableRefValue] | undefined {
    const delta = c.varint();
    const updateIndex = this.minUpdateIndex + delta;
    if (!Number.isSafeInteger(updateIndex)) fail(this.name, "update index out of range");
    let value: ReftableRefValue | undefined;
    switch (c.type) {
      case 0:
        value = { type: "deletion" };
        break;
      case 1: {
        const id = c.take(HASH_SIZE, "ref value");
        if (materialise) {
          c.budget.charge(2 * HASH_SIZE, this.name);
          value = { type: "id", id: bytesToHex(id) };
        }
        break;
      }
      case 2: {
        const id = c.take(HASH_SIZE, "ref value");
        const peeled = c.take(HASH_SIZE, "ref value");
        if (materialise) {
          c.budget.charge(4 * HASH_SIZE, this.name);
          value = { type: "peeled", id: bytesToHex(id), peeled: bytesToHex(peeled) };
        }
        break;
      }
      case 3: {
        const len = c.varint();
        const target = c.take(len, "symref target");
        if (materialise) {
          c.budget.charge(3 * len, this.name);
          value = { type: "symref", target: utf8.decode(target) };
        }
        break;
      }
      default:
        fail(this.name, `block at ${c.block.offset}: unknown ref value type ${c.type}`);
    }
    return value ? [updateIndex, value] : undefined;
  }

  private refRecord(c: Cursor): ReftableRefRecord {
    const [key, name] = c.materialise(c.keyLen);
    const [updateIndex, value] = this.refValue(c, true) as [number, ReftableRefValue];
    return { name, key, updateIndex, value };
  }

  /** Reads a log record's value: the update (materialised when asked), none for a deletion. */
  private logValue(c: Cursor, materialise = false): ReftableLogUpdate | undefined {
    if (c.type === 0) return undefined;
    if (c.type !== 1)
      fail(this.name, `block at ${c.block.offset}: unknown log value type ${c.type}`);
    const oldId = c.take(HASH_SIZE, "log value");
    const newId = c.take(HASH_SIZE, "log value");
    const text = (what: string): Uint8Array => c.take(c.varint(), what);
    const who = text("log name");
    const email = text("log email");
    const time = c.varint();
    const tzRaw = be16(c.take(2, "log time zone"), 0);
    const message = text("log message");
    if (!materialise) return undefined;
    c.budget.charge(4 * HASH_SIZE + 3 * (who.length + email.length + message.length), this.name);
    return {
      oldId: bytesToHex(oldId),
      newId: bytesToHex(newId),
      name: utf8.decode(who),
      email: utf8.decode(email),
      time,
      tzOffset: tzRaw >= 0x8000 ? tzRaw - 0x10000 : tzRaw,
      message: utf8.decode(message),
    };
  }

  verify(budget = new ReftableReadBudget()): { blocks: ReftableBlockCounts } {
    const name = this.name;
    const blocks = { ref: 0, index: 0, obj: 0, log: 0 };
    if (this.firstType === undefined) return { blocks };
    type Kind = "ref" | "refIndex" | "obj" | "objIndex" | "log" | "logIndex";
    /** Each section's rank in file order; an index takes the rank after the data it follows */
    const RANK = { ref: 0, refIndex: 1, obj: 2, objIndex: 3, log: 4, logIndex: 5 } as const;
    const startsByRank = [0, 1, 2, 3, 4, 5].map(() => new Set<number>());
    // block positions index and obj records name: [indexed rank, also (an index's own) rank]
    const targets: number[] = [];
    const targetRanks: number[] = [];
    const targetBlocks: number[] = [];
    const { objPos, logPos, footerStart } = this;
    let rank = 0;
    let cursor: Cursor | undefined;
    for (let offset = 0; offset < footerStart; ) {
      const headerOff = offset === 0 ? this.hSize : 0;
      if (offset + headerOff >= footerStart)
        fail(name, `block at ${offset} runs past the last block`);
      const type = this.bytes[offset + headerOff] as number;
      let kind: Kind;
      if (type === TYPE_REF) kind = "ref";
      else if (type === TYPE_OBJ) kind = "obj";
      else if (type === TYPE_LOG) kind = "log";
      else if (type === TYPE_INDEX) {
        if (offset === 0) fail(name, "the first block is an index");
        kind = rank <= RANK.refIndex ? "refIndex" : rank <= RANK.objIndex ? "objIndex" : "logIndex";
      } else {
        fail(name, `block at ${offset} is of unknown type 0x${type.toString(16)}`);
      }
      if (RANK[kind] < rank) fail(name, `block at ${offset} (${kind}) out of section order`);
      if (kind === "obj" && RANK[kind] > rank && offset !== objPos) {
        fail(name, `obj blocks start at ${offset}, not at obj_position ${objPos}`);
      }
      if (kind === "log" && RANK[kind] > rank && offset !== logPos) {
        fail(name, `log blocks start at ${offset}, not at log_position ${logPos}`);
      }
      // keys ascend through the ref and the log section (an index's levels each restart)
      const keepOrder =
        cursor !== undefined && RANK[kind] === rank && (kind === "ref" || kind === "log");
      rank = RANK[kind];
      const end = [objPos, logPos, footerStart].find((p) => p > offset) ?? footerStart;
      const block = this.readBlock(offset, kind === "log" ? footerStart : end, budget);
      startsByRank[rank]?.add(offset);
      const c: Cursor =
        keepOrder && cursor ? cursor : new Cursor(name, budget, kind === "obj" ? "obj" : kind);
      cursor = c;
      c.enter(block, block.recordsStart, keepOrder);
      switch (kind) {
        case "ref":
          blocks.ref++;
          while (c.nextKey()) {
            this.refValue(c);
            c.endValue();
          }
          break;
        case "log":
          blocks.log++;
          while (c.nextKey()) {
            const len = c.keyLen;
            if (len < 9 || c.key[len - 9] !== 0) fail(name, "log key without its update index");
            if (0xffffffff - be32(c.key, len - 8) >= 0x200000) {
              fail(name, "log update index out of range");
            }
            this.logValue(c);
            c.endValue();
          }
          break;
        case "obj":
          blocks.obj++;
          while (c.nextKey()) {
            let count = c.type;
            if (count === 0) count = c.varint();
            let prior = 0;
            for (let i = 0; i < count; i++) {
              const delta = c.varint();
              const target = i === 0 ? delta : prior + delta;
              if (target >= footerStart) {
                fail(name, `obj record names position ${target} past the blocks`);
              }
              targets.push(target);
              targetRanks.push(RANK.ref, -1);
              targetBlocks.push(offset);
              prior = target;
            }
            c.endValue();
          }
          break;
        default: {
          // an index: each record names a block of the section it indexes, or a lower level
          blocks.index++;
          const indexed =
            kind === "refIndex" ? RANK.ref : kind === "objIndex" ? RANK.obj : RANK.log;
          while (c.nextKey()) {
            if (c.type !== 0)
              fail(name, `block at ${offset}: index record of value type ${c.type}`);
            targets.push(c.varint());
            targetRanks.push(indexed, rank);
            targetBlocks.push(offset);
            c.endValue();
          }
        }
      }
      offset += block.fullSize;
      this.drop(block, budget);
    }
    // the footer's index roots start index blocks of their section
    const roots: [number, number, string][] = [
      [this.refIndexPos, RANK.refIndex, "ref_index_position"],
      [this.objIndexPos, RANK.objIndex, "obj_index_position"],
      [this.logIndexPos, RANK.logIndex, "log_index_position"],
    ];
    for (const [position, r, what] of roots) {
      if (position > 0 && !startsByRank[r]?.has(position)) {
        fail(name, `${what} ${position} starts no index block`);
      }
    }
    if (objPos > 0 && !startsByRank[RANK.obj]?.has(objPos))
      fail(name, "obj_position starts no obj block");
    if (logPos > 0 && !startsByRank[RANK.log]?.has(logPos))
      fail(name, "log_position starts no log block");
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i] as number;
      if (startsByRank[targetRanks[2 * i] as number]?.has(t)) continue;
      const also = targetRanks[2 * i + 1] as number;
      if (also >= 0 && startsByRank[also]?.has(t)) continue;
      fail(
        name,
        `block at ${targetBlocks[i]} names position ${t}, which starts no block it indexes`,
      );
    }
    return { blocks };
  }
}
