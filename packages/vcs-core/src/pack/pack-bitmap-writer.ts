/**
 * Writing a pack's reachability bitmap as git's pack-bitmap-write.c does, byte for byte:
 *
 *  - the type bitmaps, set in pack order (`bitmap_writer_build_type_index`);
 *  - the selected commits (`bitmap_writer_select_commits`): the commits sorted newest first by
 *    committer date; with fewer than 100, all of them; else the first 100, then one commit per
 *    window whose size grows with the distance from the newest (git's `next_commit_index`:
 *    every commit up to index 100, one in up to 100 to index 20000, then one in up to 5000), the
 *    window's last commit unless a merge comes before it or a preferred tip
 *    (`pack.preferBitmapTips`, git's NEEDS_BITMAP) is in it. Pseudo-merges (2.5x's
 *    `bitmapPseudoMerge.*`) are not written;
 *  - each selected commit's bitmap: the commits it reaches and their trees and blobs (gitlinks
 *    left out), compressed as `bitmap_to_ewah` does;
 *  - the entries in commit date order, oldest first, as 2.5x sorts them (2.43 keeps the
 *    selection order, newest first: `compatibility: "2.43"`), each stored XORed with the one
 *    among the 10 before it that gives the fewest compressed words (`compute_xor_offsets`);
 *  - the lookup table (`pack.writeBitmapLookupTable`, default false) and the name-hash cache
 *    (`pack.writeBitmapHashCache`, default true: the name hash of the path each object was
 *    first listed with, by idx position; a tag's is its `tag` name, as git's revision walk
 *    names the tags it peels), then the trailing SHA-1.
 *
 * The output depends only on the pack, the traversal order of its commits (for ties of
 * commit dates) and the names: it is the same file native git writes for the same pack when
 * the listing is the same.
 */

