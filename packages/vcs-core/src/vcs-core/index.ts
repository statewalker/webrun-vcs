/**
 * VcsCore — a thin, normalized facade over the existing vcs-core git engine,
 * wired to run over the `@statewalker/webrun-storage` byte seam.
 *
 * It builds the existing {@link History} (objects over
 * {@link blobStoreToRawStorage}, refs over {@link kvStoreRefs}), a
 * {@link DefaultSerializationApi} for packs and a {@link GcOrchestrator} for gc,
 * then returns the normalized target API by pure DELEGATION — no new engine
 * logic. Normalization is limited to shape adjustments: collect async-iterables
 * to arrays, take the first merge base, hydrate ids into commits, unify `has`,
 * and rename gc counters.
 *
 * sha256 is deferred: {@link VcsCore.hash} is always `"sha1"`; passing
 * `opts.hash === "sha256"` throws rather than silently accepting.
 */

import type { BlobStore, ByteStream, KvStore, RefStore } from "@statewalker/webrun-storage";
import { refStore } from "@statewalker/webrun-storage";
import type { ObjectId } from "../common/id/index.js";
import { GcOrchestrator, MemoryGcStrategy } from "../gc/index.js";
import type { Commit } from "../history/commits/commits.js";
import {
  createBlobs,
  createCommits,
  createGitObjectStore,
  createHistoryFromStores,
  createTags,
  createTrees,
  type History,
} from "../history/index.js";
import type { Tag } from "../history/tags/tags.js";
import type { TreeEntry } from "../history/trees/tree-entry.js";
import { DefaultSerializationApi } from "../serialization/serialization-api.impl.js";
import type { SerializationApi } from "../serialization/serialization-api.js";
import { blobStoreToRawStorage } from "../storage/adapters/blob-store-raw-storage.js";
import { kvStoreRefs } from "../storage/adapters/kv-store-refs.js";
import type { RawStorage } from "../storage/raw/raw-storage.js";

/** Object id (git SHA-1 hex string). */
export type Oid = ObjectId;

/** Supported hash algorithms. Only `"sha1"` is implemented; `"sha256"` is deferred. */
export type HashAlgo = "sha1" | "sha256";

/** Byte-seam dependencies backing a {@link VcsCore}. */
export interface VcsCoreDeps {
  /** Content-addressed object bytes (blobs + git objects). */
  objects: BlobStore;
  /** Mutable ref storage (branch/tag pointers). */
  refs: KvStore;
}

/** Options for {@link createVcsCore}. */
export interface VcsCoreOptions {
  /** Hash algorithm. Default `"sha1"`; `"sha256"` is deferred and throws. */
  hash?: HashAlgo;
}

/**
 * Normalized git object API over the storage seam.
 *
 * A hydrated commit as yielded by {@link VcsCore.log}: the {@link Commit} plus
 * its own id.
 */
export type LogEntry = Commit & { id: Oid };

export interface VcsCore {
  /** Hash algorithm in use (always `"sha1"`). */
  readonly hash: HashAlgo;

  /** Read blob bytes (empty stream if absent, per the seam convention). */
  readBlob(id: Oid): ByteStream;
  /** Read a tree, collected to an array (the engine yields an async-iterable). */
  readTree(id: Oid): Promise<TreeEntry[]>;
  /** Read a commit; throws if the id is not a stored commit. */
  readCommit(id: Oid): Promise<Commit>;
  /** Read an annotated tag; throws if the id is not a stored tag. */
  readTag(id: Oid): Promise<Tag>;

  /** Store blob bytes, returning the object id. */
  writeBlob(bytes: ByteStream): Promise<Oid>;
  /** Store a tree from entries, returning the object id. */
  writeTree(entries: TreeEntry[]): Promise<Oid>;
  /** Store a commit, returning the object id. */
  writeCommit(c: Commit): Promise<Oid>;

  /** Whether any object (blob/tree/commit/tag) with this id exists. */
  has(id: Oid): Promise<boolean>;

  /** Ref storage, target-shaped: `read` / `compareAndSet` / `list`. */
  readonly refs: RefStore;

  /** First merge base of `a` and `b`, or `undefined` if they share none. */
  mergeBase(a: Oid, b: Oid): Promise<Oid | undefined>;
  /** Whether `a` is an ancestor of `b`. */
  isAncestor(a: Oid, b: Oid): Promise<boolean>;
  /** Walk ancestry from `from`, yielding hydrated commits (each with `.id`). */
  log(from: Oid): AsyncIterable<LogEntry>;

