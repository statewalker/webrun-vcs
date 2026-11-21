/**
 * `git rev-list --objects`: the objects reachable from some tips (wants) and not from others
 * (haves), after git's revision.c / list-objects.c and JGit's ObjectWalk:
 *
 *  - commits are walked newest first (by committer time); a commit reached from a have is
 *    uninteresting, and so are its ancestors. The walk stops once every queued commit is
 *    uninteresting, plus a few more commits (git's SLOP) to absorb clock skew; a commit found
 *    uninteresting after it was listed is dropped before anything is yielded;
 *  - the trees of the uninteresting parents of listed commits (the edges, git's
 *    mark_edges_uninteresting) and the tree haves are marked uninteresting with everything below
 *    them, so a tree or blob the receiver has through those commits is not listed again; the
 *    trees of other uninteresting commits are not (a have no listed commit stands on marks
 *    nothing, as in git's walk);
 *  - commits are yielded first, then the wanted tags, trees and blobs in the order of the wants
 *    (git's pending objects: a tree or blob want named "" unless `tipPaths` names it), then
 *    the trees and blobs of each listed commit (with their path, for the delta search's name
 *    hash), as list-objects.c's traverse_non_commits lists them;
 *  - with `includeTags` (git's `pack-objects --include-tag`), last come the annotated tags among
 *    them that peel to a listed object, each with the tags of its chain.
 *
 * Memory is a map of flags per visited id and the parsed parents of walked commits; objects are
 * read one at a time and never kept.
 */
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { GitObject, GitObjects } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { listObjectsWithBitmap } from "./bitmap-walk.js";
import {
  canFilterBitmap,
  type FilterSituation,
  LOFR_DO_SHOW,
  LOFR_MARK_SEEN,
  LOFR_SKIP_TREE,
  type ObjectFilterRun,
  type ResolvedObjectFilter,
  startObjectFilter,
} from "./object-filter/index.js";
import { ObjectIdFlags } from "./object-id-flags.js";
import type { PackBitmapIndex } from "./pack-bitmap.js";

/** What `listObjects` reads: objects by id. */
export type ListObjectsSource = Pick<GitObjects, "get"> & Partial<Pick<GitObjects, "getNow">>;

