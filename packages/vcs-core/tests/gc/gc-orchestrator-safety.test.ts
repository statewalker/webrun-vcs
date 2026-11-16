/**
 * GcOrchestrator never deletes what is reachable: a reachable object that is stored but cannot
 * be read, or that is missing, aborts the run before anything is pruned (as `git gc` fails),
 * on the object kernel and on the typed-store fallback; the parents of shallow commits may be
 * absent; the reflogs the refs keep are roots; recent objects are kept with what they reach.
 */
import { describe, expect, it } from "vitest";
import {
  CorruptObjectError,
  createBlobs,
  createCommits,
  createGitObjects,
  createHistoryFromComponents,
  createHistoryFromStores,
  createTags,
  createTrees,
  GcOrchestrator,
  type GcStrategy,
  type History,
  MemoryGcStrategy,
  MemoryRawStorage,
  MissingObjectError,
} from "../../src/index.js";
import { rawStorageStaging } from "../../src/storage/adapters/staging-blob-store.js";

const enc = new TextEncoder();
const person = (t: number) => ({ name: "T", email: "t@t", timestamp: t, tzOffset: "+0000" });

function setup(kernel = true) {
  const storage = new MemoryRawStorage();
  const objects = createGitObjects(rawStorageStaging(storage));
  const history: History = kernel
    ? createHistoryFromComponents({ objects, refs: { type: "memory" } })
    : createHistoryFromStores({
        // the typed stores only: collectReachableObjects probes them in turn
        blobs: createBlobs(objects),
        trees: createTrees(objects),
        commits: createCommits(objects),
        tags: createTags(objects),
        refs: createHistoryFromComponents({ objects, refs: { type: "memory" } }).refs,
      });
  return {
    storage,
    history,
    orchestrator: new GcOrchestrator(history, new MemoryGcStrategy(storage)),
  };
}

/** `n` commits on main, each with its own blob; returns the commit ids, oldest first. */
async function chain(
  history: History,
  n: number,
): Promise<{ commits: string[]; blobs: string[]; trees: string[] }> {
  const commits: string[] = [];
  const blobs: string[] = [];
  const trees: string[] = [];
  for (let i = 0; i < n; i++) {
    const blob = await history.blobs.store([enc.encode(`file ${i}\n`)]);
    const tree = await history.trees.store([{ name: `f${i}.txt`, mode: 0o100644, id: blob }]);
    const commit = await history.commits.store({
      tree,
      parents: commits.length ? [commits[commits.length - 1] as string] : [],
      author: person(i + 1),
      committer: person(i + 1),
      message: `c${i}\n`,
    });
    blobs.push(blob);
    trees.push(tree);
    commits.push(commit);
  }
  await history.refs.set("refs/heads/main", commits[n - 1] as string);
  return { commits, blobs, trees };
}

async function keys(storage: MemoryRawStorage): Promise<string[]> {
  const out: string[] = [];
  for await (const k of storage.keys()) out.push(k);
  return out.sort();
}

async function overwrite(storage: MemoryRawStorage, id: string, bytes: Uint8Array) {
  await storage.store(
    id,
    (async function* () {
      yield bytes;
    })(),
  );
}

