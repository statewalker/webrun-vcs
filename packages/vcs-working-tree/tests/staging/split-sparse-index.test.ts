/**
 * The split index (`link`) and sparse index (`sdir`) helpers without native git: the link
 * extension's bitmaps, merging a split index git's way, telling shared entries from changed
 * ones before a write, and expanding and collapsing sparse directories with their cache-tree.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  type CacheTree,
  cacheTreeOfTree,
  classifySplitEntries,
  collapseSparseIndex,
  createGitStaging,
  encodeLinkExtension,
  expandSparseIndex,
  mergeSplitIndex,
  parseIndexFile,
  parseLinkExtension,
  prepareSplitWrite,
  type SharedIndex,
  type StagingEntry,
  storeCacheTree,
  tooManyNotSharedEntries,
} from "../../src/staging/index.js";
import { Ewah } from "../../src/status/index.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const entry = (path: string, n: number, extra: Partial<StagingEntry> = {}): StagingEntry => ({
  path,
  mode: 0o100644,
  objectId: oid(n),
  stage: 0,
  size: n,
  mtime: 1_600_000_000_000 + n,
  ...extra,
});

function ewah(bits: number[]): Ewah {
  const e = new Ewah();
  for (const b of bits) e.set(b);
  return e;
}

describe("link extension", () => {
  it("round-trips the shared index id and both bitmaps", () => {
    const data = encodeLinkExtension(oid(7), ewah([1, 70]), ewah([0, 2, 3]));
    expect(parseLinkExtension(data)).toEqual({
      baseId: oid(7),
      deleted: [1, 70],
      replaced: [0, 2, 3],
    });
  });

  it("an id alone has no bitmaps; garbage after them is refused", () => {
    expect(parseLinkExtension(Buffer.from(oid(1), "hex"))).toEqual({ baseId: oid(1) });
    const data = encodeLinkExtension(oid(1), new Ewah(), new Ewah());
    expect(() => parseLinkExtension(new Uint8Array([...data, 0]))).toThrow("garbage");
    expect(() => parseLinkExtension(new Uint8Array(5))).toThrow("too short");
  });
});

describe("merge_base_index", () => {
  const shared: SharedIndex = {
    id: oid(99),
    version: 2,
    entries: [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
  };

  it("applies replacements, deletions and new entries", () => {
    const own = [entry("", 20), entry("bb", 5), entry("e", 6)];
    const merged = mergeSplitIndex(own, { baseId: oid(99), deleted: [2], replaced: [1] }, shared);
    expect(merged.map((e) => `${e.path}:${e.size}`)).toEqual(["a:1", "b:20", "bb:5", "d:4", "e:6"]);
  });

  it("dies on corrupt links as git does", () => {
    expect(() =>
      mergeSplitIndex([entry("x", 1)], { baseId: oid(99), deleted: [], replaced: [0] }, shared),
    ).toThrow("should have zero length name");
    expect(() =>
      mergeSplitIndex([], { baseId: oid(99), deleted: [9], replaced: [] }, shared),
    ).toThrow("exceeds base index size");
    expect(() =>
      mergeSplitIndex([], { baseId: oid(99), deleted: [], replaced: [0] }, shared),
    ).toThrow("too many replacements");
  });

  it("a write keeps unchanged entries shared, edits as replacements, new entries whole", () => {
    const merged = mergeSplitIndex([], { baseId: oid(99), deleted: [], replaced: [] }, shared);
    // b edited in place (git add), c removed, e added
    const next = [
      merged[0] as StagingEntry,
      entry("b", 7),
      merged[3] as StagingEntry,
      entry("e", 8),
    ];
    const classified = classifySplitEntries(next, shared, false, merged);
    expect(classified.added.map((e) => e.path)).toEqual(["e"]);
    const { items, link } = prepareSplitWrite(classified, shared.id);
    expect(items.map((i) => `${i.path}|${i.entry.size}`)).toEqual(["|7", "e|8"]);
    expect(parseLinkExtension(link)).toEqual({ baseId: oid(99), deleted: [2], replaced: [1] });
    // an unpack-trees write builds b from a tree: the shared b deleted, the new one whole
    const fromTree = classifySplitEntries(next, shared, true, merged);
    expect(fromTree.added.map((e) => e.path)).toEqual(["b", "e"]);
    // a path git apply removed and added again: likewise
    const readded = classifySplitEntries(next, shared, false, merged, new Set(["b"]));
    expect(readded.added.map((e) => e.path)).toEqual(["b", "e"]);
  });

  it("too_many_not_shared_entries: over the percentage; 0 always, 100 never", () => {
    expect(tooManyNotSharedEntries(10, 2, 20)).toBe(false);
    expect(tooManyNotSharedEntries(10, 3, 20)).toBe(true);
    expect(tooManyNotSharedEntries(10, 0, 0)).toBe(true);
    expect(tooManyNotSharedEntries(10, 10, 100)).toBe(false);
  });
});

describe("split index through GitStaging", () => {
  it("core.splitIndex writes a shared index; the next read merges it; false unsplits", async () => {
    const files = createInMemoryFilesApi();
    let split: boolean | undefined = true;
    const staging = createGitStaging(files, ".git/index");
    staging.setIndexHost?.({ settings: () => ({ splitIndex: split, maxPercentChange: 20 }) });
    for (let i = 1; i <= 10; i++) await staging.setEntry(entry(`f${i}`, i));
    await staging.write();
    const names = async () => {
      const out: string[] = [];
      for await (const info of files.list(".git")) out.push(info.name);
      return out.filter((n) => n.startsWith("sharedindex.")).sort();
    };
    expect(await names()).toHaveLength(1);
    const read = createGitStaging(files, ".git/index");
    await read.read();
    expect(await read.getEntryCount()).toBe(10);
    expect(read.indexLayout?.()).toEqual({ split: true, sparse: false });
    // one new entry of 11: not over 20%
    await read.setEntry(entry("g", 50));
    await read.write();
    expect(await names()).toHaveLength(1);
    const parsed = await parseIndexFile(await readAll(files, ".git/index"));
    expect(parsed.entries.map((e) => e.path)).toEqual(["g"]);
    split = false;
    staging.setIndexHost?.({ settings: () => ({ splitIndex: split }) });
    await staging.read();
    await staging.write();
    const whole = await parseIndexFile(await readAll(files, ".git/index"));
    expect(whole.extensions).not.toContain("link");
    expect(whole.entries).toHaveLength(11);
  });
});

async function readAll(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

/** A tiny in-memory tree store, ids from git's tree hashing through storeCacheTree. */
function memoryTrees() {
  const stored = new Map<string, { name: string; mode: number; id: string }[]>();
  let next = 1000;
  const trees = {
    store: async (entries: Iterable<{ name: string; mode: number; id: string }>) => {
      const list = [...entries];
      const key = JSON.stringify(list);
      for (const [id, l] of stored) if (JSON.stringify(l) === key) return id;
      const id = oid(next++);
      stored.set(id, list);
      return id;
    },
    load: async (id: string) => {
      const list = stored.get(id);
      if (!list) return undefined;
      return (async function* () {
        yield* list;
      })();
    },
  };
  return trees;
}