export interface ListObjectsOptions {
  /** The tips to list from (commits, tags, trees or blobs). A missing want throws. */
  wants: Iterable<ObjectId>;
  /** Tips the receiver has: nothing reachable from them is listed. Unknown ids are ignored. */
  haves?: Iterable<ObjectId>;
  /** The same as `haves` (git's `^id`); both may be given. */
  excludes?: Iterable<ObjectId>;
  /**
   * Shallow commits (the receiver's shallow boundary, git's grafts): their parents are not
   * walked, neither to list nor to exclude. Deepening (`deepen`, `deepen-since`) is not done here.
   */
  shallow?: Iterable<ObjectId>;
  /**
   * Commit grafts (`info/grafts`): a grafted commit's parents walked as well as the ones it
   * records, as gc keeps both (`git repack --keep-true-parents` packs the real parents, `git
   * prune` walks the grafted ones). A grafted parent is required as a recorded one is (git's
   * repack dies on a missing one); a shallow commit's graft is ignored (the shallow file
   * overrides it).
   */
  grafts?: ReadonlyMap<ObjectId, readonly ObjectId[]>;
  /**
   * Called for each tree and blob below the boundary (the trees of the uninteresting parents
   * of listed commits, and tree haves), with its path: the receiver's objects, bases for a thin pack.
   */
  onBoundary?: (object: ListedObject) => void;
  /**
   * Candidate annotated tags (git's `pack-objects --include-tag`, which tries every
   * `refs/tags/*`): a tag whose target, followed through any chain of tags, is listed is listed
   * too, after everything else, with each tag of its chain. Other ids (lightweight tags, tags of
   * objects not listed, missing objects) are skipped.
   */
  includeTags?: Iterable<ObjectId>;
  /**
   * A commit's tree, parents and committer time without reading it (the commit-graph:
   * `Commits.getHeader`, which parses commits outside the graph). Undefined for an id that is
   * not a commit or not stored. Commits it knows are not read at all, except the wants (read
   * so that a missing one throws even when a stale graph still lists it).
   */
  commitHeader?: (
    id: ObjectId,
  ) => Promise<{ tree: ObjectId; parents: ObjectId[]; commitTime: number } | undefined>;
  /**
   * A pack bitmap (`PackSet.bitmap()`, git's `--use-bitmap-index`): when nothing needs the
   * revision walk (no `shallow`, `grafts` or `onBoundary`), the objects are listed through it
   * (`bitmapWalk`): exactly what the wants reach and the haves do not, by type in pack order,
   * with the name hash of each path (`nameHash`) instead of the path.
   */
  bitmap?: PackBitmapIndex;
  /**
   * The path a tree or blob want is listed with (git's pending path: an index entry's name,
   * a cache-tree node's directory, as `--indexed-objects` adds them); any other tree or blob
   * want is listed with none (name hash 0), as git names a ref's tree or blob "".
   */
  tipPaths?: ReadonlyMap<ObjectId, string>;
  /**
   * A partial clone filter (git's `rev-list --filter`, upload-pack's `filter`), its
   * `sparse:oid` patterns read (`resolveObjectFilter`): the objects it omits are not listed.
   * The wants, and what their tags peel to, are always listed (git's user-given objects).
   * Through the bitmap only for the filters git's bitmaps apply (`canFilterBitmap`), else
   * walked in git's order (trees entry by entry, depth first), which the order-dependent
   * filters (`tree:<depth>`, `sparse:oid`, `combine:`) answer as git's do.
   */
  filter?: ResolvedObjectFilter;
  /**
   * git's `core.maxTreeDepth` (default {@link DEFAULT_MAX_TREE_DEPTH}): a tree deeper than this
   * below the tree a walk starts from (that one at depth 0) stops the listing with
   * {@link TreeDepthError}, as list-objects.c's process_tree dies. Not checked by the bitmap
   * walk, which reads no trees.
   */
  maxTreeDepth?: number;
}

/** git's default `core.maxTreeDepth` (`DEFAULT_MAX_ALLOWED_TREE_DEPTH`, outside MSVC builds). */
export const DEFAULT_MAX_TREE_DEPTH = 2048;

/** A tree deeper than `core.maxTreeDepth`: git's `fatal: exceeded maximum allowed tree depth`. */
export class TreeDepthError extends Error {
  override name = "TreeDepthError";
  constructor() {
    super("exceeded maximum allowed tree depth");
  }
}

/** A tree being walked by the filtered listing: its entries from `at` on. */
interface FilterFrame {
  id: ObjectId;
  data: Uint8Array;
  at: number;
  /** the path its entries are under (`<path>/`, "" for a root) */
  childBase: string;
  name: string;
  depth: number;
}

const EMPTY_TREE = new Uint8Array(0);

/** One listed object, as `git rev-list --objects` prints it. */
export interface ListedObject {
  id: ObjectId;
  type: ObjectTypeString;
  /** The path of a tree or blob below its commit's root tree ("" for a root tree). */
  path?: string;
  /** The path's name hash, when listed through a bitmap (its name-hash cache) */
  nameHash?: number;
}

/** A want the store does not have. */
export class MissingObjectError extends Error {
  override name = "MissingObjectError";
}

const SEEN = 1;
const UNINTERESTING = 2;
const ADDED = 4;
/** a tree or blob below the boundary, already marked with everything below it */
const BOUNDARY = 8;
/** seen by the partial clone filter's walk (git's SEEN of trees, blobs and tags) */
const FILTER_SEEN = 16;
/** met through a tree or as a parent, not named by a want (git's NOT_USER_GIVEN) */
const NOT_USER_GIVEN = 32;
/** Commits walked after only uninteresting ones remain queued (git's SLOP). */
const SLOP = 5;

