/**
 * The checks a fetch makes of what it received (`fetch-checks.ts`), over a synthetic facade:
 * rev-list's messages from the connectivity walk, the reads it makes on top of the existing
 * refs, index-pack's order of received objects and its choice of the missing object to name.
 */

import { describe, expect, it } from "vitest";

import {
  type CommitGraphInfo,
  checkReceivedPack,
  connectivityErrors,
  FetchCheckError,
  ReceivedObjects,
  type RepositoryFacade,
  type TreeEntryInfo,
} from "../src/index.js";

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
