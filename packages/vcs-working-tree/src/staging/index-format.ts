import { objectIdToBytes } from "@statewalker/vcs-core";
import { createSha1, sha1 } from "@statewalker/vcs-utils";
import {
  compareGitPaths,
  decodeGitPath,
  encodeGitPath,
  foldAsciiCase,
  hasEscapedBytes,
} from "@statewalker/vcs-utils/encoding";
import type { MergeStageValue, StagingEntry } from "./types.js";

/**
 * Git index file format constants.
 *
 * Index file format (DIRC = "DirCache"):
 * - Header: 12 bytes (signature + version + entry count)
 * - Entries: variable (62 bytes header + path + padding each)
 * - Extensions: optional (TREE, etc.)
 * - Checksum: 20 bytes SHA-1
 */

/** Index file signature "DIRC" */
export const INDEX_SIGNATURE = 0x44495243;

/** Index version 2 - minimum supported */
export const INDEX_VERSION_2 = 2;

/** Index version 3 - supports extended flags */
export const INDEX_VERSION_3 = 3;

/** Index version 4 - path compression */
export const INDEX_VERSION_4 = 4;

/** Header size in bytes */
const HEADER_SIZE = 12;

/** Checksum size (SHA-1) */
const CHECKSUM_SIZE = 20;

/** Entry info length without extended flags */
const INFO_LEN = 62;

/** Entry info length with extended flags */
const INFO_LEN_EXTENDED = 64;

/** Bit positions in entry header */
const P_CTIME = 0;
const P_MTIME = 8;
const P_DEV = 16;
const P_INO = 20;
const P_MODE = 24;
const P_UID = 28;
const P_GID = 32;
const P_SIZE = 36;
const P_OBJECTID = 40;
const P_FLAGS = 60;
const P_FLAGS2 = 62;

/** Maximum path length stored in flags (12 bits) */
const NAME_MASK = 0xfff;

/** Extended flags bit in P_FLAGS */
const EXTENDED = 0x4000;

/** Assume-valid flag bit */
const ASSUME_VALID = 0x8000;

/** Intent-to-add flag (in extended flags) */
const INTENT_TO_ADD = 0x20000000;

/** Skip-worktree flag (in extended flags) */
const SKIP_WORKTREE = 0x40000000;

/** Extended flags mask */
const EXTENDED_FLAGS = INTENT_TO_ADD | SKIP_WORKTREE;

/** TREE extension signature */
const _EXT_TREE = 0x54524545;

/**
 * Supported index versions.
 */
export type IndexVersion = typeof INDEX_VERSION_2 | typeof INDEX_VERSION_3 | typeof INDEX_VERSION_4;

/**
 * Parsed index file result.
 */
export interface ParsedIndex {
  version: IndexVersion;
  entries: StagingEntry[];
  /**
   * The signatures of the extensions after the entries, in file order (`TREE`, `REUC`, `link`
   * for a split index, ...). Their contents are not parsed. When one is required
   * (lowercase), `entries` are not validated: they are incomplete or need that
   * extension to be read.
   */
  extensions: string[];
  /**
   * The extensions themselves, signature and payload (a copy), in file order. Pass
   * them through `carryIndexExtensions` before writing them back with
   * `encodeIndexFile`.
   */
  extensionData: IndexExtension[];
  /** The entries' bytes, with `keepEncoding` (versions 2 and 3) */
  encoding?: IndexEncoding;
}

/**
 * Entries as encoded in an index's bytes, for the next write of the index to copy instead of
 * encoding them again: `entries[i]` (an entry object, never changed in place) is written as
 * `buffer[offsets[i], end)`, where `end` is the next entry's start (`offsets[entries.length]`
 * ends the last). A negative offset is the complement (`~start`) of bytes that are not to be
 * copied (not as the encoder would write them). Only a write of the same version copies them.
 */
export interface IndexEncoding {
  entries: readonly StagingEntry[];
  buffer: Uint8Array;
  offsets: Int32Array;
  version: IndexVersion;
}

/** Options of {@link parseIndexFile}. */
export interface ParseIndexOptions {
  /**
   * Describe where each version 2/3 entry's bytes are (`ParsedIndex.encoding`), so that a
   * write of the entries copies them instead of encoding them (an index read and written by
   * a command keeps most of its entries). The caller hands `data` over: it must never change
   * afterwards.
   */
  keepEncoding?: boolean;
}

/** An index extension as stored: a four-character signature and its payload. */
export interface IndexExtension {
  signature: string;
  data: Uint8Array;
}

/**
 * Parse Git index file format.
 *
 * Supports versions 2, 3, and 4.
 *
 * @param data Raw index file bytes
 * @returns Parsed index with version and entries
 * @throws Error on invalid format or checksum mismatch
 */
