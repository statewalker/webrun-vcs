/**
 * Git tree object format serialization and parsing
 *
 * Tree format: sequence of entries, each entry is:
 *   mode SP name NUL sha1
 *
 * Where:
 * - mode is octal digits (no leading zeros except for trees which use 40000)
 * - SP is a space (0x20)
 * - name is UTF-8 encoded filename
 * - NUL is null byte (0x00)
 * - sha1 is 20 raw bytes
 */

import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { collect, concat, encodeString, toArray } from "@statewalker/vcs-utils/streams";
import { FileMode } from "../../common/files/index.js";
import { GitFormat } from "../../common/id/object-id.js";
import type { TreeEntry } from "./tree-entry.js";

const SPACE = 0x20;
const NULL = 0x00;
const OBJECT_ID_LENGTH = GitFormat.OBJECT_ID_LENGTH; // 20 bytes

/**
 * Encode file mode as octal ASCII bytes (no leading zeros)
 *
 * Git stores mode as octal digits without leading zeros,
 * except directories which are stored as "40000".
 */
function encodeMode(mode: number): Uint8Array {
  const octal = mode.toString(8);
  return encodeString(octal);
}

/**
 * Parse file mode from octal ASCII bytes
 */
function parseMode(bytes: Uint8Array): number {
  const decoder = new TextDecoder();
  const str = decoder.decode(bytes);
  return parseInt(str, 8);
}

/**
 * Check if mode represents a tree (directory)
 */
function isTreeMode(mode: number): boolean {
  return (mode & 0o170000) === FileMode.TREE;
}

/**
 * Compare tree entries for canonical sorting (internal use)
 *
 * Git sorts tree entries by name, treating directories as if
 * they have a trailing slash for comparison purposes.
 *
 * Note: Use compareTreeEntries from interfaces/utils for public API.
 */
function compareTreeEntriesInternal(a: TreeEntry, b: TreeEntry): number {
  const aName = a.name;
  const bName = b.name;
  const aIsTree = isTreeMode(a.mode);
  const bIsTree = isTreeMode(b.mode);

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(aName);
  const bBytes = encoder.encode(bName);

  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    const diff = aBytes[i] - bBytes[i];
    if (diff !== 0) return diff;
  }

  // If we get here, one is a prefix of the other
  // Trees are compared as if they have trailing '/'
  const aLen = aIsTree ? aBytes.length + 1 : aBytes.length;
  const bLen = bIsTree ? bBytes.length + 1 : bBytes.length;

  if (aLen === bLen) return 0;

  // Compare the character at the shorter length position
  const aChar = aBytes.length > len ? aBytes[len] : aIsTree ? 0x2f /* '/' */ : 0;
  const bChar = bBytes.length > len ? bBytes[len] : bIsTree ? 0x2f /* '/' */ : 0;

  return aChar - bChar;
}

/**
 * Validate tree entry name
 *
 * @param name Entry name to validate
 * @throws Error if name is invalid
 */
function validateEntryName(name: string): void {
  if (name === "") {
    throw new Error("Tree entry name cannot be empty");
  }
  if (name === "." || name === "..") {
    throw new Error(`Tree entry name cannot be '${name}'`);
  }
  if (name.includes("/")) {
    throw new Error("Tree entry name cannot contain '/'");
  }
  if (name.includes("\0")) {
    throw new Error("Tree entry name cannot contain null bytes");
  }
}

/**
 * Encode tree entries to byte stream
 *
 * Accepts both sync and async iterables. Entries will be sorted
 * in canonical Git order before encoding.
 *
 * @param entries Tree entries (any order)
 * @yields Byte chunks of serialized tree
 */
export async function* encodeTreeEntries(
  entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>,
): AsyncGenerator<Uint8Array> {
  // Collect and sort entries
  const collected: TreeEntry[] = [];
  for await (const entry of entries) {
    validateEntryName(entry.name);
    collected.push(entry);
  }

  const sorted = collected.sort(compareTreeEntriesInternal);

  // Encode each entry
  const encoder = new TextEncoder();
  for (const entry of sorted) {
    const mode = encodeMode(entry.mode);
    const name = encoder.encode(entry.name);
    const id = hexToBytes(entry.id);

    if (id.length !== OBJECT_ID_LENGTH) {
      throw new Error(`Invalid object ID length: ${entry.id}`);
    }

    // Build entry: mode SP name NUL sha1
    const entryBytes = new Uint8Array(mode.length + 1 + name.length + 1 + OBJECT_ID_LENGTH);
    let offset = 0;

    entryBytes.set(mode, offset);
    offset += mode.length;

    entryBytes[offset] = SPACE;
    offset += 1;

    entryBytes.set(name, offset);
    offset += name.length;

    entryBytes[offset] = NULL;
    offset += 1;

    entryBytes.set(id, offset);

    yield entryBytes;
  }
}

/**
 * Compute serialized tree size without creating buffer
 *
 * @param entries Tree entries (will be iterated)
 * @returns Size in bytes
 */
export async function computeTreeSize(
  entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>,
): Promise<number> {
  let size = 0;
  const encoder = new TextEncoder();

  for await (const entry of entries) {
    const mode = encodeMode(entry.mode);
    const name = encoder.encode(entry.name);
    size += mode.length + 1 + name.length + 1 + OBJECT_ID_LENGTH;
  }

  return size;
}

/**
 * Decode tree entries from byte stream
 *
 * @param input Async byte stream (without header)
 * @yields Tree entries in stored order
 */
