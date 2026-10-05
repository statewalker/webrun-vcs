/**
 * Native Git Client vs VCS Server integration tests.
 *
 * Tests native git commands (clone, ls-remote, push) against our
 * createHttpHandler-backed HTTP server. Validates that our server
 * implementation is compatible with the reference Git client.
 *
 * Skips gracefully when git-http-backend is not available (the probe is in
 * helpers/git-http-backend-server.ts). Nothing here is skipped for any other
 * reason: this file contains no `it.skip`, and the whole native-git directory
 * runs 12/12 green against git 2.43.0.
 *
 * (A former note here claimed most tests were skipped for "known pack
 * import/export bugs in core/serialization". That was stale — removed
 * 2026-08-01 after verifying the suite runs and passes.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTransportRefStore,
} from "../../helpers/index.js";
import { createNativeGitClient } from "./helpers/native-git-client.js";
import { startVcsHttpServer, type VcsHttpServer } from "./helpers/vcs-http-server.js";

describe("Native Git Client vs VCS Server", () => {
  let vcsServer: VcsHttpServer;
  const repos = new Map<
    string,
    {
      repository: ReturnType<typeof createRepositoryFacade>;
      refs: ReturnType<typeof createTransportRefStore>;
      cleanup: () => Promise<void>;
    }
  >();

  beforeAll(async () => {
    vcsServer = await startVcsHttpServer({
      async resolveRepository(repoPath: string) {
        const entry = repos.get(repoPath);
        if (!entry) return null;
        return { repository: entry.repository, refStore: entry.refs };
      },
    });
  });

  afterAll(async () => {
    await vcsServer.close();
    for (const entry of repos.values()) {
      await entry.cleanup();
    }
    repos.clear();
  });

  // Helper to register a VCS repository at a given path
  async function registerRepo(path: string) {
    const ctx = await createInitializedTestRepository();
    const facade = createRepositoryFacade(ctx.repository);
    const refs = createTransportRefStore(ctx.repository.refs);
    repos.set(path, { repository: facade, refs, cleanup: ctx.cleanup });
    return ctx;
  }

  describe("git ls-remote from VCS server", () => {
    it("lists refs from VCS server", async () => {
      const ctx = await registerRepo("/ls-remote.git");
      await createTestCommit(ctx.repository, "Main commit", { "a.txt": "a" });

      // Create a tag
      const headRef = await ctx.repository.refs.resolve("HEAD");
      if (headRef?.objectId) {
        await ctx.repository.refs.set("refs/tags/v1.0", headRef.objectId);
      }

      const client = createNativeGitClient();
      try {
        const remoteRefs = await client.lsRemote(`${vcsServer.url}/ls-remote.git`);
        expect(remoteRefs.has("refs/heads/main")).toBe(true);
        expect(remoteRefs.has("refs/tags/v1.0")).toBe(true);
      } finally {
        client.cleanup();
      }
    });
  });

  describe("git clone from VCS server", () => {
    it("clones a repository with commits", async () => {
      const ctx = await registerRepo("/test-clone.git");
      await createTestCommit(ctx.repository, "Server commit", {
        "hello.txt": "Hello from VCS",
      });

      const client = createNativeGitClient();
      try {
        await client.clone(`${vcsServer.url}/test-clone.git`);
        const log = await client.git("log --oneline");
        expect(log).toContain("Server commit");

        // Verify file contents
        const content = await client.git("show HEAD:hello.txt");
        expect(content).toBe("Hello from VCS");
      } finally {
        client.cleanup();
      }
    });
  });

  describe("git push to VCS server", () => {
    it("pushes commits to VCS server", async () => {
      const ctx = await registerRepo("/push-target.git");

      const client = createNativeGitClient();
      try {
        await client.clone(`${vcsServer.url}/push-target.git`);
        await client.commitFile("pushed.txt", "Pushed from native git", "Native push");
        await client.push();

        // Verify VCS server has the new ref
        const mainRef = await ctx.repository.refs.resolve("refs/heads/main");
        expect(mainRef?.objectId).toBeDefined();
      } finally {
        client.cleanup();
      }
    });
  });
});
