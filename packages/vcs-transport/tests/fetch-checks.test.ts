/**
 * The checks a fetch makes of what it received (`fetch-checks.ts`), over a synthetic facade:
 * rev-list's messages from the connectivity walk, the reads it makes on top of the existing
 * refs, index-pack's order of received objects and its choice of the missing object to name.
 */

import { createHistoryFromComponents } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

import {
  type CommitGraphInfo,
  checkReceivedPack,
  connectivityErrors,
  createRepositoryFacade,
  FetchCheckError,
  ReceivedLinks,
  ReceivedObjects,
  type RepositoryFacade,
  type TreeEntryInfo,
} from "../src/index.js";
import { commitInRepo, createTransportRepo } from "./interop/helpers.js";

type Obj =
  | { type: "commit"; parents: string[]; tree: string; time: number }
  | { type: "tree"; entries: TreeEntryInfo[] }
  | { type: "blob" }
  | { type: "tag"; object: string; targetType: "commit" | "tree" | "blob" | "tag" };

function facadeOf(objects: Map<string, Obj>) {
  const reads = { commits: 0 };
  const facade: RepositoryFacade = {
    importPack: async () => ({}) as never,
    exportPack: () => (async function* () {})(),
    async *walkAncestors() {},
    has: async (oid) => objects.has(oid),
    getObjectType: async (oid) => objects.get(oid)?.type,
    getCommitInfo: async (oid): Promise<CommitGraphInfo | undefined> => {
      reads.commits++;
      const o = objects.get(oid);
      return o?.type === "commit" ? { parents: o.parents, time: o.time, tree: o.tree } : undefined;
    },
    getTreeEntries: async (oid) => {
      const o = objects.get(oid);
      return o?.type === "tree" ? o.entries : undefined;
    },
    getTagInfo: async (oid) => {
      const o = objects.get(oid);
      return o?.type === "tag" ? { object: o.object, type: o.targetType } : undefined;
    },
  };
  return { facade, reads };
}

const id = (prefix: string, n: number) =>
  `${prefix}${n.toString(16).padStart(40 - prefix.length, "0")}`;
const BLOB = id("b", 1);
const TREE = id("e", 1);

/** A linear history c1..cn (ids id("c", k)), all sharing one tree. */
function history(n: number): Map<string, Obj> {
  const objects = new Map<string, Obj>();
  objects.set(BLOB, { type: "blob" });
  objects.set(TREE, { type: "tree", entries: [{ mode: 0o100644, name: "a", id: BLOB }] });
  for (let k = 1; k <= n; k++) {
    objects.set(id("c", k), {
      type: "commit",
      parents: k > 1 ? [id("c", k - 1)] : [],
      tree: TREE,
      time: 1700000000 + k,
    });
  }
  return objects;
}

