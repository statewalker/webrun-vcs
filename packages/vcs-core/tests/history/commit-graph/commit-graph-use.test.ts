/**
 * The commit store over a commit-graph: walks read no commit the graph has, generations cut
 * ancestry and merge-base walks short, a stale graph (commits made after it) still gives the
 * answers of a store without one, and a corrupt record falls back to the commit.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../../src/common/files/index.js";
import { createCommitGraphProvider } from "../../../src/history/commit-graph/commit-graph-provider.js";
import { readCommitGraph } from "../../../src/history/commit-graph/commit-graph-reader.js";
import { writeCommitGraphFile } from "../../../src/history/commit-graph/commit-graph-writer.js";
import {
  getMergeBases,
  isAncestorOf,
  type ReachSource,
} from "../../../src/history/commits/commit-reach.js";
import { createCommits } from "../../../src/history/commits/commits.impl.js";
import { createGitObjects, type GitObjects } from "../../../src/history/objects/index.js";
import { createTrees } from "../../../src/history/trees/trees.impl.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

const OBJECTS = ".git/objects";

/** A store whose object reads are counted. */
async function setup() {
  const files = createInMemoryFilesApi();
  const base = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const reads = { count: 0 };
  const objects: GitObjects = Object.create(base);
  objects.get = (id, options) => {
    reads.count++;
    return base.get(id, options);
  };
  objects.getNow = undefined;
  const provider = createCommitGraphProvider(
    async () => (await readCommitGraph(files, OBJECTS)).graph,
  );
  const withGraph = createCommits(objects, { commitGraph: provider });
  const plain = createCommits(base);
  const tree = await createTrees(base).store([]);
  let n = 0;
  const commit = (parents: string[], time: number) => {
    const who = { name: "A", email: "a@example.com", timestamp: time, tzOffset: "+0000" };
    return plain.store({ tree, parents, author: who, committer: who, message: `c${n++}\n` });
  };
  const writeGraph = async (tips: string[]) => {
    await writeCommitGraphFile({ files, objectsDir: OBJECTS, objects: base, commits: tips });
    provider.invalidate();
  };
  return { files, objects, base, reads, provider, withGraph, plain, commit, writeGraph };
}

async function linear(
  commit: (p: string[], t: number) => Promise<string>,
  from: string[],
  n: number,
  t0: number,
) {
  const ids: string[] = [];
  let parents = from;
  for (let i = 0; i < n; i++) {
    const id = await commit(parents, t0 + i);
    ids.push(id);
    parents = [id];
  }
  return ids;
}

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("the commit store over a commit-graph", () => {
  it("walks without reading a commit the graph has", async () => {
    const s = await setup();
    const main = await linear(s.commit, [], 50, 1000);
    const side = await linear(s.commit, [main[20] as string], 10, 2000);
    const merge = await s.commit([main[49] as string, side[9] as string], 3000);
    await s.writeGraph([merge]);
    s.reads.count = 0;
    const walked = await collect(s.withGraph.walkAncestry(merge));
    expect(walked).toHaveLength(61);
    expect(await s.withGraph.getTree(merge)).toBeDefined();
    expect(await s.withGraph.getHeader?.(main[0] as string)).toMatchObject({
      parents: [],
      commitTime: 1000,
    });
    expect(await s.withGraph.isAncestor(main[3] as string, merge)).toBe(true);
    expect(await s.withGraph.findMergeBase(main[49] as string, side[9] as string)).toEqual([
      main[20],
    ]);
    expect(s.reads.count).toBe(0);
    // full commit data still comes from the commit
    expect((await s.withGraph.load(merge))?.message).toBe("c60\n");
    expect(s.reads.count).toBe(1);
    expect(walked).toEqual(await collect(s.plain.walkAncestry(merge)));
  });

  it("gives the answers of a store without a graph when the graph is stale", async () => {
    const s = await setup();
    const main = await linear(s.commit, [], 6, 1000);
    const a = await linear(s.commit, [main[2] as string], 3, 1100);
    await s.writeGraph([main[5] as string, a[2] as string]);
    // made after the graph: criss-cross merges and a new root
    const m1 = await s.commit([main[5] as string, a[2] as string], 1200);
    const m2 = await s.commit([a[2] as string, main[5] as string], 1201);
    const b = await linear(s.commit, [m1], 3, 1300);
    const c = await linear(s.commit, [m2], 2, 1300);
    const root = await s.commit([], 1);
    const top = await s.commit([b[2] as string, c[1] as string, root], 1400);
    const all = [...main, ...a, m1, m2, ...b, ...c, root, top];
    expect(await collect(s.withGraph.walkAncestry(top))).toEqual(
      await collect(s.plain.walkAncestry(top)),
    );
    for (const x of all) {
      for (const y of all) {
        expect(await s.withGraph.isAncestor(x, y)).toBe(await s.plain.isAncestor(x, y));
        expect(await s.withGraph.findMergeBase(x, y)).toEqual(await s.plain.findMergeBase(x, y));
      }
    }
    // the criss-cross: two merge bases, newest first
    expect(await s.withGraph.findMergeBase(b[2] as string, c[1] as string)).toEqual([
      a[2],
      main[5],
    ]);
  });

  it("falls back to the commit when the graph has a corrupt record", async () => {
    const s = await setup();
    const ids = await linear(s.commit, [], 3, 1000);
    await s.writeGraph([ids[2] as string]);
    const { graph } = await readCommitGraph(s.files, OBJECTS);
    if (!graph) throw new Error("no graph");
    // point the first parent of the tip past the end of the graph
    const pos = graph.position(ids[2] as string);
    const layer = graph.top;
    const bytes = layer.bytes.slice();
    new DataView(bytes.buffer).setUint32(layer.dataOffset(pos) + 20, 999);
    await s.files.write(`${OBJECTS}/info/commit-graph`, [bytes]);
    s.provider.invalidate();
    expect(await s.withGraph.getParents(ids[2] as string)).toEqual([ids[1]]);
  });
});

