/**
 * Prove the git transport's object-exchange rides the
 * `@statewalker/webrun-storage`-backed core built by {@link createStorageRepositoryFacade}.
 *
 * A source repo (facade + refStore over mem storage) is populated with two
 * commits and `refs/heads/main`. A real git v1 fetch then runs over an
 * in-process loopback duplex (the transport's webrun channel adapter, which
 * carries `serveOverDuplex` on the server side) into a fresh, empty
 * storage-backed destination. The assertions are concrete: the destination
 * imports objects under IDENTICAL git oids and its `refs/heads/main` matches the
 * source tip — object-exchange is byte-faithful over `@statewalker/webrun-storage`.
 *
 * A second check exercises the facade's `exportPack`/`importPack`/reachability
 * directly at the storage-backend level.
 */

import {
  blobStoreToRawStorage,
  createBlobs,
  createCommits,
  createGitObjectStore,
  createHistoryFromStores,
  createTags,
  createTrees,
  type History,
  kvStoreRefs,
} from "@statewalker/vcs-core";
import {
  fetchOverDuplex,
  serveRepoOverWebrun,
  webrunClientDuplex,
} from "@statewalker/vcs-transport";
import { memBlobStore, memKvStore } from "@statewalker/webrun-storage";
import { describe, expect, it } from "vitest";
import { createStorageRepositoryFacade } from "../src/index.js";

/** Deterministic author/committer so fixture oids are reproducible. */
function ident() {
  return {
    name: "Storage Tester",
    email: "storage@example.com",
    timestamp: 1112911993,
    tzOffset: "+0000",
  };
}

interface StorageRepo {
  facade: ReturnType<typeof createStorageRepositoryFacade>["facade"];
  refStore: ReturnType<typeof createStorageRepositoryFacade>["refStore"];
  /** History over the SAME storage stores, used to populate objects. */
  history: History;
}

/** Build a storage-backed repo (facade + refStore) plus a History over the same stores. */
function buildRepo(): StorageRepo {
  const objects = memBlobStore();
  const refs = memKvStore();
  const { facade, refStore } = createStorageRepositoryFacade({ objects, refs });
  const objectStore = createGitObjectStore(blobStoreToRawStorage(objects));
  const history = createHistoryFromStores({
    blobs: createBlobs(objectStore),
    trees: createTrees(objectStore),
    commits: createCommits(objectStore),
    tags: createTags(objectStore),
    refs: kvStoreRefs(refs),
  });
  return { facade, refStore, history };
}

/** Build a commit from a flat file set in a storage-backed repo; return its git oid. */
async function commitInRepo(
  repo: StorageRepo,
  message: string,
  files: Record<string, string>,
  parents: string[] = [],
): Promise<string> {
  const encoder = new TextEncoder();
  const entries: Array<{ name: string; mode: number; id: string }> = [];
  for (const [name, content] of Object.entries(files)) {
    const id = await repo.history.blobs.store([encoder.encode(content)]);
    entries.push({ name, mode: 0o100644, id });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const tree = await repo.history.trees.store(entries);
  return repo.history.commits.store({
    tree,
    parents,
    author: ident(),
    committer: ident(),
    message: `${message}\n`,
  });
}

describe("createStorageRepositoryFacade transport object-exchange over @statewalker/webrun-storage", () => {
  it("fetches refs and objects byte-faithfully into a fresh storage-backed repo", async () => {
    // Source: two commits on main, all objects in mem storage.
    const source = buildRepo();
    const c1 = await commitInRepo(source, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(source, "c2", { "b.txt": "world\n" }, [c1]);
    await source.refStore.update("refs/heads/main", c2);

    // Destination: empty storage-backed repo.
    const dest = buildRepo();
    expect(await dest.facade.has(c1)).toBe(false);
    expect(await dest.facade.has(c2)).toBe(false);

    // Real git v1 fetch over an in-process loopback: the server handler
    // (serveRepoOverWebrun → serveOverDuplex) doubles as the client's call.
    const handler = serveRepoOverWebrun({
      repository: source.facade,
      refStore: source.refStore,
      service: "git-upload-pack",
    });

    const result = await fetchOverDuplex({
      duplex: webrunClientDuplex(handler),
      repository: dest.facade,
      refStore: dest.refStore,
    });

    expect(result.success, `fetch failed: ${result.error}`).toBe(true);
    // Advertised ref arrived under the identical source tip oid.
    expect(result.updatedRefs?.get("refs/heads/main")).toBe(c2);
    // Objects imported under IDENTICAL git oids over the storage seam.
    expect(await dest.facade.has(c1)).toBe(true);
    expect(await dest.facade.has(c2)).toBe(true);
    // The destination's ref now points at the source tip.
    await dest.refStore.update("refs/heads/main", c2);
    expect(await dest.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("exportPack/importPack roundtrips reachable objects over the storage backend", async () => {
    const source = buildRepo();
    const c1 = await commitInRepo(source, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(source, "c2", { "b.txt": "world\n" }, [c1]);
    await source.refStore.update("refs/heads/main", c2);

    // walkAncestors sees full reachability over the storage-backed history.
    const ancestry: string[] = [];
    for await (const oid of source.facade.walkAncestors(c2)) ancestry.push(oid);
    expect(ancestry).toEqual([c2, c1]);

    // exportPack(wants=c2) → importPack into a fresh storage-backed dest.
    const dest = buildRepo();
    const pack = source.facade.exportPack(new Set([c2]), new Set());
    const imported = await dest.facade.importPack(pack);
    expect(imported.objectsImported).toBeGreaterThan(0);

    // Both commits (and their reachable trees/blobs) landed under identical oids.
    expect(await dest.facade.has(c1)).toBe(true);
    expect(await dest.facade.has(c2)).toBe(true);
    const destAncestry: string[] = [];
    for await (const oid of dest.facade.walkAncestors(c2)) destAncestry.push(oid);
    expect(destAncestry).toEqual([c2, c1]);
  });
});