export async function parseIndexFile(
  data: Uint8Array,
  options: ParseIndexOptions = {},
): Promise<ParsedIndex> {
  if (data.length < HEADER_SIZE + CHECKSUM_SIZE) {
    throw new Error("Index file too small");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Parse header
  const signature = view.getUint32(offset);
  if (signature !== INDEX_SIGNATURE) {
    throw new Error(`Invalid index file signature: expected DIRC, got ${signature.toString(16)}`);
  }
  offset += 4;

  const version = view.getUint32(offset) as IndexVersion;
  if (version < INDEX_VERSION_2 || version > INDEX_VERSION_4) {
    throw new Error(`Unsupported index version: ${version}`);
  }
  offset += 4;

  const entryCount = view.getUint32(offset);
  if (entryCount < 0) {
    throw new Error("Invalid entry count");
  }
  offset += 4;

  // Verify checksum before parsing entries
  const contentWithoutChecksum = data.subarray(0, data.length - CHECKSUM_SIZE);
  const storedChecksum = data.subarray(data.length - CHECKSUM_SIZE);
  const computedChecksum = await sha1(contentWithoutChecksum);

  if (!arraysEqual(storedChecksum, computedChecksum)) {
    throw new Error("Index file checksum mismatch");
  }

  // Parse entries
  const entries: StagingEntry[] = [];
  let previousPath = "";

  // where each entry's bytes start (a version 2/3 write copies them, see IndexEncoding);
  // complemented for an entry whose extended-flags word the encoder would not write as read
  const offsets =
    options.keepEncoding === true && version !== INDEX_VERSION_4
      ? new Int32Array(entryCount + 1)
      : undefined;
  for (let i = 0; i < entryCount; i++) {
    const entry = parseEntry(data, view, offset, version, previousPath);
    const nextOffset = parsedEnd;
    entries.push(entry);
    if (offsets) {
      const extended = (view.getUint16(offset + P_FLAGS) & EXTENDED) !== 0;
      offsets[i] = extended === hasExtendedFlags(entry) ? offset : ~offset;
    }
    previousPath = entry.path;
    offset = nextOffset;
  }
  if (offsets) offsets[entryCount] = offset;

  // Extensions: a 4-byte signature and a 4-byte size, then the data, up to the checksum
  const extensions: string[] = [];
  const extensionData: IndexExtension[] = [];
  const end = data.length - CHECKSUM_SIZE;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset + 4);
    // a size past the checksum: not an extension git wrote; stop (the entries are complete)
    if (offset + 8 + size > end) break;
    const signature = String.fromCharCode(...data.subarray(offset, offset + 4));
    extensions.push(signature);
    extensionData.push({ signature, data: data.slice(offset + 8, offset + 8 + size) });
    offset += 8 + size;
  }

  // A required extension we do not understand (a split index's `link`) changes what
  // the entries mean: entries there may legitimately have empty paths. Leave them
  // as they are; callers refuse such an index (see `assertWritableIndexExtensions`).
  if (!extensions.some((sig) => !/^[A-Z]/.test(sig))) {
    for (const entry of entries) validatePath(entry.path);
  }

  return {
    version,
    entries,
    extensions,
    extensionData,
    // (the entries' list as parsed: the caller may edit the one it is given)
    ...(offsets ? { encoding: { entries: entries.slice(), buffer: data, offsets, version } } : {}),
  };
}

/** The char codes of "0" to "f". */
const HEX_CHARS = Array.from("0123456789abcdef", (c) => c.charCodeAt(0));
/** The 40 char codes of the id {@link hexIdAt} is converting (it never awaits). */
const ID_CHARS: number[] = new Array(40).fill(0);

/** The hex object id of the 20 bytes at `data[at]` (no view per id). */
function hexIdAt(data: Uint8Array, at: number): string {
  for (let i = 0; i < 20; i++) {
    const b = data[at + i] as number;
    ID_CHARS[2 * i] = HEX_CHARS[b >> 4] as number;
    ID_CHARS[2 * i + 1] = HEX_CHARS[b & 15] as number;
  }
  return String.fromCharCode.apply(null, ID_CHARS);
}

/** Arrays of each length up to {@link SHORT_PATH}, reused to build ASCII paths. */
const SHORT_PATH = 96;
const PATH_CHARS: number[][] = Array.from({ length: SHORT_PATH + 1 }, (_, n) =>
  new Array(n).fill(0),
);

/**
 * The path in the `length` bytes at `data[at]` ({@link decodeGitPath}): a short ASCII one
 * built from its char codes without a view of the bytes, any other decoded as bytes.
 */
function pathAt(data: Uint8Array, at: number, length: number): string {
  if (length <= SHORT_PATH) {
    const chars = PATH_CHARS[length] as number[];
    let ascii = true;
    for (let k = 0; k < length; k++) {
      const c = data[at + k] as number;
      if (c >= 0x80) {
        ascii = false;
        break;
      }
      chars[k] = c;
    }
    if (ascii) return String.fromCharCode.apply(null, chars);
  }
  return decodeGitPath(data.subarray(at, at + length));
}

/** Where the entry {@link parseEntry} last parsed ends (no result object per entry). */
let parsedEnd = 0;

/**
 * Parse a single index entry (its end in {@link parsedEnd}).
 */
