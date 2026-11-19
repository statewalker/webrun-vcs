/**
 * The commit-graph reader, writer and verifier over an in-memory repository: round trips
 * (parents, octopus edges, dates, topological levels, corrected commit dates), split chains,
 * git's load-time validation and messages, `verify`, and the Bloom filter hashes of git's
 * t0095-bloom.sh.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../../src/common/files/index.js";
import {
  bloomKey,
  bloomMayContainPath,
  computeBloomFilter,
  DEFAULT_BLOOM_FILTER_SETTINGS,
  murmur3,
} from "../../../src/history/commit-graph/bloom-filter.js";
import {
  type CommitGraphDiagnostic,
  parseCommitGraphLayer,
} from "../../../src/history/commit-graph/commit-graph-format.js";
import { readCommitGraph } from "../../../src/history/commit-graph/commit-graph-reader.js";
import { verifyCommitGraph } from "../../../src/history/commit-graph/commit-graph-verify.js";
import { writeCommitGraphFile } from "../../../src/history/commit-graph/commit-graph-writer.js";
import { parseGraphCommit } from "../../../src/history/commit-graph/graph-commit-parse.js";
import { createCommits } from "../../../src/history/commits/commits.impl.js";
import type { Commits } from "../../../src/history/commits/commits.js";
import { createGitObjects, type GitObjects } from "../../../src/history/objects/index.js";
import { createTrees } from "../../../src/history/trees/trees.impl.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

const OBJECTS = ".git/objects";
const enc = new TextEncoder();

interface Repo {
  files: FilesApi;
  objects: GitObjects;
  commits: Commits;
  tree: string;
  commit(parents: string[], time: number, message?: string): Promise<string>;
}

async function repo(): Promise<Repo> {
  const files = createInMemoryFilesApi();
  const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const commits = createCommits(objects);
  const tree = await createTrees(objects).store([]);
  let n = 0;
  return {
    files,
    objects,
    commits,
    tree,
    commit: (parents, time, message) => {
      const who = { name: "A", email: "a@example.com", timestamp: time, tzOffset: "+0000" };
      return commits.store({
        tree,
        parents,
        author: who,
        committer: who,
        message: message ?? `c${n++}\n`,
      });
    },
  };
}

/** git's corrected commit dates and topological levels, computed from the parsed commits. */
async function expectedLevels(commits: Commits, ids: string[]) {
  const gen = new Map<string, number>();
  const topo = new Map<string, number>();
  const visit = async (id: string): Promise<void> => {
    if (gen.has(id)) return;
    const c = await commits.load(id);
    if (!c) throw new Error(id);
    let maxGen = 0;
    let maxTopo = 0;
    for (const p of c.parents) {
      await visit(p);
      maxGen = Math.max(maxGen, gen.get(p) as number);
      maxTopo = Math.max(maxTopo, topo.get(p) as number);
    }
    const date = c.committer.timestamp;
    gen.set(id, date && date > maxGen ? date : maxGen + 1);
    topo.set(id, maxTopo + 1);
  };
  for (const id of ids) await visit(id);
  return { gen, topo };
}

async function history(r: Repo) {
  // root -> a -> b ; root -> x -> y ; octopus(b, y, z) ; z a second root
  const root = await r.commit([], 1000);
  const a = await r.commit([root], 2000);
  const b = await r.commit([a], 3000);
  const x = await r.commit([root], 1500);
  // a commit dated before its parent: its corrected date is the parent's plus one
  const y = await r.commit([x], 1400);
  const z = await r.commit([], 500);
  const octopus = await r.commit([b, y, z], 4000);
  const merge = await r.commit([octopus, a], 5000);
  return { root, a, b, x, y, z, octopus, merge };
}

