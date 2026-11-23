/**
 * Object enumeration through a pack bitmap, as git's `prepare_bitmap_walk` / `find_objects`
 * (pack-bitmap.c): the objects the wants reach minus those the haves reach, as one bitmap.
 *
 *  - each tip with a stored bitmap contributes it whole; any other tip is walked (commits,
 *    their trees) until the walk meets a commit with a stored bitmap, whose bitmap is OR-ed in,
 *    or an object already in the result. A tag tip adds the tag and goes on with its target;
 *  - objects the walk meets that the bitmapped pack does not hold (pushed or fetched since the
 *    bitmap was written) get positions after the pack's (git's extended index);
 *  - the haves are enumerated first, and the wants' walk stops at what they reach, so the
 *    result is exactly `reach(wants) \ reach(haves)`. (The plain walk, `listObjects`, marks
 *    only the trees of the boundary commits uninteresting, as git's revision walk does, so it
 *    may list a few more objects; both give a valid pack.)
 *  - filters git's bitmaps support (`blob:none`, `tree:0`, `object:type=<t>`) clear their
 *    types from the result, wants themselves kept; any other filter is not handled here.
 *
 * Objects are listed by type (commits, trees, blobs, tags) in pack order, then the extended
 * ones, each with the name hash of its path from the bitmap's name-hash cache (git feeds those
 * to the delta search), as `traverse_bitmap_commit_list` lists them.
 */
import { RawBitmap } from "@statewalker/vcs-utils";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import {
  type CommitInfo,
  type ListedObject,
  type ListObjectsOptions,
  type ListObjectsSource,
  MissingObjectError,
  parseCommitHeader,
  parseTagTarget,
  scanTreeEntry,
  TREE_ENTRY_GITLINK,
  TREE_ENTRY_TREE,
} from "./list-objects.js";
import type { ObjectFilter } from "./object-filter/index.js";
import type { PackBitmapIndex } from "./pack-bitmap.js";
import { packNameHash } from "./write-pack.js";

/** Object filters git's bitmaps can apply (`--filter=`). */
export type BitmapFilter =
  | { kind: "blob:none" }
  | { kind: "tree:0" }
  | { kind: "object:type"; type: ObjectTypeString };

/**
 * Parses a `--filter` spec into a filter the bitmap walk applies; undefined for one it cannot
 * (`blob:limit=`, `sparse:`, `combine:`, tree depths above 0), for which git walks too.
 */
export function bitmapFilterOf(spec: string): BitmapFilter | undefined {
  if (spec === "blob:none") return { kind: "blob:none" };
  if (spec === "tree:0") return { kind: "tree:0" };
  const m = /^object:type=(commit|tree|blob|tag)$/.exec(spec);
  return m ? { kind: "object:type", type: m[1] as ObjectTypeString } : undefined;
}

export interface BitmapWalkOptions {
  /** The tips to list from. A missing want throws `MissingObjectError`. */
  wants: Iterable<ObjectId>;
  /** Tips the receiver has: nothing they reach is listed. Unknown ids are ignored. */
  haves?: Iterable<ObjectId>;
  /** A filter of the listed objects (wants are always kept). */
  filter?: BitmapFilter;
  /**
   * A partial clone filter git's bitmaps apply (`canFilterBitmap`: `blob:none`,
   * `blob:limit`, `tree:0`, `object:type`, `combine:` of those), as pack-bitmap.c's
   * `filter_bitmap`: the wants and what their tags peel to are kept whatever their type.
   */
  objectFilter?: ObjectFilter;
  /** A commit's tree and parents without reading it (the commit-graph). */
  commitHeader?: ListObjectsOptions["commitHeader"];
}

/** An object the bitmap walk lists: its type and the name hash of its path. */
export interface BitmapListedObject extends ListedObject {
  nameHash: number;
}

/** What a bitmap walk found. */
export interface BitmapWalkResult {
  /** Objects listed (git's `rev-list --use-bitmap-index --count --objects`). */
  readonly count: number;
  /** Commits walked because no stored bitmap covered them. */
  readonly walkedCommits: number;
  has(id: ObjectId): boolean;
  /** The objects, by type (commits, trees, blobs, tags) in pack order, then the extended ones. */
  objects(): Generator<BitmapListedObject>;
}

