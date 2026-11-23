/**
 * One reftable file read whole (git's `reftable/table.c`, `block.c`, `record.c`; the format is
 * `Documentation/technical/reftable.adoc`).
 *
 * @example
 * ```typescript
 * const table = parseReftable(bytes, "0x000000000001-0x000000000004-70da100a.ref");
 * for (const ref of table.refs) console.log(ref.name, ref.updateIndex, ref.value);
 * ```
 *
 * A table is a header, the ref blocks, the ref index, the obj blocks and their index, the log
 * blocks and their index, and a footer that repeats the header, gives where each section
 * starts and ends with a CRC-32. Every section is walked block by block and every record is
 * decoded, so a crafted table is refused (`ReftableFormatError`) rather than read past its
 * bounds:
 *
 *  - the footer's magic, header copy and CRC-32, and section positions in file order before it;
 *  - each block's type, length (within its section; at least its header and restart count)
 *    and restart table (offsets ascending, inside the record area, each one the start of a
 *    record whose key is not prefix compressed);
 *  - each record's prefix length (at most the previous key's), suffix, varints (no overflow)
 *    and value, inside the record area; keys strictly ascending through a section;
 *  - log blocks inflated (vcs-utils' `inflateWhole`) to exactly the length their header gives;
 *  - index records naming a block start of the section they index.
 *
 * The obj blocks and the indexes are checked but not used: lookups scan the ref records, which
 * are few enough to hold in memory. Version 1 tables (SHA-1) and version 2 tables with hash id
 * `sha1` are read; SHA-256 tables (`s256`) are refused (`ReftableUnsupportedError`).
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

/** A parsed reftable. */
export interface ReftableTable {
  /** The file's name (for messages) */
  readonly name: string;
  /** 1, or 2 (with a hash id) */
  readonly version: 1 | 2;
  /** The header's block size (0 for an unaligned table) */
  readonly blockSize: number;
  readonly minUpdateIndex: number;
  readonly maxUpdateIndex: number;
  /** Ref records in key order, deletions included */
  readonly refs: readonly ReftableRefRecord[];
  /** Log records in key order: by ref name, then newest update index first */
  readonly logs: readonly ReftableLogRecord[];
  /** How many blocks of each kind the sections hold (ref, index, obj, log) */
  readonly blocks: { ref: number; index: number; obj: number; log: number };
  /** The footer's `obj_id_len` (0 without obj blocks) */
  readonly objectIdLength: number;
}

const MAGIC = [0x52, 0x45, 0x46, 0x54]; // "REFT"
const HASH_SIZE = 20;
const FORMAT_ID_SHA1 = 0x73686131; // "sha1"
const FORMAT_ID_SHA256 = 0x73323536; // "s256"
const TYPE_REF = 0x72; // 'r'
const TYPE_LOG = 0x67; // 'g'
const TYPE_OBJ = 0x6f; // 'o'
const TYPE_INDEX = 0x69; // 'i'

const utf8 = new TextDecoder();

/** The sections of a table, in file order. */
type SectionKind = "ref" | "refIndex" | "obj" | "objIndex" | "log" | "logIndex";

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

/** A block of a section, its records' bytes in hand (a log block inflated). */
interface Block {
  /** The block's bytes from its start (the file's start for the first block) */
  data: Uint8Array;
  /** Where its records start: after the file header (first block) and the block header */
  recordsStart: number;
  /** Where the restart table starts: the records end there */
  recordsEnd: number;
  restarts: Set<number>;
  /** The bytes the block takes in the file, padding included */
  fullSize: number;
}

/**
 * Parses a reftable file held whole in memory. Throws `ReftableFormatError` for a file that is
 * not well formed and `ReftableUnsupportedError` for a SHA-256 table. `name` names the table in
 * those errors.
 */
/** The key bytes a table may expand to: this many times its record bytes, plus the slack. */
const MAX_KEY_BYTES_FACTOR = 16;
const MAX_KEY_BYTES_SLACK = 1 << 20;

