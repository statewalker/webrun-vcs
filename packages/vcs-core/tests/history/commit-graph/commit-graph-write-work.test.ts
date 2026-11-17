/**
 * The work `writeCommitGraphFile` does, counted rather than timed: each commit is parsed from
 * the object store once (a parent's tree for its child's Bloom filter comes from the commits
 * already parsed), each tree is read once while consecutive commits share it, and the filters
 * hold exactly the changed paths when entries switch between file and directory, change mode
 * or only differ in their ids.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../../src/common/files/index.js";
import { bloomMayContainPath } from "../../../src/history/commit-graph/bloom-filter.js";
import { readCommitGraph } from "../../../src/history/commit-graph/commit-graph-reader.js";
import { writeCommitGraphFile } from "../../../src/history/commit-graph/commit-graph-writer.js";
import { createCommits } from "../../../src/history/commits/commits.impl.js";
import { createGitObjects, type GitObjects } from "../../../src/history/objects/index.js";
import { createTrees } from "../../../src/history/trees/trees.impl.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

const OBJECTS = ".git/objects";
const enc = new TextEncoder();

/** A store that counts the objects read through it, by type. */
function counting(objects: GitObjects) {
  const reads = { commit: 0, tree: 0, other: 0 };
  const store: Pick<GitObjects, "get"> = {
    get: async (id, options) => {
      const obj = await objects.get(id, options);
      if (obj?.type === "commit") reads.commit++;
      else if (obj?.type === "tree") reads.tree++;
      else reads.other++;
      return obj;
    },
  };
  return { store, reads };
}

type Files = Record<string, { content: string; mode?: number }>;

/** A repository whose commits each store the whole `files` map given (nested trees built). */
async function repo() {
  const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const commits = createCommits(objects);
  const trees = createTrees(objects);
  const blobs = new Map<string, string>();
  const blob = async (content: string) => {
    let id = blobs.get(content);
    if (!id) {
      const bytes = enc.encode(content);
      id = await objects.put("blob", bytes.length, [bytes]);
      blobs.set(content, id);
    }
    return id;
  };
  const storeTree = async (files: Files, prefix: string): Promise<string> => {
    // a name maps to its file, or to undefined for a directory
    const names = new Map<string, { content: string; mode?: number } | undefined>();
    for (const [path, file] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) names.set(rest, file);
      else names.set(rest.slice(0, slash), undefined);
    }
    const entries: { name: string; mode: number; id: string }[] = [];
    for (const [name, file] of names) {
      if (file) {
        entries.push({ name, mode: file.mode ?? 0o100644, id: await blob(file.content) });
      } else {
        entries.push({ name, mode: 0o040000, id: await storeTree(files, `${prefix}${name}/`) });
      }
    }
    return trees.store(entries);
  };
  let time = 1000;
  const commit = async (parents: string[], files: Files) => {
    time += 10;
    const who = { name: "A", email: "a@example.com", timestamp: time, tzOffset: "+0000" };
    return commits.store({
      tree: await storeTree(files, ""),
      parents,
      author: who,
      committer: who,
      message: `c${time}\n`,
    });
  };
  return { objects, commit };
}

