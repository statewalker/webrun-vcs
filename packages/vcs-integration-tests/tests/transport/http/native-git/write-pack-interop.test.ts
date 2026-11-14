/**
 * Packs written by listObjects + writePack, checked by native git end to end:
 *
 *  - native git clones, then fetches (a thin pack), a repository built by our code from our HTTP
 *    server, and `git fsck --full --strict` passes;
 *  - our client pushes (the pack streamed in the POST body) into a git-http-backend bare
 *    repository, twice, and `git fsck --full --strict` passes there.
 *
 * Every git call runs with fixed author and committer identities in its environment.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { httpPush, push } from "@statewalker/vcs-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTransportRefStore,
  type TestRepositoryContext,
} from "../../helpers/index.js";
import {
  type GitHttpBackendServer,
  gitHttpBackendAvailable,
  startGitHttpBackendServer,
} from "./helpers/git-http-backend-server.js";
import { startVcsHttpServer, type VcsHttpServer } from "./helpers/vcs-http-server.js";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
/** Async: the HTTP servers run in this process. */
const git = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 })).stdout.trim();
const fsck = (dir: string) => git(dir, ["fsck", "--full", "--strict", "--no-dangling"]);

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "write-pack-interop-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `n` commits rewriting a few text files, so the packs carry deltas. */
async function commitVersions(ctx: TestRepositoryContext, from: number, n: number) {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: the quick brown fox`);
  let last = "";
  for (let v = from; v < from + n; v++) {
    for (let k = 0; k <= v; k++) lines[(k * 31) % lines.length] = `edited in version ${v}/${k}`;
    last = await createTestCommit(ctx.repository, `version ${v}`, {
      "notes.txt": `${lines.join("\n")}\n`,
      "other.txt": `${lines.slice(50).join("\n")}\nversion ${v}\n`,
      "small.txt": `v${v}\n`,
    });
  }
  return last;
}

describe("native git clones and fetches what our server packs", () => {
  let server: VcsHttpServer;
  const repos = new Map<string, TestRepositoryContext>();

  beforeAll(async () => {
    server = await startVcsHttpServer({
      async resolveRepository(repoPath: string) {
        const ctx = repos.get(repoPath);
        if (!ctx) return null;
        return {
          repository: createRepositoryFacade(ctx.repository),
          refStore: createTransportRefStore(ctx.repository.refs),
        };
      },
    });
  });
  afterAll(async () => {
    await server.close();
    for (const ctx of repos.values()) await ctx.cleanup();
  });

  it("clone, then a thin fetch: git fsck --full --strict passes", async () => {
    const ctx = await createInitializedTestRepository();
    repos.set("/history.git", ctx);
    const first = await commitVersions(ctx, 0, 12);

    const work = tmp();
    await git(work, [
      "-c",
      "init.defaultBranch=main",
      "clone",
      "-q",
      `${server.url}/history.git`,
      ".",
    ]);
    await fsck(work);
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(first);
    expect(await git(work, ["rev-list", "--count", "HEAD"])).toBe("13");

    const second = await commitVersions(ctx, 12, 6);
    await git(work, ["fetch", "-q", "origin"]);
    await fsck(work);
    expect(await git(work, ["rev-parse", "origin/main"])).toBe(second);
    const notes = await git(work, ["show", "origin/main:notes.txt"]);
    expect(notes).toContain("edited in version 17/17");
  });
});

const describeWithGit = gitHttpBackendAvailable() ? describe : describe.skip;

describeWithGit("our client pushes into git-http-backend", () => {
  let backend: GitHttpBackendServer;

  beforeAll(async () => {
    backend = await startGitHttpBackendServer();
  });
  afterAll(async () => {
    await backend.close();
  });

  it("httpPush streams the pack; two pushes pass git fsck --full --strict", async () => {
    const url = await backend.createBareRepo("pushed.git");
    const bare = join(backend.reposDir, "pushed.git");
    const ctx = await createInitializedTestRepository();
    try {
      const facade = createRepositoryFacade(ctx.repository);
      const refs = createTransportRefStore(ctx.repository.refs);

      const first = await commitVersions(ctx, 0, 10);
      expect((await httpPush(url, facade, refs, { refspecs: ["refs/heads/main"] })).success).toBe(
        true,
      );
      await fsck(bare);
      expect(await git(bare, ["rev-parse", "refs/heads/main"])).toBe(first);

      const second = await commitVersions(ctx, 10, 5);
      expect((await httpPush(url, facade, refs, { refspecs: ["refs/heads/main"] })).success).toBe(
        true,
      );
      await fsck(bare);
      expect(await git(bare, ["rev-parse", "refs/heads/main"])).toBe(second);
    } finally {
      await ctx.cleanup();
    }
  });

  it("push() with exportPack: the pack streams; git fsck --full --strict passes", async () => {
    const url = await backend.createBareRepo("pushed-op.git");
    const bare = join(backend.reposDir, "pushed-op.git");
    const ctx = await createInitializedTestRepository();
    try {
      const tip = await commitVersions(ctx, 0, 8);
      const result = await push({
        url,
        refspecs: ["refs/heads/main:refs/heads/main"],
        getLocalRef: async (name) => (await ctx.repository.refs.resolve(name))?.objectId,
        exportPack: (wants, exclude) => ctx.repository.serialization.exportPack(wants, exclude),
      });
      expect(result.ok).toBe(true);
      expect(result.objectCount).toBeGreaterThan(8);
      await fsck(bare);
      expect(await git(bare, ["rev-parse", "refs/heads/main"])).toBe(tip);
    } finally {
      await ctx.cleanup();
    }
  });
});