export function parseReftable(bytes: Uint8Array, name = "<reftable>"): ReftableTable {
  const fail = (detail: string): never => {
    throw new ReftableFormatError(name, detail);
  };

  // header: magic, version, block size, update indexes (and a hash id in version 2)
  if (bytes.length < 24) fail(`truncated: ${bytes.length} bytes, shorter than a header`);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) fail("bad magic (not 'REFT')");
  const version = bytes[4] as number;
  if (version !== 1 && version !== 2) fail(`unknown version ${version}`);
  const hSize = headerSize(version);
  const fSize = footerSize(version);
  if (bytes.length < hSize + fSize) {
    fail(`truncated: ${bytes.length} bytes, shorter than a header and a footer`);
  }
  if (version === 2) {
    const hashId = be32(bytes, 24);
    if (hashId === FORMAT_ID_SHA256) {
      throw new ReftableUnsupportedError(name, "SHA-256 tables (hash id 's256') are not read");
    }
    if (hashId !== FORMAT_ID_SHA1) fail(`unknown hash id 0x${hashId.toString(16)}`);
  }
  const blockSize = be24(bytes, 5);
  const toIndex = (value: bigint, what: string): number => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${what} ${value} out of range`);
    return Number(value);
  };
  const minUpdateIndex = toIndex(be64(bytes, 8), "min_update_index");
  const maxUpdateIndex = toIndex(be64(bytes, 16), "max_update_index");

  // footer: the header again, the section positions and a CRC-32 of all that
  const footerStart = bytes.length - fSize;
  for (let i = 0; i < hSize; i++) {
    if (bytes[footerStart + i] !== bytes[i]) fail("footer does not repeat the header");
  }
  const crcAt = footerStart + fSize - 4;
  if (crc32(bytes.subarray(footerStart, crcAt)) !== be32(bytes, crcAt)) {
    fail("footer CRC-32 mismatch");
  }
  let at = footerStart + hSize;
  const position = (what: string): number => {
    const value = be64(bytes, at);
    at += 8;
    if (value >= BigInt(footerStart)) fail(`${what} ${value} past the last block`);
    return Number(value);
  };
  const refIndexPos = position("ref_index_position");
  const objField = be64(bytes, at);
  at += 8;
  const objectIdLength = Number(objField & 31n);
  const objPosBig = objField >> 5n;
  if (objPosBig >= BigInt(footerStart)) fail(`obj_position ${objPosBig} past the last block`);
  const objPos = Number(objPosBig);
  if (objPos > 0 && objectIdLength === 0) fail("obj blocks without an obj_id_len");
  const objIndexPos = position("obj_index_position");
  const logPos = position("log_position");
  const logIndexPos = position("log_index_position");

  // the blocks in file order: ref blocks, the ref index, obj blocks and their index, log
  // blocks and their index (an index's lower levels before its root, the footer's position)
  const firstType = footerStart > hSize ? (bytes[hSize] as number) : undefined;
  if (firstType !== undefined && firstType !== TYPE_REF && firstType !== TYPE_LOG) {
    fail(`the first block is of type 0x${firstType.toString(16)}, neither ref nor log`);
  }
  if (firstType === undefined && (refIndexPos || objPos || objIndexPos || logPos || logIndexPos)) {
    fail("an empty table names sections");
  }
  if (firstType === TYPE_LOG && logPos > 0) fail("a log-only table with a log_position");
  if (objPos > 0 && logPos > 0 && objPos >= logPos) fail("obj blocks after the log blocks");

  const readVarint = (data: Uint8Array, pos: number, end: number): [number, number] => {
    if (pos >= end) fail("varint past the end of its block");
    let c = data[pos++] as number;
    let value = c & 0x7f;
    while (c & 0x80) {
      value += 1;
      if (value > Math.floor(Number.MAX_SAFE_INTEGER / 128)) fail("varint overflow");
      if (pos >= end) fail("varint past the end of its block");
      c = data[pos++] as number;
      value = value * 128 + (c & 0x7f);
    }
    return [value, pos];
  };

  /** The block at `offset` of a section ending at `end`, checked against its bounds. */
  const readBlock = (offset: number, type: number, end: number): Block => {
    const headerOff = offset === 0 ? hSize : 0;
    if (offset + headerOff + 4 > end) fail(`block at ${offset} runs past its section`);
    const blockType = bytes[offset + headerOff] as number;
    if (blockType !== type) {
      fail(
        `block at ${offset} is of type 0x${blockType.toString(16)}, expected 0x${type.toString(16)}`,
      );
    }
    const blockLen = be24(bytes, offset + headerOff + 1);
    if (blockLen < headerOff + 4 + 2) fail(`block at ${offset} too short (${blockLen} bytes)`);
    let data: Uint8Array;
    let fullSize: number;
    if (type === TYPE_LOG) {
      // block_len is the inflated length, block header included; the deflated stream follows
      const skip = headerOff + 4;
      data = new Uint8Array(blockLen);
      data.set(bytes.subarray(offset, offset + skip));
      let consumed: number;
      try {
        const r = inflateWhole(bytes.subarray(offset + skip, end), {
          into: data.subarray(skip),
        });
        if (r.length !== blockLen - skip) {
          fail(`log block at ${offset} inflates to ${r.length + skip} bytes, not ${blockLen}`);
        }
        consumed = r.consumed;
      } catch (error) {
        if (error instanceof ReftableFormatError) throw error;
        fail(`log block at ${offset} does not inflate: ${(error as Error).message}`);
        throw error;
      }
      fullSize = skip + consumed;
    } else {
      if (offset + blockLen > end)
        fail(`block at ${offset} (${blockLen} bytes) runs past its section`);
      data = bytes.subarray(offset, offset + blockLen);
      // padded to the block size unless the next byte starts another block (git's
      // reftable_block_init)
      fullSize = blockLen;
      if (blockSize > 0 && blockLen < blockSize && offset + blockLen < bytes.length) {
        if (bytes[offset + blockLen] === 0) fullSize = blockSize;
      }
    }
    const restartCount = be16(data, blockLen - 2);
    const recordsStart = headerOff + 4;
    const recordsEnd = blockLen - 2 - 3 * restartCount;
    if (restartCount === 0) fail(`block at ${offset} has no restart point`);
    if (recordsEnd < recordsStart) fail(`block at ${offset}: restart table overlaps its header`);
    const restarts = new Set<number>();
    let previous = -1;
    for (let i = 0; i < restartCount; i++) {
      const r = be24(data, recordsEnd + 3 * i);
      if (r < recordsStart || r >= recordsEnd || r <= previous) {
        fail(`block at ${offset}: restart offset ${r} out of range`);
      }
      restarts.add(r);
      previous = r;
    }
    return { data, recordsStart, recordsEnd, restarts, fullSize };
  };

  /**
   * Each record of a block: its key (prefix compressed against the previous one) and value
   * type, `decodeValue` reading the value; checks restarts start uncompressed keys.
   */
  // The key bytes a table may make us keep: prefix compression lets each record repeat its
  // whole predecessor for a few bytes, so a crafted table of a few hundred KiB could make
  // the copies quadratic (gigabytes). Real tables keep well under twice their record bytes;
  // the budget grows with the records read (inflated, for log blocks).
  let keyBytes = 0;
  let recordBytes = 0;
  const eachRecord = (
    block: Block,
    offset: number,
    decodeValue: (key: Uint8Array, type: number, pos: number) => number,
  ): void => {
    const { data, recordsEnd, restarts } = block;
    let pos = block.recordsStart;
    recordBytes += recordsEnd - block.recordsStart;
    let lastKey = new Uint8Array(0);
    let seen = 0;
    while (pos < recordsEnd) {
      const start = pos;
      let prefix: number;
      let suffixAndType: number;
      [prefix, pos] = readVarint(data, pos, recordsEnd);
      [suffixAndType, pos] = readVarint(data, pos, recordsEnd);
      const suffix = Math.floor(suffixAndType / 8);
      const type = suffixAndType % 8;
      if (restarts.has(start)) {
        seen++;
        if (prefix !== 0) fail(`block at ${offset}: restart record with a compressed key`);
      }
      if (prefix > lastKey.length) fail(`block at ${offset}: key prefix longer than the last key`);
      if (pos + suffix > recordsEnd) fail(`block at ${offset}: key runs past the records`);
      keyBytes += prefix + suffix;
      if (keyBytes > MAX_KEY_BYTES_FACTOR * recordBytes + MAX_KEY_BYTES_SLACK) {
        fail(`block at ${offset}: keys expand past ${MAX_KEY_BYTES_FACTOR}x the table's records`);
      }
      const key = new Uint8Array(prefix + suffix);
      key.set(lastKey.subarray(0, prefix));
      key.set(data.subarray(pos, pos + suffix), prefix);
      pos = decodeValue(key, type, pos + suffix);
      if (pos > recordsEnd) fail(`block at ${offset}: record runs past the records`);
      lastKey = key;
    }
    if (seen !== restarts.size) fail(`block at ${offset}: a restart offset is not a record start`);
  };

  const bytesAt = (data: Uint8Array, pos: number, n: number, end: number, what: string) => {
    if (pos + n > end) fail(`${what} runs past the records`);
    return data.subarray(pos, pos + n);
  };

  const refs: ReftableRefRecord[] = [];
  const logs: ReftableLogRecord[] = [];
  const blocks = { ref: 0, index: 0, obj: 0, log: 0 };
  const indexTargets: {
    kind: SectionKind;
    also?: SectionKind;
    position: number;
    offset: number;
  }[] = [];
  let lastRefKey: Uint8Array | undefined;
  let lastLogKey: Uint8Array | undefined;

  /** Each section's rank in file order; an index takes the rank after the data it follows */
  const RANK = { ref: 0, refIndex: 1, obj: 2, objIndex: 3, log: 4, logIndex: 5 } as const;
  const startsByRank = [0, 1, 2, 3, 4, 5].map(() => new Set<number>());
  let rank = 0;
  // an empty table: the footer right after the header
  for (let offset = 0; firstType !== undefined && offset < footerStart; ) {
    const headerOff = offset === 0 ? hSize : 0;
    if (offset + headerOff >= footerStart) fail(`block at ${offset} runs past the last block`);
    const type = bytes[offset + headerOff] as number;
    let kind: SectionKind;
    if (type === TYPE_REF) kind = "ref";
    else if (type === TYPE_OBJ) kind = "obj";
    else if (type === TYPE_LOG) kind = "log";
    else if (type === TYPE_INDEX) {
      if (offset === 0) fail("the first block is an index");
      kind = rank <= RANK.refIndex ? "refIndex" : rank <= RANK.objIndex ? "objIndex" : "logIndex";
    } else {
      fail(`block at ${offset} is of unknown type 0x${type.toString(16)}`);
      throw new Error("unreachable");
    }
    if (RANK[kind] < rank) fail(`block at ${offset} (${kind}) out of section order`);
    if (kind === "obj" && RANK[kind] > rank && offset !== objPos) {
      fail(`obj blocks start at ${offset}, not at obj_position ${objPos}`);
    }
    if (kind === "log" && RANK[kind] > rank && offset !== logPos) {
      fail(`log blocks start at ${offset}, not at log_position ${logPos}`);
    }
    rank = RANK[kind];
    // a block stays within its section: before the next data section the footer names
    const end = [objPos, logPos, footerStart].find((p) => p > offset) ?? footerStart;
    const block = readBlock(offset, type, kind === "log" ? footerStart : end);
    startsByRank[rank]?.add(offset);
    const { data, recordsEnd } = block;
    const blockOffset = offset;
    switch (kind) {
      case "ref":
        blocks.ref++;
        eachRecord(block, offset, (key, type, pos) => {
          if (lastRefKey && compareKeys(lastRefKey, key) >= 0) fail("ref records out of order");
          lastRefKey = key;
          let delta: number;
          [delta, pos] = readVarint(data, pos, recordsEnd);
          const updateIndex = minUpdateIndex + delta;
          if (!Number.isSafeInteger(updateIndex)) fail("update index out of range");
          let value: ReftableRefValue;
          switch (type) {
            case 0:
              value = { type: "deletion" };
              break;
            case 1:
              value = {
                type: "id",
                id: bytesToHex(bytesAt(data, pos, HASH_SIZE, recordsEnd, "ref value")),
              };
              pos += HASH_SIZE;
              break;
            case 2:
              value = {
                type: "peeled",
                id: bytesToHex(bytesAt(data, pos, HASH_SIZE, recordsEnd, "ref value")),
                peeled: bytesToHex(
                  bytesAt(data, pos + HASH_SIZE, HASH_SIZE, recordsEnd, "ref value"),
                ),
              };
              pos += 2 * HASH_SIZE;
              break;
            case 3: {
              let len: number;
              [len, pos] = readVarint(data, pos, recordsEnd);
              const target = bytesAt(data, pos, len, recordsEnd, "symref target");
              value = { type: "symref", target: utf8.decode(target) };
              pos += len;
              break;
            }
            default:
              fail(`block at ${blockOffset}: unknown ref value type ${type}`);
              throw new Error("unreachable");
          }
          refs.push({ name: utf8.decode(key), key, updateIndex, value });
          return pos;
        });
        break;
      case "log":
        blocks.log++;
        eachRecord(block, offset, (key, type, pos) => {
          if (lastLogKey && compareKeys(lastLogKey, key) >= 0) fail("log records out of order");
          lastLogKey = key;
          if (key.length < 9 || key[key.length - 9] !== 0) fail("log key without its update index");
          const refKey = key.subarray(0, key.length - 9);
          const reversed = be64(key, key.length - 8);
          const updateIndex = toIndex(0xffffffffffffffffn - reversed, "log update index");
          const refName = utf8.decode(refKey);
          if (type === 0) {
            logs.push({ refName, refKey, updateIndex });
            return pos;
          }
          if (type !== 1) fail(`block at ${blockOffset}: unknown log value type ${type}`);
          const oldId = bytesToHex(bytesAt(data, pos, HASH_SIZE, recordsEnd, "log value"));
          const newId = bytesToHex(
            bytesAt(data, pos + HASH_SIZE, HASH_SIZE, recordsEnd, "log value"),
          );
          pos += 2 * HASH_SIZE;
          const text = (what: string): string => {
            let len: number;
            [len, pos] = readVarint(data, pos, recordsEnd);
            const out = utf8.decode(bytesAt(data, pos, len, recordsEnd, what));
            pos += len;
            return out;
          };
          const who = text("log name");
          const email = text("log email");
          let time: number;
          [time, pos] = readVarint(data, pos, recordsEnd);
          const tz = bytesAt(data, pos, 2, recordsEnd, "log time zone");
          const tzRaw = be16(tz, 0);
          const tzOffset = tzRaw >= 0x8000 ? tzRaw - 0x10000 : tzRaw;
          pos += 2;
          const message = text("log message");
          logs.push({
            refName,
            refKey,
            updateIndex,
            update: { oldId, newId, name: who, email, time, tzOffset, message },
          });
          return pos;
        });
        break;
      case "obj":
        blocks.obj++;
        eachRecord(block, offset, (_key, type, pos) => {
          let count = type;
          if (count === 0) [count, pos] = readVarint(data, pos, recordsEnd);
          let prior = 0;
          for (let i = 0; i < count; i++) {
            let delta: number;
            [delta, pos] = readVarint(data, pos, recordsEnd);
            const target = i === 0 ? delta : prior + delta;
            if (target >= footerStart) fail(`obj record names position ${target} past the blocks`);
            indexTargets.push({ kind: "ref", position: target, offset: blockOffset });
            prior = target;
          }
          return pos;
        });
        break;
      default: {
        // an index: each record names a block of the section it indexes, or a lower level
        blocks.index++;
        const indexed: SectionKind =
          kind === "refIndex" ? "ref" : kind === "objIndex" ? "obj" : "log";
        const level = kind;
        eachRecord(block, offset, (_key, type, pos) => {
          if (type !== 0) fail(`block at ${blockOffset}: index record of value type ${type}`);
          let target: number;
          [target, pos] = readVarint(data, pos, recordsEnd);
          indexTargets.push({ kind: indexed, also: level, position: target, offset: blockOffset });
          return pos;
        });
      }
    }
    offset += block.fullSize;
  }

  // the footer's index roots start index blocks of their section
  const roots: [number, number, string][] = [
    [refIndexPos, RANK.refIndex, "ref_index_position"],
    [objIndexPos, RANK.objIndex, "obj_index_position"],
    [logIndexPos, RANK.logIndex, "log_index_position"],
  ];
  for (const [position, r, what] of roots) {
    if (position > 0 && !startsByRank[r]?.has(position)) {
      fail(`${what} ${position} starts no index block`);
    }
  }
  if (objPos > 0 && !startsByRank[RANK.obj]?.has(objPos)) fail("obj_position starts no obj block");
  if (logPos > 0 && !startsByRank[RANK.log]?.has(logPos)) fail("log_position starts no log block");
  // index and obj records point at block starts: of the indexed section, or (an index's
  // records) at a lower level of the same index
  for (const t of indexTargets) {
    if (startsByRank[RANK[t.kind]]?.has(t.position)) continue;
    if (t.also && startsByRank[RANK[t.also]]?.has(t.position)) continue;
    fail(`block at ${t.offset} names position ${t.position}, which starts no block it indexes`);
  }

  return {
    name,
    version: version as 1 | 2,
    blockSize,
    minUpdateIndex,
    maxUpdateIndex,
    refs,
    logs,
    blocks,
    objectIdLength,
  };
}