function parseEntry(
  data: Uint8Array,
  view: DataView,
  offset: number,
  version: IndexVersion,
  previousPath: string,
): StagingEntry {
  const startOffset = offset;

  // Timestamps (ctime, mtime - each 8 bytes: seconds + nanoseconds)
  const ctimeSeconds = view.getUint32(offset);
  const ctimeNanos = view.getUint32(offset + 4);
  offset += 8;

  const mtimeSeconds = view.getUint32(offset);
  const mtimeNanos = view.getUint32(offset + 4);
  offset += 8;

  // Device and inode
  const dev = view.getUint32(offset);
  offset += 4;
  const ino = view.getUint32(offset);
  offset += 4;

  // Mode
  const mode = view.getUint32(offset);
  offset += 4;

  // UID and GID (kept, so a rewrite does not make git see every entry as changed)
  const uid = view.getUint32(offset);
  const gid = view.getUint32(offset + 4);
  offset += 8;

  // Size
  const size = view.getUint32(offset);
  offset += 4;

  // Object ID (20 bytes SHA-1)
  const objectId = hexIdAt(data, offset);
  offset += 20;

  // Flags (2 bytes)
  const flags = view.getUint16(offset);
  offset += 2;

  const stage = ((flags >> 12) & 0x3) as MergeStageValue;
  const hasExtended = (flags & EXTENDED) !== 0;
  const assumeValid = (flags & ASSUME_VALID) !== 0;
  const nameLength = flags & NAME_MASK;

  // Extended flags (version 3+, if EXTENDED bit set)
  let intentToAdd = false;
  let skipWorktree = false;

  if (hasExtended) {
    const extFlags = view.getUint16(offset) << 16;
    offset += 2;
    intentToAdd = (extFlags & INTENT_TO_ADD) !== 0;
    skipWorktree = (extFlags & SKIP_WORKTREE) !== 0;

    // Check for unsupported extended flags
    if ((extFlags & ~EXTENDED_FLAGS) !== 0) {
      throw new Error(`Unrecognized extended flags: ${extFlags.toString(16)}`);
    }
  }

  // Path parsing
  let path: string;

  if (version === INDEX_VERSION_4) {
    // Version 4: path compression
    // Read varint for bytes to remove from previous path
    const { value: toRemove, bytesRead } = readVarint(data, offset);
    offset += bytesRead;

    // Read null-terminated path suffix
    const { bytes: suffix, nextOffset: pathEnd } = readNullTerminated(data, offset);
    offset = pathEnd;

    // Reconstruct path: prefix from previous + suffix (counted in bytes)
    const previous = encodeGitPath(previousPath);
    const prefixLen = previous.length - toRemove;
    if (prefixLen < 0) {
      throw new Error(
        `Invalid path compression: removing ${toRemove} from ${previous.length} bytes`,
      );
    }
    const whole = new Uint8Array(prefixLen + suffix.length);
    whole.set(previous.subarray(0, prefixLen));
    whole.set(suffix, prefixLen);
    path = decodeGitPath(whole);
  } else {
    // Version 2/3: uncompressed path
    if (nameLength === NAME_MASK) {
      // Long path (>= 0xfff bytes)
      const { value: pathStr, nextOffset: pathEnd } = readNullTerminated(data, offset);
      path = pathStr;
      offset = pathEnd;
    } else {
      // Short path
      path = pathAt(data, offset, nameLength);
      offset += nameLength;

      // Skip null terminator
      if (data[offset] === 0) {
        offset++;
      }
    }

    // Padding to 8-byte boundary (version 2/3 only)
    const entryLen = offset - startOffset;
    const alignedLen = (entryLen + 7) & ~7;
    offset = startOffset + alignedLen;
  }

  // Paths are validated by the caller, once the extensions are known

  // Convert timestamps to milliseconds
  const mtime = mtimeSeconds * 1000 + Math.floor(mtimeNanos / 1_000_000);
  const ctime = ctimeSeconds * 1000 + Math.floor(ctimeNanos / 1_000_000);

  const entry: StagingEntry = {
    path,
    mode,
    objectId,
    stage,
    size,
    mtime,
    ctime,
    dev,
    ino,
    mtimeNs: mtimeNanos,
    ctimeNs: ctimeNanos,
    uid,
    gid,
    assumeValid,
    intentToAdd,
    skipWorktree,
  };

  parsedEnd = offset;
  return entry;
}

/** Entries are gathered into chunks of about this many bytes before they are yielded. */
const INDEX_CHUNK_SIZE = 64 * 1024;

/**
 * Encode entries in Git index format, as chunks.
 *
 * Entries are validated and sorted by (path, stage) before anything is yielded,
 * so an invalid path or object id throws here and not halfway through a write. The chunks
 * (the header, entries gathered into about 64 KiB pieces, then the trailing
 * SHA-1, computed as they go) are produced as they are pulled, so an index is
 * never built as one buffer.
 *
 * @example
 * ```typescript
 * await files.write(".git/index", encodeIndexFile(entries));
 * ```
 *
 * @param entries Entries to encode (sorted here; the array is not changed)
 * @param version Index version (default: 2)
 * @param extensions Extensions written after the entries, as given (see `carryIndexExtensions`)
 * @returns The index file's bytes, chunk by chunk; the last chunk is the 20-byte checksum
 * @throws Error when a path is invalid; InvalidObjectIdError when an object id is not 40 lowercase hex
 */
