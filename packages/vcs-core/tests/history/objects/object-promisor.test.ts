/**
 * The lazy fetch of a partial clone's object store (`withLazyFetch`): a read of an absent
 * object fetches it once, `has` never fetches, batches fetch only what is absent, and
 * `withoutLazyFetch` turns single reads off as git's `fetch_if_missing = 0`.
 */
import { describe, expect, it } from "vitest";
import { createBlobs } from "../../../src/history/blobs/blobs.impl.js";
import { createGitObjects, type GitObjects } from "../../../src/history/objects/index.js";
import {
  createObjectPromisor,
  namedObjects,
  objectsWithoutLazyFetch,
  outgoingLinks,
  PromisorFetchError,
  type PromisorFetcher,
  type PromisorPack,
  withLazyFetch,
} from "../../../src/history/objects/object-promisor.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

const enc = new TextEncoder();

/** A "remote" store holding blobs, a local one lacking them, and the lazy view of it. */
async function setup(options: { promisorPacks?: PromisorPack[] } = {}) {
  const remote = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const local = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const ids: string[] = [];
  for (const text of ["one\n", "two\n", "three\n"]) {
    const bytes = enc.encode(text);
    ids.push(await remote.put("blob", bytes.length, [bytes]));
  }
  const batches: string[][] = [];
  const promisor = createObjectPromisor({
    objects: local,
    promisorPacks: async () => options.promisorPacks ?? [],
  });
  const fetcher: PromisorFetcher = {
    hasPromisorRemote: () => true,
    async fetch(wanted) {
      batches.push([...wanted]);
      for (const id of wanted) {
        const o = await remote.get(id);
        if (o) await local.putRaw(id, remote.getRaw(id));
      }
      return [];
    },
  };
  promisor.setFetcher(fetcher);
  const objects: GitObjects = withLazyFetch(local, promisor);
  return { remote, local, objects, promisor, ids, batches };
}

