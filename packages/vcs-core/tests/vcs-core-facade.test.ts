/**
 * B2 — the normalized {@link VcsCore} facade over the `@statewalker/webrun-storage`
 * seam. Builds a facade over `memBlobStore()` + `memKvStore()` and asserts the
 * delegated + normalized behaviour: array trees, first merge base, hydrated log,
 * unified `has`, storage-shaped refs, pack roundtrip, gc pruning, sha256 gate.
 */

import { memBlobStore, memKvStore } from "@statewalker/webrun-storage";
import { describe, expect, it } from "vitest";

import type { PersonIdent } from "../src/history/index.js";
import { createVcsCore, type VcsCore } from "../src/vcs-core/index.js";

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ABSENT_OID = "0".repeat(40);

function newVcsCore(opts?: { hash?: "sha1" | "sha256" }): VcsCore {
  return createVcsCore({ objects: memBlobStore(), refs: memKvStore() }, opts);
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

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("VcsCore facade over the storage seam", () => {
  describe("objects", () => {
    it("blob write→read roundtrip returns identical bytes", async () => {
      const vcs = newVcsCore();
      const payload = new TextEncoder().encode("Hello, facade!");
      const id = await vcs.writeBlob(
        (async function* () {
          yield payload;
        })(),
      );
      expect(await collect(vcs.readBlob(id))).toEqual(payload);
    });

    it("readTree returns an array (not an iterable) tiling a real tree", async () => {
      const vcs = newVcsCore();
      const blobId = await vcs.writeBlob(
        (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })(),
      );
      const treeId = await vcs.writeTree([{ name: "file.txt", mode: 0o100644, id: blobId }]);
      const entries = await vcs.readTree(treeId);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toEqual([{ name: "file.txt", mode: 0o100644, id: blobId }]);
    });

    it("writeTree([]) yields git's canonical empty-tree oid", async () => {
      const vcs = newVcsCore();
      expect(await vcs.writeTree([])).toBe(EMPTY_TREE_OID);
    });

    it("commit write→read roundtrip preserves fields", async () => {
      const vcs = newVcsCore();
      const tree = await vcs.writeTree([]);
      const parent = await vcs.writeCommit({
        tree,
        parents: [],
        author: person(),
        committer: person(),
        message: "root",
      });
      const childId = await vcs.writeCommit({
        tree,
        parents: [parent],
        author: person(),
        committer: person(),
        message: "child",
      });
      const child = await vcs.readCommit(childId);
      expect(child.tree).toBe(tree);
      expect(child.parents).toEqual([parent]);
      expect(child.message).toBe("child");
      expect(child.author).toEqual(person());
    });

    it("has() unifies existence across object types; readCommit throws on a missing id", async () => {
      const vcs = newVcsCore();
      const blobId = await vcs.writeBlob(
        (async function* () {
          yield new Uint8Array([9]);
        })(),
      );
      expect(await vcs.has(blobId)).toBe(true);
      expect(await vcs.has(ABSENT_OID)).toBe(false);
      await expect(vcs.readCommit(ABSENT_OID)).rejects.toThrow();
    });
  });

  describe("refs", () => {
    it("sets and reads a ref back, and rejects a stale compare-and-set", async () => {
      const vcs = newVcsCore();
      const name = "refs/heads/main";
      const oid = "a".repeat(40);

      expect(await vcs.refs.compareAndSet(name, undefined, oid)).toBe(true);
      expect(await vcs.refs.read(name)).toBe(oid);

      // Stale expectation → rejected, value unchanged.
      expect(await vcs.refs.compareAndSet(name, "b".repeat(40), "c".repeat(40))).toBe(false);
      expect(await vcs.refs.read(name)).toBe(oid);
    });
  });

  describe("ancestry", () => {
    async function buildDag(vcs: VcsCore) {
      const tree = await vcs.writeTree([]);
      const commit = (message: string, parents: string[]) =>
        vcs.writeCommit({ tree, parents, author: person(), committer: person(), message });
      const c1 = await commit("c1", []);
      const c2 = await commit("c2", [c1]);
      const c3 = await commit("c3", [c2]);
      const a = await commit("A", [c1]);
      const b = await commit("B", [c1]);
      return { c1, c2, c3, a, b };
    }

    it("mergeBase returns a single oid", async () => {
      const vcs = newVcsCore();
      const { c1, a, b } = await buildDag(vcs);
      expect(await vcs.mergeBase(a, b)).toBe(c1);
      expect(await vcs.mergeBase(a, ABSENT_OID)).toBeUndefined();
    });

    it("isAncestor is correct in both directions", async () => {
      const vcs = newVcsCore();
      const { c1, a, b } = await buildDag(vcs);
      expect(await vcs.isAncestor(c1, a)).toBe(true);
      expect(await vcs.isAncestor(a, b)).toBe(false);
    });

    it("log yields hydrated commits in order, each carrying its id", async () => {
      const vcs = newVcsCore();
      const { c1, c2, c3 } = await buildDag(vcs);
      const entries = await drain(vcs.log(c3));
      expect(entries.map((e) => e.id)).toEqual([c3, c2, c1]);
      expect(entries.map((e) => e.message)).toEqual(["c3", "c2", "c1"]);
      // Hydrated: full commit fields present.
      expect(entries[0].tree).toBe(await vcs.writeTree([]));
    });
  });

  describe("packs", () => {
    it("writePack → readPack roundtrips the id set and imports readable objects", async () => {
      const source = newVcsCore();
      const target = newVcsCore();

      const blobId = await source.writeBlob(
        (async function* () {
          yield new TextEncoder().encode("packed content");
        })(),
      );
      const treeId = await source.writeTree([{ name: "a.txt", mode: 0o100644, id: blobId }]);
      const commitId = await source.writeCommit({
        tree: treeId,
        parents: [],
        author: person(),
        committer: person(),
        message: "packed",
      });
      const ids = [blobId, treeId, commitId];

      const imported = await drain(target.readPack(source.writePack(ids)));
      expect(new Set(imported)).toEqual(new Set(ids));

      expect(await target.has(blobId)).toBe(true);
      expect(await collect(target.readBlob(blobId))).toEqual(
        new TextEncoder().encode("packed content"),
      );
      expect((await target.readCommit(commitId)).message).toBe("packed");
    });
  });

  describe("gc", () => {
    it("prunes unreferenced objects and keeps ref-reachable ones", async () => {
      const vcs = newVcsCore();
      const blobId = await vcs.writeBlob(
        (async function* () {
          yield new TextEncoder().encode("kept");
        })(),
      );
      const treeId = await vcs.writeTree([{ name: "keep.txt", mode: 0o100644, id: blobId }]);
      const head = await vcs.writeCommit({
        tree: treeId,
        parents: [],
        author: person(),
        committer: person(),
        message: "head",
      });
      const dangling = await vcs.writeBlob(
        (async function* () {
          yield new TextEncoder().encode("garbage");
        })(),
      );

      // Root the reachability at head.
      await vcs.refs.compareAndSet("refs/heads/main", undefined, head);

      const { pruned } = await vcs.gc();
      expect(pruned).toBe(1);
      expect(await vcs.has(dangling)).toBe(false);
      expect(await vcs.has(head)).toBe(true);
      expect(await vcs.has(treeId)).toBe(true);
      expect(await vcs.has(blobId)).toBe(true);
    });
  });

  describe("hash algorithm gate", () => {
    it("defaults to sha1", () => {
      expect(newVcsCore().hash).toBe("sha1");
      expect(newVcsCore({ hash: "sha1" }).hash).toBe("sha1");
    });

    it("throws for the deferred sha256", () => {
      expect(() => newVcsCore({ hash: "sha256" })).toThrow(/sha256/);
    });
  });
});