import { EwahBitmap, RawBitmap } from "@statewalker/vcs-utils";
import { SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import {
  type ListedObject,
  type ListObjectsOptions,
  type ListObjectsSource,
  MissingObjectError,
  parseCommitHeader,
  scanTreeEntry,
  TREE_ENTRY_GITLINK,
  TREE_ENTRY_TREE,
} from "./list-objects.js";
import {
  BITMAP_OPT_FULL_DAG,
  BITMAP_OPT_HASH_CACHE,
  BITMAP_OPT_LOOKUP_TABLE,
  type BitmapPack,
} from "./pack-bitmap.js";
import { packNameHash, packNameHashBytes } from "./write-pack.js";

/** A pack the bitmap cannot describe: an object it reaches is not in it (git's warning). */
export class BitmapClosureError extends Error {
  override name = "BitmapClosureError";
  constructor(readonly objectId: ObjectId) {
    super(
      `Failed to write bitmap index. Packfile doesn't have full closure (object ${objectId} is missing)`,
    );
  }
}

export interface PackBitmapWriteOptions {
  /** The pack the bitmap describes (an installed `PackFile`). */
  pack: BitmapPack;
  /** Where commits and trees are read. */
  objects: ListObjectsSource;
  /**
   * The pack's objects as the traversal listed them (`listObjects`): their types, the path
   * each was first met at (the name-hash cache) and the order of the commits (which decides
   * between commits of one date). Objects of the pack it leaves out are read for their type
   * and get name hash 0; without it the commits come in pack order.
   */
  listed?: Iterable<ListedObject & { nameHash?: number }>;
  /** Write the name-hash cache (git's `pack.writeBitmapHashCache`). Default true. */
  hashCache?: boolean;
  /** Write the lookup table (git's `pack.writeBitmapLookupTable`). Default false. */
  lookupTable?: boolean;
  /** Commits that must get a bitmap when in a selection window (`pack.preferBitmapTips`). */
  preferredTips?: Iterable<ObjectId>;
  /** Entry order: 2.5x's (oldest first, the default) or 2.43's (newest first). */
  compatibility?: "2.43" | "2.56";
  /** A commit's tree, parents and date without reading it (the commit-graph). */
  commitHeader?: ListObjectsOptions["commitHeader"];
  /**
   * Name an unlisted tag by its `tag` header (default true, as pack-objects' listing names
   * it); a multi-pack bitmap names nothing (every name hash 0, as git's midx writer leaves
   * them).
   */
  nameTags?: boolean;
}

interface CommitData {
  id: ObjectId;
  pos: number;
  tree: ObjectId;
  parents: ObjectId[];
  date: number;
  /** listing order, for stable sorts */
  seq: number;
}

/**
 * Builds the `.bitmap` bytes of `pack`. Throws `BitmapClosureError` when an object a commit
 * reaches is not in the pack.
 *
 * @example
 * ```typescript
 * const bytes = await writePackBitmap({ pack, objects, listed });
 * await files.write(`${packDir}/pack-${pack.packId}.bitmap`, [bytes]);
 * ```
 */
export async function writePackBitmap(options: PackBitmapWriteOptions): Promise<Uint8Array> {
  const { pack, objects } = options;
  // the pack's object format: the width of its ids, of the header's checksum and the trailer
  const format = pack.objectFormat ?? SHA1_OBJECT_FORMAT;
  const raw = format.rawLength;
  if (pack.packId.length !== format.hexLength)
    throw new Error(`pack checksum must be ${raw} bytes in a ${format.name} repository`);
  const count = pack.count;
  const order = pack.packOrder();
  const packPos = new Uint32Array(count);
  for (let p = 0; p < count; p++) packPos[order[p] as number] = p;
  const posOf = (id: ObjectId): number => {
    const i = pack.indexOf(id);
    return i < 0 ? -1 : (packPos[i] as number);
  };
  const need = (id: ObjectId): number => {
    const p = posOf(id);
    if (p < 0) throw new BitmapClosureError(id);
    return p;
  };

  // ---- types, names and the commits in listing order ----
  const TYPE_CODE: Record<ObjectTypeString, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const types = new Uint8Array(count);
  const hashes = new Uint32Array(count);
  const named = new Uint8Array(count);
  const commitOrder: number[] = [];
  const tagsToName: number[] = [];
  for (const o of options.listed ?? []) {
    const p = posOf(o.id);
    if (p < 0 || types[p]) continue;
    types[p] = TYPE_CODE[o.type];
    if (o.type === "commit") commitOrder.push(p);
    if (o.nameHash !== undefined || o.path !== undefined) {
      hashes[p] = o.nameHash ?? packNameHash(o.path);
      named[p] = 1;
    } else if (o.type === "tag") tagsToName.push(p);
  }
  const read = async (id: ObjectId): Promise<{ type: ObjectTypeString; data: Uint8Array }> => {
    const getNow = objects.getNow?.bind(objects);
    let o = getNow ? getNow(id) : await objects.get(id);
    if (o instanceof Promise) o = await o;
    if (!o) throw new MissingObjectError(`object ${id} is missing`);
    if (o.bytes) {
      await o.content[Symbol.asyncIterator]().return?.();
      return { type: o.type, data: o.bytes };
    }
    const data = new Uint8Array(o.size);
    let at = 0;
    for await (const c of o.content) {
      data.set(c, at);
      at += c.length;
    }
    return { type: o.type, data };
  };
  for (let p = 0; p < count; p++) {
    if (types[p]) continue;
    const id = pack.idAt(order[p] as number);
    const o = await objects.get(id);
    if (!o) throw new MissingObjectError(`object ${id} is missing`);
    await o.content[Symbol.asyncIterator]().return?.();
    types[p] = TYPE_CODE[o.type];
    if (o.type === "commit") commitOrder.push(p);
    else if (o.type === "tag") tagsToName.push(p);
  }
  // a tag listed without a name is named by its `tag` header, as the revision walk names it
  for (const p of options.nameTags === false ? [] : tagsToName) {
    const { data } = await read(pack.idAt(order[p] as number));
    hashes[p] = packNameHashBytes(tagName(data));
  }

  const typeBitmaps = [new EwahBitmap(), new EwahBitmap(), new EwahBitmap(), new EwahBitmap()];
  for (let p = 0; p < count; p++) (typeBitmaps[(types[p] as number) - 1] as EwahBitmap).set(p);

  // ---- the commits: tree, parents, date ----
  const commits = new Map<number, CommitData>();
  let seq = 0;
  for (const p of commitOrder) {
    const id = pack.idAt(order[p] as number);
    let info: { tree: ObjectId; parents: ObjectId[]; time: number } | undefined;
    if (options.commitHeader) {
      const h = await options.commitHeader(id).catch(() => undefined);
      if (h) info = { tree: h.tree, parents: h.parents, time: h.commitTime };
    }
    if (!info) {
      const o = await read(id);
      info = parseCommitHeader(id, o.data);
    }
    commits.set(p, {
      id,
      pos: p,
      tree: info.tree,
      parents: info.parents,
      date: info.time,
      seq: seq++,
    });
  }

  // ---- selection (bitmap_writer_select_commits) ----
  const indexed = [...commits.values()];
  stableSort(indexed, (a, b) => b.date - a.date);
  const preferred = new Set<number>();
  for (const id of options.preferredTips ?? []) {
    const p = posOf(id);
    if (p >= 0 && commits.has(p)) preferred.add(p);
  }
  const selected: CommitData[] = [];
  if (indexed.length < 100) selected.push(...indexed);
  else {
    let i = 0;
    for (;;) {
      const next = nextCommitIndex(i);
      if (i + next >= indexed.length) break;
      let chosen: CommitData;
      if (next === 0) chosen = indexed[i] as CommitData;
      else {
        chosen = indexed[i + next] as CommitData;
        for (let j = 0; j <= next; j++) {
          const cm = indexed[i + j] as CommitData;
          if (preferred.has(cm.pos)) {
            chosen = cm;
            break;
          }
          if (cm.parents.length > 1) chosen = cm;
        }
      }
      selected.push(chosen);
      i += next + 1;
    }
  }

  // ---- the bitmaps (bitmap_writer_build; any order gives the same sets) ----
  const treeChildren = new Map<number, Int32Array>();
  const childrenOf = async (treePos: number, id: ObjectId): Promise<Int32Array> => {
    let c = treeChildren.get(treePos);
    if (c) return c;
    const { data } = await read(id);
    const out: number[] = [];
    for (let at = 0; at < data.length; ) {
      const e = scanTreeEntry(data, at, raw);
      at = e.next;
      if (e.kind === TREE_ENTRY_GITLINK) continue;
      const eid = hexOf(data, e.nul + 1, raw);
      const p = need(eid);
      // trees as -(pos + 1), blobs as pos
      out.push(e.kind === TREE_ENTRY_TREE ? -(p + 1) : p);
    }
    c = Int32Array.from(out);
    treeChildren.set(treePos, c);
    return c;
  };
  const fillTree = async (bitmap: RawBitmap, rootPos: number) => {
    const stack = [rootPos];
    while (stack.length) {
      const t = stack.pop() as number;
      if (bitmap.get(t)) continue;
      bitmap.set(t);
      const children = await childrenOf(t, pack.idAt(order[t] as number));
      for (let k = 0; k < children.length; k++) {
        const c = children[k] as number;
        if (c >= 0) bitmap.set(c);
        else if (!bitmap.get(-c - 1)) stack.push(-c - 1);
      }
    }
  };
  const built = new Map<number, RawBitmap>();
  const selectedSet = new Set(selected.map((c) => c.pos));
  // oldest first: ancestors are usually built before their descendants and reused whole
  const buildOrder = [...selected];
  stableSort(buildOrder, (a, b) => a.date - b.date);
  for (const sc of buildOrder) {
    const bitmap = new RawBitmap();
    const stack = [sc.pos];
    const trees: number[] = [];
    while (stack.length) {
      const c = stack.pop() as number;
      if (bitmap.get(c)) continue;
      const done = c !== sc.pos && selectedSet.has(c) ? built.get(c) : undefined;
      if (done) {
        bitmap.or(done);
        continue;
      }
      const data = commits.get(c);
      if (!data) throw new BitmapClosureError(pack.idAt(order[c] as number));
      bitmap.set(c);
      trees.push(need(data.tree));
      for (const parent of data.parents) {
        const pp = need(parent);
        if (!bitmap.get(pp)) stack.push(pp);
      }
    }
    for (const t of trees) await fillTree(bitmap, t);
    built.set(sc.pos, bitmap);
  }

  // ---- entry order and XOR offsets (compute_xor_offsets) ----
  const entries = [...selected];
  if (options.compatibility !== "2.43" && entries.length > 1)
    stableSort(entries, (a, b) => a.date - b.date);
  const ewahs = entries.map((c) => (built.get(c.pos) as RawBitmap).toEwah());
  const writeAs: EwahBitmap[] = [];
  const xorOffsets: number[] = [];
  for (let next = 0; next < entries.length; next++) {
    const stored = ewahs[next] as EwahBitmap;
    let best = stored;
    let bestOffset = 0;
    for (let i = 1; i <= 10; i++) {
      const curr = next - i;
      if (curr < 0) break;
      const test = EwahBitmap.xor(ewahs[curr] as EwahBitmap, stored);
      if (test.bufferSize < best.bufferSize) {
        best = test;
        bestOffset = i;
      }
    }
    writeAs.push(best);
    xorOffsets.push(bestOffset);
  }

  // ---- the file ----
  const hashCache = options.hashCache ?? true;
  const lookupTable = options.lookupTable ?? false;
  let flags = BITMAP_OPT_FULL_DAG;
  if (hashCache) flags |= BITMAP_OPT_HASH_CACHE;
  if (lookupTable) flags |= BITMAP_OPT_LOOKUP_TABLE;
  const headerSize = 12 + raw;
  let size = headerSize;
  for (const b of typeBitmaps) size += b.serializedSize;
  const offsets: number[] = [];
  for (const b of writeAs) {
    offsets.push(size);
    size += 6 + b.serializedSize;
  }
  if (lookupTable) size += entries.length * 16;
  if (hashCache) size += count * 4;
  size += raw;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x42, 0x49, 0x54, 0x4d], 0);
  view.setUint16(4, 1);
  view.setUint16(6, flags);
  view.setUint32(8, entries.length);
  out.set(hexToBytes(pack.packId), 12);
  let at = headerSize;
  for (const b of typeBitmaps) at = b.writeTo(out, at);
  const commitIdxPos = entries.map((c) => order[c.pos] as number);
  for (let i = 0; i < entries.length; i++) {
    view.setUint32(at, commitIdxPos[i] as number);
    out[at + 4] = xorOffsets[i] as number;
    out[at + 5] = 0;
    at = (writeAs[i] as EwahBitmap).writeTo(out, at + 6);
  }
  if (lookupTable) {
    const table = entries.map((_, i) => i);
    stableSort(table, (a, b) => (commitIdxPos[a] as number) - (commitIdxPos[b] as number));
    const inv = new Array<number>(entries.length);
    table.forEach((e, i) => {
      inv[e] = i;
    });
    for (const e of table) {
      view.setUint32(at, commitIdxPos[e] as number);
      view.setBigUint64(at + 4, BigInt(offsets[e] as number));
      const x = xorOffsets[e] as number;
      view.setUint32(at + 12, x ? (inv[e - x] as number) : 0xffffffff);
      at += 16;
    }
  }
  if (hashCache) {
    for (let i = 0; i < count; i++) {
      view.setUint32(at, hashes[packPos[i] as number] as number);
      at += 4;
    }
  }
  out.set(format.createHasher().update(out.subarray(0, at)).digest(), at);
  return out;
}