describe("sparse index", () => {
  it("collapses directories outside the cone, and expands them back", async () => {
    const trees = memoryTrees();
    const sw = { skipWorktree: true };
    const full = [
      entry("k/a", 1),
      entry("s/c", 2, sw),
      entry("s/t/d", 3, sw),
      entry("top", 4),
      entry("u/e", 5, sw),
      entry("v/f", 6),
    ];
    const tree = (await storeCacheTree((l) => trees.store(l), full)) as CacheTree;
    const inCone = (p: string) => p === "k/" || p === "v/";
    const sparse = collapseSparseIndex(full, tree, inCone);
    expect(sparse.entries.map((e) => `${e.mode.toString(8)} ${e.path}`)).toEqual([
      "100644 k/a",
      "40000 s/",
      "100644 top",
      "40000 u/",
      "100644 v/f",
    ]);
    expect(sparse.cacheTree.entryCount).toBe(5);
    expect(sparse.cacheTree.subtrees.find((s) => s.name === "s")?.tree).toEqual({
      entryCount: 1,
      id: expect.any(String),
      subtrees: [],
    });
    const expanded = await expandSparseIndex(sparse.entries, sparse.cacheTree, trees);
    expect(expanded.entries.map((e) => `${e.path}${e.skipWorktree ? " S" : ""}`)).toEqual([
      "k/a",
      "s/c S",
      "s/t/d S",
      "top",
      "u/e S",
      "v/f",
    ]);
    expect(expanded.cacheTree?.entryCount).toBe(6);
    expect(expanded.cacheTree).toEqual(
      expect.objectContaining({ id: tree.id, entryCount: tree.entryCount }),
    );
    expect(await cacheTreeOfTree(trees, tree.id as string)).toEqual(expanded.cacheTree);
  });

  it("a directory with an entry not skip-worktree, or inside the cone, stays expanded", async () => {
    const trees = memoryTrees();
    const full = [entry("s/c", 2, { skipWorktree: true }), entry("s/d", 3), entry("u/e", 5)];
    const tree = (await storeCacheTree((l) => trees.store(l), full)) as CacheTree;
    const sparse = collapseSparseIndex(full, tree, (p) => p === "u/");
    expect(sparse.entries.map((e) => e.path)).toEqual(["s/c", "s/d", "u/e"]);
  });
});
