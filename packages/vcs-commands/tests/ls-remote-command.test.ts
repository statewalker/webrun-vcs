/**
 * Tests for LsRemoteCommand
 *
 * Based on JGit's LsRemoteCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

describe.each(backends)("LsRemoteCommand ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createTestWorkingCopy(): Promise<WorkingCopy> {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    return ctx.workingCopy;
  }
  describe("basic operations", () => {
    it("should list refs from remote repository", async () => {
      // Set up remote server with commits
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create local client store
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Override fetch to use test server
      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).call();

        // Should have refs
        expect(result.refs.length).toBeGreaterThan(0);

        // Should have main branch (HEAD is filtered out by LsRemoteCommand)
        expect(result.refs.some((r) => r.name === "refs/heads/main")).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should filter heads only", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Add a tag on server
      await server.serverStores.refs.set("refs/tags/v1.0", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).setHeads(true).call();

        // Should have heads only (tags filtered out)
        const hasHeads = result.refs.some((r) => r.name.startsWith("refs/heads/"));
        const hasTags = result.refs.some((r) => r.name.startsWith("refs/tags/"));

        expect(hasHeads).toBe(true);
        expect(hasTags).toBe(false); // setHeads(true) filters out tags
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should filter tags only", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Add a tag on server
      await server.serverStores.refs.set("refs/tags/v1.0", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).setTags(true).call();

        // Result should contain tags only
        expect(result.refs.length).toBeGreaterThan(0);
        expect(result.refs.every((r) => r.name.startsWith("refs/tags/"))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw for invalid remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Use a server that returns 404
      const _server = createTestServer();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_input: RequestInfo | URL) => {
        return new Response("Not Found", { status: 404 });
      };

      try {
        await expect(git.lsRemote().setRemote("http://invalid/repo.git").call()).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should require remote to be set", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.lsRemote().call()).rejects.toThrow();
    });
  });

  describe("with multiple refs", () => {
    it("should list all branches", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create additional branches on server
      await server.serverStores.refs.set("refs/heads/feature", server.initialCommitId);
      await server.serverStores.refs.set("refs/heads/develop", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).call();

        expect(result.refs.some((r) => r.name === "refs/heads/main")).toBe(true);
        expect(result.refs.some((r) => r.name === "refs/heads/feature")).toBe(true);
        expect(result.refs.some((r) => r.name === "refs/heads/develop")).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should include tags and branches", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create tags
      await server.serverStores.refs.set("refs/tags/v1.0", server.initialCommitId);
      await server.serverStores.refs.set("refs/tags/v2.0", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).call();

        // Should have both branches and tags
        expect(result.refs.some((r) => r.name === "refs/heads/main")).toBe(true);
        expect(result.refs.some((r) => r.name === "refs/tags/v1.0")).toBe(true);
        expect(result.refs.some((r) => r.name === "refs/tags/v2.0")).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("with commits", () => {
    it("should return correct object IDs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Add a file and commit on server
      const _commitId = await addFileAndCommit(
        server.serverStores,
        "README.md",
        "# Test",
        "Add README",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.lsRemote().setRemote(remoteUrl).call();

        // The object ID should be a valid SHA-1 (40 hex chars) or SHA-256 (64 hex chars)
        const mainRef = result.refs.find((r) => r.name === "refs/heads/main");
        expect(mainRef).toBeDefined();
        expect(mainRef?.objectId).toMatch(/^[0-9a-f]{40,64}$/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
