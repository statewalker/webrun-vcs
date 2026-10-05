/**
 * VCS Client vs Native Git Server integration tests.
 *
 * Tests our httpFetch and httpPush against a real git-http-backend server.
 * Validates wire-level interoperability with the reference Git implementation.
 *
 * Skips gracefully when git-http-backend is not available.
 */

import { httpFetch, httpPush } from "@statewalker/vcs-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTestRepository,
  createTransportRefStore,
} from "../../helpers/index.js";
import {
  type GitHttpBackendServer,
  gitHttpBackendAvailable,
  startGitHttpBackendServer,
} from "./helpers/git-http-backend-server.js";
import { createNativeGitClient } from "./helpers/native-git-client.js";

const describeWithGit = gitHttpBackendAvailable() ? describe : describe.skip;

describeWithGit("VCS Client vs Native Git Server", () => {
  let server: GitHttpBackendServer;

  beforeAll(async () => {
    server = await startGitHttpBackendServer();
  });

  afterAll(async () => {
    await server.close();
  });

  describe("httpFetch from git-http-backend", () => {
    it("fetches from empty bare repository", async () => {
      const repoUrl = await server.createBareRepo("empty.git");
      const clientCtx = await createTestRepository();

      try {
        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpFetch(repoUrl, facade, refs);
        expect(result.success).toBe(true);
        expect(result.updatedRefs?.size ?? 0).toBe(0);
      } finally {
        await clientCtx.cleanup();
      }
    });

    it("fetches a single commit", async () => {
      const repoUrl = await server.createBareRepo("one-commit.git");
      const nativeClient = createNativeGitClient();

      try {
        await nativeClient.clone(repoUrl);
        await nativeClient.commitFile("README.md", "# Hello", "Initial commit");
        await nativeClient.push();

        const clientCtx = await createTestRepository();
        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpFetch(repoUrl, facade, refs);

        expect(result.success).toBe(true);
        const refNames = [...(result.updatedRefs?.keys() ?? [])];
        const hasMainOrMaster =
          refNames.includes("refs/heads/main") || refNames.includes("refs/heads/master");
        expect(hasMainOrMaster).toBe(true);
        expect(result.objectsImported).toBeGreaterThan(0);

        await clientCtx.cleanup();
      } finally {
        nativeClient.cleanup();
      }
    });

    it("fetches multiple commits with history", async () => {
      const repoUrl = await server.createBareRepo("multi-commit.git");
      const nativeClient = createNativeGitClient();

      try {
        await nativeClient.clone(repoUrl);
        await nativeClient.commitFile("file1.txt", "v1", "First commit");
        await nativeClient.push();
        await nativeClient.commitFile("file2.txt", "v2", "Second commit");
        await nativeClient.push();
        await nativeClient.commitFile("file1.txt", "v1-updated", "Third commit");
        await nativeClient.push();

        const clientCtx = await createTestRepository();
        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpFetch(repoUrl, facade, refs);

        expect(result.success).toBe(true);
        // 3 commits + trees + blobs
        expect(result.objectsImported).toBeGreaterThanOrEqual(3);

        await clientCtx.cleanup();
      } finally {
        nativeClient.cleanup();
      }
    });

    it("fetches branches and tags", async () => {
      const repoUrl = await server.createBareRepo("branches.git");
      const nativeClient = createNativeGitClient();

      try {
        await nativeClient.clone(repoUrl);
        await nativeClient.commitFile("main.txt", "main", "Main commit");
        await nativeClient.push();

        await nativeClient.git("checkout -b feature");
        await nativeClient.commitFile("feature.txt", "feature", "Feature commit");
        await nativeClient.git("push origin feature");

        await nativeClient.git(`-c user.name="Test" -c user.email="test@test.com" tag v1.0`);
        await nativeClient.git("push origin v1.0");

        const clientCtx = await createTestRepository();
        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpFetch(repoUrl, facade, refs);

        expect(result.success).toBe(true);
        const refNames = [...(result.updatedRefs?.keys() ?? [])];
        expect(refNames).toContain("refs/heads/feature");
        expect(refNames).toContain("refs/tags/v1.0");

        await clientCtx.cleanup();
      } finally {
        nativeClient.cleanup();
      }
    });

    it("performs incremental fetch (only new objects)", async () => {
      const repoUrl = await server.createBareRepo("incremental.git");
      const nativeClient = createNativeGitClient();

      try {
        await nativeClient.clone(repoUrl);
        await nativeClient.commitFile("first.txt", "first", "First commit");
        await nativeClient.push();

        // First fetch
        const clientCtx = await createTestRepository();
        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result1 = await httpFetch(repoUrl, facade, refs);
        expect(result1.success).toBe(true);
        const firstImported = result1.objectsImported ?? 0;

        // Add more commits on the server
        await nativeClient.commitFile("second.txt", "second", "Second commit");
        await nativeClient.push();

        // Second fetch should get only new objects (incremental)
        const result2 = await httpFetch(repoUrl, facade, refs);
        expect(result2.success).toBe(true);
        // Incremental fetch should not import more objects than initial
        // (each single-commit fetch imports ~3 objects: commit + tree + blob)
        expect(result2.objectsImported).toBeLessThanOrEqual(firstImported);

        await clientCtx.cleanup();
      } finally {
        nativeClient.cleanup();
      }
    });
  });

  describe("httpPush to git-http-backend", () => {
    it("pushes a single commit to empty repo", async () => {
      const repoUrl = await server.createBareRepo("push-empty.git");
      const clientCtx = await createInitializedTestRepository();

      try {
        await createTestCommit(clientCtx.repository, "Push test", {
          "README.md": "# Pushed from VCS",
        });

        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpPush(repoUrl, facade, refs, {
          refspecs: ["refs/heads/main"],
        });

        expect(result.success).toBe(true);

        // Verify with native git ls-remote
        const verifyClient = createNativeGitClient();
        const remoteRefs = await verifyClient.lsRemote(repoUrl);
        expect(remoteRefs.has("refs/heads/main")).toBe(true);
        verifyClient.cleanup();
      } finally {
        await clientCtx.cleanup();
      }
    });

    it("pushes multiple commits", async () => {
      const repoUrl = await server.createBareRepo("push-multi.git");
      const clientCtx = await createInitializedTestRepository();

      try {
        await createTestCommit(clientCtx.repository, "Commit 1", { "a.txt": "a" });
        await createTestCommit(clientCtx.repository, "Commit 2", { "b.txt": "b" });
        await createTestCommit(clientCtx.repository, "Commit 3", { "c.txt": "c" });

        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpPush(repoUrl, facade, refs, {
          refspecs: ["refs/heads/main"],
        });

        expect(result.success).toBe(true);

        // Verify: clone with native git and check history
        const verifyClient = createNativeGitClient();
        await verifyClient.clone(repoUrl);
        const log = await verifyClient.git("log --oneline");
        expect(log).toContain("Commit 3");
        expect(log).toContain("Commit 1");
        verifyClient.cleanup();
      } finally {
        await clientCtx.cleanup();
      }
    });

    it("pushes branch using refspec", async () => {
      const repoUrl = await server.createBareRepo("push-branch.git");
      const clientCtx = await createInitializedTestRepository();

      try {
        await createTestCommit(clientCtx.repository, "Feature work", {
          "feature.txt": "feature",
        });

        // Create feature branch pointing to HEAD
        const headRef = await clientCtx.repository.refs.resolve("HEAD");
        if (headRef?.objectId) {
          await clientCtx.repository.refs.set("refs/heads/feature", headRef.objectId);
        }

        const facade = createRepositoryFacade(clientCtx.repository);
        const refs = createTransportRefStore(clientCtx.repository.refs);

        const result = await httpPush(repoUrl, facade, refs, {
          refspecs: ["refs/heads/feature:refs/heads/feature"],
        });

        expect(result.success).toBe(true);

        const verifyClient = createNativeGitClient();
        const remoteRefs = await verifyClient.lsRemote(repoUrl);
        expect(remoteRefs.has("refs/heads/feature")).toBe(true);
        verifyClient.cleanup();
      } finally {
        await clientCtx.cleanup();
      }
    });
  });

  describe("round-trip: push then fetch", () => {
    it("push from VCS, fetch back into another VCS repo", async () => {
      const repoUrl = await server.createBareRepo("roundtrip.git");

      // Push from repo A
      const repoA = await createInitializedTestRepository();
      await createTestCommit(repoA.repository, "Round-trip commit", {
        "data.txt": "round-trip content",
      });

      const facadeA = createRepositoryFacade(repoA.repository);
      const refsA = createTransportRefStore(repoA.repository.refs);

      const pushResult = await httpPush(repoUrl, facadeA, refsA, {
        refspecs: ["refs/heads/main"],
      });
      expect(pushResult.success).toBe(true);

      // Fetch into repo B
      const repoB = await createTestRepository();
      const facadeB = createRepositoryFacade(repoB.repository);
      const refsB = createTransportRefStore(repoB.repository.refs);

      const fetchResult = await httpFetch(repoUrl, facadeB, refsB);
      expect(fetchResult.success).toBe(true);
      expect(fetchResult.objectsImported).toBeGreaterThan(0);

      // Verify repo B has the same commit OID as repo A
      const mainRefB = await repoB.repository.refs.resolve("refs/heads/main");
      const mainRefA = await repoA.repository.refs.resolve("refs/heads/main");
      expect(mainRefB?.objectId).toBe(mainRefA?.objectId);

      await repoA.cleanup();
      await repoB.cleanup();
    });
  });
});