export function encodeIndexFile(
  entries: readonly StagingEntry[],
  version: IndexVersion = INDEX_VERSION_2,
  extensions: readonly IndexExtension[] = [],
): Iterable<Uint8Array> {
  const written = writtenVersion(entries, version);
  const sortedEntries = checkedSorted(entries, extensions, written === INDEX_VERSION_4);
  if (written === INDEX_VERSION_4) return encodeSorted(sortedEntries, written, extensions);
  // encoded (and so checked) now, before the first chunk is asked for
  const { out, size } = encodeFlat(sortedEntries, written, extensions, 0);
  return chunked(out, size);
}

/**
 * The index file's bytes as one buffer, the checksum hashed by Web Crypto where the runtime
 * has it (the bytes `encodeIndexFile` yields, joined). For a write of the whole file at once
 * (an index lock created holding it): a large index is copied once and hashed natively.
 * The buffer is the caller's own: changing it never reaches a later encode.
 *
 * @example
 * ```typescript
 * const { bytes, checksum } = await encodeIndexFileBytes(entries);
 * ```
 *
 * @throws as `encodeIndexFile`, before anything is encoded
 */
export async function encodeIndexFileBytes(
  entries: readonly StagingEntry[],
  version: IndexVersion = INDEX_VERSION_2,
  extensions: readonly IndexExtension[] = [],
  options: { source?: IndexEncoding } = {},
): Promise<{ bytes: Uint8Array; checksum: Uint8Array; encoding?: IndexEncoding }> {
  const written = writtenVersion(entries, version);
  const sortedEntries = checkedSorted(entries, extensions, written === INDEX_VERSION_4);
  if (written === INDEX_VERSION_4) {
    const bytes = concatBytes([...encodeSorted(sortedEntries, written, extensions)]);
    return { bytes, checksum: bytes.subarray(bytes.length - 20) };
  }
  const source = options.source?.version === written ? options.source : undefined;
  const offsets = new Int32Array(sortedEntries.length + 1);
  const { out, size } = encodeFlat(sortedEntries, written, extensions, 20, source, offsets);
  const checksum = await sha1(out.subarray(0, size));
  out.set(checksum, size);
  // the entries' records point into `out` (a later encode copies their bytes from there):
  // the caller gets a copy, so changing it cannot slip into a later index under a valid
  // checksum
  const bytes = out.slice();
  return {
    bytes,
    checksum: bytes.subarray(size),
    encoding: { entries: sortedEntries, buffer: out, offsets, version: written },
  };
}

/**
 * A version 2/3 index without its checksum, written into one buffer (with `spare` bytes
 * left at its end for the checksum): the sizes summed first, then each entry written in
 * place (an ASCII path character by character, the object id from its hex), no buffer per
 * entry. An entry written before is copied from where its bytes were last written.
 */
