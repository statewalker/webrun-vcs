/**
 * The commit-graph walks of upload-pack (`upload-pack-graph.ts`) on in-memory graphs:
 * `okToGiveUp` as git's `can_all_from_reach_with_flag` (each commit walked once for all wants,
 * the start commit walked whatever its date), and `computeShallowUpdate` without
 * `getCommitInfo`.
 */

import { describe, expect, it } from "vitest";
import type { CommitGraphInfo, RepositoryFacade } from "../src/api/repository-facade.js";
import {
  getOutput,
  getState,
  type ProcessContext,
  setConfig,
  setOutput,
  setRefStore,
  setRepository,
  setState,
} from "../src/context/context-adapters.js";
import { HandlerOutput } from "../src/context/handler-output.js";
import { ProcessConfiguration } from "../src/context/process-config.js";
import type { RefStore } from "../src/context/process-context.js";
import { ProtocolState } from "../src/context/protocol-state.js";
import { serverFetchHandlers } from "../src/fsm/fetch/index.js";
import {
  computeShallowUpdate,
  findUnreachableWant,
  INFINITE_DEPTH,
  okToGiveUp,
  UploadPackRequestError,
  withServedShallow,
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

describe("withServedShallow", () => {
  // main: c1 <- c2 <- c3 <- c4, the served repository shallow at c3 (c1, c2 still stored)
  const chain = (): Graph =>
    new Map([
      ["c1", { parents: [], time: 100 }],
      ["c2", { parents: ["c1"], time: 200 }],
      ["c3", { parents: ["c2"], time: 300 }],
      ["c4", { parents: ["c3"], time: 400 }],
    ]);

  it("refuses to serve a shallow repository without the commit graph", () => {
    const { repository } = graphFacade(chain());
    const bare = { ...repository, getCommitInfo: undefined } as unknown as RepositoryFacade;
    expect(() => withServedShallow(bare, new Set(["c3"]))).toThrow(UploadPackRequestError);
    // a repository that is not shallow is served as it is
    expect(withServedShallow(bare, new Set())).toBe(bare);
  });

  it("walks and checks reachability through the grafted history", async () => {
    const { repository } = graphFacade(chain());
    const served = withServedShallow(
      { ...repository, isReachableFromAnyTip: async () => true } as unknown as RepositoryFacade,
      new Set(["c3"]),
    );
    const walked: string[] = [];
    for await (const oid of served.walkAncestors("c4")) walked.push(oid);
    expect(walked).toEqual(["c4", "c3"]);
    expect(await served.isReachableFrom?.("c3", ["c4"])).toBe(true);
    expect(await served.isReachableFrom?.("c2", ["c4"])).toBe(false);
    expect(served.isReachableFromAnyTip).toBeUndefined();
    // a want below the boundary is no ref's: refused as git's reachability check does
    expect(await findUnreachableWant(served, ["c3"], ["c4"])).toBeUndefined();
    expect(await findUnreachableWant(served, ["c2"], ["c4"])).toBe("c2");
  });

  for (const policy of ["REACHABLE_COMMIT", "REACHABLE_COMMIT_TIP"] as const) {
    it(`${policy} refuses a want below the served repository's shallow commits`, async () => {
      const { repository } = graphFacade(chain());
      const served = withServedShallow(
        { ...repository, isReachableFromAnyTip: async () => true } as unknown as RepositoryFacade,
        new Set(["c3"]),
      );
      const refStore = {
        get: async () => undefined,
        update: async () => {},
        listAll: async () => [["refs/heads/main", "c4"]],
      } as unknown as RefStore;
      const validate = async (want: string) => {
        const ctx: ProcessContext = {};
        setRepository(ctx, served);
        setRefStore(ctx, refStore);
        setState(ctx, new ProtocolState());
        setOutput(ctx, new HandlerOutput());
        const config = new ProcessConfiguration();
        config.requestPolicy = policy;
        setConfig(ctx, config);
        getState(ctx).refs.set("refs/heads/main", "c4");
        getState(ctx).wants.add(want);
        const handler = serverFetchHandlers.get("VALIDATE_WANTS");
        if (!handler) throw new Error("no VALIDATE_WANTS");
        return { event: await handler(ctx), output: getOutput(ctx) };
      };
      expect((await validate("c3")).event).toBe("VALID");
      const refused = await validate("c2");
      expect(refused.event).toBe("INVALID_WANT");
      expect(refused.output.invalidWant).toBe("c2");
    });
  }
});

describe("computeShallowUpdate of a shallow server's deepen(INFINITE)", () => {
  it("unshallows nothing when the client's shallow commits are grafts too", async () => {
    // c1 <- c2 <- c3 <- c4 <- c5: the server shallow at c2, the client at c4
    const graph: Graph = new Map([
      ["c1", { parents: [], time: 100 }],
      ["c2", { parents: ["c1"], time: 200 }],
      ["c3", { parents: ["c2"], time: 300 }],
      ["c4", { parents: ["c3"], time: 400 }],
      ["c5", { parents: ["c4"], time: 500 }],
    ]);
    const { repository } = graphFacade(graph);
    const update = await computeShallowUpdate(repository, {
      wants: ["c5"],
      clientShallow: ["c4"],
      depth: INFINITE_DEPTH,
      serverShallow: new Set(["c2", "c4"]),
    });
    expect(update.shallow).toEqual([]);
    expect(update.unshallow).toEqual([]);
    expect([...update.packShallow]).toEqual(["c4"]);
  });
});