const TYPE_ORDER: ObjectTypeString[] = ["commit", "tree", "blob", "tag"];

/**
 * Lists the objects `wants` reach and `haves` do not through `index`.
 *
 * @example
 * ```typescript
 * const index = await packs.bitmap?.();
 * if (index) {
 *   const result = await bitmapWalk(index, objects, { wants: [tip], haves: [theirs] });
 *   const pack = writePack(objects, [...result.objects()], { packs });
 * }
 * ```
 */
export async function bitmapWalk(
  index: PackBitmapIndex,
  objects: ListObjectsSource,
  options: BitmapWalkOptions,
): Promise<BitmapWalkResult> {
  const count = index.count;
  // bytes of a tree entry's id: the pack's object format's
  const raw = index.pack.objectFormat?.rawLength ?? 20;
  const extIds: ObjectId[] = [];
  const extTypes: ObjectTypeString[] = [];
  const extHashes: number[] = [];
  const extPos = new Map<ObjectId, number>();
  let walkedCommits = 0;

  const posOf = (id: ObjectId): number => {
    const p = index.position(id);
    if (p >= 0) return p;
    return extPos.get(id) ?? -1;
  };
  const extend = (id: ObjectId, type: ObjectTypeString, path?: string): number => {
    let p = posOf(id);
    if (p >= 0) return p;
    p = count + extIds.length;
    extIds.push(id);
    extTypes.push(type);
    extHashes.push(packNameHash(path));
    extPos.set(id, p);
    return p;
  };

  const getNow = objects.getNow?.bind(objects);
  const read = async (
    id: ObjectId,
    required: boolean,
  ): Promise<{ type: ObjectTypeString; data: Uint8Array } | undefined> => {
    let o = getNow ? getNow(id) : await objects.get(id);
    if (o instanceof Promise) o = await o;
    if (!o) {
      if (required) throw new MissingObjectError(`object ${id} is missing`);
      return undefined;
    }
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
  const commitInfo = async (id: ObjectId, required: boolean): Promise<CommitInfo | undefined> => {
    if (options.commitHeader) {
      const h = await options.commitHeader(id).catch(() => undefined);
      if (h) return { tree: h.tree, parents: h.parents, time: h.commitTime };
    }
    const o = await read(id, required);
    if (!o) return undefined;
    if (o.type !== "commit") throw new Error(`object ${id} is a ${o.type}, not a commit`);
    return parseCommitHeader(id, o.data);
  };

  /** git's find_objects: what `roots` reach, stopping at what `seen` (or the result) holds. */
  const find = async (
    roots: Iterable<ObjectId>,
    seen: RawBitmap | undefined,
    required: boolean,
    tips?: ObjectId[],
  ): Promise<RawBitmap> => {
    const out = new RawBitmap(Math.ceil(count / 64) + 1);
    const known = (p: number) => p >= 0 && (out.get(p) || (seen?.get(p) ?? false));
    const commitStack: ObjectId[] = [];
    const treeStack: { id: ObjectId; path: string }[] = [];

    const addTree = async (root: ObjectId, rootPath: string) => {
      treeStack.push({ id: root, path: rootPath });
      while (treeStack.length) {
        const { id, path } = treeStack.pop() as { id: ObjectId; path: string };
        if (known(posOf(id))) continue;
        const o = await read(id, required);
        if (!o) continue;
        if (o.type !== "tree") throw new Error(`object ${id} is a ${o.type}, not a tree`);
        out.set(extend(id, "tree", path));
        const data = o.data;
        for (let at = 0; at < data.length; ) {
          const e = scanTreeEntry(data, at, raw);
          at = e.next;
          if (e.kind === TREE_ENTRY_GITLINK) continue;
          const eid = bytesToHex(data.subarray(e.nul + 1, e.nul + 1 + raw));
          const p = posOf(eid);
          if (known(p)) continue;
          // paths only matter to objects outside the pack (their name hash)
          const sub =
            p < 0
              ? `${path ? `${path}/` : ""}${decodeGitPath(data.subarray(e.nameStart, e.nul))}`
              : "";
          if (e.kind === TREE_ENTRY_TREE) treeStack.push({ id: eid, path: sub });
          else out.set(p >= 0 ? p : extend(eid, "blob", sub));
        }
      }
    };

    for (const root of roots) {
      let id = root;
      for (let depth = 0; depth < 64; depth++) {
        // git's prepare_bitmap_walk lists each tag of a want and what it peels to
        tips?.push(id);
        const p = posOf(id);
        if (known(p)) break;
        const inPack = p >= 0 && p < count;
        let type = inPack ? index.typeAt(p) : undefined;
        let data: Uint8Array | undefined;
        if (!type || type === "tag") {
          const o = await read(id, required);
          if (!o) break;
          type = o.type;
          data = o.data;
        }
        if (type === "tag") {
          out.set(extend(id, "tag"));
          id = parseTagTarget(id, data as Uint8Array);
          continue;
        }
        if (type === "commit") commitStack.push(id);
        else if (type === "tree") await addTree(id, "");
        else out.set(extend(id, "blob"));
        break;
      }
    }

    const trees: ObjectId[] = [];
    while (commitStack.length) {
      const c = commitStack.pop() as ObjectId;
      const p = posOf(c);
      if (known(p)) continue;
      const stored = p >= 0 && p < count ? index.bitmapFor(c) : undefined;
      if (stored) {
        // bits at or above the pack's count stand for no object of it (nor an extended one)
        out.orEwah(stored, count);
        continue;
      }
      const info = await commitInfo(c, required);
      if (!info) continue;
      walkedCommits++;
      out.set(extend(c, "commit"));
      trees.push(info.tree);
      for (const parent of info.parents) if (!known(posOf(parent))) commitStack.push(parent);
    }
    for (const t of trees) await addTree(t, "");
    return out;
  };

  const haves = await find(options.haves ?? [], undefined, false);
  const wantList = [...options.wants];
  const tipIds: ObjectId[] = [];
  const result = await find(wantList, haves, true, tipIds);
  result.andNot(haves);

  const typeOf = (p: number): ObjectTypeString | undefined =>
    p < count ? index.typeAt(p) : (extTypes[p - count] as ObjectTypeString);
  if (options.objectFilter) {
    // the tips' bits as they are now: a filter never clears them (find_tip_objects)
    const tips = new Map<number, boolean>();
    for (const id of tipIds) {
      const p = posOf(id);
      if (p >= 0) tips.set(p, result.get(p));
    }
    const typed = {
      commit: index.commits,
      tree: index.trees,
      blob: index.blobs,
      tag: index.tags,
    };
    const exclude = (type: ObjectTypeString) => {
      result.andNotEwah(typed[type], count);
      for (let k = 0; k < extIds.length; k++) {
        if (extTypes[k] === type) result.unset(count + k);
      }
      for (const [p, was] of tips) if (was && typeOf(p) === type) result.set(p);
    };
    const sizeOf = async (p: number): Promise<number> => {
      const id = p < count ? index.idAt(p) : (extIds[p - count] as ObjectId);
      const o = await objects.get(id);
      if (!o) throw new MissingObjectError(`unable to get size of ${id}`);
      await o.content[Symbol.asyncIterator]().return?.();
      return o.size;
    };
    const apply = async (f: ObjectFilter): Promise<void> => {
      switch (f.choice) {
        case "blob:none":
          exclude("blob");
          return;
        case "tree":
          if (f.depth !== 0) throw new Error(`bitmaps cannot apply tree:${f.depth}`);
          exclude("tree");
          exclude("blob");
          return;
        case "object:type":
          for (const t of ["tag", "commit", "tree", "blob"] as const) if (t !== f.type) exclude(t);
          return;
        case "blob:limit": {
          const blobs: number[] = [];
          result.forEach((p) => {
            if (typeOf(p) === "blob" && !tips.has(p)) blobs.push(p);
          });
          for (const p of blobs) if ((await sizeOf(p)) >= f.limit) result.unset(p);
          return;
        }
        case "combine":
          for (const sub of f.filters) await apply(sub);
          return;
        default:
          throw new Error(`bitmaps cannot apply ${f.choice}`);
      }
    };
    await apply(options.objectFilter);
  }

  // filters: their types cleared, the wants kept (git's filter_bitmap_exclude_type tips)
  const filter = options.filter;
  if (filter) {
    const drop = new Set<ObjectTypeString>(
      filter.kind === "blob:none"
        ? ["blob"]
        : filter.kind === "tree:0"
          ? ["tree", "blob"]
          : TYPE_ORDER.filter((t) => t !== filter.type),
    );
    const tips = new Set<number>();
    for (const w of wantList) {
      const p = posOf(w);
      if (p >= 0) tips.add(p);
    }
    const bitmaps = {
      commit: index.commits,
      tree: index.trees,
      blob: index.blobs,
      tag: index.tags,
    };
    for (const t of drop) result.andNotEwah(bitmaps[t], count);
    for (let k = 0; k < extIds.length; k++) {
      if (drop.has(extTypes[k] as ObjectTypeString)) result.unset(count + k);
    }
    for (const p of tips) {
      const t = p < count ? index.typeAt(p) : extTypes[p - count];
      if (t && drop.has(t) && !haves.get(p)) result.set(p);
    }
  }

  const total = result.popcount();
  return {
    count: total,
    walkedCommits,
    has(id) {
      const p = posOf(id);
      return p >= 0 && result.get(p);
    },
    *objects() {
      const bitmaps = [index.commits, index.trees, index.blobs, index.tags];
      for (let k = 0; k < 4; k++) {
        const type = TYPE_ORDER[k] as ObjectTypeString;
        const typed = result.clone();
        typed.andEwah(bitmaps[k] as NonNullable<(typeof bitmaps)[0]>);
        const positions: number[] = [];
        typed.forEach((p) => {
          if (p < count) positions.push(p);
        });
        for (const p of positions) yield { id: index.idAt(p), type, nameHash: index.nameHashAt(p) };
      }
      for (let k = 0; k < extIds.length; k++) {
        if (!result.get(count + k)) continue;
        yield {
          id: extIds[k] as ObjectId,
          type: extTypes[k] as ObjectTypeString,
          nameHash: extHashes[k] as number,
        };
      }
    },
  };
}

/**
 * `listObjects` through a bitmap: the walk's objects, then (git's `--include-tag`) each
 * candidate annotated tag whose chain ends at a listed object, with the tags of its chain.
 * @internal
 */
export async function* listObjectsWithBitmap(
  index: PackBitmapIndex,
  objects: ListObjectsSource,
  options: ListObjectsOptions,
): AsyncGenerator<ListedObject> {
  const result = await bitmapWalk(index, objects, {
    wants: options.wants,
    haves: [...(options.haves ?? []), ...(options.excludes ?? [])],
    ...(options.filter ? { objectFilter: options.filter as ObjectFilter } : {}),
    ...(options.commitHeader ? { commitHeader: options.commitHeader } : {}),
  });
  yield* result.objects();
  const added = new Set<ObjectId>();
  for (const tip of options.includeTags ?? []) {
    if (result.has(tip) || added.has(tip)) continue;
    const chain: ObjectId[] = [];
    let id = tip;
    let listed = false;
    for (let depth = 0; depth < 64; depth++) {
      if (chain.length > 0 && (result.has(id) || added.has(id))) {
        listed = true;
        break;
      }
      const o = await objects.get(id);
      if (!o) break;
      if (o.type !== "tag") {
        await o.content[Symbol.asyncIterator]().return?.();
        break;
      }
      const data = new Uint8Array(o.size);
      let at = 0;
      for await (const c of o.content) {
        data.set(c, at);
        at += c.length;
      }
      chain.push(id);
      id = parseTagTarget(id, data);
    }
    if (!listed) continue;
    for (const tag of chain) {
      if (result.has(tag) || added.has(tag)) continue;
      added.add(tag);
      yield { id: tag, type: "tag" };
    }
  }
}
