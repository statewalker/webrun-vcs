/**
 * The cost of receive-pack's connectivity and fast-forward checks, counted in facade reads
 * (not time): many refs, a failed push with many commands, a commit dated in the past, a
 * fast-forward over a long history.
 */

import { describe, expect, it } from "vitest";

import {
  type CommitGraphInfo,
  checkConnectivity,
  isAncestorOf,
  PushConnectivity,
  type RepositoryFacade,
  type TreeEntryInfo,
} from "../src/index.js";
import {
  clientWithNewCommits,
  fullPackOf,
  packOf,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";

type Obj =
  | { type: "commit"; parents: string[]; tree: string; time: number }
  | { type: "tree"; entries: TreeEntryInfo[] }
  | { type: "blob" };

/** A facade over a map of objects that counts its reads. */
function syntheticFacade(objects: Map<string, Obj>) {
  const reads = { commits: 0, trees: 0, types: 0, has: 0, tags: 0 };
  const facade: RepositoryFacade = {
    importPack: async () => ({}) as never,
    exportPack: () => (async function* () {})(),
    async *walkAncestors(start: string) {
      const stack = [start];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        reads.commits++;
        const o = objects.get(oid);
        if (o?.type !== "commit") continue;
        yield oid;
        stack.push(...o.parents);
      }
    },
    has: async (oid) => {
      reads.has++;
      return objects.has(oid);
    },
    getObjectType: async (oid) => {
      reads.types++;
      return objects.get(oid)?.type;
    },
    getCommitInfo: async (oid): Promise<CommitGraphInfo | undefined> => {
      reads.commits++;
      const o = objects.get(oid);
      return o?.type === "commit" ? { parents: o.parents, time: o.time, tree: o.tree } : undefined;
    },
    getTreeEntries: async (oid) => {
      reads.trees++;
      const o = objects.get(oid);
      return o?.type === "tree" ? o.entries : undefined;
    },
    getTagInfo: async () => {
      reads.tags++;
      return undefined;
    },
  };
  return { facade, reads };
}

const hex = (n: number) => n.toString(16).padStart(40, "0");
const TREE = "e".repeat(40);

/** A linear history of `n` commits (ids hex(1)…hex(n)), times increasing. */
function history(n: number): Map<string, Obj> {
  const objects = new Map<string, Obj>();
  objects.set(TREE, { type: "tree", entries: [] });
  for (let i = 1; i <= n; i++) {
    objects.set(hex(i), {
      type: "commit",
      parents: i > 1 ? [hex(i - 1)] : [],
      tree: TREE,
      time: 1_000_000 + i,
    });
  }
  return objects;
}

