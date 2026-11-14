/**
 * createStorageRepositoryFacade — build the transport's {@link RepositoryFacade}
 * plus its {@link RefStore} over the `@statewalker/webrun-storage` byte seam.
 *
 * It mirrors `createVcsCore`'s internal wiring
 * (packages/vcs-core/src/vcs-core/index.ts): object bytes ride
 * {@link blobStoreToRawStorage}(objects) → {@link createGitObjectStore}, refs ride
 * {@link kvStoreRefs}(refs), and the {@link History} composed from those stores
 * backs both a {@link DefaultSerializationApi} (packs) and the
 * {@link VcsRepositoryFacade}. The returned {@link RefStore} adapts the same core
 * {@link Refs} into the transport-layer RefStore shape (the same adaptation the
 * vcs-transport interop helper `createTransportRefStore` performs).
 *
 * With this, the transport's object-exchange (`exportPack`/`importPack`/
 * `walkAncestors`, which need server-side reachability) runs against a History
 * backed by `@statewalker/webrun-storage` instead of the old mem/git backend.
 */

import {
  blobStoreToRawStorage,
  createBlobs,
  createCommits,
  createGitObjectStore,
  createHistoryFromStores,
  createTags,
  createTrees,
  DefaultSerializationApi,
  kvStoreRefs,
  type SerializationApi,
} from "@statewalker/vcs-core";
import {
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import type { BlobStore, KvStore } from "@statewalker/webrun-storage";
import { createVcsRepositoryFacade } from "./vcs-repository-facade.js";

/** Byte-seam stores backing a storage-backed transport RepositoryFacade. */
export interface StorageRepositoryFacadeDeps {
  /** Content-addressed git object bytes (blobs, trees, commits, tags). */
  objects: BlobStore;
  /** Mutable ref storage (branch/tag pointers). */
  refs: KvStore;
}

/** A transport {@link RepositoryFacade} plus its matching transport {@link RefStore}. */
export interface StorageRepositoryFacade {
  /** RepositoryFacade for transport pack import/export + reachability. */
  facade: RepositoryFacade;
  /** Transport RefStore over the same storage-backed refs. */
  refStore: RefStore;
}

/**
 * Build a transport {@link RepositoryFacade} + {@link RefStore} over the
 * `@statewalker/webrun-storage` byte seam.
 *
 * @param deps - Byte-seam stores (git objects + refs).
 * @returns The transport facade and a RefStore over the same refs.
 */
export function createStorageRepositoryFacade(
  deps: StorageRepositoryFacadeDeps,
): StorageRepositoryFacade {
  const raw = blobStoreToRawStorage(deps.objects);
  const objectStore = createGitObjectStore(raw);
  const coreRefs = kvStoreRefs(deps.refs);
  const history = createHistoryFromStores({
    blobs: createBlobs(objectStore),
    trees: createTrees(objectStore),
    commits: createCommits(objectStore),
    tags: createTags(objectStore),
    refs: coreRefs,
  });
  const serialization: SerializationApi = new DefaultSerializationApi({ history });
  const facade = createVcsRepositoryFacade({ history, serialization });
  const refStore = createTransportRefStore(coreRefs);
  return { facade, refStore };
}
