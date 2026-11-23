/**
 * History implementation - concrete classes for the History interface
 */

import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { BackendCapabilities } from "../backend/storage-backend.js";
import type { ObjectId } from "../common/id/index.js";
import { MissingObjectError } from "../pack/list-objects.js";
import type { PackSet } from "../pack/pack-set.js";
import type { SerializationApi } from "../serialization/serialization-api.js";
import type { DeltaApi } from "../storage/delta/delta-api.js";
import type { Blobs } from "./blobs/blobs.js";
import type { CommitGraphProvider } from "./commit-graph/commit-graph-provider.js";
import type { Commits } from "./commits/commits.js";
import type { CollectReachableOptions, History, HistoryWithOperations } from "./history.js";
import { CorruptObjectError, type GitObjects, objectFormatOf } from "./objects/git-objects.js";
import { PromisorFetchError } from "./objects/object-promisor.js";
import type { Refs } from "./refs/refs.js";
import type { Tags } from "./tags/tags.js";
import { decodeTreeEntries } from "./trees/index.js";
import type { Trees } from "./trees/trees.js";

/** The object kernel (and packs) under a history's typed stores, when it has one. */
export interface HistoryKernel {
  objects?: GitObjects;
  packs?: PackSet;
  commitGraph?: CommitGraphProvider;
}

/** A gitlink: a submodule's commit, which lives in another repository and is not walked. */
const GITLINK_MODE = 0o160000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const textDecoder = new TextDecoder();

/** A reachable object stored but unreadable or undecodable: the walk stops instead of skipping it. */
function corrupt(oid: string, what: string, cause?: unknown): CorruptObjectError {
  const reason = cause instanceof Error ? `: ${cause.message}` : "";
  return new CorruptObjectError(`object ${oid} ${what}${reason}`, { cause });
}

/** The tree and parents of a commit, from its header lines only (as git's parse_commit_buffer). */
function commitLinks(oid: string, data: Uint8Array): string[] {
  let end = data.length;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 10 && data[i + 1] === 10) {
      end = i;
      break;
    }
  }
  let tree: string | undefined;
  const parents: string[] = [];
  for (const line of textDecoder.decode(data.subarray(0, end)).split("\n")) {
    if (line.startsWith("tree ")) tree ??= line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }
  if (!tree || !OBJECT_ID.test(tree)) throw corrupt(oid, "is a commit without a valid tree");
  for (const p of parents) if (!OBJECT_ID.test(p)) throw corrupt(oid, `has an invalid parent ${p}`);
  return [tree, ...parents];
}

/** The object a tag points to (its `object` line). */
function tagTarget(oid: string, data: Uint8Array): string {
  const first = textDecoder.decode(data.subarray(0, Math.min(data.length, 128))).split("\n")[0];
  const target = first?.startsWith("object ") ? first.slice(7).trim() : "";
  if (!OBJECT_ID.test(target)) throw corrupt(oid, "is a tag without a valid object");
  return target;
}

async function readAll(content: AsyncIterable<Uint8Array>, size: number): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  let at = 0;
  for await (const chunk of content) {
    if (at + chunk.length > size) throw new Error("longer than its header says");
    data.set(chunk, at);
    at += chunk.length;
  }
  if (at !== size) throw new Error("shorter than its header says");
  return data;
}

/** Reads `content` to its end, chunk by chunk, and checks it has the `size` its header says. */
async function checkLength(content: AsyncIterable<Uint8Array>, size: number): Promise<void> {
  let length = 0;
  for await (const chunk of content) {
    length += chunk.length;
    if (length > size) throw new Error("longer than its header says");
  }
  if (length !== size) throw new Error(`shorter than its header says (${length} of ${size} bytes)`);
}

/**
 * The ids an object refers to (a commit's tree and parents, a tree's entries but gitlinks, a
 * tag's target, none for a blob), from a single read of the object; undefined if it is absent
 * (the empty tree exists even when not stored). With `verifyBlob`, a blob is read to its end
 * (inflated and streamed, never held whole) and must have the length its header says.
 *
 * An object that is stored but cannot be read, or whose content does not decode, throws
 * `CorruptObjectError`: treating it as absent would cut the walk there and let gc delete
 * everything only it leads to. Commits are read by their tree and parent lines only, so an odd
 * author line (which git accepts too) does not count as corruption.
 */
async function readChildIds(
  objects: GitObjects,
  oid: string,
  verifyBlob = false,
): Promise<string[] | undefined> {
  let obj: Awaited<ReturnType<GitObjects["get"]>>;
  try {
    obj = await objects.get(oid);
  } catch (e) {
    throw e instanceof CorruptObjectError || e instanceof PromisorFetchError
      ? e
      : corrupt(oid, "is stored but cannot be read", e);
  }
  const format = objectFormatOf(objects);
  if (!obj) return oid === format.emptyTreeId ? [] : undefined;
  const it = obj.content[Symbol.asyncIterator]();
  const content: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => it };
  try {
    switch (obj.type) {
      case "commit":
        return commitLinks(oid, await readAll(content, obj.size));
      case "tree": {
        const ids: string[] = [];
        for await (const entry of decodeTreeEntries(content, format.rawLength)) {
          if (entry.mode !== GITLINK_MODE) ids.push(entry.id);
        }
        return ids;
      }
      case "tag":
        return [tagTarget(oid, await readAll(content, obj.size))];
      case "blob":
        if (verifyBlob) await checkLength(content, obj.size);
        return [];
      default:
        return [];
    }
  } catch (e) {
    if (e instanceof CorruptObjectError) throw e;
    throw corrupt(oid, `is a ${obj.type} that cannot be read or decoded`, e);
  } finally {
    // Releases a blob's unread stream, or one a decoder left unfinished.
    await it.return?.();
  }
}

