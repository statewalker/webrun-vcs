/**
 * `git rev-list --objects`: the objects reachable from some tips (wants) and not from others
 * (haves), after git's revision.c / list-objects.c and JGit's ObjectWalk:
 *
 *  - commits are walked newest first (by committer time); a commit reached from a have is
 *    uninteresting, and so are its ancestors. The walk stops once every queued commit is
 *    uninteresting, plus a few more commits (git's SLOP) to absorb clock skew; a commit found
 *    uninteresting after it was listed is dropped before anything is yielded;
 *  - the trees of the uninteresting commits met on the way (the boundary) and of the haves are
 *    marked uninteresting with everything below them, so a tree or blob the receiver has through
 *    its own commits is not listed again;
 *  - commits are yielded first, then wanted tags, then the trees and blobs of each listed commit
 *    (with their path, for the delta search's name hash).
 *
 * Memory is a map of flags per visited id and the parsed parents of walked commits; objects are
 * read one at a time and never kept.
 */
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import type { GitObject, GitObjects } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";

/** What `listObjects` reads: objects by id. */
export type ListObjectsSource = Pick<GitObjects, "get">;

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
   * Called for each tree and blob below the boundary (the trees of the uninteresting commits
   * met, and tree haves), with its path: the receiver's objects, bases for a thin pack.
   */
  onBoundary?: (object: ListedObject) => void;
}

/** One listed object, as `git rev-list --objects` prints it. */
export interface ListedObject {
  id: ObjectId;
  type: ObjectTypeString;
  /** The path of a tree or blob below its commit's root tree ("" for a root tree). */
  path?: string;
}

/** A want the store does not have. */
export class MissingObjectError extends Error {
  override name = "MissingObjectError";
}

const SEEN = 1;
const UNINTERESTING = 2;
const ADDED = 4;
/** Commits walked after only uninteresting ones remain queued (git's SLOP). */
const SLOP = 5;

interface CommitInfo {
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
  const flags = new Map<ObjectId, number>();
  const has = (id: ObjectId, f: number) => ((flags.get(id) ?? 0) & f) !== 0;
  const set = (id: ObjectId, f: number) => flags.set(id, (flags.get(id) ?? 0) | f);
  const commits = new Map<ObjectId, CommitInfo>();
  const shallow = new Set(options.shallow ?? []);
  const parentsOf = (id: ObjectId, c: CommitInfo) => (shallow.has(id) ? [] : c.parents);

  const read = async (id: ObjectId): Promise<{ type: ObjectTypeString; data: Uint8Array }> => {
    const o = await objects.get(id);
    if (!o) throw new MissingObjectError(`object ${id} is missing`);
    return { type: o.type, data: await collect(o) };
  };
  const tryRead = (id: ObjectId) =>
    read(id).catch((e) => {
      if (e instanceof MissingObjectError) return undefined;
      throw e;
    });