function encodeFlat(
  sortedEntries: readonly StagingEntry[],
  version: IndexVersion,
  extensions: readonly IndexExtension[],
  spare: number,
  source?: IndexEncoding,
  /** filled with where each entry starts in `out` (and where the entries end) */
  offsets?: Int32Array,
): { out: Uint8Array; size: number } {
  const count = sortedEntries.length;
  // the path's bytes for a path that is not ASCII (undefined: ASCII, written as it is)
  const encodedPaths: Array<Uint8Array | undefined> = new Array(count);
  const known: Array<EncodedEntry | undefined> = new Array(count);
  // the source's bytes of each entry it has (start; -1 none), found walking both in order
  const fromSource = source ? new Int32Array(count).fill(-1) : undefined;
  const fromSourceEnd = source ? new Int32Array(count) : undefined;
  const sourceEntries = source?.entries ?? [];
  const sourceOffsets = source?.offsets;
  const sourceCount = sourceOffsets ? Math.min(sourceEntries.length, sourceOffsets.length - 1) : 0;
  let j = 0;
  let size = HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    const entry = sortedEntries[i] as StagingEntry;
    if (fromSource && sourceOffsets) {
      // the source's entries before this one are gone; one at its path was replaced
      let found = false;
      while (j < sourceCount) {
        const s = sourceEntries[j] as StagingEntry;
        if (s === entry) {
          found = true;
          j++;
          break;
        }
        const order = comparePaths(s.path, entry.path) || s.stage - entry.stage;
        if (order > 0) break;
        j++;
        if (order === 0) break;
      }
      const start = found ? (sourceOffsets[j - 1] as number) : -1;
      if (start >= 0) {
        // the next entry's start ends it
        const next = sourceOffsets[j] as number;
        const end = next >= 0 ? next : ~next;
        fromSource[i] = start;
        (fromSourceEnd as Int32Array)[i] = end;
        size += end - start;
        continue;
      }
    }
    const record = encodedEntries.get(entry);
    // (a buffer handed away since, detached, holds nothing any more)
    if (record && record.version === version && record.buffer.length > 0) {
      known[i] = record;
      size += record.length;
      continue;
    }
    const path = entry.path;
    validatePath(path);
    let pathLength = path.length;
    if (!isAscii(path)) {
      const bytes = encodeGitPath(path);
      encodedPaths[i] = bytes;
      pathLength = bytes.length;
    }
    const infoLen = hasExtendedFlags(entry) ? INFO_LEN_EXTENDED : INFO_LEN;
    size += (infoLen + pathLength + 8) & ~7;
  }
  for (const ext of extensions) size += 8 + ext.data.length;

  const out = new Uint8Array(size + spare);
  const view = new DataView(out.buffer);
  view.setUint32(0, INDEX_SIGNATURE);
  view.setUint32(4, version);
  view.setUint32(8, count);
  let at = HEADER_SIZE;
  // entries encoded next to each other before are copied in one run
  let runBuffer: Uint8Array | undefined;
  let runStart = 0;
  let runEnd = 0;
  let runAt = 0;
  const flushRun = () => {
    if (runBuffer) out.set(runBuffer.subarray(runStart, runEnd), runAt);
    if (runBuffer) out.set(runBuffer.subarray(runStart, runEnd), runAt);
    runBuffer = undefined;
  };
  for (let i = 0; i < count; i++) {
    const entry = sortedEntries[i] as StagingEntry;
    if (offsets) offsets[i] = at;
    const start = fromSource ? (fromSource[i] as number) : -1;
    if (start >= 0) {
      const end = (fromSourceEnd as Int32Array)[i] as number;
      const buffer = (source as IndexEncoding).buffer;
      if (runBuffer === buffer && runEnd === start) {
        runEnd = end;
      } else {
        flushRun();
        runBuffer = buffer;
        runStart = start;
        runEnd = end;
        runAt = at;
      }
      at += end - start;
      continue;
    }
    const record = known[i];
    if (record) {
      if (runBuffer === record.buffer && runEnd === record.offset) {
        runEnd += record.length;
      } else {
        flushRun();
        runBuffer = record.buffer;
        runStart = record.offset;
        runEnd = runStart + record.length;
        runAt = at;
      }
      // the bytes now live here: the record follows them, so an older buffer is let go
      record.buffer = out;
      record.offset = at;
      at += record.length;
      continue;
    }
    flushRun();
    const hasExtended = hasExtendedFlags(entry);
    const infoLen = hasExtended ? INFO_LEN_EXTENDED : INFO_LEN;
    const bytes = encodedPaths[i];
    const path = entry.path;
    const pathLength = bytes ? bytes.length : path.length;
    writeEntryHeader(view, at, entry, pathLength, hasExtended);
    // objectIdToBytes throws the error for an id that is none
    if (!writeObjectId(out, at + P_OBJECTID, entry.objectId)) objectIdToBytes(entry.objectId);
    const pathAt = at + infoLen;
    if (bytes) out.set(bytes, pathAt);
    else for (let k = 0; k < pathLength; k++) out[pathAt + k] = path.charCodeAt(k);
    // the NUL and the padding are zero already
    const length = (infoLen + pathLength + 8) & ~7;
    encodedEntries.set(entry, { version, buffer: out, offset: at, length });
    at += length;
  }
  flushRun();
  if (offsets) offsets[count] = at;
  for (const ext of extensions) {
    for (let i = 0; i < 4; i++) out[at + i] = ext.signature.charCodeAt(i);
    view.setUint32(at + 4, ext.data.length);
    out.set(ext.data, at + 8);
    at += 8 + ext.data.length;
  }
  return { out, size };
}

/** Whether `s` holds a surrogate (where UTF-16 order and byte order may disagree). */
const hasSurrogate = (s: string) => SURROGATE_CHAR.test(s);
const SURROGATE_CHAR = /[\ud800-\udfff]/;

/** Whether `s` is all ASCII (its UTF-8 bytes are its characters). */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** The value of each hex digit by character code (-1: none; lowercase only, as git writes). */
const HEX_DIGIT = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 10; i++) table[48 + i] = i;
  for (let i = 0; i < 6; i++) table[97 + i] = 10 + i;
  return table;
})();

/**
 * The 20 bytes of the object id `id` written at `at`; false (bytes undefined) when it is
 * not 40 lowercase hex digits.
 */
function writeObjectId(out: Uint8Array, at: number, id: string): boolean {
  if (typeof id !== "string" || id.length !== 40) return false;
  for (let i = 0; i < 20; i++) {
    const c1 = id.charCodeAt(2 * i);
    const c2 = id.charCodeAt(2 * i + 1);
    const hi = c1 < 128 ? (HEX_DIGIT[c1] as number) : -1;
    const lo = c2 < 128 ? (HEX_DIGIT[c2] as number) : -1;
    if ((hi | lo) < 0) return false;
    out[at + i] = (hi << 4) | lo;
  }
  return true;
}