describe("GcOrchestrator on a corrupt reachable object", () => {
  for (const kernel of [true, false]) {
    const path = kernel ? "object kernel" : "typed-store fallback";

    it(`aborts and prunes nothing (${path})`, async () => {
      const { storage, history, orchestrator } = setup(kernel);
      await history.initialize();
      const { commits } = await chain(history, 5);
      await history.blobs.store([enc.encode("orphan\n")]);
      // main~2 becomes garbage: the walk must not stop there and lose main~3 and main~4
      await overwrite(storage, commits[2] as string, enc.encode("this is not a git object"));
      const before = await keys(storage);

      await expect(orchestrator.run({ dryRun: true })).rejects.toBeInstanceOf(CorruptObjectError);
      await expect(orchestrator.run()).rejects.toBeInstanceOf(CorruptObjectError);
      expect(await keys(storage)).toEqual(before);
    });

    it(`aborts on a commit that does not decode (${path})`, async () => {
      const { storage, history, orchestrator } = setup(kernel);
      await history.initialize();
      const { commits } = await chain(history, 4);
      // a well-formed object header, a commit without a tree
      const body = enc.encode("author T <t@t> 1 +0000\n\nbroken\n");
      const header = enc.encode(`commit ${body.length}\0`);
      const bytes = new Uint8Array(header.length + body.length);
      bytes.set(header);
      bytes.set(body, header.length);
      await overwrite(storage, commits[1] as string, bytes);
      const before = await keys(storage);

      await expect(orchestrator.run()).rejects.toBeInstanceOf(CorruptObjectError);
      expect(await keys(storage)).toEqual(before);
    });

    it(`aborts on a missing reachable object (${path})`, async () => {
      const { storage, history, orchestrator } = setup(kernel);
      await history.initialize();
      const { commits } = await chain(history, 5);
      await history.blobs.store([enc.encode("orphan\n")]);
      await storage.remove(commits[2] as string);
      const before = await keys(storage);

      await expect(orchestrator.run()).rejects.toBeInstanceOf(MissingObjectError);
      expect(await keys(storage)).toEqual(before);
    });

    it(`accepts the absent parents of shallow commits (${path})`, async () => {
      const { storage, history, orchestrator } = setup(kernel);
      await history.initialize();
      const { commits, blobs, trees } = await chain(history, 4);
      // a shallow clone of depth 3: c0 and what only it holds are not there
      for (const id of [commits[0], trees[0], blobs[0]]) await storage.remove(id as string);
      await history.refs.setShallow?.([commits[1] as string]);
      const orphan = await history.blobs.store([enc.encode("orphan\n")]);

      const result = await orchestrator.run();
      expect(result.prunedObjects).toBe(1);
      expect(result.reachableObjects).toBe(9);
      expect(await history.blobs.has(orphan)).toBe(false);
    });
  }

  it("collectReachableObjects throws CorruptObjectError for push and export callers", async () => {
    const { storage, history } = setup(true);
    await history.initialize();
    const { commits } = await chain(history, 3);
    await overwrite(storage, commits[1] as string, enc.encode("garbage"));
    const walk = async () => {
      for await (const _ of history.collectReachableObjects(
        new Set([commits[2] as string]),
        new Set(),
      )) {
        // drain
      }
    };
    await expect(walk()).rejects.toBeInstanceOf(CorruptObjectError);
  });
});

describe("GcOrchestrator roots", () => {
  it("keeps the objects the reflogs name", async () => {
    const { history, orchestrator } = setup(true);
    await history.initialize();
    const { commits } = await chain(history, 3);
    // main moves back with a reflog line, as `git reset --hard main~2` writes it
    await history.refs.batch(
      [{ name: "refs/heads/main", old: commits[2] as string, new: commits[0] as string }],
      { ident: "T <t@t> 1700000000 +0000", message: "reset: moving to HEAD~2", createReflog: true },
    );
    expect((await history.refs.getReflog?.("refs/heads/main")) !== undefined).toBe(true);

    const result = await orchestrator.run();
    expect(result.prunedObjects).toBe(0);
    expect(await history.commits.has(commits[2] as string)).toBe(true);
  });

  it("keeps recent unreachable objects with what they reach", async () => {
    const storage = new MemoryRawStorage();
    const objects = createGitObjects(rawStorageStaging(storage));
    const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
    await history.initialize();
    const { commits, trees, blobs } = await chain(history, 2);
    // an unreachable "recent" commit on an old (unreachable) tree
    const oldBlob = await history.blobs.store([enc.encode("old\n")]);
    const oldTree = await history.trees.store([{ name: "o", mode: 0o100644, id: oldBlob }]);
    const recent = await history.commits.store({
      tree: oldTree,
      parents: [commits[0] as string],
      author: person(9),
      committer: person(9),
      message: "in progress\n",
    });
    const garbage = await history.blobs.store([enc.encode("garbage\n")]);
    const memory = new MemoryGcStrategy(storage);
    const strategy: GcStrategy = {
      prune: (ids) => memory.prune(ids),
      compact: () => memory.compact(),
      deltify: (c) => memory.deltify(c),
      getStats: () => memory.getStats(),
      recentObjects: async (ids) => new Set([...ids].filter((id) => id === recent)),
    };
    const result = await new GcOrchestrator(history, strategy).run();
    expect(result.prunedObjects).toBe(1);
    for (const id of [recent, oldTree, oldBlob, ...trees, ...blobs])
      expect(await objects.has(id)).toBe(true);
    expect(await objects.has(garbage)).toBe(false);
  });
});