describe("connectivityErrors (git's check_connected)", () => {
  it("passes for a complete history and reads only the new commits on top of a ref", async () => {
    const { facade, reads } = facadeOf(history(1000));
    const errors = await connectivityErrors(facade, [id("c", 1000)], {
      known: [id("c", 995)],
      shallow: new Set(),
    });
    expect(errors).toBeUndefined();
    expect(reads.commits).toBeLessThan(20);
  });

  it("a missing parent: rev-list's limited walk fails as a whole when a ref exists", async () => {
    const objects = history(5);
    objects.delete(id("c", 3));
    const { facade } = facadeOf(objects);
    expect(
      await connectivityErrors(facade, [id("c", 5)], { known: [id("c", 1)], shallow: new Set() }),
    ).toEqual([`error: Could not read ${id("c", 3)}`, "fatal: revision walk setup failed"]);
    // no ref: the lazy walk dies at the commit naming it
    expect(
      await connectivityErrors(facade, [id("c", 5)], { known: [], shallow: new Set() }),
    ).toEqual([
      `error: Could not read ${id("c", 3)}`,
      `fatal: Failed to traverse parents of commit ${id("c", 4)}`,
    ]);
  });

  it("the shallow commits end the walk; a deepening check ignores the refs", async () => {
    const objects = history(5);
    objects.delete(id("c", 2));
    const { facade } = facadeOf(objects);
    expect(
      await connectivityErrors(facade, [id("c", 5)], { known: [], shallow: new Set([id("c", 3)]) }),
    ).toBeUndefined();
    expect(
      await connectivityErrors(facade, [id("c", 5)], {
        known: [id("c", 3)],
        shallow: new Set(),
        deepening: true,
      }),
    ).toEqual([
      `error: Could not read ${id("c", 2)}`,
      `fatal: Failed to traverse parents of commit ${id("c", 3)}`,
    ]);
  });

  it("a missing tip, tag target, tree and blob, in rev-list's words", async () => {
    const objects = history(2);
    objects.set(id("a", 1), { type: "tag", object: id("c", 9), targetType: "commit" });
    const { facade } = facadeOf(objects);
    const opts = { known: [id("c", 1)], shallow: new Set<string>() };
    expect(await connectivityErrors(facade, [id("c", 9)], opts)).toEqual([
      `fatal: bad object ${id("c", 9)}`,
    ]);
    expect(await connectivityErrors(facade, [id("a", 1)], opts)).toEqual([
      `fatal: bad object ${id("c", 9)}`,
    ]);
    const tree2 = id("e", 2);
    objects.set(id("c", 3), {
      type: "commit",
      parents: [id("c", 2)],
      tree: tree2,
      time: 1700000003,
    });
    expect(await connectivityErrors(facade, [id("c", 3)], opts)).toEqual([
      `fatal: bad tree object ${tree2}`,
    ]);
    objects.set(tree2, { type: "tree", entries: [{ mode: 0o100644, name: "b", id: id("b", 2) }] });
    expect(await connectivityErrors(facade, [id("c", 3)], opts)).toEqual([
      `fatal: missing blob object '${id("b", 2)}'`,
    ]);
  });
});

