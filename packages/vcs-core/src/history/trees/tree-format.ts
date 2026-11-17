/**
 * Git tree object format serialization and parsing
 *
 * Tree format: sequence of entries, each entry is:
 *   mode SP name NUL sha1
 *
 * Where:
 * - mode is octal digits (no leading zeros except for trees which use 40000)
 * - SP is a space (0x20)
 * - name is the file name's bytes (UTF-8 as a rule, but any bytes: `decodeGitPath` keeps
 *   the ones that are no valid UTF-8, `encodeGitPath` writes them back)
 * - NUL is null byte (0x00)
 * - sha1 is 20 raw bytes
 */

import { decodeGitPath, encodeGitPath, hasEscapedBytes } from "@statewalker/vcs-utils/encoding";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { collect, encodeString, toArray } from "@statewalker/vcs-utils/streams";
import { FileMode } from "../../common/files/index.js";
import { GitFormat } from "../../common/id/object-id.js";
import { objectIdToBytes } from "../objects/index.js";
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
  const str = new TextDecoder().decode(bytes);
  return parseInt(str, 8);
}

/**
 * Check if mode represents a tree (directory)
 */
function isTreeMode(mode: number): boolean {
  return (mode & 0o170000) === FileMode.TREE;
}

/**
 * Compare tree entries in git's canonical tree order.
 *
 * ```typescript
 * // a file "a-" sorts before a tree "a" (compared as "a/"), a file "a" before both
 * [{ name: "a", mode: 0o40000 }, { name: "a-", mode: 0o100644 }].sort(compareTreeEntries);
 * ```
 *
 * Git's `base_name_compare` (tree.c): names compare as UTF-8 bytes, and the byte after the
 * shorter name is `/` for a tree and NUL for anything else. So a tree compares as its name
 * plus "/", and a tree and a file of the same name are never equal.
 */
export function compareTreeEntries(
  a: Pick<TreeEntry, "name" | "mode">,
  b: Pick<TreeEntry, "name" | "mode">,
): number {
  return compareTreeEntryNames(
    encodeGitPath(a.name),
    isTreeMode(a.mode),
    encodeGitPath(b.name),
    isTreeMode(b.mode),
  );
}

/** `compareTreeEntries` over names already encoded as UTF-8: git's `base_name_compare`. */
export function compareTreeEntryNames(
  aBytes: Uint8Array,
  aIsTree: boolean,
  bBytes: Uint8Array,
  bIsTree: boolean,
): number {
  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    const diff = aBytes[i] - bBytes[i];
    if (diff !== 0) return diff;
  }
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
  // only the strings `decodeGitPath` makes stand for bytes; any other lone surrogate would
  // encode to the same bytes as another name (two entries of one name in a tree)
  if (hasEscapedBytes(name) && decodeGitPath(encodeGitPath(name)) !== name) {
    throw new Error("Tree entry name holds a lone surrogate that stands for no byte");
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
  // Collect and sort entries (each name encoded once)
  const collected: { entry: TreeEntry; name: Uint8Array; tree: boolean }[] = [];
  for await (const entry of entries) {
    validateEntryName(entry.name);
    collected.push({ entry, name: encodeGitPath(entry.name), tree: isTreeMode(entry.mode) });
  }
  collected.sort((a, b) => compareTreeEntryNames(a.name, a.tree, b.name, b.tree));

  const parts: { mode: Uint8Array; name: Uint8Array; id: Uint8Array }[] = [];
  let size = 0;
  for (const { entry, name } of collected) {
    const mode = encodeMode(entry.mode);
    const id = objectIdToBytes(entry.id);
    parts.push({ mode, name, id });
    size += mode.length + 1 + name.length + 1 + OBJECT_ID_LENGTH;
  }
  // Build entries: mode SP name NUL sha1
  const out = new Uint8Array(size);
  let offset = 0;
  for (const { mode, name, id } of parts) {
    out.set(mode, offset);
    offset += mode.length;
    out[offset++] = SPACE;
    out.set(name, offset);
    offset += name.length;
    out[offset++] = NULL;
    out.set(id, offset);
    offset += OBJECT_ID_LENGTH;
  }
  if (size > 0) yield out;
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

  for await (const entry of entries) {
    const mode = encodeMode(entry.mode);
    const name = encodeGitPath(entry.name);
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
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    size += chunk.length;
  }
  let buffer: Uint8Array;
  if (chunks.length === 1) buffer = chunks[0];
  else {
    buffer = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, at);
      at += chunk.length;
    }
  }
  yield* decodeTreeBytes(buffer);
}

/**
 * Decode a whole tree's bytes (without header) at once.
 *
 * @param buffer Serialized tree content
 * @returns Tree entries in stored order
 */
export function decodeTreeBytes(buffer: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const spacePos = buffer.indexOf(SPACE, offset);
    if (spacePos < 0) break;
    const nullPos = buffer.indexOf(NULL, spacePos + 1);
    if (nullPos < 0 || nullPos + 1 + OBJECT_ID_LENGTH > buffer.length) break;
    const mode = parseModeAt(buffer, offset, spacePos);
    const name = decodeGitPath(buffer.subarray(spacePos + 1, nullPos));
    // A decoded tree may come from a remote. Its names become worktree paths, and
    // the FilesApi resolves `..` (webrun-files 0.12), so refuse what git fsck refuses.
    validateEntryName(name);
    const id = bytesToHex(buffer.subarray(nullPos + 1, nullPos + 1 + OBJECT_ID_LENGTH));
    out.push({ mode, name, id });
    offset = nullPos + 1 + OBJECT_ID_LENGTH;
  }
  if (offset < buffer.length) {
    throw new Error("Invalid tree format: truncated entry");
  }
  return out;
}

/** The octal mode in `buffer[start, end)`, as parseInt(text, 8) reads it. */
function parseModeAt(buffer: Uint8Array, start: number, end: number): number {
  let mode = 0;
  for (let i = start; i < end; i++) {
    const digit = buffer[i] - 0x30;
    if (digit < 0 || digit > 7) return parseMode(buffer.subarray(start, end));
    mode = mode * 8 + digit;
  }
  return end > start ? mode : Number.NaN;
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
  const sorted = [...entries].sort(compareTreeEntries);

  // Calculate total size
  let totalSize = 0;
  const encodedEntries: {
    mode: Uint8Array;
    name: Uint8Array;
    id: Uint8Array;
  }[] = [];

  for (const entry of sorted) {
    const mode = encodeMode(entry.mode);
    const name = encodeGitPath(entry.name);
    const id = objectIdToBytes(entry.id);

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

    const name = decodeGitPath(data.subarray(offset, nullPos));
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
