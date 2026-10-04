/**
 * B1 SPIKE — prove the existing vcs-core git engine runs unchanged over the new
 * `@statewalker/storage` byte seam.
 *
 * The bytes and oids produced through a storage-backed {@link RawStorage} (built
 * from `memBlobStore()` via the {@link blobStoreToRawStorage} adapter)
 * must be byte-identical to those the native `MemoryRawStorage` produces — same
 * git wire format, same SHA-1 oids, same empty-tree oid, same pack roundtrip.
 * Any divergence is a real seam bug (most likely a range/size mismatch).
 */

import { memBlobStore } from "@statewalker/storage";
import { describe, expect, it } from "vitest";

import type { PersonIdent } from "../src/history/index.js";
import {
  createGitObjectStore,
  createHistoryFromComponents,
  type History,
} from "../src/history/index.js";
import { DefaultSerializationApi } from "../src/serialization/serialization-api.impl.js";
import type { SerializationApi } from "../src/serialization/serialization-api.js";
import { blobStoreToRawStorage } from "../src/storage/adapters/blob-store-raw-storage.js";

/** Build a History + SerializationApi over the storage seam (memBlobStore). */
function seamHistory(): { history: History; serialization: SerializationApi } {
  const raw = blobStoreToRawStorage(memBlobStore());
  const objects = createGitObjectStore(raw);
  const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
  const serialization = new DefaultSerializationApi({ history });
  return { history, serialization };
}

const person = (): PersonIdent => ({
  name: "Ada Lovelace",
  email: "ada@example.com",
  timestamp: 1_700_000_000,
  tzOffset: "+0000",
});

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe("B1 spike: vcs-core git engine over the @statewalker/storage seam", () => {
  it("blob write→read roundtrip returns identical bytes", async () => {
    const { history } = seamHistory();
    await history.initialize();
    const payload = new TextEncoder().encode("Hello, seam!");
    const id = await history.blobs.store([payload]);
    expect(await collect((await history.blobs.load(id))!)).toEqual(payload);
    await history.close();
  });

  it("empty tree resolves to git's canonical empty-tree oid over the seam", async () => {
    const { history } = seamHistory();
    await history.initialize();
    const emptyId = await history.trees.store([]);
    expect(emptyId).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(history.trees.getEmptyTreeId()).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    await history.close();
  });

  it("tree write→read roundtrip preserves entries and oid", async () => {
    const { history } = seamHistory();
    await history.initialize();
    const blobId = await history.blobs.store([new Uint8Array([1, 2, 3])]);
    const treeId = await history.trees.store([{ name: "file.txt", mode: 0o100644, id: blobId }]);
    const loaded: Array<{ name: string; mode: number; id: string }> = [];
    for await (const entry of (await history.trees.load(treeId))!) loaded.push(entry);
    expect(loaded).toEqual([{ name: "file.txt", mode: 0o100644, id: blobId }]);
    await history.close();
  });

  it("commit write→read roundtrip preserves parents/author/committer/message", async () => {
    const { history } = seamHistory();
    await history.initialize();
    const tree = await history.trees.store([]);
    const parentId = await history.commits.store({
      tree,
      parents: [],
      author: person(),
      committer: person(),
      message: "root commit",
    });
    const childId = await history.commits.store({
      tree,
      parents: [parentId],
      author: person(),
      committer: person(),
      message: "child commit",
    });
    const child = (await history.commits.load(childId))!;
    expect(child.tree).toBe(tree);
    expect(child.parents).toEqual([parentId]);
    expect(child.author).toEqual(person());
    expect(child.committer).toEqual(person());
    expect(child.message).toBe("child commit");
    await history.close();
  });

  it("pack build→read roundtrip carries objects between two seams intact", async () => {
    const source = seamHistory();
    const target = seamHistory();
    await source.history.initialize();
    await target.history.initialize();

    const blobId = await source.history.blobs.store([new TextEncoder().encode("packed content")]);
    const treeId = await source.history.trees.store([
      { name: "a.txt", mode: 0o100644, id: blobId },
    ]);
    const commitId = await source.history.commits.store({
      tree: treeId,
      parents: [],
      author: person(),
      committer: person(),
      message: "packed commit",
    });

    // Every reachable object, collected over the source seam.
    const reachable: string[] = [];
    for await (const oid of source.history.collectReachableObjects(
      new Set([commitId]),
      new Set(),
    )) {
      reachable.push(oid);
    }
    expect(reachable).toEqual(expect.arrayContaining([blobId, treeId, commitId]));

    async function* ids(): AsyncIterable<string> {
      yield* reachable;
    }
    const packBytes = await collect(source.serialization.createPack(ids()));

    async function* packStream(): AsyncIterable<Uint8Array> {
      yield packBytes;
    }
    const result = await target.serialization.importPack(packStream());
    expect(result.objectsImported).toBe(reachable.length);

    // Same oids resolve on the target seam with identical content.
    expect(await collect((await target.history.blobs.load(blobId))!)).toEqual(
      new TextEncoder().encode("packed content"),
    );
    const commit = (await target.history.commits.load(commitId))!;
    expect(commit.tree).toBe(treeId);
    expect(commit.message).toBe("packed commit");

    await source.history.close();
    await target.history.close();
  });
});