describe("commit-graph round trip", () => {
  it("stores parents, octopus edges, dates, levels and corrected dates", async () => {
    const r = await repo();
    const ids = await history(r);
    const written = await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [ids.merge],
    });
    expect(written.written).toBe(true);
    expect(written.commits).toBe(8);
    const { graph, opened } = await readCommitGraph(r.files, OBJECTS);
    expect(opened).toBe("graph");
    if (!graph) throw new Error("no graph");
    expect(graph.size).toBe(8);
    expect(graph.correctedDates).toBe(true);
    expect(
      graph.top.chunkIds.map((c) =>
        String.fromCharCode(c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255),
      ),
    ).toEqual(["OIDF", "OIDL", "CDAT", "GDA2", "EDGE"]);
    const { gen, topo } = await expectedLevels(r.commits, Object.values(ids));
    for (const id of Object.values(ids)) {
      const c = await r.commits.load(id);
      const g = graph.lookup(id);
      expect(g?.parents).toEqual(c?.parents);
      expect(g?.tree).toBe(r.tree);
      expect(g?.commitTime).toBe(c?.committer.timestamp);
      expect(g?.generation).toBe(gen.get(id));
      expect(g?.topoLevel).toBe(topo.get(id));
    }
    expect(graph.lookup(ids.y)?.generation).toBe(1501);
    expect(graph.lookup("0".repeat(40))).toBeUndefined();
    expect(graph.generationOf("f".repeat(40))).toBe(Number.POSITIVE_INFINITY);
  });

  it("writes no GDA2 with commitGraph.generationVersion=1 (generations are levels)", async () => {
    const r = await repo();
    const ids = await history(r);
    await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [ids.merge],
      generationVersion: 1,
    });
    const { graph } = await readCommitGraph(r.files, OBJECTS);
    expect(graph?.correctedDates).toBe(false);
    expect(graph?.lookup(ids.merge)?.generation).toBe(5);
  });

  it("reads GDA2 only when commitGraph.generationVersion is 2 or more", async () => {
    const r = await repo();
    const ids = await history(r);
    await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [ids.merge],
    });
    const { graph } = await readCommitGraph(r.files, OBJECTS, { generationVersion: 1 });
    expect(graph?.correctedDates).toBe(false);
    expect(graph?.lookup(ids.merge)?.generation).toBe(5);
  });

  it("does not write an empty graph", async () => {
    const r = await repo();
    const result = await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [],
    });
    expect(result.written).toBe(false);
    expect(await r.files.exists(`${OBJECTS}/info/commit-graph`)).toBe(false);
  });

  it("throws on a missing commit, as git dies", async () => {
    const r = await repo();
    const a = await r.commit(["1".repeat(40)], 1);
    await expect(
      writeCommitGraphFile({
        files: r.files,
        objectsDir: OBJECTS,
        objects: r.objects,
        commits: [a],
      }),
    ).rejects.toThrow(/unable to parse commit 1{40}/);
  });
});

