/**
 * Which local refs a fetch writes (refspec mapping), and how (git's update_local_ref):
 * new, up to date, fast-forward, forced, rejected; written one transaction per ref, or all in
 * one (`atomic`), with refusals from the ref store reported.
 */

import { describe, expect, it } from "vitest";

import type { RepositoryFacade } from "../../src/api/repository-facade.js";
import type { RefStore } from "../../src/context/process-context.js";
import {
  applyRefUpdates,
  type FetchRefUpdate,
  isFastForward,
  mapRefs,
  planRefUpdates,
  type RemoteRef,
  refPrefixes,
} from "../../src/fetch-client/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const T = "e".repeat(40);

const remote: RemoteRef[] = [
  { name: "HEAD", oid: A, symref: "refs/heads/main" },
  { name: "refs/heads/main", oid: A },
  { name: "refs/heads/feature", oid: B },
  { name: "refs/tags/v1", oid: T, peeled: A },
];

describe("mapRefs (refspecs → local refs)", () => {
  it("maps through a wildcard refspec, keeping the force flag", () => {
    expect(mapRefs(remote, ["+refs/heads/*:refs/remotes/origin/*"])).toEqual([
      {
        remoteRef: "refs/heads/main",
        localRef: "refs/remotes/origin/main",
        oid: A,
        force: true,
        refspec: 0,
      },
      {
        remoteRef: "refs/heads/feature",
        localRef: "refs/remotes/origin/feature",
        oid: B,
        force: true,
        refspec: 0,
      },
    ]);
  });

  it("maps an exact refspec, and only the ref it names", () => {
    expect(mapRefs(remote, ["refs/heads/main:refs/remotes/peer/main"])).toEqual([
      {
        remoteRef: "refs/heads/main",
        localRef: "refs/remotes/peer/main",
        oid: A,
        force: false,
        refspec: 0,
      },
    ]);
  });

  it("excludes the refs a negative refspec names", () => {
    const mapped = mapRefs(remote, ["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/feature"]);
    expect(mapped.map((p) => p.localRef)).toEqual(["refs/remotes/origin/main"]);
  });

  it("finds a short name as git does, fetches an object id, and maps no destination to none", () => {
    expect(mapRefs(remote, ["feature:refs/remotes/f"])[0]).toMatchObject({
      remoteRef: "refs/heads/feature",
      localRef: "refs/remotes/f",
    });
    expect(mapRefs(remote, [`${C}:refs/heads/pinned`])[0]).toMatchObject({
      oid: C,
      localRef: "refs/heads/pinned",
    });
    expect(mapRefs(remote, ["HEAD"])).toEqual([
      { remoteRef: "HEAD", localRef: undefined, oid: A, force: false, refspec: 0 },
    ]);
  });

  it("lists the ref prefixes ls-refs needs for the refspecs", () => {
    expect(refPrefixes(["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/wip", "v1"])).toEqual([
      "refs/heads/",
      "v1",
      "refs/v1",
      "refs/tags/v1",
      "refs/heads/v1",
      "refs/remotes/v1",
      "refs/remotes/v1/HEAD",
    ]);
  });
});

/** A linear history D ← C ← A, and B on another line; refs in memory. */
function local(refs: Record<string, string> = {}) {
  const parents: Record<string, string[]> = { [D]: [], [C]: [D], [A]: [C], [B]: [] };
  const repository = {
    getCommitInfo: async (oid: string) =>
      parents[oid] ? { parents: parents[oid], time: 0 } : undefined,
    peelTag: async (oid: string) => (oid === T ? A : null),
    has: async (oid: string) => oid in parents || oid === T,
    walkAncestors: async function* () {},
  } as unknown as RepositoryFacade;
  const store = new Map(Object.entries(refs));
  const batches: string[][] = [];
  const refStore: RefStore = {
    get: async (name) => store.get(name),
    update: async (name, oid) => {
      store.set(name, oid);
    },
    listAll: async () => store.entries(),
    batch: async (commands) => {
      batches.push(commands.map((c) => c.name));
      const rejected = commands
        .filter(
          (c) => (store.get(c.name) ?? null) !== (c.old ?? null) || c.name.endsWith("/locked"),
        )
        .map((c) => ({ name: c.name, reason: c.name.endsWith("/locked") ? "locked" : "mismatch" }));
      if (rejected.length) return { ok: false, rejected } as never;
      for (const c of commands) if (c.new) store.set(c.name, c.new);
      return { ok: true, rejected: [] };
    },
  };
  return { repository, refStore, store, batches };
}