/** The entries checked (paths, ids, extension names) and in the index's order. */
function checkedSorted(
  entries: readonly StagingEntry[],
  extensions: readonly IndexExtension[],
  checkEntries: boolean,
): StagingEntry[] {
  // versions 2 and 3 check each entry as they write it (encodeFlat), before any byte is out
  for (const entry of checkEntries ? entries : []) {
    // an entry encoded before was checked then (entries are never changed in place)
    if (encodedEntries.has(entry)) continue;
    validatePath(entry.path);
    objectIdToBytes(entry.objectId);
  }
  for (const ext of extensions) {
    if (!/^[\x21-\x7e]{4}$/.test(ext.signature)) {
      throw new Error(`Invalid index extension signature: ${JSON.stringify(ext.signature)}`);
    }
  }
  const order = (a: StagingEntry, b: StagingEntry) => {
    const pathCmp = comparePaths(a.path, b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.stage - b.stage;
  };
  // an index is mostly given in its order already: checked in one pass before a sort. The
  // engine's string order (UTF-16 code units) is the bytes' order unless a surrogate makes
  // the difference: a pair it calls ordered is checked again only then
  let sorted = true;
  for (let i = 1; i < entries.length && sorted; i++) {
    const a = entries[i - 1] as StagingEntry;
    const b = entries[i] as StagingEntry;
    sorted = a.path < b.path && !hasSurrogate(a.path) && !hasSurrogate(b.path);
    if (!sorted) sorted = order(a, b) < 0;
  }
  return sorted ? [...entries] : [...entries].sort(order);
}

/**
 * The version git writes an index of `entries` in, asked for `version` (`do_write_index`):
 * versions 2 and 3 differ only in allowing extended flags, so the header says 3 exactly when
 * an entry has one (skip-worktree, intent-to-add) and 2 otherwise; version 4 stays 4.
 */
function writtenVersion(entries: readonly StagingEntry[], version: IndexVersion): IndexVersion {
  if (version !== INDEX_VERSION_2 && version !== INDEX_VERSION_3) return version;
  return entries.some(hasExtendedFlags) ? INDEX_VERSION_3 : INDEX_VERSION_2;
}

/** Whether an entry needs the extended flags word (git's CE_EXTENDED_FLAGS). */
function hasExtendedFlags(entry: StagingEntry): boolean {
  return entry.intentToAdd === true || entry.skipWorktree === true;
}

/** The first `size` bytes of `out` in chunks of {@link INDEX_CHUNK_SIZE}, then their SHA-1. */
function* chunked(out: Uint8Array, size: number): Generator<Uint8Array> {
  const hasher = createSha1();
  for (let at = 0; at < size; at += INDEX_CHUNK_SIZE) {
    // a copy: the entries' records point into `out` (see encodeIndexFileBytes)
    const chunk = out.slice(at, Math.min(size, at + INDEX_CHUNK_SIZE));
    hasher.update(chunk);
    yield chunk;
  }
  yield hasher.digest();
}

function* encodeSorted(
  sortedEntries: StagingEntry[],
  version: IndexVersion,
  extensions: readonly IndexExtension[],
): Generator<Uint8Array> {
  const hasher = createSha1();

  const header = new Uint8Array(HEADER_SIZE);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, INDEX_SIGNATURE);
  headerView.setUint32(4, version);
  headerView.setUint32(8, sortedEntries.length);

  let pending: Uint8Array[] = [header];
  let pendingLength = header.length;
  const take = (): Uint8Array => {
    const chunk = pending.length === 1 ? (pending[0] as Uint8Array) : concatBytes(pending);
    pending = [];
    pendingLength = 0;
    hasher.update(chunk);
    return chunk;
  };

  let previousPath = "";
  for (const entry of sortedEntries) {
    const entryBytes = serializeEntry(entry, previousPath);
    pending.push(entryBytes);
    pendingLength += entryBytes.length;
    previousPath = entry.path;
    if (pendingLength >= INDEX_CHUNK_SIZE) yield take();
  }
  for (const ext of extensions) {
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = ext.signature.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, ext.data.length);
    pending.push(head, ext.data);
    pendingLength += 8 + ext.data.length;
    if (pendingLength >= INDEX_CHUNK_SIZE) yield take();
  }
  if (pendingLength > 0) yield take();

  yield hasher.digest();
}

/**
 * Serialize entries to Git index format, as one buffer.
 *
 * The bytes `encodeIndexFile` yields, joined. To write an index, pass
 * `encodeIndexFile` to `FilesApi.write` instead.
 *
 * @param entries Entries to serialize (will be sorted)
 * @param version Index version (default: 2)
 * @returns Serialized index file bytes
 */
export async function serializeIndexFile(
  entries: readonly StagingEntry[],
  version: IndexVersion = INDEX_VERSION_2,
  extensions: readonly IndexExtension[] = [],
): Promise<Uint8Array> {
  return concatBytes([...encodeIndexFile(entries, version, extensions)]);
}

/**
 * Compare paths using Git's canonical ordering.
 */
