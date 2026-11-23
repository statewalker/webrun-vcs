/**
 * Writes one reftable file as git's `reftable/writer.c` writes it (`block.c`, `record.c`):
 * the same blocks, restarts, padding, indexes and footer, so a table written here with the
 * settings git uses is byte for byte the table git writes for the same records.
 *
 * @example
 * ```typescript
 * const bytes = writeReftable({
 *   minUpdateIndex: 1,
 *   maxUpdateIndex: 1,
 *   refs: [{ name: "HEAD", updateIndex: 1, value: { type: "symref", target: "refs/heads/main" } }],
 * });
 * // the 124 bytes of `git init`'s first table (bytes === undefined for an empty table)
 * ```
 *
 * The layout: ref blocks (each padded to the block size but the last of the table), an
 * index of them once there are more than three (several levels while a level has more
 * than three blocks), the obj blocks mapping object ids to the ref blocks naming them (only
 * when the refs have an index, and unless `indexObjects` is false), then the log blocks,
 * each deflated (zlib level 9) and never padded, with their own index; a footer repeating
 * the header with each section's position and a CRC-32. A record is prefix compressed
 * against the previous key of its block; every key that shares nothing with it, and every
 * `restartInterval`th record, is a restart point. Records must come in key order: refs by
 * name, logs by name then newest update index first (the writer sorts them). A SHA-1 table
 * is version 1 (24-byte header, 68-byte footer); a SHA-256 one version 2 with hash id `s256`
 * (28 and 72 bytes) and 32-byte ids, as git's `writer_version`.
 */

import { deflateSync } from "@statewalker/vcs-utils/compression";
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";

import type { ReftableLogUpdate, ReftableRefValue } from "./reftable-table.js";
import { compareKeys } from "./reftable-table.js";

/** What git's `reftable_write_options` set. */
export interface ReftableWriteOptions {
  /** `reftable.blockSize`: 4096 by default; at most 16 MiB - 1 */
  blockSize?: number;
  /** `reftable.restartInterval`: 16 by default */
  restartInterval?: number;
  /** `reftable.indexObjects`: true by default (obj blocks written once the refs have an index) */
  indexObjects?: boolean;
  /** No padding of ref blocks, and an index from two blocks on (git's tests only) */
  unpadded?: boolean;
  /** Log messages written as given (otherwise one line ending in a newline) */
  exactLogMessage?: boolean;
  /** The repository's object format (SHA-1 by default): the table's version, hash id, id width */
  objectFormat?: ObjectFormat;
}

/** A ref record to write: an absolute update index, within the table's limits. */
export interface ReftableRefWrite {
  name: string;
  updateIndex: number;
  value: ReftableRefValue;
}

/** A log record to write; without `update`, a deletion (tombstone) of that entry. */
export interface ReftableLogWrite {
  refName: string;
  updateIndex: number;
  update?: ReftableLogUpdate;
  /** The message as given (git's reflog existence marker has an empty one) */
  exactMessage?: boolean;
}

/** The records of one table and its update index range. */
export interface ReftableContent {
  minUpdateIndex: number;
  maxUpdateIndex: number;
  refs?: readonly ReftableRefWrite[];
  logs?: readonly ReftableLogWrite[];
}

/** A record the writer refuses (git's `REFTABLE_API_ERROR`, `REFTABLE_ENTRY_TOO_BIG_ERROR`). */
export class ReftableWriteError extends Error {
  constructor(message: string) {
    super(`reftable: ${message}`);
    this.name = "ReftableWriteError";
  }
}

const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_RESTART_INTERVAL = 16;
const MAX_RESTARTS = (1 << 16) - 1;
const TYPE_REF = 0x72;
const TYPE_LOG = 0x67;
const TYPE_OBJ = 0x6f;
const TYPE_INDEX = 0x69;
const FORMAT_ID_SHA256 = 0x73323536; // "s256"
const LOG_COMPRESSION_LEVEL = 9;

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

class TooBig extends Error {}