/** @internal */
export interface CommitInfo {
  tree: ObjectId;
  parents: ObjectId[];
  time: number;
}

const dec = new TextDecoder();

/**
 * Streams the objects reachable from `wants` and not from `haves`/`excludes`.
 *
 * @example
 * ```typescript
 * const ids: ListedObject[] = [];
 * for await (const o of listObjects(objects, { wants: [tip], haves: [remoteTip] })) ids.push(o);
 * const pack = writePack(objects, ids); // the pack a push sends
 * ```
 */
export async function* listObjects(
  objects: ListObjectsSource,
  options: ListObjectsOptions,
): AsyncGenerator<ListedObject> {
  if (options.bitmap) options = { ...options, wants: [...options.wants] };
  if (
    options.bitmap &&
    // no wants: nothing to list (git's prepare_bitmap_walk gives up too)
    (options.wants as ObjectId[]).length > 0 &&
    !options.shallow &&
    !options.grafts &&
    !options.onBoundary &&
    (!options.filter || canFilterBitmap(options.filter)) &&
    (await haveInBitmappedPack(options.bitmap, objects, [
      ...(options.haves ?? []),
      ...(options.excludes ?? []),
    ]))
  ) {
    yield* listObjectsWithBitmap(options.bitmap, objects, options);
    return;
  }
  const maxTreeDepth = options.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH;
  const flags = new ObjectIdFlags();
  const has = (id: ObjectId, f: number) => (flags.get(id) & f) !== 0;
  const set = (id: ObjectId, f: number) => flags.add(id, f);
  const commits = new Map<ObjectId, CommitInfo>();
  const shallow = new Set(options.shallow ?? []);
  const grafts = options.grafts;
  const parentsOf = (id: ObjectId, c: CommitInfo): ObjectId[] => {
    // a shallow commit has no parents, whatever its graft says (register_shallow)
    if (shallow.has(id)) return [];
    const grafted = grafts?.get(id);
    if (!grafted) return c.parents;
    const extra = grafted.filter((p) => !c.parents.includes(p));
    return extra.length > 0 ? [...c.parents, ...extra] : c.parents;
  };

  const getNow = objects.getNow?.bind(objects);
  const read = async (id: ObjectId): Promise<{ type: ObjectTypeString; data: Uint8Array }> => {
    // without a promise when the store has the object at hand (a loaded pack window)
    let o = getNow ? getNow(id) : await objects.get(id);
    if (o instanceof Promise) o = await o;
    if (!o) throw new MissingObjectError(`object ${id} is missing`);
    if (o.bytes) {
      await o.content[Symbol.asyncIterator]().return?.();
      if (o.bytes.length !== o.size) throw new Error("object size mismatch");
      return { type: o.type, data: o.bytes };
    }
    return { type: o.type, data: await collect(o) };
  };
  const tryRead = (id: ObjectId) =>
    read(id).catch((e) => {
      if (e instanceof MissingObjectError) return undefined;
      throw e;
    });

  const fromHeader = async (id: ObjectId): Promise<CommitInfo | undefined> => {
    if (!options.commitHeader) return undefined;
    const h = await options.commitHeader(id).catch(() => undefined);
    return h ? { tree: h.tree, parents: h.parents, time: h.commitTime } : undefined;
  };

  const parseCommit = async (id: ObjectId, required: boolean): Promise<CommitInfo | undefined> => {
    let c = commits.get(id) ?? (await fromHeader(id));
    if (c) {
      commits.set(id, c);
      return c;
    }
    const o = required ? await read(id) : await tryRead(id);
    if (!o) return undefined;
    if (o.type !== "commit") throw new Error(`object ${id} is a ${o.type}, not a commit`);
    c = parseCommitHeader(id, o.data);
    commits.set(id, c);
    return c;
  };

  // ---- the commit walk: a max-heap on committer time ----
  const heap: { id: ObjectId; time: number }[] = [];
  const push = (id: ObjectId, time: number) => {
    heap.push({ id, time });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] as { time: number }).time >= time) break;
      [heap[p], heap[i]] = [heap[i] as (typeof heap)[0], heap[p] as (typeof heap)[0]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l] as typeof last).time > (heap[m] as typeof last).time) m = l;
        if (r < heap.length && (heap[r] as typeof last).time > (heap[m] as typeof last).time) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i] as typeof last, heap[m] as typeof last];
        i = m;
      }
    }
    return top;
  };
  const enqueue = async (id: ObjectId, uninteresting: boolean) => {
    if (uninteresting) markUninteresting(id);
    if (has(id, SEEN)) return;
    const c = await parseCommit(id, !uninteresting);
    if (!c) return; // an uninteresting parent missing (a shallow or partial store)
    set(id, SEEN);
    push(id, c.time);
  };
  /** Marks a commit uninteresting, and its walked ancestors (git's mark_parents_uninteresting). */
  const markUninteresting = (id: ObjectId) => {
    const stack = [id];
    while (stack.length) {
      const x = stack.pop() as ObjectId;
      if (has(x, UNINTERESTING)) continue;
      set(x, UNINTERESTING);
      const c = commits.get(x);
      if (c && has(x, SEEN)) for (const p of parentsOf(x, c)) stack.push(p);
    }
  };

  const tags: ObjectId[] = [];
  /** commits the wants name (directly or through tags): git's user-given commits */
  const givenCommits = new Set<ObjectId>();
  /** wanted tags, trees and blobs in the order met (git's revs->pending after handle_commit) */
  const pending: { id: ObjectId; type: "tag" | "tree" | "blob" }[] = [];
  const boundaryTrees: ObjectId[] = [];

  /** Follows tags down to their target and queues it. */
  const start = async (tip: ObjectId, uninteresting: boolean) => {
    let id = tip;
    for (;;) {
      // a want is read (a missing one throws, though a stale commit-graph still lists it)
      const known = commits.get(id) ?? (uninteresting ? await fromHeader(id) : undefined);
      if (known) {
        if (uninteresting) set(id, UNINTERESTING);
        else givenCommits.add(id);
        commits.set(id, known);
        await enqueue(id, uninteresting);
        return;
      }
      const o = uninteresting ? await tryRead(id) : await read(id);
      if (!o) return;
      if (uninteresting) set(id, UNINTERESTING);
      switch (o.type) {
        case "tag": {
          if (!uninteresting && !has(id, ADDED)) {
            set(id, ADDED);
            tags.push(id);
            pending.push({ id, type: "tag" });
          }
          id = parseTagTarget(id, o.data);
          continue;
        }
        case "commit":
          commits.set(id, commits.get(id) ?? parseCommitHeader(id, o.data));
          if (!uninteresting) givenCommits.add(id);
          await enqueue(id, uninteresting);
          return;
        case "tree":
          if (uninteresting) boundaryTrees.push(id);
          else pending.push({ id, type: "tree" });
          return;
        case "blob":
          if (!uninteresting) pending.push({ id, type: "blob" });
          return;
      }
    }
  };

  for (const id of [...(options.haves ?? []), ...(options.excludes ?? [])]) await start(id, true);
  for (const id of options.wants) await start(id, false);

  const listed: ObjectId[] = [];
  let slop = SLOP;
  while (heap.length) {
    if (heap.every((e) => has(e.id, UNINTERESTING))) {
      if (slop-- <= 0) break;
    } else {
      slop = SLOP;
    }
    const { id } = pop() as { id: ObjectId };
    const c = commits.get(id) as CommitInfo;
    const uninteresting = has(id, UNINTERESTING);
    // an uninteresting commit's tree is not marked (only edges below, as git's walk)
    if (!uninteresting) listed.push(id);
    for (const p of parentsOf(id, c)) await enqueue(p, uninteresting);
  }

  // the trees of uninteresting parents of listed commits (git's mark_edges_uninteresting)
  const kept = listed.filter((id) => !has(id, UNINTERESTING));
  for (const id of kept) {
    for (const p of parentsOf(id, commits.get(id) as CommitInfo)) {
      if (!has(p, UNINTERESTING)) continue;
      const pc = await parseCommit(p, false);
      if (pc) boundaryTrees.push(pc.tree);
    }
  }
  for (const t of boundaryTrees) await markTreeUninteresting(t);

  /** Marks a tree and everything below it uninteresting; each tree is read once. */
  async function markTreeUninteresting(root: ObjectId) {
    const onBoundary = options.onBoundary;
    const stack = [{ id: root, path: "" }];
    while (stack.length) {
      const { id: t, path } = stack.pop() as { id: ObjectId; path: string };
      if (has(t, BOUNDARY)) continue;
      set(t, BOUNDARY | UNINTERESTING);
      const o = await tryRead(t);
      if (o?.type !== "tree") continue;
      onBoundary?.({ id: t, type: "tree", path });
      const data = o.data;
      for (let at = 0; at < data.length; ) {
        const e = scanTreeEntry(data, at);
        at = e.next;
        if (e.kind === GITLINK) continue;
        if (flags.getAt(data, e.nul + 1) & BOUNDARY) continue;
        // the paths only matter to `onBoundary`
        const name = onBoundary ? decodeGitPath(data.subarray(e.nameStart, e.nul)) : "";
        const p = path ? `${path}/${name}` : name;
        if (e.kind === TREE) {
          stack.push({ id: bytesToHex(data.subarray(e.nul + 1, e.nul + 21)), path: p });
        } else {
          flags.addAt(data, e.nul + 1, BOUNDARY | UNINTERESTING);
          onBoundary?.({
            id: bytesToHex(data.subarray(e.nul + 1, e.nul + 21)),
            type: "blob",
            path: p,
          });
        }
      }
    }
  }

  // ---- output ----
  if (options.filter) {
    yield* filteredOutput(options.filter);
  } else {
    yield* plainOutput();
  }

  /** git's traverse_commit_list_filtered: commits, then the pending objects, trees in order */
  async function* filteredOutput(filter: ResolvedObjectFilter): AsyncGenerator<ListedObject> {
    const run: ObjectFilterRun = startObjectFilter(filter, {
      objectSize: async (id) => {
        const o = await objects.get(id);
        if (!o) return undefined;
        await o.content[Symbol.asyncIterator]().return?.();
        return o.size;
      },
    });
    const ask = async (
      situation: FilterSituation,
      id: ObjectId,
      pathname: string,
      filename: string,
    ): Promise<number> => {
      const r = run.filter(situation, id, has(id, NOT_USER_GIVEN), pathname, filename);
      return r instanceof Promise ? await r : r;
    };
    for (const id of kept) {
      // parents met by the walk are not user given; the wants' commits are
      if (!givenCommits.has(id)) set(id, NOT_USER_GIVEN);
      const r = await ask("commit", id, "", "");
      if (r & LOFR_DO_SHOW) {
        set(id, ADDED);
        yield { id, type: "commit" };
      }
    }
    // do_traverse marks every listed commit's root tree before any pending object is walked
    for (const id of kept) set((commits.get(id) as CommitInfo).tree, NOT_USER_GIVEN);

    async function processBlob(
      id: ObjectId,
      base: string,
      name: string,
    ): Promise<ListedObject | undefined> {
      if (has(id, UNINTERESTING | FILTER_SEEN)) return undefined;
      const path = base + name;
      const r = await ask("blob", id, path, name);
      if (r & LOFR_MARK_SEEN) set(id, FILTER_SEEN);
      if (r & LOFR_DO_SHOW && !has(id, ADDED)) {
        set(id, ADDED);
        return { id, type: "blob", path };
      }
      return undefined;
    }
    /**
     * git's process_tree up to its contents: the depth check, the tree read and its
     * begin-tree question; the frame whose entries are walked next (none when skipped).
     */
    async function beginTree(
      id: ObjectId,
      base: string,
      name: string,
      depth: number,
    ): Promise<{ shown?: ListedObject; frame?: FilterFrame }> {
      if (has(id, UNINTERESTING | FILTER_SEEN)) return {};
      if (depth > maxTreeDepth) throw new TreeDepthError();
      const o = await read(id);
      if (o.type !== "tree") throw new Error(`object ${id} is a ${o.type}, not a tree`);
      const path = base + name;
      const r = await ask("begin-tree", id, path, name);
      if (r & LOFR_MARK_SEEN) set(id, FILTER_SEEN);
      let shown: ListedObject | undefined;
      if (r & LOFR_DO_SHOW && !has(id, ADDED)) {
        set(id, ADDED);
        shown = { id, type: "tree", path };
      }
      const childBase = path ? `${path}/` : "";
      const data = r & LOFR_SKIP_TREE ? EMPTY_TREE : o.data;
      return { ...(shown ? { shown } : {}), frame: { id, data, at: 0, childBase, name, depth } };
    }
    /**
     * git's process_tree over a whole tree, depth first in entry order, with an explicit
     * stack of frames (no recursion: each listed object costs the same at any depth)
     */
    async function* processTree(
      root: ObjectId,
      base: string,
      name: string,
    ): AsyncGenerator<ListedObject> {
      const first = await beginTree(root, base, name, 0);
      if (first.shown) yield first.shown;
      if (!first.frame) return;
      const stack: FilterFrame[] = [first.frame];
      while (stack.length > 0) {
        const f = stack[stack.length - 1] as FilterFrame;
        if (f.at < f.data.length) {
          const e = scanTreeEntry(f.data, f.at);
          f.at = e.next;
          if (e.kind === GITLINK) continue;
          const eid = bytesToHex(f.data.subarray(e.nul + 1, e.nul + 21));
          const entryName = decodeGitPath(f.data.subarray(e.nameStart, e.nul));
          set(eid, NOT_USER_GIVEN);
          if (e.kind === TREE) {
            const next = await beginTree(eid, f.childBase, entryName, f.depth + 1);
            if (next.shown) yield next.shown;
            if (next.frame) stack.push(next.frame);
          } else {
            const shown = await processBlob(eid, f.childBase, entryName);
            if (shown) yield shown;
          }
          continue;
        }
        stack.pop();
        const r = await ask("end-tree", f.id, f.childBase, f.name);
        if (r & LOFR_MARK_SEEN) set(f.id, FILTER_SEEN);
      }
    }

    const tipPaths = options.tipPaths;
    for (const { id, type } of pending) {
      if (has(id, UNINTERESTING | FILTER_SEEN)) continue;
      if (type === "tag") {
        // (a wanted tag is ADDED already: `start` met it)
        const r = await ask("tag", id, "", "");
        if (r & LOFR_MARK_SEEN) set(id, FILTER_SEEN);
        if (r & LOFR_DO_SHOW) yield { id, type: "tag" };
      } else if (type === "tree") yield* processTree(id, "", tipPaths?.get(id) ?? "");
      else {
        const shown = await processBlob(id, "", tipPaths?.get(id) ?? "");
        if (shown) yield shown;
      }
    }
    for (const id of kept) yield* processTree((commits.get(id) as CommitInfo).tree, "", "");
  }

  async function* plainOutput(): AsyncGenerator<ListedObject> {
    for (const id of kept) {
      set(id, ADDED);
      yield { id, type: "commit" };
    }

    async function* walkTree(root: ObjectId, rootPath: string): AsyncGenerator<ListedObject> {
      const stack: { id: ObjectId; path: string; depth: number }[] = [
        { id: root, path: rootPath, depth: 0 },
      ];
      while (stack.length) {
        const { id, path, depth } = stack.pop() as { id: ObjectId; path: string; depth: number };
        if (has(id, UNINTERESTING | ADDED)) continue;
        // process_tree's core.maxTreeDepth (the root at depth 0)
        if (depth > maxTreeDepth) throw new TreeDepthError();
        set(id, ADDED);
        const o = await read(id);
        if (o.type !== "tree") throw new Error(`object ${id} is a ${o.type}, not a tree`);
        yield { id, type: "tree", path };
        const subtrees: { id: ObjectId; path: string; depth: number }[] = [];
        const data = o.data;
        // entries already listed or excluded are skipped before their names are decoded
        for (let at = 0; at < data.length; ) {
          const e = scanTreeEntry(data, at);
          at = e.next;
          if (e.kind === GITLINK) continue;
          if (flags.getAt(data, e.nul + 1) & (UNINTERESTING | ADDED)) continue;
          const eid = bytesToHex(data.subarray(e.nul + 1, e.nul + 21));
          const name = decodeGitPath(data.subarray(e.nameStart, e.nul));
          const p = path ? `${path}/${name}` : name;
          if (e.kind === TREE) subtrees.push({ id: eid, path: p, depth: depth + 1 });
          else {
            flags.addAt(data, e.nul + 1, ADDED);
            yield { id: eid, type: "blob", path: p };
          }
        }
        // depth first, in tree order
        for (let i = subtrees.length - 1; i >= 0; i--)
          stack.push(subtrees[i] as (typeof subtrees)[0]);
      }
    }

    // the pending objects first (tags, tree and blob wants), then the commits' trees
    const tipPaths = options.tipPaths;
    for (const { id, type } of pending) {
      if (type === "tag") {
        if (!has(id, UNINTERESTING)) yield { id, type: "tag" };
      } else if (type === "tree") yield* walkTree(id, tipPaths?.get(id) ?? "");
      else {
        if (has(id, UNINTERESTING | ADDED)) continue;
        set(id, ADDED);
        const path = tipPaths?.get(id);
        yield path === undefined ? { id, type: "blob" } : { id, type: "blob", path };
      }
    }
    for (const id of kept) yield* walkTree((commits.get(id) as CommitInfo).tree, "");
  }

  // git's add_ref_tag / add_tag_chain: a tag peeling to a listed object comes with its chain.
  // Only tag objects are read: a listed object (ADDED) ends the chain without a read, an
  // object the walk met and did not list (other flags) drops the candidate, and any other
  // object is looked at by its header only
  const tagIds = new Set(tags);
  for (const tip of options.includeTags ?? []) {
    if (has(tip, ADDED)) continue;
    const chain: ObjectId[] = [];
    let id = tip;
    let listed = false;
    for (let depth = 0; depth < 64; depth++) {
      if (has(id, ADDED) && !tagIds.has(id)) {
        listed = !has(id, UNINTERESTING);
        break;
      }
      if (!tagIds.has(id) && flags.get(id) !== 0) break; // met, not listed
      const o = await objects.get(id);
      if (!o) break;
      if (o.type !== "tag") {
        // neither listed nor a tag: its content is not needed
        await o.content[Symbol.asyncIterator]().return?.();
        break;
      }
      chain.push(id);
      id = parseTagTarget(id, await collect(o));
    }
    if (!listed || chain.length === 0) continue;
    for (const tag of chain) {
      if (has(tag, ADDED)) continue;
      set(tag, ADDED);
      tagIds.add(tag);
      yield { id: tag, type: "tag" };
    }
  }
}