function comparePaths(a: string, b: string): number {
  // the order of the paths' bytes (an escaped byte of a non-UTF-8 name included)
  return compareGitPaths(a, b);
}

/**
 * Serialize a single index entry.
 */
/**
 * The version 2/3 bytes of entries already encoded, by entry object and version. An index
 * written again and again (a rebase's picks) keeps most of its entry objects: only the
 * entries a command replaced are encoded afresh. Entries are never changed in place.
 */
const encodedEntries = new WeakMap<StagingEntry, EncodedEntry>();

/**
 * Where an entry's version 2/3 bytes were last written: `length` bytes at `offset` of
 * `buffer` (an index file's bytes). Moved to each new buffer the entry is written to, so a
 * buffer is kept only by the entries last written there.
 */
interface EncodedEntry {
  version: IndexVersion;
  buffer: Uint8Array;
  offset: number;
  length: number;
}

/**
 * Lets `copy`, a new entry object built from `source` (an index builder copies the entries
 * it keeps), reuse the bytes `source` was encoded to, when every field the encoding reads is
 * the same in both. A rewrite of a large index then encodes only what changed.
 */
export function reuseEntryEncoding(source: object, copy: StagingEntry): void {
  const known = encodedEntries.get(source as StagingEntry);
  if (!known) return;
  const a = source as StagingEntry;
  if (
    a.path === copy.path &&
    a.mode === copy.mode &&
    a.objectId === copy.objectId &&
    a.stage === copy.stage &&
    a.size === copy.size &&
    a.mtime === copy.mtime &&
    a.ctime === copy.ctime &&
    a.mtimeNs === copy.mtimeNs &&
    a.ctimeNs === copy.ctimeNs &&
    a.dev === copy.dev &&
    a.ino === copy.ino &&
    a.uid === copy.uid &&
    a.gid === copy.gid &&
    a.assumeValid === copy.assumeValid &&
    a.intentToAdd === copy.intentToAdd &&
    a.skipWorktree === copy.skipWorktree
  ) {
    encodedEntries.set(copy, known);
  }
}

function serializeEntry(entry: StagingEntry, previousPath: string): Uint8Array {
  const pathBytes = encodeGitPath(entry.path);
  // only an entry with an extended flag carries the word ("reduce extended entries")
  return serializeEntryV4(entry, pathBytes, previousPath, hasExtendedFlags(entry));
}

/**
 * Serialize entry for version 4 (path compression).
 */
function serializeEntryV4(
  entry: StagingEntry,
  pathBytes: Uint8Array,
  previousPath: string,
  hasExtended: boolean,
): Uint8Array {
  // Find common prefix
  let commonLen = 0;
  const prevBytes = encodeGitPath(previousPath);
  const minLen = Math.min(pathBytes.length, prevBytes.length);

  while (commonLen < minLen && pathBytes[commonLen] === prevBytes[commonLen]) {
    commonLen++;
  }

  const toRemove = prevBytes.length - commonLen;
  const suffix = pathBytes.subarray(commonLen);

  // Encode varint for bytes to remove
  const varintBytes = encodeVarint(toRemove);

  const infoLen = hasExtended ? INFO_LEN_EXTENDED : INFO_LEN;
  const totalLen = infoLen + varintBytes.length + suffix.length + 1; // +1 for null

  const buffer = new Uint8Array(totalLen);
  const view = new DataView(buffer.buffer);

  writeEntryHeader(view, 0, entry, pathBytes.length, hasExtended);
  buffer.set(objectIdToBytes(entry.objectId), P_OBJECTID);

  let offset = infoLen;
  buffer.set(varintBytes, offset);
  offset += varintBytes.length;
  buffer.set(suffix, offset);
  // Last byte is already 0 (null terminator)

  return buffer;
}

/**
 * The seconds and nanoseconds to record for a time of `ms` milliseconds whose exact
 * nanoseconds within the second may be known (`ns`). A time in milliseconds is a double that
 * cannot hold nanoseconds at today's dates (about 244 ns of resolution), so `ms` can round
 * across a millisecond, or even a second (.999999931 reads as the next second). The exact
 * nanoseconds win whenever they are within a few milliseconds of `ms`, and the seconds are
 * taken from them; otherwise `ms` alone decides.
 */
function timeParts(ms: number, ns: number | undefined): void {
  const approx = (((ms % 1000) + 1000) % 1000) * 1e6;
  if (ns !== undefined && Number.isInteger(ns) && ns >= 0 && ns < 1e9) {
    const distance = Math.abs(approx - ns);
    if (Math.min(distance, 1e9 - distance) < 2e6) {
      timeSeconds = Math.round((ms - ns / 1e6) / 1000);
      timeNanos = ns;
      return;
    }
  }
  timeSeconds = Math.floor(ms / 1000);
  timeNanos = Math.min(999_999_999, Math.max(0, Math.floor(approx)));
}

/** What the last {@link timeParts} gave (no array per call). */
let timeSeconds = 0;
let timeNanos = 0;

/**
 * Write entry header (62 or 64 bytes).
 */
