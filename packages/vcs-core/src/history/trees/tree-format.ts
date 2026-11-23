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
/** Raw id bytes of SHA-1 trees (git's default object format); SHA-256 trees hold 32 */
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
 * Check if mode represents a tree (directory)
 */
function isTreeMode(mode: number): boolean {
  return (mode & 0o170000) === FileMode.TREE;
}

/**
 * A tree entry's mode as git's tree walks see it (`canon_mode`): a regular file is 100644 or
 * 100755 by its owner's execute bit, whatever other bits are stored (older git wrote 100664),
 * and a mode of no known type reads as a gitlink. Tree comparisons (diffs, history
 * simplification, changed-path filters) compare these.
 *
 * @example
 * ```typescript
 * canonTreeMode(0o100664); // 0o100644
 * canonTreeMode(0o100775); // 0o100755
 * ```
 */
export function canonTreeMode(mode: number): number {
  switch (mode & 0o170000) {
    case 0o100000:
      return mode & 0o100 ? 0o100755 : 0o100644;
    case 0o120000:
      return 0o120000;
    case 0o040000:
      return 0o040000;
    default:
      return 0o160000;
  }
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
 * @param idLength The raw id length of the repository's object format (20 for SHA-1, 32 for
 *   SHA-256): an entry id of another format is refused. Default: each id's own length.
 * @yields Byte chunks of serialized tree
 */
export async function* encodeTreeEntries(
  entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>,
  idLength?: number,
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
    const id = objectIdToBytes(entry.id, idLength);
    parts.push({ mode, name, id });
    size += mode.length + 1 + name.length + 1 + id.length;
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
    offset += id.length;
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
    // a hex id of either format: 40 (SHA-1, 20 raw bytes) or 64 (SHA-256, 32)
    size += mode.length + 1 + name.length + 1 + (entry.id.length >> 1 || OBJECT_ID_LENGTH);
  }

  return size;
}

/**
 * Decode tree entries from byte stream
 *
 * @param input Async byte stream (without header)
 * @param idLength Raw id bytes per entry: 20 (SHA-1, the default) or 32 (SHA-256)
 * @yields Tree entries in stored order
 */
export async function* decodeTreeEntries(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  idLength: number = OBJECT_ID_LENGTH,
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
  yield* decodeTreeBytes(buffer, { idLength });
}

/**
 * Decode a whole tree's bytes (without header) at once.
 *
 * Modes are as stored, unless `canonicalModes` asks for them as git's tree walks read
 * them ({@link canonTreeMode}): 100664 reads as 100644. Readers of a tree's entries (the
 * tree store's `load`/`entries`) read canonical modes; what must keep the stored bytes (a
 * tree re-encoded, fsck) reads the raw ones.
 *
 * @example
 * ```typescript
 * decodeTreeBytes(bytes)[0].mode; // 0o100664, as stored
 * decodeTreeBytes(bytes, { canonicalModes: true })[0].mode; // 0o100644
 * ```
 *
 * @param buffer Serialized tree content
 * @param options `canonicalModes`: modes as git's walks see them; `idLength`: raw id bytes
 *   per entry, 20 (SHA-1, the default) or 32 (a SHA-256 repository's trees)
 * @returns Tree entries in stored order
 */
export function decodeTreeBytes(
  buffer: Uint8Array,
  options?: { canonicalModes?: boolean; idLength?: number },
): TreeEntry[] {
  const canonical = options?.canonicalModes === true;
  const OBJECT_ID_LENGTH = options?.idLength ?? GitFormat.OBJECT_ID_LENGTH;
  let rewritten = false;
  const out: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const spacePos = buffer.indexOf(SPACE, offset);
    if (spacePos < 0) break;
    const nullPos = buffer.indexOf(NULL, spacePos + 1);
    if (nullPos < 0 || nullPos + 1 + OBJECT_ID_LENGTH > buffer.length) break;
    const stored = parseModeAt(buffer, offset, spacePos);
    const mode = canonical ? canonTreeMode(stored) : stored;
    // a mode read otherwise than written (100664, a zero-padded 040000)
    if (canonical && (mode !== stored || buffer[offset] === 0x30)) rewritten = true;
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
  if (rewritten) NON_CANONICAL.add(out);
  else if (canonical) DECODED_CANONICAL.add(out);
  return out;
}

/** Entry lists `decodeTreeBytes` read with canonical modes from a tree written so */
const DECODED_CANONICAL = new WeakSet<readonly TreeEntry[]>();

/** Entry lists `decodeTreeBytes` read with canonical modes from a tree written otherwise */
const NON_CANONICAL = new WeakSet<readonly TreeEntry[]>();

/**
 * Whether `entries`, as `decodeTreeBytes` read them with `canonicalModes` (the tree store's
 * `entries`), came from a tree whose modes were written otherwise (100664, a zero-padded
 * 040000): encoding them again makes another tree, as git's cache-tree computes it.
 * Undefined for a list it did not decode (unknown).
 *
 * @example
 * ```typescript
 * const entries = decodeTreeBytes(bytes, { canonicalModes: true });
 * treeModesRewritten(entries); // true for a tree that holds a 100664 blob
 * ```
 */
export function treeModesRewritten(entries: readonly TreeEntry[]): boolean | undefined {
  if (NON_CANONICAL.has(entries)) return true;
  return DECODED_CANONICAL.has(entries) ? false : undefined;
}

/**
 * The octal mode in `buffer[start, end)`. An empty mode or one with another character than an
 * octal digit is refused as git's `decode_tree_entry` refuses it (`get_mode`), so a reader
 * fails on such a tree as git dies on it ("malformed mode in tree entry"); fsck checks the
 * raw bytes itself.
 */