/**
 * git's prepare_bitmap_walk check (classic traversal, `pack.useBitmapBoundaryTraversal`
 * unset): with haves, at least one of them (or a tag's target on the way) must be in the
 * bitmapped pack, else the bitmap gives nothing to optimize and the plain walk runs.
 */
async function haveInBitmappedPack(
  index: PackBitmapIndex,
  objects: ListObjectsSource,
  haves: ObjectId[],
): Promise<boolean> {
  if (haves.length === 0) return true;
  const inPack = (id: ObjectId) => {
    const p = index.position(id);
    return p >= 0 && p < index.count;
  };
  if (haves.some(inPack)) return true;
  // tags peeled as git's loop does: each tag and what it points at join the haves
  for (const have of haves) {
    let id = have;
    for (let depth = 0; depth < 64; depth++) {
      const o = await objects.get(id);
      if (!o) break;
      if (o.type !== "tag") {
        await o.content[Symbol.asyncIterator]().return?.();
        break;
      }
      id = parseTagTarget(id, await collect(o));
      if (inPack(id)) return true;
    }
  }
  return false;
}

async function collect(o: GitObject): Promise<Uint8Array> {
  const data = new Uint8Array(o.size);
  let at = 0;
  for await (const c of o.content) {
    if (at + c.length > data.length) throw new Error("object longer than its size");
    data.set(c, at);
    at += c.length;
  }
  if (at !== data.length) throw new Error("object shorter than its size");
  return data;
}

