import { describe, expect, it } from "vitest";
import {
  canonTreeMode,
  compareTreeEntries,
  createMemoryHistory,
  decodeTreeBytes,
  EMPTY_TREE_ID,
  serializeTree,
  type TreeEntry,
  TreeEntryCursor,
} from "../../../src/index.js";

const id = (n: number) => n.toString(16).padStart(40, "0");

/** The entries a cursor walks, decoded */
function walk(bytes: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const c = new TreeEntryCursor(bytes); !c.done; c.next()) {
    out.push({ mode: c.mode, name: c.name(), id: c.id() });
  }
  return out;
}

describe("TreeEntryCursor", () => {
  const entries: TreeEntry[] = [
    { mode: 0o100644, name: "a", id: id(1) },
    { mode: 0o40000, name: "a-dir", id: id(2) },
    { mode: 0o100755, name: "a.c", id: id(3) },
    { mode: 0o40000, name: "b", id: id(4) },
    { mode: 0o120000, name: "café", id: id(5) },
    { mode: 0o160000, name: "sub", id: id(6) },
  ];
  const bytes = serializeTree(entries);

  it("walks the entries decodeTreeBytes decodes", () => {
    expect(walk(bytes)).toEqual(decodeTreeBytes(bytes));
    expect(walk(new Uint8Array(0))).toEqual([]);
  });

  it("orders names as git's base_name_compare (a tree as its name and '/')", () => {
    const pairs: [TreeEntry, TreeEntry][] = [
      [
        { mode: 0o40000, name: "foo", id: id(1) },
        { mode: 0o100644, name: "foo.c", id: id(2) },
      ],
      [
        { mode: 0o100644, name: "foo", id: id(1) },
        { mode: 0o40000, name: "foo", id: id(2) },
      ],
      [
        { mode: 0o40000, name: "foo", id: id(1) },
        { mode: 0o100644, name: "foo0", id: id(2) },
      ],
      [
        { mode: 0o100644, name: "é", id: id(1) },
        { mode: 0o100644, name: "z", id: id(2) },
      ],
    ];
    for (const [a, b] of pairs) {
      const x = new TreeEntryCursor(serializeTree([a]));
      const y = new TreeEntryCursor(serializeTree([b]));
      expect(Math.sign(x.compare(y))).toBe(Math.sign(compareTreeEntries(a, b)));
      expect(Math.sign(y.compare(x))).toBe(Math.sign(compareTreeEntries(b, a)));
    }
  });

  it("tells entries of one name apart by mode and id", () => {
    const one = (mode: number, n: number) =>
      new TreeEntryCursor(serializeTree([{ mode, name: "f", id: id(n) }]));
    expect(one(0o100644, 1).sameAs(one(0o100644, 1))).toBe(true);
    expect(one(0o100644, 1).sameAs(one(0o100755, 1))).toBe(false);
    expect(one(0o100644, 1).sameAs(one(0o100644, 2))).toBe(false);
  });

  it("refuses a truncated entry, and names git refuses, when it reaches them", () => {
    expect(() => new TreeEntryCursor(bytes.subarray(0, bytes.length - 3))).not.toThrow();
    expect(() => walk(bytes.subarray(0, bytes.length - 3))).toThrow(/truncated/);
    const dots = new Uint8Array([
      ...new TextEncoder().encode("100644 ..\0"),
      ...new Uint8Array(20),
    ]);
    const c = new TreeEntryCursor(dots);
    expect(() => c.name()).toThrow();
  });
});

describe("Trees.raw and Trees.entries", () => {
  it("give the stored bytes and the shared decoded entries", async () => {
    const history = createMemoryHistory();
    const entries: TreeEntry[] = [
      { mode: 0o100644, name: "x", id: id(7) },
      { mode: 0o40000, name: "y", id: id(8) },
    ];
    const treeId = await history.trees.store(entries);
    const raw = await history.trees.raw?.(treeId);
    expect(raw && decodeTreeBytes(raw)).toEqual(entries);
    expect(await history.trees.entries?.(treeId)).toEqual(entries);
    // the same array on each read: no copy per read
    expect(await history.trees.entries?.(treeId)).toBe(await history.trees.entries?.(treeId));
    expect(await history.trees.raw?.(EMPTY_TREE_ID)).toEqual(new Uint8Array(0));
    expect(await history.trees.entries?.(EMPTY_TREE_ID)).toEqual([]);
  });

  it("read nothing for an object that is not a tree, or is missing", async () => {
    const history = createMemoryHistory();
    const blob = await history.blobs.store([new TextEncoder().encode("x")]);
    expect(await history.trees.raw?.(blob)).toBeUndefined();
    expect(await history.trees.entries?.(blob)).toBeUndefined();
    expect(await history.trees.raw?.(id(9))).toBeUndefined();
  });
});

describe("canonTreeMode", () => {
  it("gives the modes git's tree walks read (canon_mode)", () => {
    expect(canonTreeMode(0o100644)).toBe(0o100644);
    expect(canonTreeMode(0o100664)).toBe(0o100644);
    expect(canonTreeMode(0o100600)).toBe(0o100644);
    expect(canonTreeMode(0o100775)).toBe(0o100755);
    expect(canonTreeMode(0o100700)).toBe(0o100755);
    expect(canonTreeMode(0o120777)).toBe(0o120000);
    expect(canonTreeMode(0o40755)).toBe(0o40000);
    expect(canonTreeMode(0o160000)).toBe(0o160000);
    expect(canonTreeMode(0o0)).toBe(0o160000);
  });

  it("is the mode a cursor reads, so 100664 and 100644 on one blob are the same entry", () => {
    const a = new TreeEntryCursor(serializeTree([{ mode: 0o100664, name: "f", id: id(1) }]));
    const b = new TreeEntryCursor(serializeTree([{ mode: 0o100644, name: "f", id: id(1) }]));
    expect(a.mode).toBe(0o100644);
    expect(a.sameAs(b)).toBe(true);
    const x = new TreeEntryCursor(serializeTree([{ mode: 0o100775, name: "f", id: id(1) }]));
    expect(x.mode).toBe(0o100755);
    expect(x.sameAs(b)).toBe(false);
  });
});