describe("generation cutoffs", () => {
  /** A main line of 300 commits and a branch off its tip. */
  async function longHistory() {
    const s = await setup();
    const main = await linear(s.commit, [], 300, 1000);
    const side = await linear(s.commit, [main[290] as string], 3, 5000);
    const other = await linear(s.commit, [main[290] as string], 3, 5000);
    // criss-cross over the two branches
    const x = await s.commit([side[2] as string, other[2] as string], 6000);
    const y = await s.commit([other[2] as string, side[2] as string], 6001);
    await s.writeGraph([main[299] as string, x, y]);
    const graphSource: ReachSource = async (id) => {
      const h = await s.withGraph.getHeader?.(id);
      return h && { parents: h.parents, date: h.commitTime, generation: h.generation };
    };
    const plainSource: ReachSource = async (id) => {
      const c = await s.plain.load(id);
      return (
        c && {
          parents: c.parents,
          date: c.committer.timestamp,
          generation: Number.POSITIVE_INFINITY,
        }
      );
    };
    return { s, main, side, other, x, y, graphSource, plainSource };
  }

  it("an ancestor check that fails stops at the generation of the commit looked for", async () => {
    const h = await longHistory();
    let withGen = 0;
    let without = 0;
    const tip = h.main[299] as string;
    const notAncestor = h.side[0] as string;
    expect(await isAncestorOf(h.graphSource, notAncestor, tip, { onVisit: () => withGen++ })).toBe(
      false,
    );
    expect(await isAncestorOf(h.plainSource, notAncestor, tip, { onVisit: () => without++ })).toBe(
      false,
    );
    expect(without).toBeGreaterThan(300);
    expect(withGen).toBeLessThan(15);
  });

  it("merge-base's redundancy check stops at the generation of the base checked", async () => {
    const h = await longHistory();
    let withGen = 0;
    let without = 0;
    const a = await getMergeBases(h.graphSource, h.x, [h.y], {
      correctedDates: true,
      onVisit: () => withGen++,
    });
    const b = await getMergeBases(h.plainSource, h.x, [h.y], { onVisit: () => without++ });
    expect(a).toEqual(b);
    expect(new Set(a)).toEqual(new Set([h.side[2], h.other[2]]));
    expect(without).toBeGreaterThan(250);
    expect(withGen).toBeLessThan(30);
  });

  it("the store's isAncestor reads few commits from the graph", async () => {
    const h = await longHistory();
    const graph = await h.s.provider.get();
    if (!graph) throw new Error("no graph");
    let parentsRead = 0;
    const parentsAt = graph.parentsAt.bind(graph);
    graph.parentsAt = (pos: number) => {
      parentsRead++;
      return parentsAt(pos);
    };
    expect(await h.s.withGraph.isAncestor(h.side[0] as string, h.main[299] as string)).toBe(false);
    expect(parentsRead).toBeLessThan(15);
    expect(await h.s.withGraph.isAncestor(h.main[3] as string, h.main[299] as string)).toBe(true);
    expect(parentsRead).toBeGreaterThan(250);
  });
});

describe("random histories", () => {
  it("merge bases and ancestry match a store without a graph (skewed dates, part of the history in the graph)", async () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 3; round++) {
      const s = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 45; i++) {
        const parents: string[] = [];
        if (i > 0 && rand(10) > 0)
          parents.push(ids[ids.length - 1 - rand(Math.min(ids.length, 6))] as string);
        if (i > 3 && rand(3) === 0) parents.push(ids[rand(ids.length)] as string);
        if (i > 6 && rand(9) === 0) parents.push(ids[rand(ids.length)] as string);
        // dates mostly rising, sometimes older than a parent; all distinct
        ids.push(
          await s.commit([...new Set(parents)], 1000 + i * 10 - (rand(5) === 0 ? 300 : 0) + round),
        );
        if (i === 30) await s.writeGraph(ids.slice());
      }
      const sample = ids.filter((_, i) => i % 3 === 0 || i > 40);
      for (const x of sample) {
        for (const y of sample) {
          expect(await s.withGraph.findMergeBase(x, y)).toEqual(await s.plain.findMergeBase(x, y));
          expect(await s.withGraph.isAncestor(x, y)).toBe(await s.plain.isAncestor(x, y));
        }
      }
    }
  });
});