  const parseCommit = async (id: ObjectId, required: boolean): Promise<CommitInfo | undefined> => {
    let c = commits.get(id);
    if (c) return c;
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
  const pendingTrees: ObjectId[] = [];
  const pendingBlobs: ObjectId[] = [];
  const boundaryTrees: ObjectId[] = [];

  /** Follows tags down to their target and queues it. */
  const start = async (tip: ObjectId, uninteresting: boolean) => {
    let id = tip;
    for (;;) {
      const o = uninteresting ? await tryRead(id) : await read(id);
      if (!o) return;
      if (uninteresting) set(id, UNINTERESTING);
      switch (o.type) {
        case "tag": {
          if (!uninteresting && !has(id, ADDED)) {
            set(id, ADDED);
            tags.push(id);
          }
          id = parseTagTarget(id, o.data);
          continue;
        }
        case "commit":
          commits.set(id, commits.get(id) ?? parseCommitHeader(id, o.data));
          await enqueue(id, uninteresting);
          return;
        case "tree":
          (uninteresting ? boundaryTrees : pendingTrees).push(id);
          return;
        case "blob":
          if (!uninteresting) pendingBlobs.push(id);
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
    if (uninteresting) boundaryTrees.push(c.tree);
    else listed.push(id);
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
  /** trees already walked to their leaves as uninteresting */
  const boundary = new Set<ObjectId>();
  for (const t of boundaryTrees) await markTreeUninteresting(t);

  /** Marks a tree and everything below it uninteresting; each tree is read once. */
  async function markTreeUninteresting(root: ObjectId) {
    const onBoundary = options.onBoundary;
    const stack = [{ id: root, path: "" }];
    while (stack.length) {
      const { id: t, path } = stack.pop() as { id: ObjectId; path: string };
      if (boundary.has(t)) continue;
      boundary.add(t);
      set(t, UNINTERESTING);
      const o = await tryRead(t);
      if (o?.type !== "tree") continue;
      onBoundary?.({ id: t, type: "tree", path });
      for (const e of treeEntries(o.data)) {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.kind === "tree") stack.push({ id: e.id, path: p });
        else if (e.kind === "blob" && !boundary.has(e.id)) {
          boundary.add(e.id);
          set(e.id, UNINTERESTING);
          onBoundary?.({ id: e.id, type: "blob", path: p });
        }
      }
    }
  }

  // ---- output ----
  for (const id of kept) yield { id, type: "commit" };
  for (const id of tags) if (!has(id, UNINTERESTING)) yield { id, type: "tag" };

  async function* walkTree(root: ObjectId, rootPath: string): AsyncGenerator<ListedObject> {
    const stack: { id: ObjectId; path: string }[] = [{ id: root, path: rootPath }];
    while (stack.length) {
      const { id, path } = stack.pop() as { id: ObjectId; path: string };
      if (has(id, UNINTERESTING | ADDED)) continue;
      set(id, ADDED);
      const o = await read(id);
      if (o.type !== "tree") throw new Error(`object ${id} is a ${o.type}, not a tree`);
      yield { id, type: "tree", path };
      const subtrees: { id: ObjectId; path: string }[] = [];
      for (const e of treeEntries(o.data)) {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.kind === "tree") subtrees.push({ id: e.id, path: p });
        else if (e.kind === "blob" && !has(e.id, UNINTERESTING | ADDED)) {
          set(e.id, ADDED);
          yield { id: e.id, type: "blob", path: p };
        }
      }
      // depth first, in tree order
      for (let i = subtrees.length - 1; i >= 0; i--)
        stack.push(subtrees[i] as (typeof subtrees)[0]);
    }
  }

  for (const id of kept) yield* walkTree((commits.get(id) as CommitInfo).tree, "");
  for (const id of pendingTrees) yield* walkTree(id, "");
  for (const id of pendingBlobs) {
    if (has(id, UNINTERESTING | ADDED)) continue;
    set(id, ADDED);
    yield { id, type: "blob" };
  }
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

/** The tree and parents of a commit, and its committer time. */
function parseCommitHeader(id: ObjectId, data: Uint8Array): CommitInfo {
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

function parseTagTarget(id: ObjectId, data: Uint8Array): ObjectId {
  const text = dec.decode(data.subarray(0, Math.min(data.length, 64)));
  if (!text.startsWith("object ")) throw new Error(`tag ${id} has no object`);
  return text.slice(7, 47);
}

function indexOfBlankLine(data: Uint8Array): number {
  for (let i = 0; i + 1 < data.length; i++) if (data[i] === 10 && data[i + 1] === 10) return i;
  return data.length;
}

/** A tree's entries: subtrees, blobs (files and symlinks) and gitlinks (submodule commits). */
function* treeEntries(
  data: Uint8Array,
): Generator<{ kind: "tree" | "blob" | "gitlink"; name: string; id: ObjectId }> {
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error("malformed tree");
    const mode = dec.decode(data.subarray(p, sp));
    const name = dec.decode(data.subarray(sp + 1, nul));
    const id = bytesToHex(data.subarray(nul + 1, nul + 21));
    p = nul + 21;
    const kind = mode === "40000" ? "tree" : mode === "160000" ? "gitlink" : "blob";
    yield { kind, name, id };
  }
}