describe("split chains", () => {
  it("adds layers, merges them by size, and replaces the chain", async () => {
    const r = await repo();
    const first: string[] = [];
    let tip = await r.commit([], 100);
    first.push(tip);
    for (let i = 1; i < 10; i++) {
      tip = await r.commit([tip], 100 + i);
      first.push(tip);
    }
    const write = async (split: true | "no-merge" | "replace") => {
      const existing = await readCommitGraph(r.files, OBJECTS);
      return writeCommitGraphFile({
        files: r.files,
        objectsDir: OBJECTS,
        objects: r.objects,
        commits: [tip],
        existing,
        split,
      });
    };
    const one = await write(true);
    expect(one.hashes).toHaveLength(1);
    expect(await r.files.exists(`${OBJECTS}/info/commit-graphs/graph-${one.hashes[0]}.graph`)).toBe(
      true,
    );
    for (let i = 0; i < 2; i++) tip = await r.commit([tip], 200 + i);
    const two = await write("no-merge");
    expect(two.hashes).toHaveLength(2);
    expect(two.hashes[0]).toBe(one.hashes[0]);
    let { graph, opened, files } = await readCommitGraph(r.files, OBJECTS);
    expect(opened).toBe("chain");
    expect(files).toHaveLength(2);
    expect(graph?.layers.map((l) => l.numCommits)).toEqual([10, 2]);
    expect(graph?.layers[1]?.numCommitsInBase).toBe(10);
    // a parent in the base layer
    const bottom = graph?.lookup(tip);
    expect(bottom?.parents).toHaveLength(1);
    expect(graph?.lookup(first[9] as string)?.generation).toBe(109);
    // twelve commits: 2 * 1 >= 2, so the 2-commit layer merges; 10 > 2 * 3 stays
    tip = await r.commit([tip], 300);
    const three = await write(true);
    expect(three.hashes).toHaveLength(2);
    expect(three.expired).toHaveLength(1);
    ({ graph } = await readCommitGraph(r.files, OBJECTS));
    expect(graph?.layers.map((l) => l.numCommits)).toEqual([10, 3]);
    tip = await r.commit([tip], 400);
    const four = await write("replace");
    expect(four.hashes).toHaveLength(1);
    ({ graph } = await readCommitGraph(r.files, OBJECTS));
    expect(graph?.layers.map((l) => l.numCommits)).toEqual([14]);
    const names: string[] = [];
    for await (const e of r.files.list(`${OBJECTS}/info/commit-graphs`)) names.push(e.name);
    expect(names.sort()).toEqual(["commit-graph-chain", `graph-${four.hashes[0]}.graph`]);
  });

  it("keeps the layers that load when the chain names a missing one", async () => {
    const r = await repo();
    let tip = await r.commit([], 1);
    const existing0 = await readCommitGraph(r.files, OBJECTS);
    const a = await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [tip],
      existing: existing0,
      split: true,
    });
    tip = await r.commit([tip], 2);
    const b = await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [tip],
      existing: await readCommitGraph(r.files, OBJECTS),
      split: "no-merge",
    });
    expect(b.hashes[0]).toBe(a.hashes[0]);
    await r.files.remove(`${OBJECTS}/info/commit-graphs/graph-${b.hashes[1]}.graph`);
    const read = await readCommitGraph(r.files, OBJECTS);
    expect(read.incompleteChain).toBe(true);
    expect(read.graph?.size).toBe(1);
    expect(read.diagnostics).toEqual([
      { level: "warning", message: "unable to find all commit-graph files" },
    ]);
    const verify = await verifyCommitGraph(r.files, OBJECTS, readCommit(r));
    expect(verify.exitCode).toBe(1);
    expect(verify.messages).toEqual([
      "warning: unable to find all commit-graph files",
      "error: one or more commit-graph chain files could not be loaded",
    ]);
  });

  it("expires the layers merged away without an expire time, however slow the clock ticks", async () => {
    const r = await repo();
    let tip = await r.commit([], 1);
    const write = async (split: true | "no-merge" | "replace", now?: () => number) =>
      writeCommitGraphFile({
        files: r.files,
        objectsDir: OBJECTS,
        objects: r.objects,
        commits: [tip],
        existing: await readCommitGraph(r.files, OBJECTS),
        split,
        now,
      });
    await write(true);
    tip = await r.commit([tip], 2);
    const two = await write("no-merge");
    expect(two.hashes).toHaveLength(2);
    // every clock read lands in a later second (git reads time(NULL) once for the expiry,
    // after mark_commit_graphs set the merged-away layers' mtime)
    let t = Date.now() + 60_000;
    const replaced = await write("replace", () => {
      t += 1500;
      return t;
    });
    expect(replaced.expired).toHaveLength(2);
    const names: string[] = [];
    for await (const e of r.files.list(`${OBJECTS}/info/commit-graphs`)) names.push(e.name);
    expect(names.sort()).toEqual(["commit-graph-chain", `graph-${replaced.hashes[0]}.graph`]);
  });
});

