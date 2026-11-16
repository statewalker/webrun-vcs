/**
 * How many object reads `collectReachableObjects` and `Commits.load` cost.
 *
 * Each read of a loose object is a file open plus an inflate, so probing the typed stores
 * one after another (has, then load as commit, tree, tag) multiplied the work about tenfold
 * on a file-backed repository. These tests count `GitObjects.get` calls, which is
 * deterministic, instead of timing, and check that the single-read walk returns exactly what
 * probing the typed stores returns.
 */

import { describe, expect, it } from "vitest";
import type { PersonIdent } from "../../src/common/person/index.js";
import {
  createGitObjects,
  createHistoryFromComponents,
  createHistoryFromStores,
  EMPTY_TREE_ID,
  type GitObjects,
  type History,
  ObjectType,
} from "../../src/history/index.js";
import { rawStorageStaging } from "../../src/storage/adapters/index.js";
import { MemoryRawStorage } from "../../src/storage/raw/index.js";

const enc = new TextEncoder();

const person = (timestamp: number): PersonIdent => ({
  name: "Ada Lovelace",
  email: "ada@example.com",
  timestamp,
  tzOffset: "+0000",
});

/** GitObjects that counts `get` calls. */
function countingObjects(): { objects: GitObjects; gets: { count: number } } {
  const inner = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const gets = { count: 0 };
  const objects: GitObjects = {
    ...inner,
    get: (id, opts) => {
      gets.count++;
      return inner.get(id, opts);
    },
  };
  return { objects, gets };
}

/**
 * A history of `n` commits with a merge, nested trees, an empty subtree and an annotated tag;
 * returns the tag id, the first commit id and the number of distinct objects reachable from the
 * tag.
 */
async function buildRepository(history: History, n: number) {
  const ids = new Set<string>();
  let previous: string | undefined;
  let first: string | undefined;
  const branchTips: string[] = [];
  for (let i = 0; i < n; i++) {
    const blob = await history.blobs.store([enc.encode(`file ${i}\n`)]);
    const shared = await history.blobs.store([enc.encode("shared\n")]);
    const sub = await history.trees.store([
      { mode: 0o100644, name: "shared.txt", id: shared },
      { mode: 0o100644, name: `n${i}.txt`, id: blob },
    ]);
    const root = await history.trees.store([
      { mode: 0o040000, name: "empty", id: EMPTY_TREE_ID },
      { mode: 0o100644, name: "file.txt", id: blob },
      { mode: 0o040000, name: "sub", id: sub },
    ]);
    const parents = previous ? [previous] : [];
    // every tenth commit merges a side commit
    if (i % 10 === 9 && previous) {
      const side = await history.commits.store({
        tree: sub,
        parents: [previous],
        author: person(1_700_000_000 + i),
        committer: person(1_700_000_000 + i),
        message: `side ${i}\n`,
      });
      ids.add(side);
      branchTips.push(side);
      parents.push(side);
    }
    const commit = await history.commits.store({
      tree: root,
      parents,
      author: person(1_700_000_000 + i),
      committer: person(1_700_000_000 + i),
      message: `commit ${i}\n`,
    });
    for (const id of [blob, shared, sub, root, commit, EMPTY_TREE_ID]) ids.add(id);
    first ??= commit;
    previous = commit;
  }
  if (!previous || !first) throw new Error("no commits");
  const tag = await history.tags.store({
    object: previous,
    objectType: ObjectType.COMMIT,
    tag: "v1",
    tagger: person(1_800_000_000),
    message: "release\n",
  });
  ids.add(tag);
  return { tag, first, reachable: ids.size };
}

async function collect(history: History, wants: string[], exclude: string[] = []) {
  const out: string[] = [];
  for await (const id of history.collectReachableObjects(new Set(wants), new Set(exclude))) {
    out.push(id);
  }
  return out;
}

describe("collectReachableObjects reads each object once", () => {
  it("does at most one get per reachable object", async () => {
    const { objects, gets } = countingObjects();
    const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
    await history.initialize();
    const { tag, reachable } = await buildRepository(history, 40);

    gets.count = 0;
    const ids = await collect(history, [tag]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(reachable);
    // Probing the typed stores took about ten reads per object.
    expect(gets.count).toBeLessThanOrEqual(reachable);
  });

  it("yields the same objects, in the same order, as probing the typed stores", async () => {
    const { objects } = countingObjects();
    const kernel = createHistoryFromComponents({ objects, refs: { type: "memory" } });
    await kernel.initialize();
    const { tag, first } = await buildRepository(kernel, 25);
    // The same stores without the kernel: collectReachableObjects probes them in turn.
    const probing = createHistoryFromStores({
      blobs: kernel.blobs,
      trees: kernel.trees,
      commits: kernel.commits,
      tags: kernel.tags,
      refs: kernel.refs,
    });
    const missing = "0".repeat(40);

    expect(await collect(kernel, [tag, missing])).toEqual(await collect(probing, [tag, missing]));
    expect(await collect(kernel, [tag], [first])).toEqual(await collect(probing, [tag], [first]));
  });

  it("Commits.load reads a commit once and a non-commit once", async () => {
    const { objects, gets } = countingObjects();
    const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
    await history.initialize();
    const { first } = await buildRepository(history, 1);
    const blob = await history.blobs.store([enc.encode("not a commit\n")]);

    gets.count = 0;
    expect((await history.commits.load(first))?.message).toBe("commit 0\n");
    expect(gets.count).toBe(1);

    gets.count = 0;
    expect(await history.commits.load(blob)).toBeUndefined();
    expect(await history.commits.load("f".repeat(40))).toBeUndefined();
    expect(gets.count).toBeLessThanOrEqual(2);
  });
});
