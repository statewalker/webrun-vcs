/**
 * The push client's ref rules, table-driven: refspec matching as git's match_push_refs
 * (remote.c; cases after t5516-fetch-push and t5505) and per-ref statuses as
 * set_ref_status_for_push (cases after t5516, t5533-push-cas).
 */

import { describe, expect, it } from "vitest";

import {
  countRefspecMatch,
  type MatchedPushRef,
  matchPushRefs,
  type PushObjectSource,
  PushRefspecError,
  pushSummary,
  setPushStatus,
  ZERO_OID,
} from "../src/index.js";

const oid = (c: string) => c.repeat(40);
const A = oid("a"); // local main
const B = oid("b"); // local topic
const T = oid("7"); // local tag v1
const R = oid("1"); // remote main
const S = oid("2"); // remote other

const local = {
  refs: new Map([
    ["refs/heads/main", A],
    ["refs/heads/topic", B],
    ["refs/tags/v1", T],
    ["refs/remotes/origin/main", R],
  ]),
  head: { target: "refs/heads/main", oid: A },
  hasObject: async (o: string) => [A, B, T, R].includes(o),
};
const remote = [
  { name: "HEAD", oid: R },
  { name: "refs/heads/main", oid: R },
  { name: "refs/heads/other", oid: S },
  { name: "refs/tags/v0", oid: S },
];

const brief = (m: MatchedPushRef[]) =>
  m.map((x) => `${x.force ? "+" : ""}${x.localRef ?? x.newOid.slice(0, 4)}>${x.remoteRef}`);