describe("a failed split write", () => {
  /** `files` with `move` refusing what `refuse` names (its source, then its target). */
  const refusing = (files: FilesApi, refuse: (from: string, to: string) => boolean): FilesApi =>
    new Proxy(files, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "move") {
          return async (from: string, to: string) =>
            refuse(from, to) ? false : (value as FilesApi["move"]).call(target, from, to);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const graphDir = async (files: FilesApi) => {
    const names: string[] = [];
    for await (const e of files.list(`${OBJECTS}/info/commit-graphs`)) names.push(e.name);
    return names.sort();
  };

  /** A single-file graph of one commit, and a second commit for a split write over it. */
  async function overSingleFile() {
    const r = await repo();
    const first = await r.commit([], 1);
    await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [first],
      existing: await readCommitGraph(r.files, OBJECTS),
    });
    const tip = await r.commit([first], 2);
    return { r, tip, existing: await readCommitGraph(r.files, OBJECTS) };
  }

  it("leaves no temporary layer when the base graph cannot be renamed", async () => {
    const { r, tip, existing } = await overSingleFile();
    const files = refusing(r.files, (from) => from.endsWith("/info/commit-graph"));
    await expect(
      writeCommitGraphFile({
        files,
        objectsDir: OBJECTS,
        objects: r.objects,
        commits: [tip],
        existing,
        split: "no-merge",
      }),
    ).rejects.toThrow(/failed to rename base commit-graph file/);
    expect(await graphDir(r.files)).toEqual([]);
    expect(await r.files.exists(`${OBJECTS}/info/commit-graph`)).toBe(true);
  });

  it("leaves no temporary layer when the layer cannot be renamed into place", async () => {
    const { r, tip, existing } = await overSingleFile();
    const files = refusing(r.files, (from) => from.includes("/tmp_graph_"));
    await expect(
      writeCommitGraphFile({
        files,
        objectsDir: OBJECTS,
        objects: r.objects,
        commits: [tip],
        existing,
        split: "no-merge",
      }),
    ).rejects.toThrow(/could not move/);
    expect((await graphDir(r.files)).filter((n) => n.startsWith("tmp_graph_"))).toEqual([]);
    expect((await graphDir(r.files)).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });
});

/** A commit read from the object store, as verify compares it. */
function readCommit(r: Repo) {
  return async (id: string) => {
    const o = await r.objects.get(id);
    if (!o) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of o.content) chunks.push(c);
    const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    return parseGraphCommit(data, id);
  };
}

describe("validation on load", () => {
  async function graphBytes() {
    const r = await repo();
    const ids = await history(r);
    await writeCommitGraphFile({
      files: r.files,
      objectsDir: OBJECTS,
      objects: r.objects,
      commits: [ids.merge],
    });
    const chunks: Uint8Array[] = [];
    for await (const c of r.files.read(`${OBJECTS}/info/commit-graph`)) chunks.push(c);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { r, bytes, ids };
  }

  const refuse = (bytes: Uint8Array) => {
    const diagnostics: CommitGraphDiagnostic[] = [];
    expect(parseCommitGraphLayer(bytes, undefined, {}, diagnostics)).toBeUndefined();
    return diagnostics.map((d) => d.message);
  };

  it("refuses what git refuses, with git's messages", async () => {
    const { bytes } = await graphBytes();
    expect(refuse(bytes.subarray(0, 100))).toEqual(["commit-graph file is too small"]);
    const sig = bytes.slice();
    sig[0] = 0x58;
    expect(refuse(sig)).toEqual([
      "commit-graph signature 58475048 does not match signature 43475048",
    ]);
    const ver = bytes.slice();
    ver[4] = 2;
    expect(refuse(ver)).toEqual(["commit-graph version 2 does not match version 1"]);
    const hash = bytes.slice();
    hash[5] = 2;
    expect(refuse(hash)).toEqual(["commit-graph hash version 2 does not match version 1"]);
    const chunks = bytes.slice();
    chunks[6] = 200;
    expect(refuse(chunks)).toEqual(["commit-graph file is too small to hold 200 chunks"]);
    // the OIDL entry renamed: the required chunk is missing
    const missing = bytes.slice();
    missing.set(enc.encode("XXXX"), 8 + 12);
    expect(refuse(missing)).toEqual([
      "commit-graph required OID lookup chunk missing or corrupted",
    ]);
    // a chunk offset past the end
    const offset = bytes.slice();
    new DataView(offset.buffer).setBigUint64(8 + 12 + 4, BigInt(bytes.length));
    expect(refuse(offset)[0]).toMatch(/^improper chunk offset\(s\)/);
    // fanout out of order
    const fanout = bytes.slice();
    const at = Number(new DataView(bytes.buffer).getBigUint64(8 + 4));
    new DataView(fanout.buffer).setUint32(at, 0xffff);
    expect(refuse(fanout)).toEqual([
      "commit-graph fanout values out of order",
      "commit-graph required OID fanout chunk missing or corrupted",
    ]);
  });

  it("verify reports a bad checksum, wrong dates and parents", async () => {
    const { r, bytes, ids } = await graphBytes();
    expect((await verifyCommitGraph(r.files, OBJECTS, readCommit(r))).exitCode).toBe(0);
    // the last byte of the trailer
    const sum = bytes.slice();
    sum[sum.length - 1] ^= 1;
    await r.files.write(`${OBJECTS}/info/commit-graph`, [sum]);
    let v = await verifyCommitGraph(r.files, OBJECTS, readCommit(r));
    expect(v).toEqual({
      exitCode: 2,
      messages: ["the commit-graph file has incorrect checksum and is likely corrupt"],
    });
    // the date of the first commit (its low word), checksum left stale
    const { graph } = await readCommitGraph(r.files, OBJECTS);
    const layer = graph?.top;
    if (!layer) throw new Error();
    const date = bytes.slice();
    const pos = layer.dataOffset(0) + 20 + 12;
    new DataView(date.buffer).setUint32(pos, new DataView(date.buffer).getUint32(pos) + 1);
    await r.files.write(`${OBJECTS}/info/commit-graph`, [date]);
    v = await verifyCommitGraph(r.files, OBJECTS, readCommit(r));
    expect(v.exitCode).toBe(1);
    const first = graph?.idAt(0) as string;
    const real = (await r.commits.load(first))?.committer.timestamp as number;
    expect(v.messages).toContain(
      `commit date for commit ${first} in commit-graph is ${real + 1} != ${real}`,
    );
    expect(v.messages[0]).toBe(
      "the commit-graph file has incorrect checksum and is likely corrupt",
    );
    void ids;
  });

  it("no graph verifies", async () => {
    const r = await repo();
    expect(await verifyCommitGraph(r.files, OBJECTS, readCommit(r))).toEqual({
      exitCode: 0,
      messages: [],
    });
  });
});

