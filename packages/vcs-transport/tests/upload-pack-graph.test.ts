/**
 * The commit-graph walks of upload-pack (`upload-pack-graph.ts`) on in-memory graphs:
 * `okToGiveUp` as git's `can_all_from_reach_with_flag` (each commit walked once for all wants,
 * the start commit walked whatever its date), and `computeShallowUpdate` without
 * `getCommitInfo`.
 */

import { describe, expect, it } from "vitest";
import type { CommitGraphInfo, RepositoryFacade } from "../src/api/repository-facade.js";
import {
  computeShallowUpdate,
  INFINITE_DEPTH,
  okToGiveUp,
  UploadPackRequestError,
} from "../src/fsm/fetch/upload-pack-graph.js";

type Graph = Map<string, { parents: string[]; time: number }>;

/** A facade over `graph`; `stats.parentReads` counts how often a walk read a commit's parents. */
function graphFacade(graph: Graph) {
  const stats = { parentReads: 0 };
  const repository = {
    async getCommitInfo(oid: string): Promise<CommitGraphInfo | undefined> {
      const commit = graph.get(oid);
      if (!commit) return undefined;
      return {
        get parents() {
          stats.parentReads++;
          return commit.parents;
        },
        time: commit.time,
      };
    },
    has: async (oid: string) => graph.has(oid),
    async *walkAncestors() {},
    importPack: async () => {
      throw new Error("unused");
    },
    async *exportPack() {},
  } as unknown as RepositoryFacade;
  return { repository, stats };
}

describe("okToGiveUp", () => {
  it("walks shared history once for all wants", async () => {
    // a chain c0..c4999, and 200 wants each one commit off a different chain commit
    const graph: Graph = new Map();
    const n = 5000;
    for (let i = 0; i < n; i++) {
      graph.set(`c${i}`, { parents: i ? [`c${i - 1}`] : [], time: 1000 + i });
    }
    const wants: string[] = [];
    for (let b = 0; b < 200; b++) {
      graph.set(`b${b}`, { parents: [`c${n - 1 - b}`], time: 100000 });
      wants.push(`b${b}`);
    }
    const { repository, stats } = graphFacade(graph);
    expect(await okToGiveUp(repository, wants, new Set(["c10"]))).toBe(true);
    // each commit's parents are read a few times at most, not once per want
    expect(stats.parentReads).toBeLessThan(4 * (n + wants.length));
  });

  it("walks the start commit even when it is older than the oldest common commit", async () => {
    // `old` (time 100) is a child of s3 (time 9100), the only common commit
    const graph: Graph = new Map([
      ["s2", { parents: [], time: 9000 }],
      ["s3", { parents: ["s2"], time: 9100 }],
      ["old", { parents: ["s3"], time: 100 }],
    ]);
    const { repository } = graphFacade(graph);
    expect(await okToGiveUp(repository, ["old"], new Set(["s3"]))).toBe(true);
  });

  it("is not ready when a want does not reach a common commit above the cutoff", async () => {
    const graph: Graph = new Map([
      ["a", { parents: [], time: 100 }],
      ["b", { parents: ["a"], time: 200 }],
      ["x", { parents: [], time: 300 }],
      ["y", { parents: ["x"], time: 400 }],
    ]);
    const { repository } = graphFacade(graph);
    expect(await okToGiveUp(repository, ["b", "y"], new Set(["a"]))).toBe(false);
    expect(await okToGiveUp(repository, ["b"], new Set(["a"]))).toBe(true);
  });
});

describe("computeShallowUpdate without getCommitInfo", () => {
  /** c1 ← c2 ← c3 ← c4, and computeShallowBoundaries walking it. */
  function boundariesOnly(): RepositoryFacade {
    const parents = new Map([
      ["c1", []],
      ["c2", ["c1"]],
      ["c3", ["c2"]],
      ["c4", ["c3"]],
    ]);
    return {
      has: async (oid: string) => parents.has(oid),
      async computeShallowBoundaries(wants: Set<string>, depth: number) {
        let level = [...wants];
        for (let d = 1; d < depth; d++) level = level.flatMap((oid) => parents.get(oid) ?? []);
        return new Set(level);
      },
      async *walkAncestors() {},
      importPack: async () => {
        throw new Error("unused");
      },
      async *exportPack() {},
    } as unknown as RepositoryFacade;
  }

  it("answers deepen for a client that is not shallow", async () => {
    const update = await computeShallowUpdate(boundariesOnly(), {
      wants: ["c4"],
      clientShallow: [],
      depth: 2,
    });
    expect(update.shallow).toEqual(["c3"]);
    expect(update.unshallow).toEqual([]);
  });

  it("refuses to deepen a shallow client it could not unshallow", async () => {
    for (const depth of [3, INFINITE_DEPTH]) {
      await expect(
        computeShallowUpdate(boundariesOnly(), {
          wants: ["c4"],
          clientShallow: ["c4"],
          depth,
        }),
      ).rejects.toBeInstanceOf(UploadPackRequestError);
    }
  });
});