/**
 * The tree and parents of a commit, and its committer time.
 * @internal
 */
export function parseCommitHeader(id: ObjectId, data: Uint8Array): CommitInfo {
  const end = indexOfBlankLine(data);
  const text = dec.decode(data.subarray(0, end));
  let tree: ObjectId | undefined;
  const parents: ObjectId[] = [];
  let time = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5, 45);
    else if (line.startsWith("parent ")) parents.push(line.slice(7, 47));
    else if (line.startsWith("committer ")) {
      const gt = line.lastIndexOf(">");
      const t = Number.parseInt(
        line
          .slice(gt + 1)
          .trim()
          .split(" ")[0] ?? "",
        10,
      );
      if (Number.isFinite(t)) time = t;
    }
  }
  if (!tree) throw new Error(`commit ${id} has no tree`);
  return { tree, parents, time };
}

/** @internal the object a tag names */
export function parseTagTarget(id: ObjectId, data: Uint8Array): ObjectId {
  const text = dec.decode(data.subarray(0, Math.min(data.length, 64)));
  if (!text.startsWith("object ")) throw new Error(`tag ${id} has no object`);
  return text.slice(7, 47);
}

function indexOfBlankLine(data: Uint8Array): number {
  for (let i = 0; i + 1 < data.length; i++) if (data[i] === 10 && data[i + 1] === 10) return i;
  return data.length;
}

