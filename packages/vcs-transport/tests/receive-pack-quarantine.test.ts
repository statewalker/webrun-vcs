/**
 * receive-pack's quarantine (git's `tmp_objdir`): a pushed pack is kept aside until the push is
 * accepted. Every kind of refusal (unpack error, connectivity, authorize, pre-receive, update
 * hook and git's update() checks for every ref, an atomic push with a refused ref, a client gone
 * mid-pack) leaves the object store as it was; an accepted push publishes the objects before the
 * refs move; the hooks see the quarantined objects through `ctx.repository`. Memory backend
 * (`incoming-*` keys) and files backend (`objects/tmp_objdir-incoming-*`, kept packs).
 */

import { createHistoryFromComponents, type History } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

import { createRepositoryFacade, type ReceivePackHooks, serveOverDuplex } from "../src/index.js";
import {
  clientWithNewCommits,
  fullPackOf,
  packOf,
  pushRequest,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";
import { commitInRepo, createTransportRefStore, type TransportRepo } from "./interop/helpers.js";

/** Every object id the server's store lists. */
async function storedIds(repo: { history: Pick<History, "objects"> }): Promise<Set<string>> {
  const ids = new Set<string>();
  const objects = repo.history.objects;
  if (!objects) throw new Error("no object store");
  for await (const id of objects.list()) ids.add(id);
  return ids;
}

/** The server (c1 ← c2 on main), the client's two new commits n0 ← n1 and their pack. */
async function setup() {
  const { repo, c2 } = await serverRepo();
  const { client, commits } = await clientWithNewCommits(2);
  const [n0, n1] = commits as [string, string];
  const pack = await fullPackOf(client, [n1], [c2]);
  const before = await storedIds(repo);
  /** The store holds exactly what it held before the push. */
  const unchanged = async () => expect(await storedIds(repo)).toEqual(before);
  return { repo, client, c2, n0, n1, pack, before, unchanged };
}

describe("receive-pack quarantine: a refused push leaves no objects", () => {
  it("unpack error (a corrupt pack)", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const broken = pack.slice();
    broken[broken.length - 1] = ((broken[broken.length - 1] as number) + 1) & 0xff;
    const run = await runReceivePack(repo, {
      commands: [`${c2} ${n1} refs/heads/main`],
      pack: broken,
    });
    expect(run.report[0]).toMatch(/^unpack /);
    expect(run.report[0]).not.toBe("unpack ok");
    await unchanged();
  });

  it("connectivity: the pack lacks an object the tip needs", async () => {
    const { repo, client, c2, unchanged } = await setup();
    const { commits } = await clientWithNewCommits(1);
    const tip = commits[0] as string;
    const pack = await packOf(client, [tip]); // the commit alone: its tree and blob are missing
    const run = await runReceivePack(repo, { commands: [`${c2} ${tip} refs/heads/main`], pack });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main missing necessary objects"]);
    await unchanged();
  });

  it("authorize refusing every ref", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { hooks: { authorize: () => "no" } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main no"]);
    await unchanged();
  });

  it("pre-receive refusing the push", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/topic`], pack },
      { hooks: { preReceive: () => "not today" } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main pre-receive hook declined",
      "ng refs/heads/topic pre-receive hook declined",
    ]);
    await unchanged();
  });

  it("pre-receive throwing (pre-receive hook error)", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        hooks: {
          preReceive: () => {
            throw new Error("boom");
          },
        },
        logger: { error: () => {} },
      },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main pre-receive hook declined"]);
    await unchanged();
  });

  it("the update hook refusing every ref", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/topic`], pack },
      { hooks: { update: () => "locked" } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main hook declined",
      "ng refs/heads/topic hook declined",
    ]);
    await unchanged();
  });

  it("git's update() checks refusing every ref (non-fast-forward)", async () => {
    const { repo, c2, unchanged } = await setup();
    // a client history that does not contain c2
    const other = await clientWithNewCommits(0);
    const root = await commitInRepo(other.client, "elsewhere", { "z.txt": "z\n" });
    const pack = await fullPackOf(other.client, [root]);
    const run = await runReceivePack(repo, { commands: [`${c2} ${root} refs/heads/main`], pack });
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main non-fast-forward"]);
    await unchanged();
  });

  it("an atomic push with one refused ref", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const run = await runReceivePack(
      repo,
      {
        commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/locked`],
        caps: "report-status side-band-64k atomic",
        pack,
      },
      { hooks: { update: (ref) => (ref === "refs/heads/locked" ? "locked" : undefined) } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main atomic push failure",
      "ng refs/heads/locked hook declined",
    ]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
    await unchanged();
  });

  it("a client gone in the middle of the pack", async () => {
    const { repo, c2, n1, pack, unchanged } = await setup();
    const request = pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack });
    const cut = request.length - Math.floor(pack.length / 2);
    const result = await serveOverDuplex({
      repository: repo.facade,
      refStore: repo.refStore,
      service: "git-receive-pack",
      duplex: {
        async *[Symbol.asyncIterator]() {
          yield request.subarray(0, cut);
          throw new Error("connection reset by peer");
        },
        write() {
          throw new Error("the client is gone");
        },
      },
    });
    expect(result.success).toBe(false);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
    await unchanged();
  });
});

describe("receive-pack quarantine: an accepted push", () => {
  it("publishes the objects before the refs move", async () => {
    const { repo, c2, n1, pack, before } = await setup();
    let publishedWhenRefMoved: boolean | undefined;
    const update = repo.refStore.update.bind(repo.refStore);
    repo.refStore.update = async (name, oid) => {
      publishedWhenRefMoved = await repo.facade.has(oid);
      return update(name, oid);
    };
    const batch = repo.refStore.batch?.bind(repo.refStore);
    if (batch) {
      repo.refStore.batch = async (commands, options) => {
        publishedWhenRefMoved = await repo.facade.has(n1);
        return batch(commands, options);
      };
    }
    const run = await runReceivePack(repo, { commands: [`${c2} ${n1} refs/heads/main`], pack });
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(publishedWhenRefMoved).toBe(true);
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
    const after = await storedIds(repo);
    expect(after.size).toBeGreaterThan(before.size);
    expect(await repo.facade.has(n1)).toBe(true);
  });

  it("publishes the objects when some refs are refused and others accepted", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/locked`], pack },
      { hooks: { update: (ref) => (ref === "refs/heads/locked" ? "locked" : undefined) } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/locked hook declined",
    ]);
    expect(await repo.facade.has(n1)).toBe(true);
  });

  it("the hooks see the quarantined objects; the repository does not", async () => {
    const { repo, c2, n1, pack } = await setup();
    const seen: Record<string, [boolean, boolean]> = {};
    const hooks: ReceivePackHooks = {
      async preReceive(_commands, ctx) {
        seen.preReceive = [await ctx.repository.has(n1), await repo.facade.has(n1)];
        // the quarantine's view reads the commit graph too
        expect((await ctx.repository.getCommitInfo?.(n1))?.parents).toHaveLength(1);
      },
      async update(_ref, _old, newOid, ctx) {
        seen.update = [await ctx.repository.has(newOid), await repo.facade.has(newOid)];
      },
    };
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { hooks },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(seen).toEqual({ preReceive: [true, false], update: [true, false] });
    expect(await repo.facade.has(n1)).toBe(true);
  });
});