describe("matchPushRefs: refspecs as git push maps them", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["full src:dst", ["refs/heads/main:refs/heads/main"], ["refs/heads/main>refs/heads/main"]],
    ["short name, no dst: the same name", ["main"], ["refs/heads/main>refs/heads/main"]],
    ["HEAD pushes its branch", ["HEAD"], ["refs/heads/main>refs/heads/main"]],
    ["@ is HEAD", ["@"], ["refs/heads/main>refs/heads/main"]],
    ["+ forces", ["+main"], ["+refs/heads/main>refs/heads/main"]],
    ["short dst the remote has", ["topic:other"], ["refs/heads/topic>refs/heads/other"]],
    [
      "new short dst from a branch is a branch",
      ["main:fresh"],
      ["refs/heads/main>refs/heads/fresh"],
    ],
    ["new short dst from a tag is a tag", ["v1:v2"], ["refs/tags/v1>refs/tags/v2"]],
    ["new full dst", ["main:refs/review/1"], ["refs/heads/main>refs/review/1"]],
    ["a tag by its short name", ["v1"], ["refs/tags/v1>refs/tags/v1"]],
    ["delete a ref the remote has, by short name", [":other"], ["0000>refs/heads/other"]],
    ["delete by full name", [":refs/heads/other"], ["0000>refs/heads/other"]],
    [
      "delete of a full name the remote lacks is sent (receive-pack decides)",
      [":refs/heads/gone"],
      ["0000>refs/heads/gone"],
    ],
    ["an object id to a full dst", [`${B}:refs/heads/by-id`], ["bbbb>refs/heads/by-id"]],
    ["src: (empty dst) is src", ["main:"], ["refs/heads/main>refs/heads/main"]],
    [
      "--all: every branch",
      ["refs/heads/*:refs/heads/*"],
      ["refs/heads/main>refs/heads/main", "refs/heads/topic>refs/heads/topic"],
    ],
    [
      "a pattern minus a negative refspec",
      ["refs/heads/*:refs/heads/*", "^refs/heads/topic"],
      ["refs/heads/main>refs/heads/main"],
    ],
    ["--tags", ["refs/tags/*:refs/tags/*"], ["refs/tags/v1>refs/tags/v1"]],
    ["matching (:) pushes branches the remote has", [":"], ["refs/heads/main>refs/heads/main"]],
    [
      "an explicit refspec wins over a pattern",
      ["refs/heads/*:refs/heads/*", "topic:main"],
      // main's own pattern match loses its target; topic still goes to its own name too
      ["refs/heads/topic>refs/heads/main", "refs/heads/topic>refs/heads/topic"],
    ],
    [
      "a pattern into another namespace",
      ["+refs/heads/*:refs/remotes/mine/*"],
      ["+refs/heads/main>refs/remotes/mine/main", "+refs/heads/topic>refs/remotes/mine/topic"],
    ],
  ];
  for (const [name, specs, expected] of cases) {
    it(name, async () => {
      const matched = await matchPushRefs(specs, local, remote);
      expect(brief(matched).sort()).toEqual([...expected].sort());
    });
  }

  it("old ids are the remote's advertised values (zero for a new ref)", async () => {
    const matched = await matchPushRefs(["main", "main:fresh"], local, remote);
    expect(matched.map((m) => m.oldOid)).toEqual([R, ZERO_OID]);
  });

  it("--prune deletes remote refs a pattern covers whose source is gone (--mirror)", async () => {
    const matched = await matchPushRefs(["+refs/*:refs/*"], local, remote, { prune: true });
    expect(brief(matched).sort()).toEqual(
      [
        "+refs/heads/main>refs/heads/main",
        "+refs/heads/topic>refs/heads/topic",
        "+refs/tags/v1>refs/tags/v1",
        "+refs/remotes/origin/main>refs/remotes/origin/main",
        "+0000>refs/heads/other",
        "+0000>refs/tags/v0",
      ].sort(),
    );
  });

  const errors: Array<[string, string[], RegExp]> = [
    ["a source that matches nothing", ["nope"], /src refspec nope does not match any/],
    ["an unknown object id", [`${S}:refs/heads/x`], /does not match any/],
    [
      "an unqualified new dst from an object id",
      [`${B}:fresh`],
      /The destination you provided is not a full refname/,
    ],
    ["an object id without dst", [B], /cannot be resolved to branch/],
    ["delete of a short name the remote lacks", [":gone"], /unable to delete 'gone'/],
    [
      "two sources for one remote ref",
      ["main:refs/heads/x", "topic:refs/heads/x"],
      /dst ref refs\/heads\/x receives from more than one src/,
    ],
    ["a pattern on one side only", ["refs/heads/*:refs/heads/x"], /invalid refspec/],
  ];
  for (const [name, specs, message] of errors) {
    it(`refuses ${name}`, async () => {
      await expect(matchPushRefs(specs, local, remote)).rejects.toThrow(PushRefspecError);
      await expect(matchPushRefs(specs, local, remote)).rejects.toThrow(message);
    });
  }

  it("an ambiguous source (a branch and a tag of one name) matches more than one", async () => {
    const both = { ...local, refs: new Map([...local.refs, ["refs/tags/main", T]]) };
    await expect(matchPushRefs(["main"], both, remote)).rejects.toThrow(/matches more than one/);
  });

  it("a weak match (refs/remotes/) loses to a strong one, as count_refspec_match", () => {
    expect(countRefspecMatch("main", ["refs/remotes/main", "refs/heads/main"])).toEqual({
      count: 1,
      match: "refs/heads/main",
    });
    expect(countRefspecMatch("main", ["refs/remotes/main"])).toEqual({
      count: 1,
      match: "refs/remotes/main",
    });
    expect(countRefspecMatch("origin/main", ["refs/remotes/origin/main"]).count).toBe(1);
  });
});