describe("connectivity cost (facade reads)", () => {
  it("50k refs and one new commit on a branch: reads the new commit, not the refs", async () => {
    const objects = history(50_000);
    const known = Array.from({ length: 50_000 }, (_, i) => hex(i + 1));
    const tip = "f".repeat(40);
    objects.set(tip, { type: "commit", parents: [hex(50_000)], tree: TREE, time: 2_000_000 });
    const { facade, reads } = syntheticFacade(objects);
    const result = await checkConnectivity(facade, [tip], known);
    expect(result.ok).toBe(true);
    expect(reads.commits).toBeLessThanOrEqual(3);
    expect(reads.types + reads.trees + reads.has).toBeLessThanOrEqual(5);
  });

  it("a new branch deep in history: the exact walk paints down to it once", async () => {
    const objects = history(50_000);
    const known = Array.from({ length: 50_000 }, (_, i) => hex(i + 1));
    const tip = "f".repeat(40);
    // on a commit far below the newest ref: step 1 runs into old history, step 2 paints
    objects.set(tip, { type: "commit", parents: [hex(100)], tree: TREE, time: 2_000_000 });
    const { facade, reads } = syntheticFacade(objects);
    const result = await checkConnectivity(facade, [tip], [hex(50_000), ...known.slice(0, 200)]);
    expect(result.ok).toBe(true);
    expect(result.objects).toBe(1);
    // the refs (201), the commits between the newest ref and the branch point, nothing more
    expect(reads.commits).toBeLessThan(50_000 + 201 + 10);
  });

  it("a commit dated 0 on a ref tip does not walk the history", async () => {
    const objects = history(20_000);
    const evil = "f".repeat(40);
    objects.set(evil, { type: "commit", parents: [hex(20_000)], tree: TREE, time: 0 });
    const { facade, reads } = syntheticFacade(objects);
    expect((await checkConnectivity(facade, [evil], [hex(20_000)])).ok).toBe(true);
    expect(reads.commits).toBeLessThanOrEqual(3);
  });

  it("one analysis serves many tips: a verdict per tip without walking again", async () => {
    const objects = history(1000);
    const tips: string[] = [];
    for (let i = 0; i < 200; i++) {
      const tip = `f${hex(i).slice(1)}`;
      // half broken (tree absent), half fine
      objects.set(tip, {
        type: "commit",
        parents: [hex(1000)],
        tree: i % 2 === 0 ? `d${hex(i).slice(1)}` : TREE,
        time: 2_000_000,
      });
      tips.push(tip);
    }
    const { facade, reads } = syntheticFacade(objects);
    const conn = new PushConnectivity(facade, [hex(1000)]);
    await conn.analyze(tips);
    expect(tips.filter((t) => !conn.verdict(t).ok)).toHaveLength(100);
    // the 200 tips once in step 1 and once in the exact walk, plus the known tip
    expect(reads.commits).toBeLessThan(450);
    expect(reads.trees).toBeLessThan(450);
  });

  it("a failed push of many commands reads each commit a bounded number of times", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(2);
    const [n0, n1] = commits as [string, string];
    // n1 sent without its tree: broken; n0 complete
    const tree0 = (await client.facade.getCommitInfo?.(n0))?.tree as string;
    const entries = (await client.facade.getTreeEntries?.(tree0)) ?? [];
    const pack = await packOf(client, [n1, n0, tree0, ...entries.map((e) => e.id)]);
    let commitReads = 0;
    let treeReads = 0;
    const getCommitInfo = repo.facade.getCommitInfo?.bind(repo.facade);
    const getTreeEntries = repo.facade.getTreeEntries?.bind(repo.facade);
    repo.facade.getCommitInfo = async (oid) => {
      commitReads++;
      return getCommitInfo?.(oid);
    };
    repo.facade.getTreeEntries = async (oid) => {
      treeReads++;
      return getTreeEntries?.(oid);
    };
    const run = await runReceivePack(repo, {
      commands: Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0 ? `${ZERO} ${n1} refs/heads/broken${i}` : `${ZERO} ${n0} refs/heads/fine${i}`,
      ),
      pack,
    });
    expect(run.report.filter((l) => l.endsWith("missing necessary objects"))).toHaveLength(100);
    expect(run.report.filter((l) => l.startsWith("ok "))).toHaveLength(100);
    // no walk per command: a few reads per commit for the whole push
    expect(commitReads).toBeLessThan(40);
    expect(treeReads).toBeLessThan(40);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });
});

describe("fast-forward check cost", () => {
  it("a fast-forward on a long history reads only the new commits", async () => {
    const objects = history(20_000);
    const tip = "f".repeat(40);
    objects.set(tip, { type: "commit", parents: [hex(20_000)], tree: TREE, time: 2_000_000 });
    const { facade, reads } = syntheticFacade(objects);
    expect(await isAncestorOf(facade, hex(20_000), tip)).toBe(true);
    expect(reads.commits).toBeLessThanOrEqual(3);
  });

  it("skewed history (old commit dated after the new one) is still a fast-forward", async () => {
    const objects = history(50);
    const tip = "f".repeat(40);
    // the ancestor claims to be newer than its descendants by far
    objects.set(hex(10), { type: "commit", parents: [hex(9)], tree: TREE, time: 9_000_000 });
    objects.set(tip, { type: "commit", parents: [hex(50)], tree: TREE, time: 2_000_000 });
    const { facade } = syntheticFacade(objects);
    expect(await isAncestorOf(facade, hex(10), tip)).toBe(true);
    expect(await isAncestorOf(facade, tip, hex(10))).toBe(false);
  });

  it("a real push over smart history: fast-forward accepted, rewind refused", async () => {
    const { repo, c1, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    let run = await runReceivePack(repo, {
      commands: [`${c2} ${n0} refs/heads/main`],
      pack: await fullPackOf(client, [n0], [c2]),
    });
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    run = await runReceivePack(repo, {
      commands: [`${n0} ${c1} refs/heads/main`],
      pack: await packOf(repo, []),
    });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main non-fast-forward"]);
  });
});