/** git's put_var_int: big-endian base-128, each continuation one less. */
function varintBytes(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReftableWriteError(`varint out of range: ${value}`);
  }
  const out: number[] = [value % 128];
  let v = Math.floor(value / 128);
  while (v > 0) {
    v -= 1;
    out.unshift(0x80 | (v % 128));
    v = Math.floor(v / 128);
  }
  return out;
}

function commonPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** A growable byte sink bounded by the room left in the block (git's string_view). */
class Out {
  bytes: number[] = [];
  constructor(readonly room: number) {}
  push(...values: number[]): void {
    for (const v of values) this.bytes.push(v);
    if (this.bytes.length > this.room) throw new TooBig();
  }
  put(data: Uint8Array): void {
    if (this.bytes.length + data.length > this.room) throw new TooBig();
    for (const b of data) this.bytes.push(b);
  }
  varint(value: number): void {
    this.push(...varintBytes(value));
  }
  string(value: Uint8Array): void {
    this.varint(value.length);
    this.put(value);
  }
}

/** A record as the block writer sees it: its key, value type and value encoder. */
interface BlockRecord {
  key: Uint8Array;
  valueType: number;
  encode(out: Out): void;
}

function put24(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 16) & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = v & 0xff;
}

function put64(b: Uint8Array, at: number, v: bigint | number): void {
  const big = BigInt(v);
  for (let i = 7; i >= 0; i--) b[at + 7 - i] = Number((big >> BigInt(i * 8)) & 0xffn);
}

/** git's block_writer: one block in memory. */
class BlockWriter {
  readonly block: Uint8Array;
  next: number;
  entries = 0;
  restarts: number[] = [];
  lastKey: Uint8Array = EMPTY;

  constructor(
    readonly type: number,
    readonly blockSize: number,
    readonly headerOff: number,
    readonly restartInterval: number,
  ) {
    this.block = new Uint8Array(blockSize);
    this.block[headerOff] = type;
    this.next = headerOff + 4;
  }

  /** Adds the record; false when it does not fit (git's REFTABLE_ENTRY_TOO_BIG_ERROR). */
  add(record: BlockRecord): boolean {
    if (record.key.length === 0) throw new ReftableWriteError("a record with an empty key");
    const last = this.entries % this.restartInterval === 0 ? EMPTY : this.lastKey;
    const out = new Out(this.blockSize - this.next);
    let isRestart: boolean;
    try {
      const prefix = commonPrefix(last, record.key);
      isRestart = prefix === 0;
      out.varint(prefix);
      out.varint((record.key.length - prefix) * 8 + record.valueType);
      out.put(record.key.subarray(prefix));
      record.encode(out);
    } catch (error) {
      if (error instanceof TooBig) return false;
      throw error;
    }
    const n = out.bytes.length;
    let rlen = this.restarts.length;
    if (rlen >= MAX_RESTARTS) isRestart = false;
    if (isRestart) rlen++;
    if (2 + 3 * rlen + n > this.blockSize - this.next) return false;
    if (isRestart) this.restarts.push(this.next);
    this.block.set(out.bytes, this.next);
    this.next += n;
    this.lastKey = record.key;
    this.entries++;
    return true;
  }

  /** The restart table, the block length, and for a log block the deflated records. */
  finish(): number {
    for (const r of this.restarts) {
      put24(this.block, this.next, r);
      this.next += 3;
    }
    this.block[this.next] = (this.restarts.length >>> 8) & 0xff;
    this.block[this.next + 1] = this.restarts.length & 0xff;
    this.next += 2;
    put24(this.block, this.headerOff + 1, this.next);
    if (this.type === TYPE_LOG) {
      const skip = 4 + this.headerOff;
      const compressed = deflateSync([this.block.subarray(skip, this.next)], {
        level: LOG_COMPRESSION_LEVEL,
      });
      if (skip + compressed.length > this.blockSize) return this.withCompressed(skip, compressed);
      this.block.set(compressed, skip);
      this.next = skip + compressed.length;
    }
    return this.next;
  }

  /** Bytes of a finished block; a log block's deflated form may outgrow the buffer. */
  data(): Uint8Array {
    return this.oversized ?? this.block.subarray(0, this.next);
  }

