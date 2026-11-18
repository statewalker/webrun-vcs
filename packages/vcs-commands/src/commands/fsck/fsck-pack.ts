/**
 * Checking one installed pack as git's `verify_pack` (pack-check.c) does for fsck and
 * verify-pack, with git's messages:
 *
 *  - the idx's own SHA-1 (`Packfile index for <pack> hash mismatch`);
 *  - the pack's SHA-1 over everything before its trailer (`<pack> pack checksum mismatch`) and
 *    the trailer against the checksum the idx records (`... pack checksum does not match its
 *    index`);
 *  - entry by entry in pack order: the CRC-32 the idx records (`index CRC mismatch for object
 *    <id> from <pack> at offset <n>`), the entry unpacked (`cannot unpack <id> from <pack> at
 *    offset <n>`) and re-hashed (`packed <id> from <pack> is corrupt`).
 *
 * All of it in one sequential read of the pack, as `index-pack` reads one: each entry's bytes
 * feed the pack's SHA-1 and the entry's CRC-32, and are inflated there, once, and the object is
 * hashed in one call (`sha1Of`). A delta is applied to its base from a byte-bounded cache of
 * the objects unpacked before it (16 MiB): in pack order a delta's base comes before it, and
 * close to it, so this nearly always hits. Whatever this fast path does not handle as it stands
 * (a REF_DELTA, a base not cached, an object or delta over 1 MiB, an entry the pack's reader would find
 * through a corrupt part of the idx, an entry that fails in any way) is read through the pack's
 * own reader (`PackFile.getNow`), the reader the checks used before, so failures carry the
 * same messages and verdicts. The checksum errors, known at the end of the read, are reported
 * through `checksumError`, for the caller to place before the entries' output as git prints
 * them.
 *
 * Only the idx (git maps it too), the cache and one entry at a time are held.
 */

import {
  PACK_SCAN_MAX as FAST_MAX,
  type FilesApi,
  type GitObject,
  PACK_ENTRY_HEAD_MAX as HEAD_MAX,
  packIdxLookups as idLookups,
  inflateExactly as inflateInto,
  PACK_MAX_CHAIN as MAX_CHAIN,
  PACK_MAX_OBJECT_SIZE as MAX_OBJECT_SIZE,
  ObjectIdMismatchError,
  type ObjectTypeString,
  openPack,
  type PackFile,
  type PackIndex,
  type ScannedEntryHead as ParsedHead,
  packEntryOrder,
  parsePackEntryHead as parseEntryHead,
  readPackIndex,
} from "@statewalker/vcs-core";
import { applyGitDelta } from "@statewalker/vcs-utils/diff";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1, Sha1, sha1Of } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { allocBytes } from "@statewalker/vcs-utils/streams";

/** One entry of a pack, in pack order. */
export interface PackScanEntry {
  id: string;
  offset: number;
  /** Bytes the entry takes in the pack (to the next entry, or to the trailer). */
  sizeInPack: number;
  /** False when its CRC-32 is not the one the idx records (v2 idx only). */
  crcOk: boolean;
  /** The idx's bytes, holding the id's 20 bytes at `idAt`. */
  ids: Uint8Array;
  idAt: number;
  /**
   * The entry's header (v2 idx only, and only when it is sound: otherwise `PackFile.entry`
   * reads it, with its errors): its kind (1-4, 6 OFS_DELTA, 7 REF_DELTA), the size it declares
   * and a delta's base.
   */
  head?: { kind: number; size: number; baseId?: string };
}

/** An object unpacked from a pack: its type and content, or what went wrong (git's texts). */
export type UnpackedEntry =
  | { type: string; content: Uint8Array }
  | {
      error: string;
      corrupt: boolean;
      /** The zlib error git prints first (`inflate: data stream error (...)`), if any. */
      zlib?: string;
    };

/** What `checkPack` reports, as it goes. */
export interface PackCheckHooks {
  /** An error found before the entries are read (the idx), in git's `error()` text. */
  error(message: string): void;
  /** The pack is open: its entries and checksums are read next. */
  opened?(): void;
  /**
   * A pack checksum error, found once every entry has been read; git prints it before any
   * entry's output.
   */
  checksumError(message: string): void;
  /** One entry, in pack order: unpacked and hashed, or what went wrong; `pack` reads more. */
  entry(entry: PackScanEntry, unpacked: UnpackedEntry, pack: PackFile): void | Promise<void>;
}