describe("matchPushRefs --follow-tags: remote.c's add_missing_tags", () => {
  // history: R <- A; B unrelated; T tags A, U tags B, `light` is a lightweight tag at A,
  // V a tag the remote has already
  const U = oid("8");
  const V = oid("d");
  const tagRefs = new Map([
    ["refs/heads/main", A],
    ["refs/heads/topic", B],
    ["refs/tags/v1", T],
    ["refs/tags/u", U],
    ["refs/tags/light", A],
    ["refs/tags/v0", V],
  ]);
  const peeled = new Map([
    [T, A],
    [U, B],
    [V, A],
  ]);
  const followTags = {
    isTag: async (o: string) => peeled.has(o),
    peelToCommit: async (o: string) => peeled.get(o) ?? ([A, B, R].includes(o) ? o : undefined),
    reachableSubset: async (tips: readonly string[], commits: readonly string[]) => {
      const reach = new Set<string>();
      for (const tip of tips) {
        reach.add(tip);
        if (tip === A) reach.add(R);
      }
      return new Set(commits.filter((c) => reach.has(c)));
    },
  };
  const run = (specs: string[], remoteRefs: { name: string; oid: string }[]) =>
    matchPushRefs(
      specs,
      { refs: tagRefs, head: { target: "refs/heads/main", oid: A } },
      remoteRefs,
      {
        followTags,
      },
    );

  it("adds the annotated tags the pushed values reach, not lightweight ones nor those the remote has", async () => {
    const m = await run(["main"], [{ name: "refs/tags/v0", oid: V }]);
    expect(m.map((x) => x.remoteRef)).toEqual(["refs/heads/main", "refs/tags/v1"]);
    expect(m[1]).toMatchObject({
      localRef: "refs/tags/v1",
      newOid: T,
      oldOid: ZERO_OID,
      force: false,
    });
  });
  it("counts the remote's refs that are not pushed as tips", async () => {
    const m = await run(["main"], [{ name: "refs/heads/topic", oid: B }]);
    expect(m.map((x) => x.remoteRef).sort()).toEqual([
      "refs/heads/main",
      "refs/tags/u",
      "refs/tags/v0",
      "refs/tags/v1",
    ]);
  });
});

