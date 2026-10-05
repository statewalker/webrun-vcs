import { bytesToHex, hexToBytes, sha1 } from "@statewalker/vcs-utils";
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
export async function parseIndexFile(data: Uint8Array): Promise<ParsedIndex> {
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

  for (let i = 0; i < entryCount; i++) {
    const { entry, nextOffset } = parseEntry(data, view, offset, version, previousPath);
    entries.push(entry);
    previousPath = entry.path;
    offset = nextOffset;
  }

  return { version, entries };
}

/**
 * Parse a single index entry.
 */
function parseEntry(
  data: Uint8Array,
  view: DataView,
  offset: number,
  version: IndexVersion,
  previousPath: string,
): { entry: StagingEntry; nextOffset: number } {
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

  // UID and GID (skip - not used)
  offset += 8;

  // Size
  const size = view.getUint32(offset);
  offset += 4;

  // Object ID (20 bytes SHA-1)
  const objectId = bytesToHex(data.subarray(offset, offset + 20));
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
    const { value: suffix, nextOffset: pathEnd } = readNullTerminated(data, offset);
    offset = pathEnd;

    // Reconstruct path: prefix from previous + suffix
    const prefixLen = previousPath.length - toRemove;
    if (prefixLen < 0) {
      throw new Error(
        `Invalid path compression: removing ${toRemove} from ${previousPath.length} bytes`,
      );
    }
    path = previousPath.substring(0, prefixLen) + suffix;
  } else {
    // Version 2/3: uncompressed path
    if (nameLength === NAME_MASK) {
      // Long path (>= 0xfff bytes)
      const { value: pathStr, nextOffset: pathEnd } = readNullTerminated(data, offset);
      path = pathStr;
      offset = pathEnd;
    } else {
      // Short path
      const pathBytes = data.subarray(offset, offset + nameLength);
      path = new TextDecoder().decode(pathBytes);
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

  // Validate path
  validatePath(path);

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
    assumeValid,
    intentToAdd,
    skipWorktree,
  };

  return { entry, nextOffset: offset };
}

/**
 * Serialize entries to Git index format.
 *
 * Entries are validated and sorted by (path, stage) before serialization.
 *
 * @param entries Entries to serialize (will be sorted)
 * @param version Index version (default: 2)
 * @returns Serialized index file bytes
 */
export async function serializeIndexFile(
  entries: StagingEntry[],
  version: IndexVersion = INDEX_VERSION_2,
): Promise<Uint8Array> {
  // Validate all paths first
  for (const entry of entries) {
    validatePath(entry.path);
  }

  // Sort entries by (path, stage)
  const sortedEntries = [...entries].sort((a, b) => {
    const pathCmp = comparePaths(a.path, b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.stage - b.stage;
  });

  const chunks: Uint8Array[] = [];

  // Header
  const header = new Uint8Array(HEADER_SIZE);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, INDEX_SIGNATURE);
  headerView.setUint32(4, version);
  headerView.setUint32(8, sortedEntries.length);
  chunks.push(header);

  // Entries
  let previousPath = "";
  for (const entry of sortedEntries) {
    const entryBytes = serializeEntry(entry, version, previousPath);
    chunks.push(entryBytes);
    previousPath = entry.path;
  }

  // Combine without checksum
  const withoutChecksum = concatBytes(chunks);

  // Compute and append checksum
  const checksum = await sha1(withoutChecksum);

  return concatBytes([withoutChecksum, checksum]);
}

/**
 * Compare paths using Git's canonical ordering.
 */
function comparePaths(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  const minLen = Math.min(aLen, bLen);

  for (let i = 0; i < minLen; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }

  return aLen - bLen;
}

/**
 * Serialize a single index entry.
 */
function serializeEntry(
  entry: StagingEntry,
  version: IndexVersion,
  previousPath: string,
): Uint8Array {
  const pathBytes = new TextEncoder().encode(entry.path);
  const hasExtended = entry.intentToAdd || entry.skipWorktree || version === INDEX_VERSION_3;

  if (version === INDEX_VERSION_4) {
    // Version 4: path compression
    return serializeEntryV4(entry, pathBytes, previousPath, hasExtended);
  }

  // Version 2/3: uncompressed
  const infoLen = hasExtended ? INFO_LEN_EXTENDED : INFO_LEN;
  const baseLen = infoLen + pathBytes.length + 1; // +1 for null terminator
  const alignedLen = (baseLen + 7) & ~7;
  const _padding = alignedLen - baseLen;

  const buffer = new Uint8Array(alignedLen);
  const view = new DataView(buffer.buffer);

  writeEntryHeader(view, entry, pathBytes.length, hasExtended);

  // Path + null terminator
  buffer.set(pathBytes, infoLen);
  // Remaining bytes are already 0 (null terminator + padding)

  return buffer;
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
  const prevBytes = new TextEncoder().encode(previousPath);
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

  writeEntryHeader(view, entry, pathBytes.length, hasExtended);

  let offset = infoLen;
  buffer.set(varintBytes, offset);
  offset += varintBytes.length;
  buffer.set(suffix, offset);
  // Last byte is already 0 (null terminator)

  return buffer;
}

/**
 * Write entry header (62 or 64 bytes).
 */
function writeEntryHeader(
  view: DataView,
  entry: StagingEntry,
  pathLength: number,
  hasExtended: boolean,
): void {
  // ctime
  const ctime = entry.ctime ?? entry.mtime;
  view.setUint32(P_CTIME, Math.floor(ctime / 1000));
  view.setUint32(P_CTIME + 4, (ctime % 1000) * 1_000_000);

  // mtime
  view.setUint32(P_MTIME, Math.floor(entry.mtime / 1000));
  view.setUint32(P_MTIME + 4, (entry.mtime % 1000) * 1_000_000);

  // dev, ino
  view.setUint32(P_DEV, entry.dev ?? 0);
  view.setUint32(P_INO, entry.ino ?? 0);

  // mode
  view.setUint32(P_MODE, entry.mode);

  // uid, gid (zeros)
  view.setUint32(P_UID, 0);
  view.setUint32(P_GID, 0);

  // size
  view.setUint32(P_SIZE, entry.size);

  // object ID (20 bytes)
  const oidBytes = hexToBytes(entry.objectId);
  const buffer = new Uint8Array(view.buffer, view.byteOffset);
  buffer.set(oidBytes, P_OBJECTID);

  // flags
  const nameLen = Math.min(pathLength, NAME_MASK);
  let flags = (entry.stage << 12) | nameLen;
  if (hasExtended) {
    flags |= EXTENDED;
  }
  if (entry.assumeValid) {
    flags |= ASSUME_VALID;
  }
  view.setUint16(P_FLAGS, flags);

  // extended flags
  if (hasExtended) {
    let extFlags = 0;
    if (entry.intentToAdd) {
      extFlags |= INTENT_TO_ADD >>> 16;
    }
    if (entry.skipWorktree) {
      extFlags |= SKIP_WORKTREE >>> 16;
    }
    view.setUint16(P_FLAGS2, extFlags);
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
): { value: string; nextOffset: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0) {
    end++;
  }

  const bytes = data.subarray(offset, end);
  const value = new TextDecoder().decode(bytes);

  return { value, nextOffset: end + 1 }; // +1 to skip null
}

/**
 * Validate path for index entry.
 */
function validatePath(path: string): void {
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

  // Check for .git in path components
  const components = path.split("/");
  for (const comp of components) {
    if (comp.toLowerCase() === ".git") {
      throw new Error(`Invalid path: ${path} (contains .git)`);
    }
  }
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
