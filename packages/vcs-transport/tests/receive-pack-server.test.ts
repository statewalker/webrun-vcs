/**
 * receive-pack (the package's server push FSM through `serveOverDuplex`) against git's
 * receive-pack.c rules: the connectivity check, ref name and branch-tip checks, current
 * branch rules, duplicates, deletes of missing refs, shallow pushes, limits, `quiet` and the
 * protocol's report texts. Replaces the hollow receive-pack.test.ts, which tested copies of
 * the logic written inside the test.
 */

import { describe, expect, it } from "vitest";

import { checkConnectivity, findNewCommits, mapRejectReason } from "../src/index.js";
import {
  clientWithNewCommits,
  fullPackOf,
  packOf,
  pushRequest,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";
import { commitInRepo, createTransportRepo } from "./interop/helpers.js";

const encoder = new TextEncoder();

describe("receive-pack: connectivity (git's check_connected)", () => {
  it("refuses a tip whose tree is not in the pack; other refs go on (non-atomic)", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(2);
    const [n0, n1] = commits as [string, string];
    // n1 without its tree; n0 complete
    const pack = await packOf(client, [n1, n0, ...(await treeClosure(client, n0))]);
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${n1} refs/heads/broken`, `${ZERO} ${n0} refs/heads/fine`],
      pack,
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/broken missing necessary objects",
      "ok refs/heads/fine",
    ]);
    expect(await repo.refStore.get("refs/heads/broken")).toBeUndefined();
    expect(await repo.refStore.get("refs/heads/fine")).toBe(n0);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("finds a blob missing deep in a subtree", async () => {
    const { repo, c2 } = await serverRepo();
    const client = await createTransportRepo();
    const blob = await client.history.blobs.store([encoder.encode("deep\n")]);
    const inner = await client.history.trees.store([{ name: "f.txt", mode: 0o100644, id: blob }]);
    const outer = await client.history.trees.store([{ name: "dir", mode: 0o040000, id: inner }]);
    const ident = { name: "T", email: "t@example.com", timestamp: 1112912000, tzOffset: "+0000" };
    const commit = await client.history.commits.store({
      tree: outer,
      parents: [c2],
      author: ident,
      committer: ident,
      message: "deep\n",
    });
    const pack = await packOf(client, [commit, outer, inner]); // the blob is left out
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${commit} refs/heads/deep`],
      pack,
    });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/deep missing necessary objects"]);
    expect(await checkConnectivity(repo.facade, [commit], [c2])).toMatchObject({
      ok: false,
      missing: blob,
    });
  });

  it("refuses a new id nobody sent", async () => {
    const { repo } = await serverRepo();
    const empty = await packOf(repo, []);
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${"1".repeat(40)} refs/heads/u`],
      pack: empty,
    });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/u missing necessary objects"]);
  });

  it("accepts a complete push and stops at what the refs reach (reads stay small)", async () => {
    const repo = await createTransportRepo();
    let parent: string[] = [];
    let tip = "";
    for (let i = 0; i < 200; i++) {
      tip = await commitInRepo(repo, `h${i}`, { [`h${i}.txt`]: `${i}\n` }, parent);
      parent = [tip];
    }
    await repo.refStore.update("refs/heads/main", tip);
    for (let i = 0; i < 50; i++) await repo.refStore.update(`refs/heads/old${i}`, tip);
    const newTip = await commitInRepo(repo, "new", { "new.txt": "new\n" }, [tip]);

    const reads = countReads(repo.facade);
    const run = await runReceivePack(repo, {
      commands: Array.from({ length: 50 }, (_, i) => `${ZERO} ${newTip} refs/heads/new${i}`),
      pack: await packOf(repo, []),
    });
    expect(run.report.filter((l) => l.startsWith("ok "))).toHaveLength(50);
    // one walk for the 50 commands: the new commit, its parent, the known tips, a few trees
    expect(reads.commits).toBeLessThan(20);
    expect(reads.trees).toBeLessThan(10);
  });

  it("findNewCommits is rev-list <tips> --not <known>", async () => {
    const { client, c2, commits } = await clientWithNewCommits(3);
    const found = await findNewCommits(client.facade, [commits[2] as string], [c2]);
    expect(found).toEqual({ commits: [...commits].reverse() });
  });
});

describe("receive-pack: git's update() checks", () => {
  it("a branch must point at a commit; a tag may point at a tree", async () => {
    const { repo, c2 } = await serverRepo();
    const tree = (await repo.facade.getCommitInfo?.(c2))?.tree as string;
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${tree} refs/heads/t`, `${ZERO} ${tree} refs/tags/t`],
      pack: await packOf(repo, []),
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/t failed to update ref",
      "ok refs/tags/t",
    ]);
    expect(run.messages).toContain(
      `error: cannot update ref 'refs/heads/t': trying to write non-commit object ${tree} to branch 'refs/heads/t'`,
    );
    expect(await repo.refStore.get("refs/heads/t")).toBeUndefined();
  });

  it("refuses funny ref names as git does (one level only for a delete)", async () => {
    const { repo, c2 } = await serverRepo();
    const run = await runReceivePack(repo, {
      commands: [
        `${ZERO} ${c2} refs/heads/a..b`,
        `${ZERO} ${c2} refs/foo`,
        `${ZERO} ${ZERO} refs/bar`,
        `${ZERO} ${c2} HEAD`,
        `${ZERO} ${c2} refs/heads/ok`,
      ],
      caps: "report-status delete-refs",
      pack: await packOf(repo, []),
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/a..b funny refname",
      "ng refs/foo funny refname",
      "ok refs/bar",
      "ng HEAD funny refname",
      "ok refs/heads/ok",
    ]);
  });

  it("the same ref twice: the later command fails; atomic: the transaction fails", async () => {
    const { repo, c1, c2 } = await serverRepo();
    const empty = await packOf(repo, []);
    let run = await runReceivePack(repo, {
      commands: [`${ZERO} ${c2} refs/heads/d`, `${ZERO} ${c1} refs/heads/d`],
      pack: empty,
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/d",
      "ng refs/heads/d failed to update ref",
    ]);
    expect(await repo.refStore.get("refs/heads/d")).toBe(c2);

    run = await runReceivePack(repo, {
      commands: [`${ZERO} ${c2} refs/heads/e`, `${ZERO} ${c1} refs/heads/e`],
      caps: "report-status side-band-64k atomic",
      pack: empty,
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/e atomic transaction failed",
      "ng refs/heads/e atomic transaction failed",
    ]);
    expect(run.messages).toContain("multiple updates for ref 'refs/heads/e' not allowed");
    expect(await repo.refStore.get("refs/heads/e")).toBeUndefined();
  });

  it("deleting a missing ref is ok (and not seen by post-receive); a wrong old value fails", async () => {
    const { repo, c2 } = await serverRepo();
    const seen: string[] = [];
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${ZERO} refs/heads/nonexist`, `${c2} ${ZERO} refs/heads/nonexist2`],
        caps: "report-status delete-refs",
      },
      { hooks: { postReceive: (cmds) => seen.push(...cmds.map((c) => c.refName)) } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/nonexist",
      "ng refs/heads/nonexist2 failed to update ref",
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
  });

  it("refuses deleting the current branch, and updating it in a non-bare repository", async () => {
    const { repo, c1, c2 } = await serverRepo();
    let run = await runReceivePack(repo, {
      commands: [`${c2} ${ZERO} refs/heads/main`],
      caps: "report-status delete-refs side-band-64k",
    });
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main deletion of the current branch prohibited",
    ]);
    expect(run.messages).toContain("refusing to delete the current branch: refs/heads/main");

    const empty = await packOf(repo, []);
    run = await runReceivePack(
      repo,
      { commands: [`${c2} ${c1} refs/heads/main`], pack: empty },
      { bare: false, allowNonFastForward: true },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main branch is currently checked out"]);

    // bare (the default): the current branch moves
    run = await runReceivePack(
      repo,
      { commands: [`${c2} ${c1} refs/heads/main`], pack: empty },
      { allowNonFastForward: true },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("refuses a non-fast-forward branch update by default; a stale old value fails", async () => {
    const { repo, c1, c2 } = await serverRepo();
    const empty = await packOf(repo, []);
    let run = await runReceivePack(repo, {
      commands: [`${c2} ${c1} refs/heads/main`],
      pack: empty,
    });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main non-fast-forward"]);
    run = await runReceivePack(repo, { commands: [`${c1} ${c2} refs/heads/main`], pack: empty });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main failed to update ref"]);
  });
});

describe("receive-pack: shallow pushes (git's receive.shallowUpdate)", () => {
  it("refuses a push whose history ends at a client shallow commit the server lacks", async () => {
    // the server has nothing; the client sends n1 only, shallow at n1 (its parent is absent)
    const server = await createTransportRepo();
    const { client, commits } = await clientWithNewCommits(2);
    const n1 = commits[1] as string;
    const pack = await packOf(client, [n1, ...(await treeClosure(client, n1))]);
    const run = await runReceivePack(server, {
      shallow: [n1],
      commands: [`${ZERO} ${n1} refs/heads/s`],
      pack,
    });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/s shallow update not allowed"]);
  });

  it("accepts a shallow client's push on top of history the server has", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const run = await runReceivePack(repo, {
      shallow: [c2], // the client was cloned with --depth 1
      commands: [`${c2} ${n0} refs/heads/main`],
      pack: await fullPackOf(client, [n0], [c2]),
    });
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("with shallowUpdate and a facade that records shallow commits, accepts and records", async () => {
    const server = await createTransportRepo();
    const recorded: string[] = [];
    server.facade.updateShallow = async (oids) => {
      recorded.push(...oids);
    };
    const { client, commits } = await clientWithNewCommits(2);
    const n1 = commits[1] as string;
    const pack = await packOf(client, [n1, ...(await treeClosure(client, n1))]);
    const run = await runReceivePack(
      server,
      { shallow: [n1], commands: [`${ZERO} ${n1} refs/heads/s`], pack },
      { shallowUpdate: true },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/s"]);
    expect(recorded).toEqual([n1]);
  });
});

describe("receive-pack: protocol and limits", () => {
  it("more commands than maxCommands is a protocol error, nothing is applied", async () => {
    const { repo, c2 } = await serverRepo();
    const run = await runReceivePack(
      repo,
      {
        commands: Array.from({ length: 11 }, (_, i) => `${ZERO} ${c2} refs/heads/m${i}`),
        pack: await packOf(repo, []),
      },
      { maxCommands: 10 },
    );
    expect(run.result.success).toBe(false);
    expect(run.result.error).toContain("more than 10 commands");
    expect(run.report).toEqual([]);
    expect(await repo.refStore.get("refs/heads/m0")).toBeUndefined();
  });

  it("a malformed command is a protocol error, as git's", async () => {
    const { repo } = await serverRepo();
    const run = await runReceivePack(repo, { commands: ["zzz"] });
    expect(run.result.error).toBe("protocol error: expected old/new/ref, got 'zzz'");
  });

  it("a stalled pack upload is abandoned after the idle timeout (unpack error)", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const request = pushRequest({
      commands: [`${ZERO} ${n0} refs/heads/stalled`],
      pack: await fullPackOf(client, [n0]),
    });
    const run = await runReceivePack(repo, request, {
      idleTimeoutMs: 100,
      chunkSize: 16,
      stallAfter: request.length - 40,
    });
    expect(run.report[0]).toBe("unpack request idle for 100 ms");
    expect(run.report[1]).toBe("ng refs/heads/stalled unpacker error");
    expect(await repo.refStore.get("refs/heads/stalled")).toBeUndefined();
  });

  it("a corrupt pack: unpack <error>, every command 'unpacker error'", async () => {
    const { repo, c2 } = await serverRepo();
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${c2} refs/heads/j`],
      pack: encoder.encode("PACKjunkjunkjunkjunk"),
    });
    expect(run.report[0]).toMatch(/^unpack (?!ok)/);
    expect(run.report[1]).toBe("ng refs/heads/j unpacker error");
  });

  it("progress goes to channel 2 unless the client asked quiet; no report without report-status", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const pack = await fullPackOf(client, [n0]);
    let run = await runReceivePack(repo, { commands: [`${ZERO} ${n0} refs/heads/p1`], pack });
    expect(run.messages).toMatch(/Checking connectivity: \d+, done\./);
    run = await runReceivePack(repo, {
      commands: [`${ZERO} ${n0} refs/heads/p2`],
      caps: "report-status side-band-64k quiet",
      pack,
    });
    expect(run.messages).toBe("");
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/p2"]);
    run = await runReceivePack(repo, {
      commands: [`${ZERO} ${n0} refs/heads/p3`],
      caps: "side-band-64k",
      pack,
    });
    expect(run.report).toEqual([]);
    expect(await repo.refStore.get("refs/heads/p3")).toBe(n0);
  });

  it("push options reach the hooks; report-status-v2 is not advertised", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    let options: readonly string[] = [];
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/heads/o`],
        caps: "report-status side-band-64k push-options",
        pushOptions: ["ci.skip", "reviewer=me"],
        pack: await fullPackOf(client, [n0]),
      },
      {
        hooks: {
          preReceive: (_c, ctx) => {
            options = [...ctx.pushOptions];
          },
        },
      },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/o"]);
    expect(options).toEqual(["ci.skip", "reviewer=me"]);
  });
});

describe("mapRejectReason: the client's reading of receive-pack's reasons", () => {
  it("maps git's report texts", () => {
    expect(mapRejectReason("non-fast-forward")).toBe("REJECTED_NONFASTFORWARD");
    expect(mapRejectReason("branch is currently checked out")).toBe("REJECTED_CURRENT_BRANCH");
    expect(mapRejectReason("deletion prohibited")).toBe("REJECTED_NODELETE");
    expect(mapRejectReason("deletion of the current branch prohibited")).toBe("REJECTED_NODELETE");
    expect(mapRejectReason("missing necessary objects")).toBe("REJECTED_MISSING_OBJECT");
    expect(mapRejectReason("atomic push failure")).toBe("ATOMIC_REJECTED");
    expect(mapRejectReason("atomic transaction failed")).toBe("ATOMIC_REJECTED");
    expect(mapRejectReason("failed to update ref")).toBe("LOCK_FAILURE");
    expect(mapRejectReason("hook declined")).toBe("REJECTED_OTHER_REASON");
    expect(mapRejectReason("funny refname")).toBe("REJECTED_OTHER_REASON");
  });

  it("maps the older wordings", () => {
    expect(mapRejectReason("rejected non-fast-forward")).toBe("REJECTED_NONFASTFORWARD");
    expect(mapRejectReason("refusing to update checked out current branch")).toBe(
      "REJECTED_CURRENT_BRANCH",
    );
    expect(mapRejectReason("deny deleting refs/heads/main")).toBe("REJECTED_NODELETE");
    expect(mapRejectReason("deny creating refs/heads/new")).toBe("REJECTED_NOCREATE");
    expect(mapRejectReason("failed to lock ref")).toBe("LOCK_FAILURE");
    expect(mapRejectReason("permission denied")).toBe("REJECTED_OTHER_REASON");
  });
});

/** The trees and blobs of a commit (its whole tree). */
async function treeClosure(
  repo: Awaited<ReturnType<typeof createTransportRepo>>,
  commit: string,
): Promise<string[]> {
  const ids: string[] = [];
  const tree = (await repo.facade.getCommitInfo?.(commit))?.tree;
  const stack = tree ? [tree] : [];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    ids.push(id);
    for (const e of (await repo.facade.getTreeEntries?.(id)) ?? []) {
      if ((e.mode & 0o170000) === 0o040000) stack.push(e.id);
      else ids.push(e.id);
    }
  }
  return ids;
}

/** Counts the facade's graph reads. */
function countReads(facade: Awaited<ReturnType<typeof createTransportRepo>>["facade"]) {
  const reads = { commits: 0, trees: 0 };
  const getCommitInfo = facade.getCommitInfo?.bind(facade);
  const getTreeEntries = facade.getTreeEntries?.bind(facade);
  facade.getCommitInfo = async (oid) => {
    reads.commits++;
    return getCommitInfo?.(oid);
  };
  facade.getTreeEntries = async (oid) => {
    reads.trees++;
    return getTreeEntries?.(oid);
  };
  return reads;
}

describe("receive-pack: review fixes", () => {
  it("deleting an existing ref with the zero id as old value deletes it (git warns)", async () => {
    const { repo, c2 } = await serverRepo();
    await repo.refStore.update("refs/heads/a", c2);
    const run = await runReceivePack(repo, {
      commands: [`${ZERO} ${ZERO} refs/heads/a`],
      caps: "report-status delete-refs side-band-64k",
    });
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/a"]);
    expect(run.messages).toContain("warning: allowing deletion of corrupt ref");
    expect(await repo.refStore.get("refs/heads/a")).toBeUndefined();
    // the deletion rules still hold: the current branch stays
    const current = await runReceivePack(repo, {
      commands: [`${ZERO} ${ZERO} refs/heads/main`],
      caps: "report-status delete-refs",
    });
    expect(current.report).toEqual([
      "unpack ok",
      "ng refs/heads/main deletion of the current branch prohibited",
    ]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("shallowUpdate records only the shallow commits the refs do not reach already", async () => {
    const { repo, c2 } = await serverRepo();
    const recorded: string[][] = [];
    repo.facade.updateShallow = async (oids) => {
      recorded.push(oids);
    };
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    // the client is shallow at c2, which the server has with its history
    const run = await runReceivePack(
      repo,
      {
        shallow: [c2],
        commands: [`${c2} ${n0} refs/heads/main`],
        pack: await fullPackOf(client, [n0], [c2]),
      },
      { shallowUpdate: true },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(recorded).toEqual([]);
  });

  it("a facade that is not bare protects its checked-out branch", async () => {
    const { repo, c1, c2 } = await serverRepo();
    repo.facade.isBare = () => false;
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${c1} refs/heads/main`], pack: await packOf(repo, []) },
      { allowNonFastForward: true },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main branch is currently checked out"]);
  });

  it("an explicit currentBranch keeps its protection unless bare is set", async () => {
    const { repo, c1, c2 } = await serverRepo();
    const empty = await packOf(repo, []);
    let run = await runReceivePack(
      repo,
      { commands: [`${c2} ${c1} refs/heads/main`], pack: empty },
      { allowNonFastForward: true, currentBranch: "refs/heads/main" },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main branch is currently checked out"]);
    run = await runReceivePack(
      repo,
      { commands: [`${c2} ${c1} refs/heads/main`], pack: empty },
      { allowNonFastForward: true, currentBranch: "refs/heads/main", bare: true },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("createRepositoryFacade tells its bareness", async () => {
    const { createRepositoryFacade } = await import("../src/index.js");
    const { repo } = await serverRepo();
    expect(createRepositoryFacade({ history: repo.history }).isBare?.()).toBe(true);
    expect(createRepositoryFacade({ history: repo.history, bare: false }).isBare?.()).toBe(false);
  });
});