describe("commit-graph writing, counted", () => {
  it("parses each commit once and reads each tree once for the filters", async () => {
    const { objects, commit } = await repo();
    const files: Files = {};
    for (let d = 0; d < 4; d++) {
      for (let f = 0; f < 5; f++) files[`dir${d}/file${f}.txt`] = { content: `v0 ${d} ${f}` };
    }
    let head = await commit([], files);
    const n = 60;
    for (let i = 1; i < n; i++) {
      files[`dir${i % 4}/file${i % 5}.txt`] = { content: `v${i}` };
      head = await commit([head], files);
    }
    const fs = createInMemoryFilesApi();
    const { store, reads } = counting(objects);
    const result = await writeCommitGraphFile({
      files: fs,
      objectsDir: OBJECTS,
      objects: store,
      commits: [head],
      changedPaths: true,
    });
    expect(result.commits).toBe(n);
    // every commit read once: the filters take the parents' trees from the commits parsed
    expect(result.reads?.commits).toBe(n);
    expect(reads.commit).toBe(n);
    // a commit changes one file: its root and one directory are new, the rest is shared with
    // its parent and found again among the trees read just before
    const uniqueTrees = 1 + 4 + (n - 1) * 2;
    expect(result.reads?.trees).toBeLessThanOrEqual(uniqueTrees);
    expect(reads.tree).toBe(result.reads?.trees);
    expect(reads.other).toBe(0);
  });

  it("holds exactly the changed paths: file to directory, mode, id", async () => {
    const { objects, commit } = await repo();
    const before: Files = {
      "a/b.txt": { content: "b" },
      "a/c.txt": { content: "c" },
      node: { content: "a file" },
      "run.sh": { content: "#!/bin/sh" },
      same: { content: "same" },
      "z/deep/x": { content: "x" },
    };
    const first = await commit([], before);
    const after: Files = {
      "a/b.txt": { content: "b2" },
      "a/c.txt": { content: "c" },
      "node/inner": { content: "now a directory" },
      "run.sh": { content: "#!/bin/sh", mode: 0o100755 },
      same: { content: "same" },
      "z/deep/x": { content: "x" },
      "z/deep/y": { content: "y" },
    };
    const second = await commit([first], after);
    const fs = createInMemoryFilesApi();
    await writeCommitGraphFile({
      files: fs,
      objectsDir: OBJECTS,
      objects,
      commits: [second],
      changedPaths: true,
    });
    const { graph } = await readCommitGraph(fs, OBJECTS);
    if (!graph) throw new Error("no graph");
    const filter = graph.bloomFilterAt(graph.position(second));
    if (!filter) throw new Error("no filter");
    const changed = ["a", "a/b.txt", "node", "node/inner", "run.sh", "z", "z/deep", "z/deep/y"];
    for (const path of changed) {
      expect([path, bloomMayContainPath(filter.data, path, filter.settings)]).toEqual([path, true]);
    }
    // 8 paths at 10 bits each: 10 bytes, as git sizes the filter
    expect(filter.data.length).toBe(10);
    let absent = 0;
    for (const path of ["a/c.txt", "same", "z/deep/x", "missing", "other/path"]) {
      if (bloomMayContainPath(filter.data, path, filter.settings) === false) absent++;
    }
    expect(absent).toBeGreaterThanOrEqual(4);
  });

  it("reads a streamed tree (a loose tree over 64 KB) once and to its end", async () => {
    const { objects, commit } = await repo();
    const files: Files = {};
    for (let i = 0; i < 2000; i++)
      files[`big/entry-with-a-long-name-${i}.txt`] = { content: `${i}` };
    const first = await commit([], files);
    files["big/entry-with-a-long-name-7.txt"] = { content: "changed" };
    const second = await commit([first], files);
    // objects over 64 KB come without `bytes`, as the loose store streams them; each content
    // iterator is watched: it must be read to its end (or returned), and never left open
    const open = new Set<number>();
    let streamed = 0;
    let gets = 0;
    const store: Pick<GitObjects, "get"> = {
      get: async (id, options) => {
        gets++;
        const obj = await objects.get(id, options);
        if (!obj || obj.size <= 64 * 1024) return obj;
        const n = ++streamed;
        const inner = obj.content;
        return {
          type: obj.type,
          size: obj.size,
          content: {
            [Symbol.asyncIterator]() {
              const it = inner[Symbol.asyncIterator]();
              open.add(n);
              return {
                async next() {
                  const r = await it.next();
                  if (r.done) open.delete(n);
                  return r;
                },
                async return() {
                  open.delete(n);
                  await it.return?.();
                  return { done: true as const, value: undefined };
                },
              };
            },
          },
        };
      },
    };
    const fs = createInMemoryFilesApi();
    const result = await writeCommitGraphFile({
      files: fs,
      objectsDir: OBJECTS,
      objects: store,
      commits: [second],
      changedPaths: true,
    });
    expect(result.commits).toBe(2);
    // the two versions of "big" are streamed, each read once
    expect(streamed).toBe(2);
    expect(open.size).toBe(0);
    expect(gets).toBe((result.reads?.commits ?? 0) + (result.reads?.trees ?? 0));
    const { graph } = await readCommitGraph(fs, OBJECTS);
    const filter = graph?.bloomFilterAt(graph.position(second));
    if (!filter) throw new Error("no filter");
    expect(
      bloomMayContainPath(filter.data, "big/entry-with-a-long-name-7.txt", filter.settings),
    ).toBe(true);
  });
});