/** git's next_commit_index: how far the next selected commit is from index `idx`. */
function nextCommitIndex(idx: number): number {
  const MIN_COMMITS = 100;
  const MAX_COMMITS = 5000;
  const MUST_REGION = 100;
  const MIN_REGION = 20000;
  if (idx <= MUST_REGION) return 0;
  if (idx <= MIN_REGION) {
    const offset = idx - MUST_REGION;
    return offset < MIN_COMMITS ? offset : MIN_COMMITS;
  }
  const offset = idx - MIN_REGION;
  const next = offset < MAX_COMMITS ? offset : MAX_COMMITS;
  return next > MIN_COMMITS ? next : MIN_COMMITS;
}

/** A stable sort in place (glibc's qsort is a merge sort, so git's sorts keep ties in order). */
function stableSort<T>(items: T[], cmp: (a: T, b: T) => number): void {
  const indexed = items.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => cmp(a.v, b.v) || a.i - b.i);
  for (let i = 0; i < items.length; i++) items[i] = (indexed[i] as { v: T }).v;
}

function hexOf(data: Uint8Array, at: number, raw: number): ObjectId {
  let s = "";
  for (let i = 0; i < raw; i++) s += ((data[at + i] as number) + 0x100).toString(16).slice(1);
  return s;
}

/** The `tag` header's bytes of a tag object (empty without one). */
function tagName(data: Uint8Array): Uint8Array {
  let at = 0;
  while (at < data.length) {
    let nl = data.indexOf(0x0a, at);
    if (nl < 0) nl = data.length;
    if (nl === at) break; // the blank line ends the header
    if (
      nl - at >= 4 &&
      data[at] === 0x74 &&
      data[at + 1] === 0x61 &&
      data[at + 2] === 0x67 &&
      data[at + 3] === 0x20
    )
      return data.subarray(at + 4, nl);
    at = nl + 1;
  }
  return new Uint8Array(0);
}