export interface PackCheckOptions {
  /** Resolves REF_DELTA bases outside the pack. */
  externalBase?: (id: string) => Promise<GitObject | undefined>;
  /** The idx, when the caller has read it already. */
  read?: { bytes: Uint8Array; idx: PackIndex };
  /** Whether a blob's content is wanted (otherwise its entry's `content` is empty). */
  keepBlob: (id: string) => boolean;
}

/** What `checkPack` found. */
export interface PackCheckResult {
  /** Whether a check of the idx or the pack as a whole failed. */
  failed: boolean;
  /** Whether the pack could be opened (its entries were read only then). */
  opened: boolean;
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
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

const TYPES: (ObjectTypeString | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];
/**
 * Bytes of recently unpacked objects kept as delta bases. In pack order a delta's base is
 * nearly always among the last few hundred objects (repacks choose bases within a window of
 * recent candidates), so this is far less than git's 96 MiB delta_base_cache: a base that is
 * not kept is read through the pack's reader, which has that budget.
 */
const BASE_CACHE_BYTES = 16 * 2 ** 20;
const EMPTY = new Uint8Array(0);

/**
 * Checks one pack: the idx's checksum first, then, in one read of the pack, its checksums and
 * every entry (see the module comment). `hooks.entry` gets each entry as it is unpacked.
 */
export async function checkPack(
  files: FilesApi,
  packPath: string,
  idxPath: string,
  hooks: PackCheckHooks,
  options: PackCheckOptions,
): Promise<PackCheckResult> {
  let failed = false;
  let idxBytes: Uint8Array;
  let idx: PackIndex;
  const read = options.read;
  try {
    // the idx as the caller read it, or read here: once either way
    idxBytes = read?.bytes ?? (await readAll(files, idxPath));
    idx = read?.idx ?? readPackIndex(idxBytes);
  } catch {
    hooks.error(`packfile ${packPath} index not opened`);
    return { failed: true, opened: false };
  }
  // verify_pack_index
  const idxSum = new Sha1().update(idxBytes.subarray(0, idxBytes.length - 20)).digest();
  if (!sameBytes(idxSum, 0, idxBytes, idxBytes.length - 20)) {
    hooks.error(`Packfile index for ${packPath} hash mismatch`);
    failed = true;
  }

  const externalBase = options.externalBase;
  let pack: PackFile;
  try {
    pack = await openPack(files, packPath, idxPath, {
      idxBytes,
      externalBase: externalBase
        ? async (id) => {
            const obj = await externalBase(id);
            if (!obj) return undefined;
            return { type: obj.type, data: await collect(obj) };
          }
        : undefined,
    });
  } catch {
    hooks.error(`packfile ${packPath} cannot be accessed`);
    return { failed: true, opened: false };
  }

  hooks.opened?.();
  try {
    const stats = await files.stats(packPath);
    const packLength = stats?.size ?? 0;
    const trailerAt = packLength - 20;

    // the entries in pack order, with where each one's id is in the idx
    const v2 = idx.version > 1;
    const idsAt = v2 ? 8 + 1024 : 1024 + 4;
    const idStride = v2 ? 20 : 24;
    const count = idx.objectCount;
    const lookups = idLookups(idxBytes, v2, count);
    const ids = hexIds(idxBytes, idsAt, idStride, count);
    const crcAt = idsAt + count * 20;
    // in pack order (sorted by offset): each entry's idx position and offset
    const { order, sorted } = packEntryOrder(idxBytes, v2, count);
    const n = count;
    const offsetOf = (k: number) => sorted[k] as number;
    const posOf = (k: number) => order[k] as number;
    const entryEnd = (i: number) => (i + 1 < n ? (sorted[i + 1] as number) : trailerAt);
    // the fast path reads only entries the pack's reader finds without an idx error: in a
    // sound fan-out bucket, at a 32-bit offset past the pack header
    const fastAt = (k: number) => lookups(posOf(k)) && offsetOf(k) >= 12;
    const crcAtK = (k: number) => (v2 ? u32(idxBytes, crcAt + posOf(k) * 4) : undefined);
    const idAtK = (k: number) => idsAt + posOf(k) * idStride;

    const keepBlob = options.keepBlob;
    // The objects unpacked last, by entry, as delta bases: in pack order, the oldest dropped
    // first once they hold more than BASE_CACHE_BYTES (`queue` lists them, oldest first).
    const kept: (Uint8Array | undefined)[] = new Array(count);
    const keptType = new Uint8Array(count);
    const queue = new Int32Array(count);
    let qHead = 0;
    let qTail = 0;
    let keptBytes = 0;
    const keepBase = (k: number, type: ObjectTypeString, data: Uint8Array) => {
      kept[k] = data;
      keptType[k] = TYPES.indexOf(type);
      queue[qTail++] = k;
      keptBytes += data.length;
      while (keptBytes > BASE_CACHE_BYTES && qHead < qTail - 1) {
        const old = queue[qHead++] as number;
        keptBytes -= (kept[old] as Uint8Array).length;
        kept[old] = undefined;
      }
    };
    /** each entry's delta depth (0 for a whole object), as the fast path resolved it */
    const depth = new Uint16Array(n);
    let deltaScratch = new Uint8Array(64 * 1024);

    /**
     * The entry `k` unpacked from its bytes `bytes` (header included), or undefined when the
     * pack's reader has to read it.
     */
    const unpackFast = (
      k: number,
      head: ParsedHead,
      bytes: Uint8Array,
    ): { type: ObjectTypeString; data: Uint8Array } | undefined => {
      if (head.size > FAST_MAX) return undefined;
      const stream = bytes.subarray(head.dataAt);
      let type: ObjectTypeString;
      let data: Uint8Array;
      if (head.kind <= 4) {
        type = TYPES[head.kind] as ObjectTypeString;
        // small objects carved from shared slabs (a buffer of its own costs a microsecond)
        data = allocBytes(head.size);
        if (!inflateInto(stream, data)) return undefined;
      } else if (head.kind === 6) {
        const b = head.base;
        if ((depth[b] as number) >= MAX_CHAIN) return undefined;
        const baseData = kept[b];
        if (!baseData) return undefined;
        if (deltaScratch.length < head.size) deltaScratch = new Uint8Array(head.size);
        const delta = deltaScratch.subarray(0, head.size);
        if (!inflateInto(stream, delta)) return undefined;
        try {
          data = applyGitDelta(baseData, delta, MAX_OBJECT_SIZE, allocBytes);
        } catch {
          return undefined;
        }
        type = TYPES[keptType[b] as number] as ObjectTypeString;
        depth[k] = (depth[b] as number) + 1;
      } else {
        return undefined;
      }
      if (!hashesTo(type, data, idxBytes, idAtK(k))) return undefined;
      keepBase(k, type, data);
      return { type, data };
    };

    /** Entry `k`, its bytes read (or undefined when they were not kept): to `hooks.entry`. */
    const visit = (k: number, bytes: Uint8Array | undefined): void | Promise<void> => {
      const offset = offsetOf(k);
      const head =
        v2 && bytes && fastAt(k)
          ? parseEntryHead(bytes, sorted, k, entryEnd(k), (b) => ids(posOf(b)))
          : undefined;
      const id = ids(posOf(k));
      const entry: PackScanEntry = {
        id,
        offset,
        sizeInPack: entryEnd(k) - offset,
        crcOk,
        ids: idxBytes,
        idAt: idAtK(k),
        head:
          head &&
          (head.baseId === undefined
            ? { kind: head.kind, size: head.size }
            : { kind: head.kind, size: head.size, baseId: head.baseId }),
      };
      const fast = head && bytes ? unpackFast(k, head, bytes) : undefined;
      if (fast) {
        const content = fast.type === "blob" && !keepBlob(id) ? EMPTY : fast.data;
        return hooks.entry(entry, { type: fast.type, content }, pack);
      }
      const slow = unpackEntry(pack, packPath, entry, keepBlob);
      if (slow instanceof Promise) return slow.then((u) => hooks.entry(entry, u, pack));
      return hooks.entry(entry, slow, pack);
    };

    // One pass: the pack's SHA-1, each entry's CRC-32 and bytes
    const sha = new Sha1();
    const trailer = new Uint8Array(20);
    let at = 0;
    let k = 0;
    let crc = new CRC32();
    let crcOk = true;
    /** The bytes of the entry being read, when it spans chunks (and is not too long to keep). */
    let pending = new Uint8Array(64 * 1024);
    let pendingLength = 0;
    let keep = false;
    // entries the read skips (spanning nothing, at the start): through the reader, in order
    for (; k < n && entryEnd(k) <= offsetOf(k); k++) {
      crcOk = true;
      const r = visit(k, undefined);
      if (r instanceof Promise) await r;
    }
    const startEntry = () => {
      if (k >= n) return;
      const span = entryEnd(k) - offsetOf(k);
      keep = span <= FAST_MAX + HEAD_MAX;
      pendingLength = 0;
      if (keep && pending.length < span) pending = new Uint8Array(span);
    };
    startEntry();
    for await (const chunk of files.read(packPath)) {
      // the pack's SHA-1 covers everything before the trailer
      const hashed = Math.min(chunk.length, Math.max(0, trailerAt - at));
      if (hashed > 0) sha.update(hashed === chunk.length ? chunk : chunk.subarray(0, hashed));
      let c = 0;
      while (c < chunk.length) {
        if (at >= trailerAt) {
          const take = Math.min(chunk.length - c, packLength - at);
          if (take <= 0) break;
          trailer.set(chunk.subarray(c, c + take), at - trailerAt);
          at += take;
          c += take;
          continue;
        }
        let take = Math.min(chunk.length - c, trailerAt - at);
        const inEntry = k < n && at >= offsetOf(k);
        if (k < n) {
          const start = offsetOf(k);
          if (at < start) take = Math.min(take, start - at);
          else take = Math.min(take, entryEnd(k) - at);
        }
        const part = chunk.subarray(c, c + take);
        at += take;
        c += take;
        if (!inEntry) continue;
        crc.update(part);
        const done = at === entryEnd(k);
        let bytes: Uint8Array | undefined;
        if (keep) {
          if (done && pendingLength === 0) {
            bytes = part; // the whole entry is in this chunk
          } else {
            pending.set(part, pendingLength);
            pendingLength += part.length;
            if (done) bytes = pending.subarray(0, pendingLength);
          }
        }
        if (!done) continue;
        const want = crcAtK(k);
        crcOk = want === undefined || crc.getValue() === want;
        crc = new CRC32();
        const r = visit(k, bytes);
        if (r instanceof Promise) await r;
        k++;
        startEntry();
      }
    }
    // entries the read did not reach (a pack shorter than its idx says): through the reader
    for (; k < n; k++) {
      crcOk = true;
      const r = visit(k, undefined);
      if (r instanceof Promise) await r;
    }
    if (!sameBytes(sha.digest(), 0, trailer, 0)) {
      hooks.checksumError(`${packPath} pack checksum mismatch`);
      failed = true;
    }
    if (!sameBytes(idx.packChecksum, 0, trailer, 0)) {
      hooks.checksumError(`${packPath} pack checksum does not match its index`);
      failed = true;
    }
  } finally {
    pack.close();
  }
  return { failed, opened: true };
}

/** A big-endian 32-bit word (as `PackIndex` reads one: bytes past the end read as 0). */
function u32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) |
      ((b[at + 1] as number) << 16) |
      ((b[at + 2] as number) << 8) |
      (b[at + 3] as number)) >>>
    0
  );
}