/** A server repository on the files backend (an in-memory FilesApi), c1 ← c2 on main. */
async function filesServer(): Promise<{ repo: TransportRepo; files: FilesApi; c2: string }> {
  const files = createInMemoryFilesApi();
  const backend = await createGitFilesBackend({ files, gitDir: ".", create: true });
  const history = createHistoryFromComponents({
    objects: backend.objects,
    refs: backend.history.refs,
    packs: backend.packs,
  });
  const facade = createRepositoryFacade({ history });
  const repo = {
    history,
    facade,
    refStore: createTransportRefStore(history.refs),
    imports: [],
    close: async () => {},
  } as unknown as TransportRepo;
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "one\n" });
  const c2 = await commitInRepo(repo, "c2", { "a.txt": "one\n", "b.txt": "two\n" }, [c1]);
  await repo.refStore.update("refs/heads/main", c2);
  return { repo, files, c2 };
}

async function listNames(files: FilesApi, dir: string): Promise<string[]> {
  const names: string[] = [];
  if (!(await files.exists(dir))) return names;
  for await (const e of files.list(dir)) names.push(e.name);
  return names.sort();
}

describe("receive-pack quarantine on the files backend (kept packs)", () => {
  /** A client commit of 150 new blobs on c2: its pack is kept as a pack (unpackLimit 100). */
  async function bigPush() {
    const { client, c2 } = await clientWithNewCommits(0);
    const tree: Record<string, string> = { "a.txt": "one\n", "b.txt": "two\n" };
    for (let i = 0; i < 150; i++) tree[`big-f${i}.txt`] = `file ${i}\n`;
    const tip = await commitInRepo(client, "big", tree, [c2]);
    return { tip, pack: await fullPackOf(client, [tip], [c2]) };
  }

  it("a refused push leaves objects/pack, the loose objects and objects/ as they were", async () => {
    const { repo, files, c2 } = await filesServer();
    const { tip, pack } = await bigPush();
    const objectsBefore = await listNames(files, "objects");
    const packsBefore = await listNames(files, "objects/pack");
    const idsBefore = await storedIds(repo);
    let quarantineSeen: string[] = [];
    let quarantinedPack: string[] = [];
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${tip} refs/heads/main`], pack },
      {
        hooks: {
          preReceive: async () => {
            quarantineSeen = (await listNames(files, "objects")).filter((n) =>
              n.startsWith("tmp_objdir-incoming-"),
            );
            quarantinedPack = await listNames(files, `objects/${quarantineSeen[0]}/pack`);
            return "refused";
          },
        },
      },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main pre-receive hook declined"]);
    // the pack waited in the quarantine while the hook ran
    expect(quarantineSeen).toHaveLength(1);
    expect(quarantinedPack.map((n) => n.slice(n.lastIndexOf(".")))).toEqual([".idx", ".pack"]);
    expect(await listNames(files, "objects")).toEqual(objectsBefore);
    expect(await listNames(files, "objects/pack")).toEqual(packsBefore);
    expect(await storedIds(repo)).toEqual(idsBefore);
  });

  it("an accepted push moves the kept pack into objects/pack", async () => {
    const { repo, files, c2 } = await filesServer();
    const { tip, pack } = await bigPush();
    const packsBefore = await listNames(files, "objects/pack");
    const run = await runReceivePack(repo, { commands: [`${c2} ${tip} refs/heads/main`], pack });
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    const packsAfter = await listNames(files, "objects/pack");
    expect(packsAfter.length).toBe(packsBefore.length + 2); // .pack and .idx
    expect((await listNames(files, "objects")).some((n) => n.startsWith("tmp_objdir-"))).toBe(
      false,
    );
    expect(await repo.facade.has(tip)).toBe(true);
    expect(await repo.refStore.get("refs/heads/main")).toBe(tip);
  });

  it("a small refused push (unpacked) leaves no loose object", async () => {
    const { repo, files, c2 } = await filesServer();
    const { client, commits } = await clientWithNewCommits(1);
    const tip = commits[0] as string;
    const pack = await fullPackOf(client, [tip], [c2]);
    const idsBefore = await storedIds(repo);
    const objectsBefore = await listNames(files, "objects");
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${tip} refs/heads/main`], pack },
      { hooks: { update: () => "no" } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main hook declined"]);
    expect(await storedIds(repo)).toEqual(idsBefore);
    expect(await listNames(files, "objects")).toEqual(objectsBefore);
  });
});