describe("planRefUpdates (git's update_local_ref)", () => {
  it("new branch, new tag, up to date, fast-forward, rejected non-fast-forward", async () => {
    const { repository, refStore } = local({
      "refs/remotes/origin/main": C, // C → A: fast-forward
      "refs/remotes/origin/feature": A, // A → B: unrelated
      "refs/remotes/origin/same": A,
    });
    const updates = await planRefUpdates(
      [
        {
          remoteRef: "refs/heads/main",
          localRef: "refs/remotes/origin/main",
          oid: A,
          force: false,
        },
        {
          remoteRef: "refs/heads/feature",
          localRef: "refs/remotes/origin/feature",
          oid: B,
          force: false,
        },
        {
          remoteRef: "refs/heads/same",
          localRef: "refs/remotes/origin/same",
          oid: A,
          force: false,
        },
        { remoteRef: "refs/heads/new", localRef: "refs/remotes/origin/new", oid: B, force: false },
        { remoteRef: "refs/tags/v1", localRef: "refs/tags/v1", oid: T, force: false },
      ],
      repository,
      refStore,
    );
    expect(updates.map((u) => [u.localRef, u.status, u.summary, u.reason])).toEqual([
      ["refs/remotes/origin/main", "fast-forward", `${C.slice(0, 7)}..${A.slice(0, 7)}`, undefined],
      ["refs/remotes/origin/feature", "rejected", "[rejected]", "non-fast-forward"],
      ["refs/remotes/origin/same", "up-to-date", "[up to date]", undefined],
      ["refs/remotes/origin/new", "new", "[new branch]", undefined],
      ["refs/tags/v1", "new", "[new tag]", undefined],
    ]);
  });

  it("a + refspec or --force forces a non-fast-forward; tags never move unless forced", async () => {
    const { repository, refStore } = local({ "refs/remotes/origin/feature": A, "refs/tags/v1": D });
    const plan = (force: boolean, options = {}) =>
      planRefUpdates(
        [
          {
            remoteRef: "refs/heads/feature",
            localRef: "refs/remotes/origin/feature",
            oid: B,
            force,
          },
          { remoteRef: "refs/tags/v1", localRef: "refs/tags/v1", oid: T, force },
        ],
        repository,
        refStore,
        options,
      );
    expect((await plan(true)).map((u) => [u.status, u.summary])).toEqual([
      ["forced", `+ ${A.slice(0, 7)}...${B.slice(0, 7)}`],
      ["forced", "[tag update]"],
    ]);
    expect((await plan(false, { force: true })).map((u) => u.status)).toEqual(["forced", "forced"]);
    expect((await plan(false)).map((u) => u.reason)).toEqual([
      "non-fast-forward",
      "would clobber existing tag",
    ]);
  });

  it("checks fast-forwards through annotated tags, and lets non-commits through", async () => {
    const { repository } = local();
    expect(await isFastForward(repository, D, T)).toBe(true); // T peels to A, D is below A
    expect(await isFastForward(repository, B, A)).toBe(false);
    expect(await isFastForward(repository, "f".repeat(40), A)).toBe(true); // not a commit here
  });
});

describe("applyRefUpdates", () => {
  const update = (
    localRef: string,
    oldOid: string | undefined,
    newOid: string,
  ): FetchRefUpdate => ({
    remoteRef: localRef,
    localRef,
    oldOid,
    newOid,
    status: "fast-forward" as const,
    summary: "..",
  });

  it("writes each ref in its own transaction, old value checked; a refusal rejects that ref only", async () => {
    const { refStore, store, batches } = local({ "refs/heads/a": C, "refs/heads/b": C });
    const updates = [
      update("refs/heads/a", C, A),
      update("refs/heads/b", D, A), // changed meanwhile
      update("refs/heads/locked", undefined, A),
      {
        ...update("refs/heads/c", undefined, B),
        status: "rejected" as const,
        summary: "[rejected]",
      },
    ];
    await applyRefUpdates(updates, refStore);
    expect(batches).toEqual([["refs/heads/a"], ["refs/heads/b"], ["refs/heads/locked"]]);
    expect(updates.map((u) => [u.status, u.reason])).toEqual([
      ["fast-forward", undefined],
      ["rejected", "mismatch"],
      ["rejected", "locked"],
      ["rejected", undefined],
    ]);
    expect(store.get("refs/heads/a")).toBe(A);
    expect(store.get("refs/heads/c")).toBeUndefined();
  });

  it("atomic: one transaction, and all refs are rejected when it fails", async () => {
    const { refStore, store, batches } = local({ "refs/heads/a": C });
    const updates = [update("refs/heads/a", C, A), update("refs/heads/locked", undefined, A)];
    await applyRefUpdates(updates, refStore, { atomic: true });
    expect(batches).toEqual([["refs/heads/a", "refs/heads/locked"]]);
    expect(updates.map((u) => u.status)).toEqual(["rejected", "rejected"]);
    expect(store.get("refs/heads/a")).toBe(C);
  });
});

describe("isFastForward under clock skew", () => {
  it("finds the old commit however far its date is ahead of its descendants'", async () => {
    // old C (dated 2030) ← B (dated 2001) ← tip A (dated 2001): a true fast-forward
    const info: Record<string, { parents: string[]; time: number }> = {
      [A]: { parents: [B], time: 1_000_000_100 },
      [B]: { parents: [C], time: 1_000_000_000 },
      [C]: { parents: [], time: 1_900_000_000 },
      [D]: { parents: [], time: 1_000_000_000 },
    };
    const repository = {
      getCommitInfo: async (oid: string) => info[oid],
      peelTag: async () => null,
      has: async (oid: string) => oid in info,
      walkAncestors: async function* () {},
    } as unknown as RepositoryFacade;
    expect(await isFastForward(repository, C, A)).toBe(true);
    expect(await isFastForward(repository, D, A)).toBe(false);
  });
});