/**
 * History implementation that composes individual stores
 *
 * This is the primary implementation used by applications.
 * It wraps individual store implementations into a unified facade.
 *
 * @example
 * ```typescript
 * const history = new HistoryImpl(blobs, trees, commits, tags, refs);
 * await history.initialize();
 *
 * // Use stores
 * const blobId = await history.blobs.store(content);
 * const commit = await history.commits.load(commitId);
 *
 * await history.close();
 * ```
 */
export class HistoryImpl implements History {
  private initialized = false;

  constructor(
    readonly blobs: Blobs,
    readonly trees: Trees,
    readonly commits: Commits,
    readonly tags: Tags,
    readonly refs: Refs,
    kernel: HistoryKernel = {},
  ) {
    this.objects = kernel.objects;
    this.packs = kernel.packs;
    this.commitGraph = kernel.commitGraph;
    if (kernel.objects?.objectFormat) this.objectFormat = kernel.objects.objectFormat;
  }

  readonly objectFormat?: ObjectFormat;
  readonly objects?: GitObjects;
  readonly packs?: PackSet;
  readonly commitGraph?: CommitGraphProvider;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize refs (creates directory structure, etc.)
    if (this.refs.initialize) {
      await this.refs.initialize();
    }

    // Set up default HEAD → refs/heads/main if HEAD doesn't exist yet.
    // For new repos this creates the standard symbolic ref;
    // for existing repos HEAD is already present and this is a no-op.
    if (!(await this.refs.has("HEAD"))) {
      await this.refs.setSymbolic("HEAD", "refs/heads/main");
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    // Flush any pending operations
    // Individual stores may have their own cleanup

    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Collect all objects reachable from wants, excluding haves
   *
   * Traverses the object graph using BFS:
   * - From commits: adds tree and parent commits
   * - From trees: adds child blobs and trees (not gitlinks)
   * - From tags: adds target object
   * - Blobs: leaf nodes, no children
   *
   * A stored object that cannot be read or decoded throws `CorruptObjectError`; an absent one
   * is skipped, or throws `MissingObjectError` with `missing: "throw"` unless it is a want or
   * lies beyond the shallow boundary (see `CollectReachableOptions`). With `verifyBlobs` (the
   * default when strict), blobs are read to their end and their length checked.
   */
  async *collectReachableObjects(
    wants: Set<string>,
    exclude: Set<string>,
    options: CollectReachableOptions = {},
  ): AsyncIterable<ObjectId> {
    const visited = new Set<string>();
    const strict = options.missing === "throw";
    const shallow = new Set(options.shallow ?? []);
    const grafts = options.grafts;
    const known = options.known ?? new Set<string>();
    const verifyBlobs = options.verifyBlobs ?? strict;
    // When strict, an object referred to by a reachable one must be stored, unless the
    // reference is a shallow commit's parent; a want alone may be absent (a broken ref, a
    // reflog entry pruned long ago). Whichever is met first, the reference or the absence,
    // the other one throws.
    const required = new Set<string>();
    const missing = new Set<string>();
    const missingError = (oid: string) =>
      new MissingObjectError(`object ${oid} is missing (reachable, not stored)`);

    // Expand exclude set to include all ancestor commits
    const excludeExpanded = new Set<string>(exclude);
    for (const excludeOid of exclude) {
      try {
        for await (const ancestorOid of this.commits.walkAncestry(excludeOid)) {
          excludeExpanded.add(ancestorOid);
        }
      } catch {
        // Not a commit, skip
      }
    }

    // BFS from wants; a head index instead of shift() keeps each dequeue O(1)
    const queue: string[] = [...wants];
    const objects = this.objects;
    // When strict, the parents of shallow commits wait until everything else is walked: what
    // only they lead to (beyond the boundary) is then walked leniently, so an absent or
    // corrupt object there is left out instead of aborting, as git does not walk past the
    // boundary at all. Whatever was reached before that is required.
    const deferred: string[] = [];
    let lenient = false;
    /** Queues what `from` refers to; `parents` of a shallow commit may be absent. */
    const enqueue = (from: string, ids: string[], parents: string[] = []) => {
      const optionalParents = shallow.has(from);
      for (const id of [...ids, ...(optionalParents ? [] : parents)]) {
        if (strict && !lenient) {
          if (missing.has(id)) throw missingError(id);
          required.add(id);
        }
        if (!visited.has(id) && !excludeExpanded.has(id)) queue.push(id);
      }
      if (optionalParents) {
        for (const id of parents) {
          if (!visited.has(id) && !excludeExpanded.has(id)) {
            (strict && !lenient ? deferred : queue).push(id);
          }
        }
      }
    };
    const absent = (oid: string) => {
      if (!strict) return;
      if (required.has(oid)) throw missingError(oid);
      missing.add(oid);
    };

    for (let head = 0; ; head++) {
      if (head >= queue.length) {
        if (lenient || deferred.length === 0) break;
        lenient = true;
        queue.push(...deferred);
      }
      const oid = queue[head] as string;

      if (visited.has(oid) || excludeExpanded.has(oid) || known.has(oid)) {
        continue;
      }
      visited.add(oid);

      let children: string[] | undefined;
      try {
        children = objects
          ? // One read per object: the header gives the type, the same stream is decoded.
            await readChildIds(objects, oid, verifyBlobs && !lenient)
          : await this.readChildIdsFromStores(oid);
      } catch (e) {
        if (lenient && e instanceof CorruptObjectError) continue;
        throw e;
      }
      if (children === undefined) {
        if (!lenient) absent(oid);
        continue;
      }
      yield oid;
      // a commit's children are its tree, then its parents
      if (shallow.has(oid)) {
        // the shallow file overrides a graft (register_shallow): no grafted parents
        enqueue(oid, children.slice(0, 1), children.slice(1));
      } else {
        // a grafted commit's grafted parents besides its recorded ones (repack keeps the true
        // parents, prune walks the grafted ones); required as parents are (git dies: "Could
        // not read <id>", "Failed to traverse parents of commit <id>")
        const grafted = grafts?.get(oid);
        const extra = grafted?.filter((id) => !children.includes(id));
        enqueue(oid, extra?.length ? [...children, ...extra] : children);
      }
    }
  }

  /**
   * The ids an object refers to, as `readChildIds`, through the typed stores when there is no
   * object kernel; undefined if it is absent. Their has() throws for an object that is stored
   * but unreadable; a load that fails after has() said yes is corruption too, never an absent
   * object. (Commits.load parses the whole commit, so here a commit with an author line it
   * cannot parse counts as corrupt.)
   */
  private async readChildIdsFromStores(oid: string): Promise<string[] | undefined> {
    if (await this.commits.has(oid)) {
      let commit: Awaited<ReturnType<Commits["load"]>>;
      try {
        commit = await this.commits.load(oid);
      } catch (e) {
        throw e instanceof CorruptObjectError
          ? e
          : corrupt(oid, "is a commit that cannot be decoded", e);
      }
      if (!commit) throw corrupt(oid, "is a commit that cannot be decoded");
      return [commit.tree, ...commit.parents];
    }
    if (await this.trees.has(oid)) {
      const ids: string[] = [];
      try {
        const tree = await this.trees.load(oid);
        if (!tree) throw new Error("not found after has()");
        for await (const entry of tree) if (entry.mode !== GITLINK_MODE) ids.push(entry.id);
      } catch (e) {
        throw e instanceof CorruptObjectError
          ? e
          : corrupt(oid, "is a tree that cannot be decoded", e);
      }
      return ids;
    }
    if (await this.tags.has(oid)) {
      let target: string | undefined;
      try {
        target = (await this.tags.load(oid))?.object;
      } catch (e) {
        throw e instanceof CorruptObjectError
          ? e
          : corrupt(oid, "is a tag that cannot be decoded", e);
      }
      if (!target) throw corrupt(oid, "is a tag that cannot be decoded");
      return [target];
    }
    if (await this.blobs.has(oid)) return []; // a blob: no children to walk
    return undefined;
  }
}

/**
 * History implementation with storage operations
 *
 * Used when delta compression, serialization, or GC is needed.
 * Provides access to low-level storage operations without duplicating stores.
 *
 * @example
 * ```typescript
 * const history = new HistoryWithOperationsImpl(
 *   blobs, trees, commits, tags, refs,
 *   delta, serialization, capabilities,
 *   initializeFn, closeFn
 * );
 * await history.initialize();
 *
 * // Use delta API for GC
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, delta);
 * await history.delta.endBatch();
 *
 * // Use serialization for transport
 * const pack = history.serialization.createPack(objectIds);
 *
 * await history.close();
 * ```
 */
export class HistoryWithOperationsImpl extends HistoryImpl implements HistoryWithOperations {
  constructor(
    blobs: Blobs,
    trees: Trees,
    commits: Commits,
    tags: Tags,
    refs: Refs,
    readonly delta: DeltaApi,
    readonly serialization: SerializationApi,
    readonly capabilities: BackendCapabilities,
    private readonly initializeOps: () => Promise<void>,
    private readonly closeOps: () => Promise<void>,
    kernel: HistoryKernel = {},
  ) {
    super(blobs, trees, commits, tags, refs, kernel);
  }

  async initialize(): Promise<void> {
    // Initialize operations first (creates storage structures)
    await this.initializeOps();

    // Then initialize refs
    await super.initialize();
  }

  async close(): Promise<void> {
    // Close stores first
    await super.close();

    // Then close operations (flushes data)
    await this.closeOps();
  }
}