describe("checkReceivedPack (index-pack --strict)", () => {
  it("orders the received objects as index-pack: whole entries, then deltas, in pack order", () => {
    const received = new ReceivedObjects();
    received.add(id("d", 1), "blob", { index: 2, delta: true });
    received.add(id("d", 2), "tree", { index: 3, delta: false });
    received.add(id("d", 3), "commit", { index: 0, delta: false });
    received.add(id("d", 4), "blob", { index: 1, delta: true });
    received.add(id("d", 3), "commit", { index: 5, delta: false }); // a duplicate entry
    expect([...received.ordered()].map((o) => o.id)).toEqual([
      id("d", 3),
      id("d", 2),
      id("d", 4),
      id("d", 1),
    ]);
    expect(received.size).toBe(4);
    expect(received.has(id("d", 2))).toBe(true);
    expect(received.has(id("d", 9))).toBe(false);
  });

  it("names the missing object in the lowest slot of git's object table", async () => {
    const objects = history(1);
    // a commit naming two missing parents: slot 0x05 (little-endian first bytes) beats 0x11
    const later = "1100000000000000000000000000000000000000";
    const sooner = "0500000000000000000000000000000000000000";
    const c = id("c", 7);
    objects.set(c, { type: "commit", parents: [later, sooner], tree: TREE, time: 1 });
    const { facade } = facadeOf(objects);
    const received = new ReceivedObjects();
    received.add(c, "commit", { index: 0, delta: false });
    let error: unknown;
    try {
      await checkReceivedPack(facade, received, { links: true, shallow: new Set(), kept: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FetchCheckError);
    expect((error as FetchCheckError).lines).toEqual([
      `fatal: did not receive expected object ${sooner}`,
      "fatal: fetch-pack: invalid index-pack output",
    ]);
    // the parents of a shallow commit are not named; the tree is here, not received
    const checked = await checkReceivedPack(facade, received, {
      links: true,
      shallow: new Set([c]),
      kept: false,
    });
    expect(checked.selfContained).toBe(false);
  });
});

const enc = new TextEncoder();
const rawId = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
/** A tree's content: `<mode> <name>\0<20-byte id>` per entry. */
function treeContent(entries: { mode: string; name: string; id: string }[]): Uint8Array {
  const parts: number[] = [];
  for (const e of entries) parts.push(...enc.encode(`${e.mode} ${e.name}\0`), ...rawId(e.id));
  return Uint8Array.from(parts);
}

describe("ReceivedLinks (index-pack's links, read while the import holds the objects)", () => {
  it("checks the links without reading the objects back, as the read-back check does", async () => {
    const objects = history(3);
    const gitlink = id("f", 9);
    const tree2 = id("e", 2);
    objects.set(tree2, {
      type: "tree",
      entries: [
        { mode: 0o100644, name: "a", id: BLOB },
        { mode: 0o160000, name: "sub", id: gitlink },
      ],
    });
    const missing = id("a", 5);
    const c4 = id("c", 4);
    objects.set(c4, { type: "commit", parents: [id("c", 3), missing], tree: tree2, time: 1 });
    const tag = id("d", 1);
    objects.set(tag, { type: "tag", object: c4, targetType: "commit" });
    const { facade, reads } = facadeOf(objects);

    const received = new ReceivedObjects();
    const links = new ReceivedLinks(() => new Set());
    const report = (oid: string, type: "commit" | "tree" | "tag", content: Uint8Array) => {
      received.add(oid, type, { index: received.size, delta: false });
      links.add(oid, type, content);
    };
    report(
      c4,
      "commit",
      enc.encode(`tree ${tree2}\nparent ${id("c", 3)}\nparent ${missing}\nauthor x\n\nm\n`),
    );
    report(
      tree2,
      "tree",
      treeContent([
        { mode: "100644", name: "a", id: BLOB },
        { mode: "160000", name: "sub", id: gitlink },
      ]),
    );
    report(tag, "tag", enc.encode(`object ${c4}\ntype commit\ntag v1\n\nm\n`));

    const run = async (receivedLinks?: ReceivedLinks) => {
      try {
        await checkReceivedPack(facade, received, {
          links: true,
          shallow: new Set(),
          kept: false,
          ...(receivedLinks ? { receivedLinks } : {}),
        });
        return undefined;
      } catch (e) {
        return (e as FetchCheckError).lines;
      }
    };
    const readBack = await run();
    expect(reads.commits).toBe(1);
    const collected = await run(links);
    expect(reads.commits).toBe(1); // nothing read back
    expect(collected).toEqual([
      `fatal: did not receive expected object ${missing}`,
      "fatal: index-pack failed",
    ]);
    expect(collected).toEqual(readBack);
  });

  it("a shallow commit's parents are not links; an unreported object falls back to reading", async () => {
    const objects = history(2);
    const { facade, reads } = facadeOf(objects);
    const c2 = id("c", 2);
    const received = new ReceivedObjects();
    received.add(c2, "commit", { index: 0, delta: false });
    received.add(TREE, "tree", { index: 1, delta: false });
    received.add(BLOB, "blob", { index: 2, delta: false });
    const links = new ReceivedLinks(() => new Set([c2]));
    links.add(c2, "commit", enc.encode(`tree ${TREE}\nparent ${id("c", 1)}\n\nm\n`));
    links.add(TREE, "tree", treeContent([{ mode: "100644", name: "a", id: BLOB }]));
    const checked = await checkReceivedPack(facade, received, {
      links: true,
      receivedLinks: links,
      shallow: new Set([c2]),
      kept: false,
    });
    expect(checked.selfContained).toBe(true);
    expect(reads.commits).toBe(0);
    // the tree's content was never reported: its links are read back
    const partial = new ReceivedLinks(() => new Set([c2]));
    partial.add(c2, "commit", enc.encode(`tree ${TREE}\nparent ${id("c", 1)}\n\nm\n`));
    await checkReceivedPack(facade, received, {
      links: true,
      receivedLinks: partial,
      shallow: new Set([c2]),
      kept: false,
    });
    expect(reads.commits).toBe(1);
  });

  it("the pack import reports every commit and tree it receives (kept and unpacked)", async () => {
    const source = await createTransportRepo();
    const c1 = await commitInRepo(source, "c1", { "a.txt": "one\n", "b.txt": "two\n" });
    const c2 = await commitInRepo(source, "c2", { "a.txt": "three\n", "b.txt": "two\n" }, [c1]);
    const chunks: Uint8Array[] = [];
    for await (const c of source.facade.exportPack(new Set([c2]), new Set())) chunks.push(c);
    for (const keepPack of [true, false]) {
      const files = createInMemoryFilesApi();
      const backend = await createGitFilesBackend({ files, gitDir: ".", create: true });
      const history = createHistoryFromComponents({
        objects: backend.objects,
        refs: backend.history.refs,
        packs: backend.packs,
      });
      const facade = createRepositoryFacade({ history });
      const received = new ReceivedObjects();
      const links = new ReceivedLinks(() => new Set());
      const imported = await facade.importPack(
        (async function* () {
          yield* chunks;
        })(),
        {
          keepPack,
          onObject: (oid, type, entry) => received.add(oid, type, entry),
          onContent: (oid, type, content) => links.add(oid, type, content),
        },
      );
      expect(imported.packId !== undefined).toBe(keepPack);
      expect(links.reportedCount).toBe(received.nonBlobs);
      expect(received.nonBlobs).toBe(4); // two commits, two trees
      const checked = await checkReceivedPack(facade, received, {
        links: true,
        receivedLinks: links,
        shallow: new Set(),
        kept: keepPack,
      });
      expect(checked.selfContained).toBe(true);
    }
  });
});

describe("pack import of an empty stream into a quarantine", () => {
  const incoming = async (files: FilesApi) => {
    const names: string[] = [];
    for await (const e of files.list("objects")) {
      if (e.name.startsWith("tmp_objdir-incoming-")) names.push(e.name);
    }
    return names;
  };

  it("opens no quarantine (none can be left behind)", async () => {
    const files = createInMemoryFilesApi();
    const backend = await createGitFilesBackend({ files, gitDir: ".", create: true });
    const history = createHistoryFromComponents({
      objects: backend.objects,
      refs: backend.history.refs,
      packs: backend.packs,
    });
    const facade = createRepositoryFacade({ history });
    const imported = await facade.importPack((async function* () {})(), { quarantine: true });
    expect(imported.quarantine).toBeUndefined();
    expect(imported.objectsImported).toBe(0);
    expect(await incoming(files)).toEqual([]);
  });
});

describe("checkReceivedPack: fsck reads only the blobs it looks at", () => {
  it("a blob the fsck does not want is never loaded", async () => {
    const objects = history(1);
    const { facade } = facadeOf(objects);
    const loaded: string[] = [];
    facade.loadObject = async (oid) => {
      loaded.push(oid);
      const o = objects.get(oid);
      return o ? { type: o.type, content: new Uint8Array() } : undefined;
    };
    const received = new ReceivedObjects();
    received.add(TREE, "tree", { index: 0, delta: false });
    received.add(BLOB, "blob", { index: 1, delta: false });
    const checked: string[] = [];
    await checkReceivedPack(facade, received, {
      fsck: {
        checkObject: (oid) => {
          checked.push(oid);
          return false;
        },
        wantsBlob: () => false,
        pendingBlobs: () => [],
        checkPendingBlob: () => false,
      },
      links: false,
      shallow: new Set(),
      kept: false,
    });
    expect(loaded).toEqual([TREE]);
    expect(checked).toEqual([TREE]);
  });
});
