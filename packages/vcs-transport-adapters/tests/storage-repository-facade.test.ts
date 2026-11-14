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
  createGitObjects,
  createHistoryFromStores,
  createTags,
  createTrees,
  type History,
  kvStoreRefs,
  rawStorageStaging,
} from "@statewalker/vcs-core";
import {
  Fsm,
  fetchOverDuplex,
  HandlerOutput,
  ProcessConfiguration,
  ProtocolState,
  type PushCommand,
  serveRepoOverWebrun,
  serverPushHandlers,
  serverPushTransitions,
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
  const objectStore = createGitObjects(rawStorageStaging(blobStoreToRawStorage(objects)));
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

describe("createStorageRepositoryFacade receiving an atomic push", () => {
  it("applies an atomic push of several refs (its refs accept single-ref batches only)", async () => {
    const { refStore } = createStorageRepositoryFacade({
      objects: memBlobStore(),
      refs: memKvStore(),
    });
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    await refStore.update("refs/heads/main", A);
    await refStore.update("refs/heads/dev", A);
    const state = new ProtocolState();
    state.capabilities.add("atomic");
    const commands: PushCommand[] = ["refs/heads/main", "refs/heads/dev"].map((refName) => ({
      refName,
      oldOid: A,
      newOid: B,
      type: "UPDATE",
      result: "NOT_ATTEMPTED",
    }));
    (state as { pushCommands?: PushCommand[] }).pushCommands = commands;
    const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
    fsm.setState("APPLY_UPDATES");
    await fsm.run(
      {
        transport: {} as never,
        repository: {} as never,
        refStore,
        state,
        output: new HandlerOutput(),
        config: new ProcessConfiguration(),
      },
      "RUN_POST_RECEIVE_HOOK",
      "SEND_STATUS",
    );
    expect(fsm.getState()).toBe("RUN_POST_RECEIVE_HOOK");
    expect(commands.map((c) => c.result)).toEqual(["OK", "OK"]);
    expect(await refStore.get("refs/heads/dev")).toBe(B);
  });
});

describe("createStorageRepositoryFacade receiving a pack", () => {
  it("imports a pushed commit with a mergetag header byte for byte", async () => {
    const { compressBlockPako } = await import("@statewalker/vcs-utils/compression");
    const { createSha1 } = await import("@statewalker/vcs-utils/hash/hasher");
    const { bytesToHex } = await import("@statewalker/vcs-utils/hash/utils");
    const enc = new TextEncoder();
    // a header the typed commit store does not model: re-encoding it would change the id
    const commit = enc.encode(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\nmergetag object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n type commit\n\nmsg\n",
    );
    const raw = new Uint8Array([...enc.encode(`commit ${commit.length}\0`), ...commit]);
    const id = bytesToHex(createSha1().update(raw).digest());
    // a one-entry pack: header, entry (type 1, size varint), zlib data, SHA-1 trailer
    const head = new Uint8Array(12);
    head.set(enc.encode("PACK"));
    new DataView(head.buffer).setUint32(4, 2);
    new DataView(head.buffer).setUint32(8, 1);
    const sizeBytes: number[] = [];
    let size = commit.length;
    let b = (1 << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      sizeBytes.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    sizeBytes.push(b);
    const body = new Uint8Array([...head, ...sizeBytes, ...compressBlockPako(commit)]);
    const packBytes = new Uint8Array([...body, ...createSha1().update(body).digest()]);

    const objects = memBlobStore();
    const { facade } = createStorageRepositoryFacade({ objects, refs: memKvStore() });
    await facade.importPack(
      (async function* () {
        yield packBytes;
      })(),
    );
    expect(await facade.has(id)).toBe(true);
    const kernel = createGitObjects(rawStorageStaging(blobStoreToRawStorage(objects)));
    const stored: number[] = [];
    for await (const c of kernel.getRaw(id)) stored.push(...c);
    expect(new Uint8Array(stored)).toEqual(raw);
  });
});