describe("setPushStatus: git's per-ref rules", () => {
  // history: R <- A (A fast-forwards R); X is unrelated; TREE is no commit; G is not here
  const X = oid("9");
  const TREE = oid("e");
  const G = oid("6");
  const parents = new Map<string, string[]>([
    [R, []],
    [A, [R]],
    [X, []],
    [T, []],
  ]);
  const objects: PushObjectSource = {
    has: async (o) => parents.has(o) || o === TREE,
    peelToCommit: async (o) => (o === T ? A : parents.has(o) ? o : undefined),
    isAncestor: async (anc, desc) => {
      const queue = [desc];
      while (queue.length) {
        const c = queue.shift() as string;
        if (c === anc) return true;
        queue.push(...(parents.get(c) ?? []));
      }
      return false;
    },
  };
  const m = (remoteRef: string, oldOid: string, newOid: string, force = false) => ({
    remoteRef,
    oldOid,
    newOid,
    force,
    localRef: newOid === ZERO_OID ? undefined : "refs/heads/x",
  });

  const cases: Array<[string, MatchedPushRef, string, string]> = [
    ["up to date", m("refs/heads/main", A, A), "up-to-date", "[up to date]"],
    ["new branch", m("refs/heads/new", ZERO_OID, A), "ok", "[new branch]"],
    ["new tag", m("refs/tags/v9", ZERO_OID, T), "ok", "[new tag]"],
    ["new reference", m("refs/review/1", ZERO_OID, A), "ok", "[new reference]"],
    ["fast-forward", m("refs/heads/main", R, A), "ok", "1111111..aaaaaaa"],
    ["fetch first", m("refs/heads/main", G, A), "rejected-fetch-first", "[rejected] (fetch first)"],
    [
      "non-fast-forward",
      m("refs/heads/main", A, X),
      "rejected-nonfastforward",
      "[rejected] (non-fast-forward)",
    ],
    [
      "needs force",
      m("refs/heads/main", TREE, A),
      "rejected-needs-force",
      "[rejected] (needs force)",
    ],
    [
      "a tag never moves unforced",
      m("refs/tags/v1", R, A),
      "rejected-already-exists",
      "[rejected] (already exists)",
    ],
    [
      "forced non-fast-forward",
      m("refs/heads/main", A, X, true),
      "ok",
      "+ aaaaaaa...9999999 (forced update)",
    ],
    [
      "forced fetch first",
      m("refs/heads/main", G, A, true),
      "ok",
      "+ 6666666...aaaaaaa (forced update)",
    ],
    ["delete", m("refs/heads/old", R, ZERO_OID), "ok", "[deleted]"],
  ];
  for (const [name, matched, status, summary] of cases) {
    it(name, async () => {
      const [update] = await setPushStatus([matched], objects);
      expect(update?.status).toBe(status);
      expect(update?.summary).toBe(summary);
    });
  }

  it("--force applies to every ref", async () => {
    const [update] = await setPushStatus([m("refs/tags/v1", R, A)], objects, { force: true });
    expect(update?.status).toBe("ok");
    expect(update?.forced).toBe(true);
  });

  describe("--force-with-lease (t5533)", () => {
    const lease = (ref: string, expect: string) => ({ leases: new Map([[ref, expect]]) });
    it("holds: a non-fast-forward is allowed", async () => {
      const [u] = await setPushStatus(
        [m("refs/heads/main", A, X)],
        objects,
        lease("refs/heads/main", A),
      );
      expect(u?.status).toBe("ok");
      expect(u?.forced).toBe(true);
      expect(u?.expectedOid).toBe(A);
    });
    it("stale: the remote moved", async () => {
      const [u] = await setPushStatus(
        [m("refs/heads/main", A, X)],
        objects,
        lease("refs/heads/main", R),
      );
      expect(u?.status).toBe("rejected-stale");
      expect(u?.summary).toBe("[rejected] (stale info)");
    });
    it("stale even for a fast-forward", async () => {
      const [u] = await setPushStatus(
        [m("refs/heads/main", R, A)],
        objects,
        lease("refs/heads/main", X),
      );
      expect(u?.status).toBe("rejected-stale");
    });
    it("expecting absence: a ref that appeared is stale", async () => {
      const [u] = await setPushStatus(
        [m("refs/heads/main", R, A)],
        objects,
        lease("refs/heads/main", ZERO_OID),
      );
      expect(u?.status).toBe("rejected-stale");
    });
    it("--force overrides a stale lease", async () => {
      const [u] = await setPushStatus([m("refs/heads/main", A, X)], objects, {
        ...lease("refs/heads/main", R),
        force: true,
      });
      expect(u?.status).toBe("ok");
    });
    it("a lease on a tag lets it move", async () => {
      const [u] = await setPushStatus([m("refs/tags/v1", R, A)], objects, lease("refs/tags/v1", R));
      expect(u?.status).toBe("ok");
    });
    it("--force-if-includes: a holding lease whose remote value no reflog entry includes is refused", async () => {
      const [u] = await setPushStatus([m("refs/heads/main", A, X)], objects, {
        ...lease("refs/heads/main", A),
        unreachable: new Set(["refs/heads/main"]),
      });
      expect(u?.status).toBe("rejected-remote-updated");
      expect(u?.summary).toBe("[rejected] (remote ref updated since checkout)");
    });
    it("--force-if-includes: a stale lease stays stale, --force overrides", async () => {
      const options = { ...lease("refs/heads/main", R), unreachable: new Set(["refs/heads/main"]) };
      const [stale] = await setPushStatus([m("refs/heads/main", A, X)], objects, options);
      expect(stale?.status).toBe("rejected-stale");
      const [forced] = await setPushStatus([m("refs/heads/main", A, X)], objects, {
        ...lease("refs/heads/main", A),
        unreachable: new Set(["refs/heads/main"]),
        force: true,
      });
      expect(forced?.status).toBe("ok");
    });
  });

  it("remote statuses have git's summaries", () => {
    const base = { remoteRef: "refs/heads/x", oldOid: R, newOid: A, force: false, forced: false };
    expect(
      pushSummary({ ...base, status: "remote-rejected", message: "hook declined", summary: "" }),
    ).toBe("[remote rejected] (hook declined)");
    expect(pushSummary({ ...base, status: "atomic-push-failed", summary: "" })).toBe(
      "[rejected] (atomic push failed)",
    );
  });
});