  private oversized?: Uint8Array;
  private withCompressed(skip: number, compressed: Uint8Array): number {
    const out = new Uint8Array(skip + compressed.length);
    out.set(this.block.subarray(0, skip));
    out.set(compressed, skip);
    this.oversized = out;
    this.next = out.length;
    return this.next;
  }
}

/** Statistics of one section, as git's reftable_block_stats keeps them. */
interface SectionStats {
  blocks: number;
  offset: number;
  indexOffset: number;
}

interface IndexEntry {
  lastKey: Uint8Array;
  offset: number;
}

const refKey = (name: string) => encoder.encode(name);

/** git's log key: the name, a NUL, and the update index reversed (newest sorts first). */
function logKey(refName: string, updateIndex: number): Uint8Array {
  const name = encoder.encode(refName);
  const key = new Uint8Array(name.length + 9);
  key.set(name);
  put64(key, name.length + 1, 0xffffffffffffffffn - BigInt(updateIndex));
  return key;
}

const HEX = /^[0-9a-f]+$/;

/** The id's bytes; refused unless it is a full lowercase id of the table's format. */
function hashBytes(hex: string, format: ObjectFormat): Uint8Array {
  if (hex.length !== format.hexLength || !HEX.test(hex)) {
    throw new ReftableWriteError(`not a ${format.name} object id: '${hex}'`);
  }
  return hexToBytes(hex);
}

/** git's tz_offset: an int16 of minutes, stored big-endian. */
function tzBytes(minutes: number): number[] {
  const v = minutes & 0xffff;
  return [(v >>> 8) & 0xff, v & 0xff];
}

/**
 * The bytes of a table holding `content`, as git's writer writes them; undefined when it
 * holds no record (git's REFTABLE_EMPTY_TABLE_ERROR: no table is added then).
 */