/** @internal tree entry kinds of `scanTreeEntry` */
export const TREE_ENTRY_TREE = 0;
/** @internal */
export const TREE_ENTRY_BLOB = 1;
/** @internal */
export const TREE_ENTRY_GITLINK = 2;
const TREE = TREE_ENTRY_TREE;
const GITLINK = TREE_ENTRY_GITLINK;

/**
 * @internal
 * The tree entry at `at`: its kind (by its mode, `40000` a tree, `160000` a gitlink, else a
 * blob), where its name starts and its NUL (the id follows), and where the next entry starts.
 */
export function scanTreeEntry(
  data: Uint8Array,
  at: number,
): { kind: number; nameStart: number; nul: number; next: number } {
  const sp = data.indexOf(0x20, at);
  const nul = sp < 0 ? -1 : data.indexOf(0, sp);
  if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error("malformed tree");
  const len = sp - at;
  const kind =
    len === 5 &&
    data[at] === 0x34 &&
    data[at + 1] === 0x30 &&
    data[at + 2] === 0x30 &&
    data[at + 3] === 0x30 &&
    data[at + 4] === 0x30
      ? TREE
      : len === 6 &&
          data[at] === 0x31 &&
          data[at + 1] === 0x36 &&
          data[at + 2] === 0x30 &&
          data[at + 3] === 0x30 &&
          data[at + 4] === 0x30 &&
          data[at + 5] === 0x30
        ? GITLINK
        : TREE_ENTRY_BLOB;
  return { kind, nameStart: sp + 1, nul, next: nul + 21 };
}