describe("Bloom filters (git's t0095-bloom.sh)", () => {
  const s = DEFAULT_BLOOM_FILTER_SETTINGS;
  const hex = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;

  it("murmur3", () => {
    expect(hex(murmur3(0, enc.encode(""), 1))).toBe("0x00000000");
    expect(hex(murmur3(0, enc.encode("Hello world!"), 1))).toBe("0x627b0c2c");
    expect(hex(murmur3(0, enc.encode("The quick brown fox jumps over the lazy dog"), 1))).toBe(
      "0x2e4ff723",
    );
    const high = Uint8Array.of(0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff);
    expect(hex(murmur3(0, high, 2))).toBe("0xa183ccfd");
    // version 1 reads the bytes as signed chars
    expect(murmur3(0, high, 1)).not.toBe(murmur3(0, high, 2));
  });

  it("keys and filters", () => {
    const filter = (path: string) => {
      const key = bloomKey(enc.encode(path), s);
      const f = computeBloomFilter([enc.encode(path)], s);
      return {
        key: key.map(hex).join("|"),
        data: [...f].map((b) => b.toString(16).padStart(2, "0")).join("|"),
      };
    };
    expect(filter("")).toEqual({
      key: "0x5615800c|0x5b966560|0x61174ab4|0x66983008|0x6c19155c|0x7199fab0|0x771ae004",
      data: "11|11",
    });
    expect(filter(" ").data).toBe("51|55");
    expect(filter("Hello world!").data).toBe("92|6c");
    expect(filter("file.txt")).toEqual({
      key: "0x20ab385b|0xf5237fe2|0xc99bc769|0x9e140ef0|0x728c5677|0x47049dfe|0x1b7ce585",
      data: "a5|4a",
    });
    expect([...computeBloomFilter([], s)]).toEqual([0]);
    const many = Array.from({ length: 513 }, (_, i) => enc.encode(`f${i}`));
    expect([...computeBloomFilter(many, s)]).toEqual([0xff]);
  });

  it("answers path queries with the leading directories", () => {
    const paths = ["dir", "dir/sub", "dir/sub/file"].map((p) => enc.encode(p));
    const f = computeBloomFilter(paths, s);
    expect(bloomMayContainPath(f, "dir/sub/file", s)).toBe(true);
    expect(bloomMayContainPath(f, "other/place", s)).toBe(false);
    expect(bloomMayContainPath(new Uint8Array(0), "x", s)).toBeUndefined();
  });
});