export function writeReftable(
  content: ReftableContent,
  options: ReftableWriteOptions = {},
): Uint8Array | undefined {
  const blockSize = options.blockSize || DEFAULT_BLOCK_SIZE;
  const restartInterval = options.restartInterval || DEFAULT_RESTART_INTERVAL;
  if (blockSize >= 1 << 24) throw new ReftableWriteError("block size must be below 16 MiB");
  const indexObjects = options.indexObjects !== false;
  const unpadded = options.unpadded === true;
  const format = options.objectFormat ?? SHA1_OBJECT_FORMAT;
  // git's writer_version: 1 for SHA-1, 2 (with the hash id) otherwise
  const version = format.name === "sha1" ? 1 : 2;
  const headerSize = version === 1 ? 24 : 28;
  const footerSize = headerSize + 5 * 8 + 4;
  const id = (hex: string) => hashBytes(hex, format);
  const { minUpdateIndex: min, maxUpdateIndex: max } = content;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
    throw new ReftableWriteError(`bad update index range ${min}..${max}`);
  }

  const chunks: Uint8Array[] = [];
  let next = 0;
  let pendingPadding = 0;
  let writer: BlockWriter | undefined;
  /** The writer's last key: records must ascend (reset with each block writer) */
  let lastKey: Uint8Array = EMPTY;
  let index: IndexEntry[] = [];
  const stats = {
    ref: { blocks: 0, offset: 0, indexOffset: 0 } as SectionStats,
    obj: { blocks: 0, offset: 0, indexOffset: 0 } as SectionStats,
    log: { blocks: 0, offset: 0, indexOffset: 0 } as SectionStats,
    idx: { blocks: 0, offset: 0, indexOffset: 0 } as SectionStats,
  };
  let refIndexBlocks = 0;
  let objectIdLength = 0;
  /** Object ids (hex) of the refs, with the offsets of the ref blocks naming them */
  const objIndex = new Map<string, number[]>();

  const statsOf = (type: number): SectionStats =>
    type === TYPE_REF
      ? stats.ref
      : type === TYPE_OBJ
        ? stats.obj
        : type === TYPE_LOG
          ? stats.log
          : stats.idx;

  const header = (dest: Uint8Array) => {
    dest.set([0x52, 0x45, 0x46, 0x54, version]);
    put24(dest, 5, blockSize);
    put64(dest, 8, min);
    put64(dest, 16, max);
    if (version === 2) {
      dest[24] = (FORMAT_ID_SHA256 >>> 24) & 0xff;
      dest[25] = (FORMAT_ID_SHA256 >>> 16) & 0xff;
      dest[26] = (FORMAT_ID_SHA256 >>> 8) & 0xff;
      dest[27] = FORMAT_ID_SHA256 & 0xff;
    }
  };

  const paddedWrite = (data: Uint8Array, padding: number) => {
    if (pendingPadding > 0) {
      chunks.push(new Uint8Array(pendingPadding));
      pendingPadding = 0;
    }
    pendingPadding = padding;
    chunks.push(data.slice());
  };

  const reinit = (type: number) => {
    lastKey = EMPTY;
    writer = new BlockWriter(type, blockSize, next === 0 ? headerSize : 0, restartInterval);
  };

  const flushBlock = () => {
    const w = writer;
    if (!w || w.entries === 0) return;
    const raw = w.finish();
    const padding = !unpadded && w.type !== TYPE_LOG ? blockSize - raw : 0;
    const s = statsOf(w.type);
    if (s.blocks === 0 && next > 0) s.offset = next;
    s.blocks++;
    const data = w.data();
    if (next === 0) header(data);
    paddedWrite(data, padding);
    index.push({ lastKey: w.lastKey, offset: next });
    next += padding + raw;
    writer = undefined;
  };

  /** Adds `record` to a block of `type`, starting one when there is none. */
  const add = (type: number, record: BlockRecord) => {
    if (compareKeys(lastKey, record.key) >= 0) {
      throw new ReftableWriteError("records must be added in ascending key order");
    }
    lastKey = record.key;
    if (!writer) reinit(type);
    const w = writer as BlockWriter;
    if (w.type !== type) throw new ReftableWriteError("a record of another section's type");
    if (w.add(record)) return;
    flushBlock();
    reinit(type);
    if (!(writer as BlockWriter).add(record)) {
      throw new ReftableWriteError("a record does not fit into a block (entry too big)");
    }
  };

  const finishSection = () => {
    const type = (writer as BlockWriter).type;
    const before = stats.idx.blocks;
    flushBlock();
    let indexStart = 0;
    const threshold = unpadded ? 1 : 3;
    while (index.length > threshold) {
      indexStart = next;
      reinit(TYPE_INDEX);
      const level = index;
      index = [];
      for (const entry of level) {
        const offset = entry.offset;
        add(TYPE_INDEX, {
          key: entry.lastKey,
          valueType: 0,
          encode: (out) => out.varint(offset),
        });
      }
      flushBlock();
    }
    index = [];
    const s = statsOf(type);
    s.indexOffset = indexStart;
    if (type === TYPE_REF) refIndexBlocks = stats.idx.blocks - before;
    lastKey = EMPTY;
  };

  const dumpObjectIndex = () => {
    const hashes = [...objIndex.keys()].sort();
    let maxCommon = 1;
    for (let i = 1; i < hashes.length; i++) {
      const a = id(hashes[i - 1] as string);
      const b = id(hashes[i] as string);
      maxCommon = Math.max(maxCommon, commonPrefix(a, b));
    }
    objectIdLength = maxCommon + 1;
    reinit(TYPE_OBJ);
    for (const hex of hashes) {
      const offsets = objIndex.get(hex) as number[];
      const record = (offsetCount: number): BlockRecord => ({
        key: id(hex).subarray(0, objectIdLength),
        valueType: offsetCount > 0 && offsetCount < 8 ? offsetCount : 0,
        encode: (out) => {
          if (offsetCount === 0 || offsetCount >= 8) out.varint(offsetCount);
          if (offsetCount === 0) return;
          out.varint(offsets[0] as number);
          for (let i = 1; i < offsetCount; i++) {
            out.varint((offsets[i] as number) - (offsets[i - 1] as number));
          }
        },
      });
      // straight into the block writer (git's write_object_record): no key order check
      const full = record(offsets.length);
      if ((writer as BlockWriter).add(full)) continue;
      flushBlock();
      reinit(TYPE_OBJ);
      if ((writer as BlockWriter).add(full)) continue;
      if (!(writer as BlockWriter).add(record(0))) {
        throw new ReftableWriteError("an object record does not fit into a block");
      }
    }
    finishSection();
  };

  const finishPublicSection = () => {
    if (!writer) return;
    const type = writer.type;
    finishSection();
    if (type === TYPE_REF && indexObjects && refIndexBlocks > 0) dumpObjectIndex();
    objIndex.clear();
    writer = undefined;
  };

  reinit(TYPE_REF);

  const refs = [...(content.refs ?? [])]
    .map((r) => ({ r, key: refKey(r.name) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  for (const { r, key } of refs) {
    if (r.updateIndex < min || r.updateIndex > max) {
      throw new ReftableWriteError(
        `ref '${r.name}' at update index ${r.updateIndex}, outside ${min}..${max}`,
      );
    }
    const delta = r.updateIndex - min;
    const value = r.value;
    const valueType =
      value.type === "deletion" ? 0 : value.type === "id" ? 1 : value.type === "peeled" ? 2 : 3;
    add(TYPE_REF, {
      key,
      valueType,
      encode: (out) => {
        out.varint(delta);
        if (value.type === "id") out.put(id(value.id));
        else if (value.type === "peeled") {
          out.put(id(value.id));
          out.put(id(value.peeled));
        } else if (value.type === "symref") out.string(encoder.encode(value.target));
      },
    });
    if (indexObjects && (value.type === "id" || value.type === "peeled")) {
      const ids = value.type === "id" ? [value.id] : [value.id, value.peeled];
      for (const id of ids) {
        const offsets = objIndex.get(id);
        if (!offsets) objIndex.set(id, [next]);
        else if (offsets[offsets.length - 1] !== next) offsets.push(next);
      }
    }
  }

  const logs = [...(content.logs ?? [])]
    .map((l) => ({ l, key: logKey(l.refName, l.updateIndex) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  for (const { l, key } of logs) {
    if (writer && writer.type === TYPE_REF) finishPublicSection();
    // the section ends unpadded (git's add_log_verbatim drops the pending padding)
    next -= pendingPadding;
    pendingPadding = 0;
    const update = l.update;
    if (update) {
      if (l.updateIndex > max) {
        throw new ReftableWriteError(`log of '${l.refName}' at update index past ${max}`);
      }
      let message = update.message;
      if (!options.exactLogMessage && !l.exactMessage) {
        message = message.replace(/\n+$/, "");
        if (message.includes("\n")) {
          throw new ReftableWriteError(`a reflog message of several lines ('${l.refName}')`);
        }
        message += "\n";
      }
      const old = id(update.oldId);
      const neu = id(update.newId);
      const name = encoder.encode(update.name);
      const email = encoder.encode(update.email);
      const text = encoder.encode(message);
      add(TYPE_LOG, {
        key,
        valueType: 1,
        encode: (out) => {
          out.put(old);
          out.put(neu);
          out.string(name);
          out.string(email);
          out.varint(update.time);
          out.push(...tzBytes(update.tzOffset));
          out.string(text);
        },
      });
    } else {
      add(TYPE_LOG, { key, valueType: 0, encode: () => {} });
    }
  }

  finishPublicSection();
  const empty = next === 0;
  pendingPadding = 0;
  if (empty) return undefined;

  const footer = new Uint8Array(footerSize);
  header(footer);
  const h = headerSize;
  put64(footer, h, stats.ref.indexOffset);
  put64(footer, h + 8, (BigInt(stats.obj.offset) << 5n) | BigInt(objectIdLength));
  put64(footer, h + 16, stats.obj.indexOffset);
  put64(footer, h + 24, stats.log.offset);
  put64(footer, h + 32, stats.log.indexOffset);
  const crcAt = h + 40;
  const crc = crc32(footer.subarray(0, crcAt));
  footer[crcAt] = (crc >>> 24) & 0xff;
  footer[crcAt + 1] = (crc >>> 16) & 0xff;
  footer[crcAt + 2] = (crc >>> 8) & 0xff;
  footer[crcAt + 3] = crc & 0xff;
  chunks.push(footer);

  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
