/**
 * Helpers the listing plumbing commands share (`ls-files`, `ls-tree`, `cat-file`, pathspec
 * parsing), and tree-walk.c's `tree_desc` over a tree's stored bytes: git's readers walk a
 * tree entry by entry and die on the first one that cannot be decoded, after showing what
 * came before it.
 */

import { canonTreeMode, type ObjectId, type TreeEntry } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../errors/index.js";

/** ctype.c's GIT_PATHSPEC_MAGIC characters (and `/`, `^`): those that may start short magic */
export const SHORT_MAGIC = new Set([..."!\"#%&',-;<=>@_`~^/"]);

/** object_type of a tree or index mode. */
export function objectTypeOfMode(mode: number): "tree" | "commit" | "blob" {
  const kind = mode & 0o170000;
  if (kind === 0o040000) return "tree";
  if (kind === 0o160000) return "commit";
  return "blob";
}

/** The chunks joined (the chunk itself when there is one). */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Everything a byte stream yields, joined. */
export async function readAllBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of content) chunks.push(c);
  return chunks.length === 0 ? new Uint8Array(0) : concatBytes(chunks);
}

/**
 * git's death on a tree it cannot decode (tree-walk.c's `decode_tree_entry` and
 * `update_tree_entry`): `fatal: too-short tree object`, `fatal: malformed mode in tree entry`,
 * `fatal: empty filename in tree entry`, `fatal: too-short tree file`; exit 128.
 */
export class CorruptTreeError extends GitApiError {
  constructor(
    /** git's message, without `fatal: ` */
    readonly reason: string,
    /** the tree that could not be decoded */
    readonly treeId?: ObjectId,
  ) {
    super(`fatal: ${reason}`, { exitCode: 128 });
    this.name = "CorruptTreeError";
  }
}

const SPACE = 0x20;

/** An entry of a tree's stored bytes: its canonical mode, name at `[nameStart, nameEnd)`. */
interface TreeDescEntry {
  mode: number;
  nameStart: number;
  nameEnd: number;
}

/**
 * tree-walk.c's `tree_desc` over a tree's stored bytes, as git's readers (`read_tree_at`,
 * `ls-tree`, `cat-file -p`) walk it: each entry is yielded only once the one after it was
 * decoded (`tree_entry` advances before its caller looks at the entry it got), so a walk over
 * a tree whose third entry is corrupt sees the first and dies with {@link CorruptTreeError}
 * asking for the second. Names are not checked (git's readers list `..`), modes are
 * canonical (`canon_mode`).
 *
 * @example
 * ```typescript
 * for (const entry of walkTreeDesc(raw, 20)) console.log(entry.name);
 * ```
 *
 * @param raw the tree's stored content
 * @param rawLength the id width of the repository's hash (20 or 32)
 * @param treeId the tree, carried by the error
 * @throws CorruptTreeError where git dies
 */
export function* walkTreeDesc(
  raw: Uint8Array,
  rawLength: number,
  treeId?: ObjectId,
): Generator<TreeEntry> {
  for (const e of treeDesc(raw, rawLength, treeId)) {
    yield {
      mode: e.mode,
      name: decodeGitPath(raw.subarray(e.nameStart, e.nameEnd)),
      id: bytesToHex(raw.subarray(e.nameEnd + 1, e.nameEnd + 1 + rawLength)),
    };
  }
}

/**
 * tree-walk.c's `find_tree_entry`: the entry a path (bytes, not empty) names in a tree's
 * stored bytes, each entry compared with the whole path as git compares it (an entry that
 * matches a leading part followed by `/` is entered, one sorting after the path ends the
 * walk), each looked at once the next one decoded (a corrupt entry right after the one
 * found is still git's death). `rest` is the path left to look up in the subtree `id`
 * (`get_tree_entry`'s recursion); none when the entry itself was found (`d/` names `d`).
 *
 * @example
 * ```typescript
 * findTreeDescEntry(raw, 20, encodeGitPath("src/main.ts")); // { id, mode, rest: "main.ts" }
 * ```
 *
 * @throws CorruptTreeError where git dies
 */
export function findTreeDescEntry(
  raw: Uint8Array,
  rawLength: number,
  name: Uint8Array,
  treeId?: ObjectId,
): { id: ObjectId; mode: number; rest?: Uint8Array } | undefined {
  const namelen = name.length;
  for (const e of treeDesc(raw, rawLength, treeId)) {
    const entrylen = e.nameEnd - e.nameStart;
    if (entrylen > namelen) continue;
    let cmp = 0;
    for (let i = 0; i < entrylen && cmp === 0; i++) {
      cmp = (name[i] as number) - (raw[e.nameStart + i] as number);
    }
    if (cmp > 0) continue;
    if (cmp < 0) break;
    const id = () => bytesToHex(raw.subarray(e.nameEnd + 1, e.nameEnd + 1 + rawLength));
    if (entrylen === namelen) return { id: id(), mode: e.mode };
    if (name[entrylen] !== 0x2f) continue;
    if ((e.mode & 0o170000) !== 0o040000) break;
    if (entrylen + 1 === namelen) return { id: id(), mode: e.mode };
    return { id: id(), mode: e.mode, rest: name.subarray(entrylen + 1) };
  }
  return undefined;
}

/** The walk of {@link walkTreeDesc}, entries by position. */
function* treeDesc(
  raw: Uint8Array,
  rawLength: number,
  treeId: ObjectId | undefined,
): Generator<TreeDescEntry> {
  const end = raw.length;
  let at = 0;
  if (at >= end) return;
  // init_tree_desc decodes the first entry
  let current = decodeTreeEntry(raw, at, end, rawLength, treeId);
  for (;;) {
    // update_tree_entry: past the entry held, then the next one decoded
    const len = current.nameEnd + 1 - at + rawLength;
    if (end - at < len) throw new CorruptTreeError("too-short tree file", treeId);
    at += len;
    const held = current;
    if (at >= end) {
      yield held;
      return;
    }
    current = decodeTreeEntry(raw, at, end, rawLength, treeId);
    yield held;
  }
}

/** decode_tree_entry: the entry at `at`. */
function decodeTreeEntry(
  raw: Uint8Array,
  at: number,
  end: number,
  rawLength: number,
  treeId: ObjectId | undefined,
): TreeDescEntry {
  const size = end - at;
  if (size < rawLength + 3 || raw[end - (rawLength + 1)] !== 0) {
    throw new CorruptTreeError("too-short tree object", treeId);
  }
  // get_mode: octal digits up to a space; none, or another character, is malformed
  let i = at;
  let mode = 0;
  if (raw[i] === SPACE) throw new CorruptTreeError("malformed mode in tree entry", treeId);
  for (;;) {
    const c = raw[i++] as number;
    if (c === SPACE) break;
    if (c < 0x30 || c > 0x37) throw new CorruptTreeError("malformed mode in tree entry", treeId);
    mode = mode * 8 + (c - 0x30);
  }
  // the name ends at a NUL, which the check above puts at least an id before the end
  const nameEnd = raw.indexOf(0, i);
  if (nameEnd === i) throw new CorruptTreeError("empty filename in tree entry", treeId);
  return { mode: canonTreeMode(mode), nameStart: i, nameEnd };
}