const HEX_DIGITS = new TextEncoder().encode("0123456789abcdef");

/**
 * The idx's ids as hex strings, by position: decoded in one piece and sliced, so each is a
 * flat string (hashing or comparing one does not first copy it, as it would a string built a
 * digit pair at a time).
 */
function hexIds(
  idx: Uint8Array,
  idsAt: number,
  stride: number,
  n: number,
): (pos: number) => string {
  const text = new Uint8Array(n * 40);
  for (let i = 0; i < n; i++) {
    for (let k = 0, at = idsAt + i * stride, o = i * 40; k < 20; k++, o += 2) {
      const b = (idx[at + k] as number) ?? 0;
      text[o] = HEX_DIGITS[b >> 4] as number;
      text[o + 1] = HEX_DIGITS[b & 15] as number;
    }
  }
  const all = new TextDecoder().decode(text);
  return (pos) => all.slice(pos * 40, pos * 40 + 40);
}

function sameBytes(a: Uint8Array, at: number, b: Uint8Array, bt: number): boolean {
  for (let i = 0; i < 20; i++) if (a[at + i] !== b[bt + i]) return false;
  return true;
}

/** Where `hashesTo` writes an object's `"<type> <size>\0"` header (it runs synchronously). */
const header = new Uint8Array(32);