export async function* decodeTreeEntries(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<TreeEntry> {
  let buffer = new Uint8Array(0);

  for await (const chunk of input) {
    buffer = concat(buffer, chunk);

    // Parse entries from buffer
    let offset = 0;

    while (offset < buffer.length) {
      // Find space after mode
      let spacePos = offset;
      while (spacePos < buffer.length && buffer[spacePos] !== SPACE) {
        spacePos++;
      }

      if (spacePos >= buffer.length) {
        // Need more data
        break;
      }

      // Find null after name
      let nullPos = spacePos + 1;
      while (nullPos < buffer.length && buffer[nullPos] !== NULL) {
        nullPos++;
      }

      if (nullPos >= buffer.length) {
        // Need more data
        break;
      }

      // Check if we have complete SHA-1
      if (nullPos + 1 + OBJECT_ID_LENGTH > buffer.length) {
        // Need more data
        break;
      }

      // Parse entry
      const mode = parseMode(buffer.subarray(offset, spacePos));
      const decoder = new TextDecoder();
      const name = decoder.decode(buffer.subarray(spacePos + 1, nullPos));
      const id = bytesToHex(buffer.subarray(nullPos + 1, nullPos + 1 + OBJECT_ID_LENGTH));

      yield { mode, name, id };

      offset = nullPos + 1 + OBJECT_ID_LENGTH;
    }

    // Keep unparsed data
    if (offset > 0) {
      buffer = buffer.slice(offset);
    }
  }

  // Check for leftover data
  if (buffer.length > 0) {
    throw new Error("Invalid tree format: truncated entry");
  }
}

/**
 * Serialize tree entries to bytes via streaming internals
 *
 * @param entries Tree entries (any order, will be sorted)
 * @returns Serialized tree content (without header)
 */
export async function collectTreeBytes(
  entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>,
): Promise<Uint8Array> {
  return collect(encodeTreeEntries(entries));
}

/**
 * Parse tree entries from bytes via streaming internals
 *
 * @param data Serialized tree content (without header)
 * @returns Array of tree entries
 */
export async function parseTreeFromBytes(data: Uint8Array): Promise<TreeEntry[]> {
  return toArray(decodeTreeEntries([data]));
}

/**
 * Serialize tree entries to Git tree format (buffer-based)
 *
 * @param entries Tree entries (will be sorted)
 * @returns Serialized tree content (without header)
 * @deprecated Use collectTreeBytes or encodeTreeEntries
 */
export function serializeTree(entries: TreeEntry[]): Uint8Array {
  // Validate all entry names first
  for (const entry of entries) {
    validateEntryName(entry.name);
  }

  // Sort entries in canonical order
  const sorted = [...entries].sort(compareTreeEntriesInternal);

  // Calculate total size
  const encoder = new TextEncoder();
  let totalSize = 0;
  const encodedEntries: {
    mode: Uint8Array;
    name: Uint8Array;
    id: Uint8Array;
  }[] = [];

  for (const entry of sorted) {
    const mode = encodeMode(entry.mode);
    const name = encoder.encode(entry.name);
    const id = hexToBytes(entry.id);

    if (id.length !== OBJECT_ID_LENGTH) {
      throw new Error(`Invalid object ID length: ${entry.id}`);
    }

    encodedEntries.push({ mode, name, id });
    totalSize += mode.length + 1 + name.length + 1 + OBJECT_ID_LENGTH;
  }

  // Build result
  const result = new Uint8Array(totalSize);
  let offset = 0;

  for (const { mode, name, id } of encodedEntries) {
    result.set(mode, offset);
    offset += mode.length;

    result[offset] = SPACE;
    offset += 1;

    result.set(name, offset);
    offset += name.length;

    result[offset] = NULL;
    offset += 1;

    result.set(id, offset);
    offset += OBJECT_ID_LENGTH;
  }

  return result;
}

/**
 * Parse tree entries from Git tree format (generator)
 *
 * @param data Serialized tree content (without header)
 * @yields Tree entries in order
 */
export function* parseTree(data: Uint8Array): Generator<TreeEntry> {
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset < data.length) {
    // Find space after mode
    let spacePos = offset;
    while (spacePos < data.length && data[spacePos] !== SPACE) {
      spacePos++;
    }

    if (spacePos >= data.length) {
      throw new Error("Invalid tree format: no space after mode");
    }

    const mode = parseMode(data.subarray(offset, spacePos));
    offset = spacePos + 1;

    // Find null after name
    let nullPos = offset;
    while (nullPos < data.length && data[nullPos] !== NULL) {
      nullPos++;
    }

    if (nullPos >= data.length) {
      throw new Error("Invalid tree format: no null after name");
    }

    const name = decoder.decode(data.subarray(offset, nullPos));
    offset = nullPos + 1;

    // Read object ID
    if (offset + OBJECT_ID_LENGTH > data.length) {
      throw new Error("Invalid tree format: truncated object ID");
    }

    const id = bytesToHex(data.subarray(offset, offset + OBJECT_ID_LENGTH));
    offset += OBJECT_ID_LENGTH;

    yield { mode, name, id };
  }
}

/**
 * Parse tree entries to array
 *
 * @param data Serialized tree content (without header)
 * @returns Array of tree entries
 */
export function parseTreeToArray(data: Uint8Array): TreeEntry[] {
  return Array.from(parseTree(data));
}

/**
 * Well-known empty tree SHA-1 hash
 */
export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
