/**
 * The fetch client (`fetch`, smart HTTP) against native git as the server: `git http-backend`
 * speaking protocol v2 and v0, and our own `createFetchHandler` (v2 and v0) for comparison.
 *
 * What git's fetch-pack and remote-curl guarantee, checked against what native git reports:
 * a clone holds every object; an incremental fetch sends haves and receives only the new
 * objects (the pack's object count equals `git rev-list --objects old..new`); shallow
 * clones, deepening and unshallowing keep a shallow file that native `git fsck` accepts on an
 * export of the repository; tags follow; a non-fast-forward is rejected unless forced.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFetchHandler, type FetchOptions, fetch } from "../../src/index.js";
import { type GitHttpBackend, gitHttpBackend } from "./git-http-backend.js";
import {
  cleanupDir,
  createTransportRepo,
  git,
  gitAvailable,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";

const describeGit = gitAvailable() ? describe : describe.skip;

/** Appends `count` commits to `branch` of the bare repository `repo` (git fast-import). */
function addCommits(
  repo: string,
  count: number,
  options: { branch?: string; time: number; prefix?: string; from?: string },
): string {
  const branch = options.branch ?? "main";
  let stream = "";
  for (let i = 0; i < count; i++) {
    const message = `${options.prefix ?? "c"}${i}\n`;
    const content = `${options.prefix ?? "c"} ${i} at ${options.time + i}\n`;
    stream += `commit refs/heads/${branch}\n`;
    stream += `committer T <t@example.com> ${options.time + i * 60} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}`;
    if (i === 0 && options.from) stream += `from ${options.from}\n`;
    stream += `M 100644 inline f${i % 5}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: stream,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return git(repo, ["rev-parse", `refs/heads/${branch}`]);
}

/** Objects reachable from `range` (`git rev-list --objects`). */
function objectCount(repo: string, range: string[]): number {
  return git(repo, ["rev-list", "--objects", ...range])
    .split("\n")
    .filter(Boolean).length;
}

/**
 * Exports the client repository (its refs, objects and shallow file) into a fresh bare git
 * repository and runs `git fsck` there: native git must accept what the client holds.
 */
async function fsckExport(client: TransportRepo, root: string): Promise<void> {
  const dir = join(root, `export-${Math.random().toString(36).slice(2)}.git`);
  git(root, ["init", "-q", "--bare", dir]);
  const refs = new Map<string, string>();
  for (const [name, oid] of await client.refStore.listAll())
    if (name !== "HEAD") refs.set(name, oid);
  const shallow = (await client.refStore.getShallow?.()) ?? [];
  const chunks: Uint8Array[] = [];
  for await (const chunk of client.history.serialization.exportPack(
    new Set(refs.values()),
    new Set(),
    { shallow },
  )) {
    chunks.push(chunk);
  }
  execFileSync("git", ["index-pack", "--stdin"], { cwd: dir, input: Buffer.concat(chunks) });
  if (shallow.length > 0) writeFileSync(join(dir, "shallow"), `${shallow.join("\n")}\n`);
  for (const [name, oid] of refs) git(dir, ["update-ref", name, oid]);
  git(dir, ["fsck", "--no-dangling"]);
}

interface Remote {
  url: string;
  /** Options every fetch from this remote takes (the transport, the protocol) */
  connect: Pick<FetchOptions, "url" | "fetchImpl" | "protocolVersion">;
  /** The bare repository behind it (native git) */
  dir: string;
}

describeGit.each([2, 0] as const)("fetch client ← git http-backend (protocol v%i)", (version) => {
  let root: string;
  let backend: GitHttpBackend;
  let remote: Remote;
  const clients: TransportRepo[] = [];

  async function client(): Promise<TransportRepo> {
    const repo = await createTransportRepo();
    clients.push(repo);
    return repo;
  }

  beforeEach(() => {
    root = makeTmpDir("vcs-fetch-client-");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", "src.git"]);
    backend = gitHttpBackend(root);
    const url = "http://git.test/src.git";
    remote = {
      url,
      connect: { url, fetchImpl: backend.handler, protocolVersion: version },
      dir: join(root, "src.git"),
    };
  });
  afterEach(async () => {
    backend.close();
    for (const c of clients.splice(0)) await c.close();
    cleanupDir(root);
  });

  it("clones every object, maps the refs, follows the tags, reports the default branch", async () => {
    const tip = addCommits(remote.dir, 6, { time: 1_700_000_000 });
    git(remote.dir, ["branch", "feature", "main~2"]);
    git(remote.dir, ["tag", "-a", "v1", "-m", "release", "main~1"]);
    const c = await client();

    const result = await fetch({
      ...remote.connect,
      repository: c.facade,
      refStore: c.refStore,
      refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(result.protocolVersion).toBe(version);
    expect(result.defaultBranch).toBe("refs/heads/main");
    const byRef = new Map(result.refUpdates.map((u) => [u.localRef, u]));
    expect(byRef.get("refs/remotes/origin/main")).toMatchObject({ newOid: tip, status: "new" });
    expect(byRef.get("refs/remotes/origin/main")?.summary).toBe("[new branch]");
    expect(byRef.get("refs/remotes/origin/feature")?.newOid).toBe(
      git(remote.dir, ["rev-parse", "feature"]),
    );
    // the annotated tag of a fetched commit is followed (git: include-tag)
    expect(result.followedTags).toEqual(["refs/tags/v1"]);
    expect(byRef.get("refs/tags/v1")?.summary).toBe("[new tag]");
    for (const oid of git(remote.dir, ["rev-list", "--objects", "--all"]).split("\n")) {
      expect(await c.facade.has(oid.slice(0, 40))).toBe(true);
    }
    await fsckExport(c, root);
  });

  it("an incremental fetch sends haves and receives only the new objects", async () => {
    const old = addCommits(remote.dir, 300, { time: 1_700_000_000 });
    const c = await client();
    const refspecs = ["+refs/heads/*:refs/remotes/origin/*"];
    await fetch({ ...remote.connect, repository: c.facade, refStore: c.refStore, refspecs });
    const tip = addCommits(remote.dir, 3, { time: 1_800_000_000, prefix: "n", from: old });

    const result = await fetch({
      ...remote.connect,
      repository: c.facade,
      refStore: c.refStore,
      refspecs,
    });

    // git's negotiation: the newest local commits first; the first batch finds the base
    expect(result.stats.haves).toBeGreaterThan(0);
    expect(result.stats.haves).toBeLessThanOrEqual(32);
    expect(result.packObjects).toBe(objectCount(remote.dir, [tip, `^${old}`]));
    expect(result.refUpdates).toEqual([
      expect.objectContaining({
        localRef: "refs/remotes/origin/main",
        oldOid: old,
        newOid: tip,
        status: "fast-forward",
        summary: `${old.slice(0, 7)}..${tip.slice(0, 7)}`,
      }),
    ]);
    // and the requests were git's: v2 asks with Git-Protocol, lists refs, then fetches
    const posts = backend.requests.filter((r) => r.method === "POST");
    if (version === 2) {
      expect(backend.requests[0]?.gitProtocol).toBe("version=2");
      expect(posts.some((r) => r.body.includes("command=ls-refs"))).toBe(true);
      expect(posts.at(-1)?.body).toContain("command=fetch");
    } else {
      expect(backend.requests.every((r) => r.gitProtocol === null)).toBe(true);
      expect(posts.at(-1)?.body).toMatch(/^[0-9a-f]{4}want [0-9a-f]{40} multi_ack_detailed/);
    }
    expect(posts.at(-1)?.body).toContain(`have ${old}`);
  });

  it("shallow clone, deepen and unshallow keep the shallow file as git does", async () => {
    const tip = addCommits(remote.dir, 10, { time: 1_700_000_000 });
    const c = await client();
    const refspecs = ["+refs/heads/main:refs/remotes/origin/main"];
    const base = { ...remote.connect, repository: c.facade, refStore: c.refStore, refspecs };

    const shallow = await fetch({ ...base, depth: 1 });
    expect(shallow.shallow).toEqual({ before: [], after: [tip] });
    expect(await c.refStore.getShallow?.()).toEqual([tip]);
    expect(await c.facade.has(tip)).toBe(true);
    expect(await c.facade.has(git(remote.dir, ["rev-parse", "main~1"]))).toBe(false);
    await fsckExport(c, root);

    const deeper = await fetch({ ...base, depth: 3 });
    const boundary = git(remote.dir, ["rev-parse", "main~2"]);
    expect(deeper.shallow.after).toEqual([boundary]);
    expect(await c.facade.has(boundary)).toBe(true);
    expect(await c.facade.has(git(remote.dir, ["rev-parse", "main~3"]))).toBe(false);
    await fsckExport(c, root);

    const full = await fetch({ ...base, unshallow: true });
    expect(full.shallow.after).toEqual([]);
    expect(await c.refStore.getShallow?.()).toEqual([]);
    for (const oid of git(remote.dir, ["rev-list", "main"]).split("\n")) {
      expect(await c.facade.has(oid)).toBe(true);
    }
    await fsckExport(c, root);
    await expect(fetch({ ...base, unshallow: true })).rejects.toThrow(/complete repository/);
  });

  it("follows tags pointing at fetched objects, tag chains included", async () => {
    addCommits(remote.dir, 4, { time: 1_700_000_000 });
    git(remote.dir, ["tag", "-a", "v1", "-m", "v1", "main~1"]);
    git(remote.dir, ["tag", "light", "main~2"]);
    git(remote.dir, ["tag", "-a", "inner", "-m", "inner", "main"]);
    git(remote.dir, ["tag", "-a", "outer", "-m", "outer", "inner"]);
    git(remote.dir, ["tag", "-d", "inner"]); // only the outer tag is a ref
    addCommits(remote.dir, 1, { branch: "other", time: 1_600_000_000, prefix: "o" });
    git(remote.dir, ["tag", "-a", "elsewhere", "-m", "not fetched", "other"]);
    const c = await client();

    const result = await fetch({
      ...remote.connect,
      repository: c.facade,
      refStore: c.refStore,
      refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
    });

    expect([...result.followedTags].sort()).toEqual([
      "refs/tags/light",
      "refs/tags/outer",
      "refs/tags/v1",
    ]);
    expect(await c.refStore.get("refs/tags/outer")).toBe(git(remote.dir, ["rev-parse", "outer"]));
    expect(await c.refStore.get("refs/tags/elsewhere")).toBeUndefined();
    await fsckExport(c, root);

    // --no-tags: none
    const d = await client();
    const none = await fetch({
      ...remote.connect,
      repository: d.facade,
      refStore: d.refStore,
      refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      tags: "none",
    });
    expect(none.followedTags).toEqual([]);
    expect(await d.refStore.get("refs/tags/v1")).toBeUndefined();
  });

  it("rejects a non-fast-forward unless the refspec or the fetch forces it", async () => {
    const first = addCommits(remote.dir, 3, { time: 1_700_000_000 });
    git(remote.dir, ["branch", "feature", "main"]);
    const c = await client();
    const plain = { ...remote.connect, repository: c.facade, refStore: c.refStore };
    await fetch({ ...plain, refspecs: ["refs/heads/*:refs/remotes/origin/*"] });

    // main is rewritten, feature moves forward
    const parent = git(remote.dir, ["rev-parse", "main~1"]);
    git(remote.dir, ["update-ref", "refs/heads/main", parent]);
    const rewritten = addCommits(remote.dir, 1, { time: 1_750_000_000, prefix: "r", from: parent });
    const ahead = addCommits(remote.dir, 1, {
      branch: "feature",
      time: 1_760_000_000,
      prefix: "f",
      from: first,
    });

    const refused = await fetch({ ...plain, refspecs: ["refs/heads/*:refs/remotes/origin/*"] });
    const byRef = new Map(refused.refUpdates.map((u) => [u.localRef, u]));
    expect(byRef.get("refs/remotes/origin/main")).toMatchObject({
      status: "rejected",
      reason: "non-fast-forward",
      summary: "[rejected]",
      oldOid: first,
      newOid: rewritten,
    });
    expect(byRef.get("refs/remotes/origin/feature")?.status).toBe("fast-forward");
    expect(await c.refStore.get("refs/remotes/origin/main")).toBe(first);
    expect(await c.refStore.get("refs/remotes/origin/feature")).toBe(ahead);

    const forced = await fetch({ ...plain, refspecs: ["+refs/heads/*:refs/remotes/origin/*"] });
    expect(forced.refUpdates.find((u) => u.localRef === "refs/remotes/origin/main")).toMatchObject({
      status: "forced",
      summary: `+ ${first.slice(0, 7)}...${rewritten.slice(0, 7)}`,
    });
    expect(await c.refStore.get("refs/remotes/origin/main")).toBe(rewritten);

    // --force forces a non-forced refspec too
    git(remote.dir, ["update-ref", "refs/heads/main", parent]);
    const again = await fetch({
      ...plain,
      refspecs: ["refs/heads/main:refs/remotes/origin/main"],
      force: true,
    });
    expect(again.refUpdates[0]?.status).toBe("forced");
  });
});

describeGit.each([true, false])("fetch client ← our createFetchHandler (v2: %s)", (protocolV2) => {
  let root: string;
  const repos: TransportRepo[] = [];

  async function repo(): Promise<TransportRepo> {
    const r = await createTransportRepo();
    repos.push(r);
    return r;
  }

  beforeEach(() => {
    root = makeTmpDir("vcs-fetch-ours-");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", "src.git"]);
  });
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.close();
    cleanupDir(root);
  });

  /** Our server, filled from the native repository with our client. */
  async function serve(): Promise<{ server: TransportRepo; connect: FetchOptions["fetchImpl"] }> {
    const server = await repo();
    const native = gitHttpBackend(root);
    try {
      await fetch({
        url: "http://git.test/src.git",
        fetchImpl: native.handler,
        repository: server.facade,
        refStore: server.refStore,
        tags: "all",
      });
    } finally {
      native.close();
    }
    const handler = createFetchHandler({
      protocolV2,
      resolveRepository: async () => ({ repository: server.facade, refStore: server.refStore }),
    });
    return { server, connect: handler };
  }

  it("clone, incremental fetch with haves, shallow and unshallow, tag backfill", async () => {
    const dir = join(root, "src.git");
    const old = addCommits(dir, 40, { time: 1_700_000_000 });
    git(dir, ["tag", "-a", "v1", "-m", "v1", "main~3"]);
    const first = await serve();
    const url = "http://ours.test/repo.git";
    const c = await repo();
    const base = {
      url,
      fetchImpl: first.connect,
      repository: c.facade,
      refStore: c.refStore,
      refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
    };

    const cloned = await fetch(base);
    expect(cloned.protocolVersion).toBe(protocolV2 ? 2 : 0);
    expect(await c.refStore.get("refs/remotes/origin/main")).toBe(old);
    // our server ignores include-tag: the tag object comes in a second fetch (git's backfill)
    expect(cloned.followedTags).toEqual(["refs/tags/v1"]);
    expect(cloned.imports.length).toBe(2);
    await fsckExport(c, root);

    const tip = addCommits(dir, 2, { time: 1_800_000_000, prefix: "n", from: old });
    const second = await serve();
    const inc = await fetch({ ...base, fetchImpl: second.connect });
    expect(inc.stats.haves).toBeGreaterThan(0);
    expect(inc.stats.haves).toBeLessThanOrEqual(32);
    expect(inc.packObjects).toBe(objectCount(dir, [tip, `^${old}`]));
    expect(inc.refUpdates[0]?.status).toBe("fast-forward");

    const s = await repo();
    const shallow = await fetch({ ...base, repository: s.facade, refStore: s.refStore, depth: 2 });
    // the first server still serves the old tip: depth 2 cuts below its parent
    expect(shallow.shallow.after).toEqual([git(dir, ["rev-parse", `${old}~1`])]);
    await fsckExport(s, root);
    const full = await fetch({
      ...base,
      fetchImpl: second.connect,
      repository: s.facade,
      refStore: s.refStore,
      unshallow: true,
    });
    expect(full.shallow.after).toEqual([]);
    expect(full.packObjects).toBeGreaterThan(0);
    await fsckExport(s, root);
  });
});
