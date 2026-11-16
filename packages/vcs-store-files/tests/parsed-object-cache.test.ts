/**
 * The tree and commit caches of the files backend do not serve objects that gc, prune or
 * repack removed in the same process (they remove through a `FileRawStorage` of their own or
 * the pack set, not through `trees.remove` / `commits.remove`).
 */

import { createParsedObjectCacheTests } from "@statewalker/vcs-testing";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, FileRawStorage, gc, repack } from "../src/index.js";

const enc = new TextEncoder();
const who = { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" };

createParsedObjectCacheTests("Files", async () => {
  const files = createInMemoryFilesApi();
  const { objects } = await createGitFilesBackend({ files, create: true });
  const behind = new FileRawStorage(files, ".git/objects");
  return { objects, removeBehind: (id) => behind.remove(id) };
});

async function setup() {
  const files = createInMemoryFilesApi();
  const b = await createGitFilesBackend({ files, create: true });
  const h = b.history;
  const blob = await h.blobs.store([enc.encode("x\n")]);
  const tree = await h.trees.store([{ name: "x", mode: 0o100644, id: blob }]);
  const commit = await h.commits.store({
    tree,
    parents: [],
    author: who,
    committer: who,
    message: "m\n",
  });
  return { files, b, h, tree, commit };
}

describe("parsed object caches after gc in the same process", () => {
  it("gc's prune of unreachable loose objects reaches the caches", async () => {
    const { files, b, h, tree, commit } = await setup();
    // read once (cached); unreachable: no ref
    expect(await h.commits.load(commit)).toBeDefined();
    expect(await h.trees.load(tree)).toBeDefined();
    const r = await gc({ history: h, files, pruneExpireMs: 0 });
    expect(r.removedObjects).toBe(3);
    expect(await b.objects.has(tree)).toBe(false);
    expect(await h.trees.has(tree)).toBe(false);
    expect(await h.trees.load(tree)).toBeUndefined();
    expect(await h.trees.getEntry(tree, "x")).toBeUndefined();
    expect(await h.commits.has(commit)).toBe(false);
    expect(await h.commits.load(commit)).toBeUndefined();
  });

  it("gc's repack dropping unreachable packed objects reaches the caches", async () => {
    const { files, b, h, tree, commit } = await setup();
    // a ref without a reflog (HEAD's would keep the commit reachable)
    await h.refs.set("refs/keep/x", commit);
    // and something that stays reachable, so the second repack writes a pack
    const kept = await h.commits.store({
      tree: await h.trees.store([]),
      parents: [],
      author: who,
      committer: who,
      message: "kept\n",
    });
    await h.refs.set("refs/keep/y", kept);
    const packed = await repack({
      history: h,
      objects: b.objects,
      packs: b.packs,
      looseStorage: b.looseStorage,
      files,
      gitDir: b.gitDir,
    });
    expect(packed?.looseObjectsRemoved).toBe(5);
    await h.refs.remove("refs/keep/x");
    expect(await h.trees.load(tree)).toBeDefined();
    expect(await h.commits.load(commit)).toBeDefined();
    await gc({ history: h, files, pruneExpireMs: 0 });
    expect(await b.objects.has(tree)).toBe(false);
    expect(await h.trees.load(tree)).toBeUndefined();
    expect(await h.commits.load(commit)).toBeUndefined();
  });

  it("objects gc keeps are still served", async () => {
    const { files, h, tree, commit } = await setup();
    await h.refs.set("refs/heads/main", commit);
    expect(await h.trees.load(tree)).toBeDefined();
    await gc({ history: h, files, pruneExpireMs: 0 });
    const entries = [];
    for await (const e of (await h.trees.load(tree)) ?? []) entries.push(e.name);
    expect(entries).toEqual(["x"]);
    expect((await h.commits.load(commit))?.tree).toBe(tree);
  });
});
