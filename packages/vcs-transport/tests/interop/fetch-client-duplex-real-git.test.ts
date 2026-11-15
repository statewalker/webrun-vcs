/**
 * The fetch client over a stateful duplex (`fetchOverDuplex`) against a spawned native
 * `git upload-pack`, v0 and v2: incremental negotiation (haves, only new objects), a shallow
 * fetch, and per-ref fast-forward checks (a non-fast-forward is rejected, not written).
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchOverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  git,
  gitAvailable,
  makeTmpDir,
  spawnGitService,
  spawnGitServiceV2,
  type TransportRepo,
} from "./helpers.js";

const describeGit = gitAvailable() ? describe : describe.skip;

function addCommits(repo: string, count: number, time: number, prefix: string, from?: string) {
  let stream = "";
  for (let i = 0; i < count; i++) {
    const message = `${prefix}${i}\n`;
    const content = `${prefix} ${i}\n`;
    stream += "commit refs/heads/main\n";
    stream += `committer T <t@example.com> ${time + i * 60} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}`;
    if (i === 0 && from) stream += `from ${from}\n`;
    stream += `M 100644 inline f${i % 3}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: stream,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return git(repo, ["rev-parse", "refs/heads/main"]);
}

describeGit.each([0, 2] as const)("fetchOverDuplex ← git upload-pack (protocol v%i)", (version) => {
  let root: string;
  let dir: string;
  let client: TransportRepo;
  const spawn = () =>
    version === 2 ? spawnGitServiceV2("upload-pack", dir) : spawnGitService("upload-pack", dir);
  const run = async (options: Partial<Parameters<typeof fetchOverDuplex>[0]>) => {
    const duplex = spawn();
    try {
      const result = await fetchOverDuplex({
        duplex,
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["refs/heads/*:refs/remotes/origin/*"],
        ...options,
      });
      expect(result.success, `${result.error}\n${duplex.stderr()}`).toBe(true);
      return result;
    } finally {
      await duplex.close();
    }
  };

  beforeEach(async () => {
    root = makeTmpDir("vcs-fetch-duplex-");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", "src.git"]);
    dir = join(root, "src.git");
    client = await createTransportRepo();
  });
  afterEach(async () => {
    await client.close();
    cleanupDir(root);
  });

  it("negotiates an incremental fetch, then rejects a non-fast-forward", async () => {
    const old = addCommits(dir, 100, 1_700_000_000, "c");
    const cloned = await run({});
    expect(cloned.report?.protocolVersion).toBe(version);
    expect(cloned.report?.refUpdates[0]?.status).toBe("new");

    const tip = addCommits(dir, 2, 1_800_000_000, "n", old);
    const inc = await run({});
    const expected = git(dir, ["rev-list", "--objects", tip, `^${old}`]).split("\n").length;
    expect(inc.report?.packObjects).toBe(expected);
    expect(inc.report?.stats.haves).toBeGreaterThan(0);
    expect(inc.report?.stats.haves).toBeLessThanOrEqual(32);
    expect(inc.updatedRefs?.get("refs/remotes/origin/main")).toBe(tip);

    // main rewritten upstream: not written without +, written with it
    git(dir, ["update-ref", "refs/heads/main", old]);
    const rewritten = addCommits(dir, 1, 1_900_000_000, "r", old);
    const refused = await run({});
    expect(refused.report?.refUpdates[0]).toMatchObject({
      status: "rejected",
      reason: "non-fast-forward",
    });
    expect(refused.updatedRefs?.has("refs/remotes/origin/main")).toBe(false);
    expect(await client.refStore.get("refs/remotes/origin/main")).toBe(tip);
    const forced = await run({ refspecs: ["+refs/heads/*:refs/remotes/origin/*"] });
    expect(forced.report?.refUpdates[0]?.status).toBe("forced");
    expect(await client.refStore.get("refs/remotes/origin/main")).toBe(rewritten);
  });

  it("a shallow fetch records the boundary; deepening moves it", async () => {
    const tip = addCommits(dir, 8, 1_700_000_000, "c");
    const shallow = await run({ depth: 2 });
    expect(shallow.report?.shallow.after).toEqual([git(dir, ["rev-parse", "main~1"])]);
    expect(await client.facade.has(tip)).toBe(true);
    expect(await client.facade.has(git(dir, ["rev-parse", "main~2"]))).toBe(false);
    const deeper = await run({ depth: 5 });
    expect(deeper.report?.shallow.after).toEqual([git(dir, ["rev-parse", "main~4"])]);
    expect(await client.refStore.getShallow?.()).toEqual([git(dir, ["rev-parse", "main~4"])]);
  });
});
