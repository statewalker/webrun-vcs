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
  IndexFile,
  isSparseDirectoryEntry,
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

describe("sparse index writes stand for the full index", () => {
  const sw = { skipWorktree: true };
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const base = () => [
    entry("in/x", 1),
    entry("out/a.txt", 2, sw),
    entry("out/b.txt", 3, sw),
    entry("out/deep/a.txt", 4, sw),
    entry("out/deep/b.txt", 5, sw),
    entry("top", 6),
  ];
  const inCone = { includes: (p: string) => p === "in/" };
  const key = (e: StagingEntry) =>
    `${e.mode.toString(8)} ${e.objectId} ${e.stage}${e.skipWorktree ? "S" : ""}${e.intentToAdd ? "I" : ""} ${e.path}`;

  /** The index file expanded again: exactly `expected`, and no sparse directory of the empty tree. */
  async function expectStandsFor(
    files: ReturnType<typeof createInMemoryFilesApi>,
    trees: ReturnType<typeof memoryTrees>,
    expected: readonly StagingEntry[],
  ) {
    const parsed = await parseIndexFile(await readAll(files, ".git/index"));
    for (const e of parsed.entries) {
      if (isSparseDirectoryEntry(e)) expect(e.objectId, e.path).not.toBe(EMPTY_TREE);
    }
    const expanded = await expandSparseIndex(parsed.entries, undefined, trees);
    expect(expanded.entries.map(key)).toEqual(expected.map(key));
    return parsed;
  }

  it("an intent-to-add entry under a directory read sparse writes it expanded", async () => {
    const files = createInMemoryFilesApi();
    const trees = memoryTrees();
    const host = { settings: () => ({ sparse: inCone }), trees };
    const staging = createGitStaging(files, ".git/index");
    staging.setIndexHost?.(host);
    for (const e of base()) await staging.setEntry(e);
    await staging.write();
    const first = await expectStandsFor(files, trees, base());
    expect(first.entries.map((e) => e.path)).toEqual(["in/x", "out/", "top"]);

    const read = createGitStaging(files, ".git/index");
    read.setIndexHost?.(host);
    await read.read();
    expect(read.indexLayout?.()).toEqual({ split: false, sparse: true });
    const ita = entry("out/new.txt", 7, { ...sw, intentToAdd: true, objectId: EMPTY_TREE });
    await read.setEntry(ita);
    await read.write();
    const expected = [...base()];
    expected.splice(5, 0, ita);
    const written = await expectStandsFor(files, trees, expected);
    // convert_to_sparse_rec: out/ and the root invalid, so nothing below out/ collapses
    expect(written.entries.filter(isSparseDirectoryEntry)).toEqual([]);

    // removing it again collapses out/ back to its tree
    await read.removeEntry("out/new.txt");
    await read.write();
    const again = await expectStandsFor(files, trees, base());
    expect(again.entries.map((e) => e.path)).toEqual(["in/x", "out/", "top"]);
    expect(again.entries[1]?.objectId).toBe(first.entries[1]?.objectId);
  });

  it("an edited entry under a sparse directory, or one under a new directory, as the entries say", async () => {
    const files = createInMemoryFilesApi();
    const trees = memoryTrees();
    const host = { settings: () => ({ sparse: inCone }), trees };
    const staging = createGitStaging(files, ".git/index");
    staging.setIndexHost?.(host);
    for (const e of base()) await staging.setEntry(e);
    await staging.write();
    const read = createGitStaging(files, ".git/index");
    read.setIndexHost?.(host);
    await read.read();
    await read.setEntry(entry("out/deep/a.txt", 40, sw));
    await read.setEntry(entry("zz/q", 41, sw));
    await read.write();
    const expected = base();
    expected[3] = entry("out/deep/a.txt", 40, sw);
    expected.push(entry("zz/q", 41, sw));
    const written = await expectStandsFor(files, trees, expected);
    // an index kept sparse is not converted again (convert_to_sparse returns early): zz/ stays
    expect(written.entries.map((e) => e.path)).toEqual(["in/x", "out/", "top", "zz/q"]);
  });

  it("a cache-tree that no longer describes the entries is never written as a sparse directory", async () => {
    const files = createInMemoryFilesApi();
    const trees = memoryTrees();
    const file = new IndexFile(files, ".git/index", {
      host: { settings: () => ({ sparse: inCone }), trees },
    });
    const entries = base();
    // a fully valid cache-tree of other content (out/b.txt at another object), set without
    // the entries it describes
    const other = base();
    other[2] = entry("out/b.txt", 99, sw);
    const stale = (await storeCacheTree((l) => trees.store(l), other)) as CacheTree;
    file.setCacheTree(stale);
    await file.write(entries);
    const written = await expectStandsFor(files, trees, entries);
    const out = written.entries.find((e) => e.path === "out/");
    expect(out?.objectId).not.toBe(stale.subtrees.find((s) => s.name === "out")?.tree.id as string);
  });
});

describe("merge_base_index: unmerged entries under a merged one", () => {
  it("a stage-0 entry of the split file drops the shared index's stages 1-3 at its path", () => {
    const shared: SharedIndex = {
      id: oid(98),
      version: 2,
      entries: [
        entry("a", 1),
        entry("c", 2, { stage: 1 }),
        entry("c", 3, { stage: 2 }),
        entry("c", 4, { stage: 3 }),
        entry("d", 5),
      ],
    };
    const merged = mergeSplitIndex([entry("c", 9)], { baseId: oid(98) }, shared);
    expect(merged.map((e) => `${e.path}:${e.stage}:${e.size}`)).toEqual([
      "a:0:1",
      "c:0:9",
      "d:0:5",
    ]);
    // an unmerged entry added keeps the others
    const unmerged = mergeSplitIndex([entry("c", 8, { stage: 2 })], { baseId: oid(98) }, shared);
    expect(unmerged.map((e) => `${e.path}:${e.stage}:${e.size}`)).toEqual([
      "a:0:1",
      "c:1:2",
      "c:2:8",
      "c:3:4",
      "d:0:5",
    ]);
  });
});