function writeEntryHeader(
  view: DataView,
  at: number,
  entry: StagingEntry,
  pathLength: number,
  hasExtended: boolean,
): void {
  // ctime, mtime: seconds and nanoseconds (the exact nanoseconds when known, see timeParts)
  const ctime = entry.ctime ?? entry.mtime;
  const ctimeNs = entry.ctime === undefined ? entry.mtimeNs : entry.ctimeNs;
  timeParts(ctime, ctimeNs);
  view.setUint32(at + P_CTIME, timeSeconds);
  view.setUint32(at + P_CTIME + 4, timeNanos);
  timeParts(entry.mtime, entry.mtimeNs);
  view.setUint32(at + P_MTIME, timeSeconds);
  view.setUint32(at + P_MTIME + 4, timeNanos);

  view.setUint32(at + P_DEV, entry.dev ?? 0);
  view.setUint32(at + P_INO, entry.ino ?? 0);
  view.setUint32(at + P_MODE, entry.mode);
  view.setUint32(at + P_UID, (entry.uid ?? 0) >>> 0);
  view.setUint32(at + P_GID, (entry.gid ?? 0) >>> 0);
  view.setUint32(at + P_SIZE, entry.size);

  // flags (the object id is written by the caller)
  const nameLen = Math.min(pathLength, NAME_MASK);
  let flags = (entry.stage << 12) | nameLen;
  if (hasExtended) flags |= EXTENDED;
  if (entry.assumeValid) flags |= ASSUME_VALID;
  view.setUint16(at + P_FLAGS, flags);

  // extended flags
  if (hasExtended) {
    let extFlags = 0;
    if (entry.intentToAdd) extFlags |= INTENT_TO_ADD >>> 16;
    if (entry.skipWorktree) extFlags |= SKIP_WORKTREE >>> 16;
    view.setUint16(at + P_FLAGS2, extFlags);
  }
}

/**
 * Read a varint from data.
 */
function readVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;

  let b = data[offset + bytesRead];
  bytesRead++;
  value = b & 0x7f;

  while ((b & 0x80) !== 0) {
    value++;
    b = data[offset + bytesRead];
    bytesRead++;
    value = (value << 7) | (b & 0x7f);
  }

  return { value, bytesRead };
}

/**
 * Encode a number as varint.
 */
function encodeVarint(value: number): Uint8Array {
  if (value < 0) {
    throw new Error("Varint value must be non-negative");
  }

  const bytes: number[] = [];
  bytes.push(value & 0x7f);
  value >>>= 7;

  while (value > 0) {
    value--;
    bytes.unshift(0x80 | (value & 0x7f));
    value >>>= 7;
  }

  return new Uint8Array(bytes);
}

/**
 * Read null-terminated string from data.
 */
function readNullTerminated(
  data: Uint8Array,
  offset: number,
): { value: string; bytes: Uint8Array; nextOffset: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0) {
    end++;
  }

  const bytes = data.subarray(offset, end);
  const value = decodeGitPath(bytes);

  return { value, bytes, nextOffset: end + 1 }; // +1 to skip null
}

/**
 * Validate path for index entry.
 */
function validatePath(path: string): void {
  if (validAsciiPath(path)) return;
  if (!path) {
    throw new Error("Empty path");
  }
  if (path.startsWith("/")) {
    throw new Error(`Invalid path: ${path} (starts with /)`);
  }
  if (path.endsWith("/")) {
    throw new Error(`Invalid path: ${path} (ends with /)`);
  }
  if (path.includes("//")) {
    throw new Error(`Invalid path: ${path} (contains //)`);
  }
  if (path.includes("\0")) {
    throw new Error(`Invalid path: ${path} (contains null)`);
  }
  // only the strings `decodeGitPath` makes stand for bytes (see `validateEntryName` in trees)
  if (hasEscapedBytes(path) && decodeGitPath(encodeGitPath(path)) !== path) {
    throw new Error(`Invalid path: ${JSON.stringify(path)} (lone surrogate)`);
  }

  // Check for .git in path components
  const components = path.split("/");
  for (const comp of components) {
    if (foldAsciiCase(comp) === ".git") {
      throw new Error(`Invalid path: ${path} (contains .git)`);
    }
  }
}

/**
 * The common case of {@link validatePath} in one pass: an ASCII path without an empty
 * component, a NUL or a `.git` component (any case). False sends the path to the full check
 * (which then names what is wrong).
 */
function validAsciiPath(path: string): boolean {
  const n = path.length;
  let start = 0;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? path.charCodeAt(i) : 0x2f;
    if (c === 0x2f) {
      const len = i - start;
      if (len === 0) return false;
      if (
        len === 4 &&
        path.charCodeAt(start) === 0x2e &&
        (path.charCodeAt(start + 1) | 0x20) === 0x67 &&
        (path.charCodeAt(start + 2) | 0x20) === 0x69 &&
        (path.charCodeAt(start + 3) | 0x20) === 0x74
      ) {
        return false;
      }
      start = i + 1;
    } else if (c === 0 || c > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Compare two byte arrays for equality.
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Concatenate byte arrays.
 */
function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