describe("lazy fetch of absent objects", () => {
  it("fetches an absent object once on a read, never on has", async () => {
    const { objects, ids, batches } = await setup();
    const id = ids[0] as string;
    expect(await objects.has(id)).toBe(false);
    expect(batches).toEqual([]);
    const blob = await createBlobs(objects).load(id);
    let text = "";
    for await (const c of blob ?? []) text += new TextDecoder().decode(c);
    expect(text).toBe("one\n");
    expect(batches).toEqual([[id]]);
    // present now: no second fetch
    await objects.get(id);
    expect(batches.length).toBe(1);
  });

  it("prefetch fetches only the absent ids, in one batch", async () => {
    const { objects, ids, batches, local, remote } = await setup();
    await local.putRaw(ids[1] as string, remote.getRaw(ids[1] as string));
    const blobs = createBlobs(objects);
    await blobs.prefetch?.(ids);
    expect(batches).toEqual([[ids[0], ids[2]]]);
    await blobs.prefetch?.(ids);
    expect(batches.length).toBe(1);
  });

  it("withoutLazyFetch reads absent objects as absent", async () => {
    const { objects, ids, batches } = await setup();
    const found = await objectsWithoutLazyFetch(objects).get(ids[0] as string);
    expect(found).toBeUndefined();
    expect(batches).toEqual([]);
  });

  it("a promised object no remote sends is git's 'could not fetch'", async () => {
    const id = "1111111111111111111111111111111111111111";
    // a promisor pack's tree naming `id`
    const local = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const entry = new Uint8Array([...enc.encode("100644 f\0"), ...new Uint8Array(20).fill(0x11)]);
    const tree = await local.put("tree", entry.length, [entry]);
    const pack: PromisorPack = { packId: "p", ids: () => [tree], has: (x) => x === tree };
    const promisor = createObjectPromisor({ objects: local, promisorPacks: async () => [pack] });
    promisor.setFetcher({ hasPromisorRemote: () => true, fetch: async (w) => w });
    const lazy = withLazyFetch(local, promisor);
    expect(await promisor.isPromisorObject(id)).toBe(true);
    await expect(lazy.get(id)).rejects.toThrow(PromisorFetchError);
    await expect(lazy.get(id)).rejects.toThrow(`could not fetch ${id} from promisor remote`);
    // an id nothing promises reads as absent
    expect(await lazy.get("2222222222222222222222222222222222222222")).toBeUndefined();
  });

  it("names what commits, trees and tags point to", () => {
    const tree = "a".repeat(40);
    const parent = "b".repeat(40);
    expect(namedObjects("commit", enc.encode(`tree ${tree}\nparent ${parent}\n\nmsg\n`))).toEqual([
      tree,
      parent,
    ]);
    expect(namedObjects("tag", enc.encode(`object ${tree}\ntype tree\n\nmsg\n`))).toEqual([tree]);
  });
  it("a read in another task still fetches while a walk reads without lazy fetch", async () => {
    const { objects, ids, batches } = await setup();
    const direct = objectsWithoutLazyFetch(objects);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the walk: reads without lazy fetch, still running while the other task reads
    const walk = (async () => {
      const before = await direct.get(ids[0] as string);
      await gate;
      const after = await direct.get(ids[1] as string);
      return [before, after];
    })();
    const other = await objects.get(ids[1] as string);
    release();
    expect(await walk).toEqual([undefined, expect.anything()]);
    expect(other).toBeDefined();
    expect(batches).toEqual([[ids[1]]]);
    expect(direct.withoutLazyFetch).toBe(direct);
  });

  it("a fetch that succeeds without the object is PromisorFetchError, not a miss", async () => {
    const local = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const promisor = createObjectPromisor({ objects: local, promisorPacks: async () => [] });
    let fetches = 0;
    // the server answers with another object: the fetch reports success
    promisor.setFetcher({
      hasPromisorRemote: () => true,
      fetch: async () => {
        fetches++;
        return [];
      },
    });
    const lazy = withLazyFetch(local, promisor);
    const id = "3333333333333333333333333333333333333333";
    await expect(lazy.get(id)).rejects.toThrow(PromisorFetchError);
    expect(fetches).toBe(1);
  });

  it("outgoing links: a tree's subtrees only, a commit's tree and parents", () => {
    const sub = new Uint8Array(20).fill(0xaa);
    const blob = new Uint8Array(20).fill(0xbb);
    const tree = new Uint8Array([
      ...enc.encode("100644 f\0"),
      ...blob,
      ...enc.encode("40000 d\0"),
      ...sub,
    ]);
    expect(outgoingLinks("tree", tree)).toEqual(["a".repeat(40)]);
    const commit = enc.encode(`tree ${"c".repeat(40)}\nparent ${"d".repeat(40)}\n\nm\n`);
    expect(outgoingLinks("commit", commit)).toEqual(["c".repeat(40), "d".repeat(40)]);
  });

  it("localLinkObjects walks from local links, stopping at promisor packs", async () => {
    const local = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const put = async (type: "blob" | "tree" | "commit", bytes: Uint8Array) =>
      local.put(type, bytes.length, [bytes]);
    const raw = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const blobA = await put("blob", enc.encode("a\n"));
    const promisedTree = await put(
      "tree",
      new Uint8Array([...enc.encode("100644 a\0"), ...raw(blobA)]),
    );
    const base = await put("commit", enc.encode(`tree ${promisedTree}\n\nbase\n`));
    const blobC = await put("blob", enc.encode("c\n"));
    const absent = "4".repeat(40);
    const localTree = await put(
      "tree",
      new Uint8Array([
        ...enc.encode("100644 a\0"),
        ...raw(blobA),
        ...enc.encode("100644 c\0"),
        ...raw(blobC),
        ...enc.encode("100644 x\0"),
        ...raw(absent),
      ]),
    );
    const mine = await put("commit", enc.encode(`tree ${localTree}\nparent ${base}\n\nC\n`));
    const inPack = new Set([promisedTree, base]);
    const pack: PromisorPack = { packId: "p", ids: () => inPack, has: (x) => inPack.has(x) };
    const promisor = createObjectPromisor({ objects: local, promisorPacks: async () => [pack] });
    const listed = await promisor.localLinkObjects([mine, base, absent]);
    // the boundary commit in a promisor pack is listed, its tree is not
    expect(new Set(listed)).toEqual(new Set([mine, base, localTree, blobA, blobC]));
    expect(await promisor.localLinkObjects([base, absent])).toEqual([]);
  });
});