function parseModeAt(buffer: Uint8Array, start: number, end: number): number {
  if (end <= start) throw new Error("malformed mode in tree entry");
  let mode = 0;
  for (let i = start; i < end; i++) {
    const digit = buffer[i] - 0x30;
    if (digit < 0 || digit > 7) throw new Error("malformed mode in tree entry");
    mode = mode * 8 + digit;
  }
  return mode;
}

/**
 * A walk over a tree's stored bytes that decodes only what it is asked for, as git's
 * `tree_desc`: entries the same on both sides of a comparison are told apart from their
 * bytes (name, mode, id), without a string or an entry object made for them. A name is
 * decoded and checked as {@link decodeTreeBytes} does it.
 *
 * @example
 * ```typescript
 * for (const c = new TreeEntryCursor(bytes); !c.done; c.next()) {
 *   if (c.isTree) console.log(c.name(), c.id());
 * }
 * ```
 */
export class TreeEntryCursor {
  /** Whether the walk is past the last entry */
  done = false;
  /** The entry's mode as git's walks see it ({@link canonTreeMode}, not as stored) */
  mode = 0;
  private nameStart = 0;
  private nameEnd = 0;
  private end = 0;

  /**
   * @param bytes The tree's content
   * @param idLength Raw id bytes per entry: 20 (SHA-1, the default) or 32 (SHA-256)
   */
  constructor(
    readonly bytes: Uint8Array,
    readonly idLength: number = OBJECT_ID_LENGTH,
  ) {
    this.parse(0);
  }

  /** Moves to the next entry */
  next(): void {
    this.parse(this.end);
  }

  /** Whether the entry is a subtree */
  get isTree(): boolean {
    return (this.mode & 0o170000) === FileMode.TREE;
  }

  /** The entry's name, decoded and checked as `decodeTreeBytes` does */
  name(): string {
    const name = decodeGitPath(this.bytes.subarray(this.nameStart, this.nameEnd));
    validateEntryName(name);
    return name;
  }

  /** The entry's object id */
  id(): string {
    return bytesToHex(this.bytes.subarray(this.nameEnd + 1, this.end));
  }

  /** git's `base_name_compare` of this entry's name with `other`'s */
  compare(other: TreeEntryCursor): number {
    const a = this.bytes;
    const b = other.bytes;
    const as = this.nameStart;
    const bs = other.nameStart;
    const alen = this.nameEnd - as;
    const blen = other.nameEnd - bs;
    const len = alen < blen ? alen : blen;
    for (let i = 0; i < len; i++) {
      const diff = a[as + i] - b[bs + i];
      if (diff !== 0) return diff;
    }
    const ac = alen > len ? a[as + len] : this.isTree ? 0x2f : 0;
    const bc = blen > len ? b[bs + len] : other.isTree ? 0x2f : 0;
    return ac - bc;
  }

  /** Whether `other` (an entry of the same name) has this entry's mode (canonical) and id */
  sameAs(other: TreeEntryCursor): boolean {
    if (this.mode !== other.mode) return false;
    const a = this.bytes;
    const b = other.bytes;
    const ai = this.nameEnd + 1;
    const bi = other.nameEnd + 1;
    for (let k = 0, n = this.idLength; k < n; k++) if (a[ai + k] !== b[bi + k]) return false;
    return true;
  }

  private parse(offset: number): void {
    const buffer = this.bytes;
    if (offset >= buffer.length) {
      this.done = true;
      return;
    }
    const spacePos = buffer.indexOf(SPACE, offset);
    const nullPos = spacePos < 0 ? -1 : buffer.indexOf(NULL, spacePos + 1);
    if (nullPos < 0 || nullPos + 1 + this.idLength > buffer.length) {
      throw new Error("Invalid tree format: truncated entry");
    }
    this.mode = canonTreeMode(parseModeAt(buffer, offset, spacePos));
    this.nameStart = spacePos + 1;
    this.nameEnd = nullPos;
    this.end = nullPos + 1 + this.idLength;
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
  idLength?: number,
): Promise<Uint8Array> {
  return collect(encodeTreeEntries(entries, idLength));
}

/**
 * Parse tree entries from bytes via streaming internals
 *
 * @param data Serialized tree content (without header)
 * @returns Array of tree entries
 */
export async function parseTreeFromBytes(
  data: Uint8Array,
  idLength: number = OBJECT_ID_LENGTH,
): Promise<TreeEntry[]> {
  return toArray(decodeTreeEntries([data], idLength));
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
    totalSize += mode.length + 1 + name.length + 1 + id.length;
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
    offset += id.length;
  }

  return result;
}

/**
 * Parse tree entries from Git tree format (generator)
 *
 * @param data Serialized tree content (without header)
 * @yields Tree entries in order
 */
export function* parseTree(
  data: Uint8Array,
  idLength: number = OBJECT_ID_LENGTH,
): Generator<TreeEntry> {
  const OBJECT_ID_LENGTH = idLength;
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

    const mode = parseModeAt(data, offset, spacePos);
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
export function parseTreeToArray(
  data: Uint8Array,
  idLength: number = OBJECT_ID_LENGTH,
): TreeEntry[] {
  return Array.from(parseTree(data, idLength));
}

/**
 * Well-known empty tree SHA-1 hash (a SHA-256 repository's is
 * `SHA256_OBJECT_FORMAT.emptyTreeId`: see `ObjectFormat.emptyTreeId`)
 */
export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