  /** Rewrite reachable objects through the pack path (idempotent for loose stores). */
  repack(): Promise<void>;
  /** Garbage-collect unreachable objects; returns the pruned count. */
  gc(): Promise<{ pruned: number }>;

  /** Import a pack, storing its objects and yielding their ids. */
  readPack(pack: ByteStream): AsyncIterable<Oid>;
  /** Build a pack over the given object ids. */
  writePack(ids: Oid[]): ByteStream;
}

/**
 * Build a {@link VcsCore} over the storage seam.
 *
 * @param deps Byte-seam stores (objects + refs).
 * @param opts Options; `hash` defaults to `"sha1"` (`"sha256"` throws).
 */
export function createVcsCore(deps: VcsCoreDeps, opts: VcsCoreOptions = {}): VcsCore {
  const hash: HashAlgo = opts.hash ?? "sha1";
  if (hash !== "sha1") {
    throw new Error(`sha256 not yet supported (requested hash: "${hash}")`);
  }

  // Build the existing engine over the seam. `raw` is reused by the GC strategy
  // so pruning removes the same bytes the engine reads.
  const raw: RawStorage = blobStoreToRawStorage(deps.objects);
  const objects = createGitObjectStore(raw);
  const history: History = createHistoryFromStores({
    blobs: createBlobs(objects),
    trees: createTrees(objects),
    commits: createCommits(objects),
    tags: createTags(objects),
    refs: kvStoreRefs(deps.refs),
  });
  const serialization: SerializationApi = new DefaultSerializationApi({ history });

  const readCommit = async (id: Oid): Promise<Commit> => {
    const commit = await history.commits.load(id);
    if (!commit) throw new Error(`Commit not found: ${id}`);
    return commit;
  };

  return {
    hash,

    readBlob(id: Oid): ByteStream {
      return (async function* () {
        const content = await history.blobs.load(id);
        if (content) yield* content;
      })();
    },

    async readTree(id: Oid): Promise<TreeEntry[]> {
      const tree = await history.trees.load(id);
      if (!tree) throw new Error(`Tree not found: ${id}`);
      const entries: TreeEntry[] = [];
      for await (const entry of tree) entries.push(entry);
      return entries;
    },

    readCommit,

    async readTag(id: Oid): Promise<Tag> {
      const tag = await history.tags.load(id);
      if (!tag) throw new Error(`Tag not found: ${id}`);
      return tag;
    },

    writeBlob(bytes: ByteStream): Promise<Oid> {
      return history.blobs.store(bytes);
    },

    writeTree(entries: TreeEntry[]): Promise<Oid> {
      return history.trees.store(entries);
    },

    writeCommit(c: Commit): Promise<Oid> {
      return history.commits.store(c);
    },

    has(id: Oid): Promise<boolean> {
      return objects.has(id);
    },

    refs: refStore(deps.refs),

    async mergeBase(a: Oid, b: Oid): Promise<Oid | undefined> {
      const bases = await history.commits.findMergeBase(a, b);
      return bases[0];
    },

    isAncestor(a: Oid, b: Oid): Promise<boolean> {
      return history.commits.isAncestor(a, b);
    },

    log(from: Oid): AsyncIterable<LogEntry> {
      return (async function* () {
        for await (const id of history.commits.walkAncestry(from)) {
          yield { ...(await readCommit(id)), id };
        }
      })();
    },

    async repack(): Promise<void> {
      async function* allObjectIds(): AsyncIterable<Oid> {
        yield* history.blobs.keys();
        yield* history.trees.keys();
        yield* history.commits.keys();
        yield* history.tags.keys();
      }
      await serialization.importPack(serialization.createPack(allObjectIds()));
    },

    async gc(): Promise<{ pruned: number }> {
      const orchestrator = new GcOrchestrator(history, new MemoryGcStrategy(raw));
      const result = await orchestrator.run();
      return { pruned: result.prunedObjects };
    },

    readPack(pack: ByteStream): AsyncIterable<Oid> {
      return (async function* () {
        const reader = serialization.createPackReader(pack);
        for await (const entry of reader.entries()) {
          yield await serialization.importObject(entry.type, entry.resolvedContent);
        }
      })();
    },

    writePack(ids: Oid[]): ByteStream {
      async function* idStream(): AsyncIterable<Oid> {
        yield* ids;
      }
      return serialization.createPack(idStream());
    },
  };
}