/** Whether `content` as `type` hashes to the 20 id bytes at `idAt` in `ids`. */
function hashesTo(type: string, content: Uint8Array, ids: Uint8Array, idAt: number): boolean {
  let n = 0;
  for (let i = 0; i < type.length; i++) header[n++] = type.charCodeAt(i);
  header[n++] = 0x20;
  const size = String(content.length);
  for (let i = 0; i < size.length; i++) header[n++] = size.charCodeAt(i);
  header[n++] = 0;
  return sameBytes(sha1Of(header.subarray(0, n), content), 0, ids, idAt);
}

/** The whole content of an object read from a store. */
export async function collect(obj: GitObject): Promise<Uint8Array> {
  if (obj.bytes) {
    // `content` is single-use: release it unread
    await obj.content[Symbol.asyncIterator]().return?.();
    return obj.bytes;
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of obj.content) {
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

/**
 * Unpacks and re-hashes one entry through the pack's reader. A blob's content is kept only
 * when `keepBlob` says so.
 *
 * Synchronous while the entry (and its delta bases) are in loaded windows or the base cache:
 * the object comes whole from `getNow` and is hashed in one call. A large whole object streams
 * (asynchronously) through the hash.
 */
export function unpackEntry(
  pack: PackFile,
  packPath: string,
  entry: PackScanEntry,
  keepBlob: (id: string) => boolean,
): UnpackedEntry | Promise<UnpackedEntry> {
  let obj: GitObject | undefined | Promise<GitObject | undefined>;
  try {
    obj = pack.getNow(entry.id);
  } catch (e) {
    return unpackError(entry, packPath, e);
  }
  if (obj instanceof Promise) {
    return obj.then(
      (o) => hashEntry(o, packPath, entry, keepBlob),
      (e) => unpackError(entry, packPath, e),
    );
  }
  return hashEntry(obj, packPath, entry, keepBlob);
}

function hashEntry(
  obj: GitObject | undefined,
  packPath: string,
  entry: PackScanEntry,
  keepBlob: (id: string) => boolean,
): UnpackedEntry | Promise<UnpackedEntry> {
  if (!obj) return { error: cannotUnpack(entry, packPath), corrupt: false };
  const bytes = obj.bytes;
  if (!bytes) return streamEntry(obj, packPath, entry, keepBlob);
  if (objectIdOf(obj.type, bytes) !== entry.id) {
    return { error: `packed ${entry.id} from ${packPath} is corrupt`, corrupt: true };
  }
  return { type: obj.type, content: obj.type === "blob" && !keepBlob(entry.id) ? EMPTY : bytes };
}

/** A large object (or one whose stream is broken): streamed through the hash. */
async function streamEntry(
  obj: GitObject,
  packPath: string,
  entry: PackScanEntry,
  keepBlob: (id: string) => boolean,
): Promise<UnpackedEntry> {
  const keep = obj.type !== "blob" || keepBlob(entry.id);
  const h = createSha1().update(enc.encode(`${obj.type} ${obj.size}\0`));
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of obj.content) {
      h.update(c);
      if (keep) parts.push(c);
      n += c.length;
    }
  } catch (e) {
    return unpackError(entry, packPath, e);
  }
  if (bytesToHex(h.digest()) !== entry.id) {
    return { error: `packed ${entry.id} from ${packPath} is corrupt`, corrupt: true };
  }
  if (!keep) return { type: obj.type, content: EMPTY };
  const content = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    content.set(p, o);
    o += p.length;
  }
  return { type: obj.type, content };
}

function unpackError(entry: PackScanEntry, packPath: string, e: unknown): UnpackedEntry {
  if (e instanceof ObjectIdMismatchError) {
    return { error: `packed ${entry.id} from ${packPath} is corrupt`, corrupt: true };
  }
  const inflate = /: inflate failed: (.*)$/.exec(e instanceof Error ? e.message : "")?.[1];
  return {
    error: cannotUnpack(entry, packPath),
    corrupt: false,
    zlib: inflate ? `inflate: data stream error (${inflate})` : undefined,
  };
}

const enc = new TextEncoder();

/** The git object id of `content` as `type`: SHA-1 over its header and content, as hex. */
export function objectIdOf(type: string, content: Uint8Array): string {
  let n = 0;
  for (let i = 0; i < type.length; i++) header[n++] = type.charCodeAt(i);
  header[n++] = 0x20;
  const size = String(content.length);
  for (let i = 0; i < size.length; i++) header[n++] = size.charCodeAt(i);
  header[n++] = 0;
  return bytesToHex(sha1Of(header.subarray(0, n), content));
}

function cannotUnpack(entry: PackScanEntry, packPath: string): string {
  return `cannot unpack ${entry.id} from ${packPath} at offset ${entry.offset}`;
}
