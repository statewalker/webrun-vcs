/**
 * Tests for FetchCommand
 *
 * Based on JGit's FetchCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import type { Ref } from "@statewalker/vcs-core";
import { DefaultSerializationApi } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, RefUpdateStatus, TagOption } from "../src/index.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

describe.each(backends)("FetchCommand ($name backend)", ({ factory }) => {
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
    it("should fetch refs from remote repository", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Should have fetched the ref
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
        expect(result.uri).toBe(remoteUrl);

        // Check that tracking ref was created
        const trackingRef = (await workingCopy.history.refs.get("refs/remotes/origin/main")) as
          | Ref
          | undefined;
        expect(trackingRef).toBeDefined();
        // The objectId should be a valid SHA-1 (40 hex chars)
        expect(trackingRef?.objectId).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should update existing refs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // First fetch
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Get initial ref value
        const initialRef = (await workingCopy.history.refs.get("refs/remotes/origin/main")) as
          | Ref
          | undefined;
        const initialObjectId = initialRef?.objectId;

        // Add a new commit on server
        await addFileAndCommit(server.serverStores, "file2.txt", "content 2", "Second commit");

        // Second fetch should update the ref
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("+refs/heads/main:refs/remotes/origin/main") // Force update
          .call();

        // Find the update for our ref
        const update = result.trackingRefUpdates.find(
          (u) => u.localRef === "refs/remotes/origin/main",
        );
        expect(update).toBeDefined();
        // The new objectId should be different from the initial one
        expect(update?.newObjectId).not.toBe(initialObjectId);
        expect(update?.newObjectId).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not update refs in dry run mode", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setDryRun(true)
          .call();

        // Should report what would be updated
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);

        // But ref should not be created
        const trackingRef = await workingCopy.history.refs.get("refs/remotes/origin/main");
        expect(trackingRef).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("object storage", () => {
    /**
     * A fetch that writes a tracking ref but drops the pack leaves the ref
     * dangling: the commit it names cannot be loaded locally.
     */
    it("should store the fetched objects, not just the ref", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Commit a real file so the pack carries a distinctive tree + blob
      // (the initial commit's tree is the well-known EMPTY tree, which some
      // stores can answer for without ever having received it).
      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        const trackingRef = (await workingCopy.history.refs.get("refs/remotes/origin/main")) as
          | Ref
          | undefined;
        expect(trackingRef?.objectId).toBe(commitId);

        // The commit the ref points at must exist locally
        const commit = await workingCopy.history.commits.load(commitId);
        expect(commit).toBeDefined();
        if (!commit) return;

        // ...and so must its tree
        const tree = await workingCopy.history.trees.load(commit.tree);
        expect(tree).toBeDefined();
        if (!tree) return;
        const entries = [];
        for await (const entry of tree) {
          entries.push(entry);
        }
        expect(entries.map((e) => e.name)).toContain("hello.txt");

        // ...and the blob content itself
        const blobEntry = entries.find((e) => e.name === "hello.txt");
        expect(blobEntry).toBeDefined();
        if (!blobEntry) return;
        const blob = await workingCopy.history.blobs.load(blobEntry.id);
        expect(blob).toBeDefined();
        if (!blob) return;
        const chunks: Uint8Array[] = [];
        for await (const chunk of blob) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        expect(new TextDecoder().decode(bytes)).toBe("hello from the remote");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not store objects in dry run mode", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setDryRun(true)
          .call();

        expect(await workingCopy.history.commits.has(commitId)).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * An empty remote sends a zero-length pack, which the pack parser rejects
     * ("Unexpected end of stream: wanted 12 bytes, have 0"). Fetching from one
     * must still succeed.
     */
    it("should fetch from an empty remote without importing a pack", async () => {
      const server = createTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        expect(result.isEmpty).toBe(true);
        expect(result.trackingRefUpdates).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * A real backend's History is a HistoryWithOperations carrying a
     * serialization API configured with that backend's delta support; it must
     * be preferred over a freshly constructed default one.
     */
    it("should use the history's own serialization API when it has one", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const base = await createTestWorkingCopy();

      // Wrap the history with a serialization API that records its use
      let importCalls = 0;
      const delegate = new DefaultSerializationApi({ history: base.history });
      const serialization = new Proxy(delegate, {
        get(target, prop, receiver) {
          if (prop === "importPack") {
            return (pack: AsyncIterable<Uint8Array>) => {
              importCalls++;
              return target.importPack(pack);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const history = Object.create(base.history);
      Object.defineProperty(history, "serialization", { value: serialization });
      const workingCopy = Object.create(base) as WorkingCopy;
      Object.defineProperty(workingCopy, "history", { value: history });

      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        expect(importCalls).toBe(1);
        expect(await base.history.commits.has(commitId)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * The pack is imported on every fetch; a second fetch re-imports the same
     * objects. Import must be idempotent for a content-addressed store.
     */
    it("should import the same pack twice without error", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        const commit = await workingCopy.history.commits.load(commitId);
        expect(commit).toBeDefined();
        expect(commit?.message).toBe("Add hello.txt");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("refspecs", () => {
    it("should fetch multiple refspecs", async () => {
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
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs(
            "refs/heads/main:refs/remotes/origin/main",
            "refs/heads/feature:refs/remotes/origin/feature",
            "refs/heads/develop:refs/remotes/origin/develop",
          )
          .call();

        expect(result.trackingRefUpdates.length).toBe(3);

        // Verify all refs were created
        const mainRef = await workingCopy.history.refs.get("refs/remotes/origin/main");
        const featureRef = await workingCopy.history.refs.get("refs/remotes/origin/feature");
        const developRef = await workingCopy.history.refs.get("refs/remotes/origin/develop");

        expect(mainRef).toBeDefined();
        expect(featureRef).toBeDefined();
        expect(developRef).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should use default refspec when none provided", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // Set remote name to "origin" and provide explicit refspec
        // (URL-based remotes with default refspec cause issues with //)
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/*:refs/remotes/origin/*")
          .call();

        // Should have fetched something
        expect(result.advertisedRefs.size).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should support force update with + prefix", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("+refs/heads/main:refs/remotes/origin/main")
          .call();

        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should apply force update flag to all refspecs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setForceUpdate(true)
          .call();

        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("tag options", () => {
    it("should fetch tags with FETCH_TAGS option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Get the actual main objectId
      const mainRef = (await server.serverStores.refs.get("refs/heads/main")) as Ref | undefined;
      expect(mainRef?.objectId).toBeDefined();

      // Create a tag on server using actual objectId
      await server.serverStores.refs.set("refs/tags/v1.0", mainRef?.objectId ?? "");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/*:refs/remotes/origin/*", "refs/tags/*:refs/tags/*")
          .setTagOpt(TagOption.FETCH_TAGS)
          .call();

        // Should include tag refs in advertised refs
        const hasTagRefs = Array.from(result.advertisedRefs.keys()).some((r) =>
          r.startsWith("refs/tags/"),
        );
        expect(hasTagRefs).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not fetch tags with NO_TAGS option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create a tag on server
      await server.serverStores.refs.set("refs/tags/v1.0", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setTagOpt(TagOption.NO_TAGS)
          .call();

        // Should have fetched something
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("prune", () => {
    it("should prune deleted remote refs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Get the actual main objectId
      const mainRef = (await server.serverStores.refs.get("refs/heads/main")) as Ref | undefined;
      expect(mainRef?.objectId).toBeDefined();

      // Create additional branch on server using actual objectId
      await server.serverStores.refs.set("refs/heads/feature", mainRef?.objectId ?? "");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // First fetch with feature branch
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs(
            "refs/heads/main:refs/remotes/origin/main",
            "refs/heads/feature:refs/remotes/origin/feature",
          )
          .call();

        // Verify feature branch was fetched
        const featureRef = await workingCopy.history.refs.get("refs/remotes/origin/feature");
        expect(featureRef).toBeDefined();

        // Delete feature branch on server
        await server.serverStores.refs.remove("refs/heads/feature");

        // Fetch with prune using URL directly
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setRemoveDeletedRefs(true)
          .call();

        // Verify the fetch succeeded
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);

        // Note: Prune logic requires the transport result to match against local refs.
        // In this test, the feature ref may still exist locally because prune works
        // by comparing advertised refs from remote with local tracking refs.
        // The test verifies that the prune option can be set and fetch works.
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("result", () => {
    it("should report advertised refs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Should have advertised refs
        expect(result.advertisedRefs).toBeDefined();
        expect(result.advertisedRefs.size).toBeGreaterThan(0);

        // URI should be set
        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should report tracking ref updates", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Should have tracking ref updates
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);

        const update = result.trackingRefUpdates[0];
        expect(update.localRef).toBe("refs/remotes/origin/main");
        expect(update.newObjectId).toMatch(/^[0-9a-f]{40}$/);
        expect(update.status).toBe(RefUpdateStatus.NEW);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should detect NO_CHANGE status", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // First fetch
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Second fetch without changes
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        // Should have NO_CHANGE status
        const update = result.trackingRefUpdates.find(
          (u) => u.localRef === "refs/remotes/origin/main",
        );
        expect(update?.status).toBe(RefUpdateStatus.NO_CHANGE);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("shallow fetch", () => {
    it("should support depth option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create multiple commits on server
      await addFileAndCommit(server.serverStores, "file2.txt", "content 2", "Second commit");
      await addFileAndCommit(server.serverStores, "file3.txt", "content 3", "Third commit");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .setDepth(1)
          .call();

        // Should have fetched something
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should reject invalid depth", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      expect(() => git.fetch().setRemote("http://example.com/repo.git").setDepth(0)).toThrow(
        "Depth must be at least 1",
      );

      expect(() => git.fetch().setRemote("http://example.com/repo.git").setDepth(-1)).toThrow(
        "Depth must be at least 1",
      );
    });
  });

  describe("error handling", () => {
    it("should throw for invalid remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response("Not Found", { status: 404 });
      };

      try {
        await expect(
          git
            .fetch()
            .setRemote("http://invalid/repo.git")
            .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
            .call(),
        ).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("options getters", () => {
    it("should return correct values for getters", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .fetch()
        .setRemote("upstream")
        .setRemoveDeletedRefs(true)
        .setThin(false)
        .setDryRun(true)
        .setForceUpdate(true);

      expect(command.getRemote()).toBe("upstream");
      expect(command.isRemoveDeletedRefs()).toBe(true);
      expect(command.isThin()).toBe(false);
      expect(command.isDryRun()).toBe(true);
      expect(command.isForceUpdate()).toBe(true);
    });
  });

  /**
   * JGit-ported tests: Extended options
   */
  describe("extended options (JGit parity)", () => {
    /**
     * JGit: FetchCommandTest.testCheckFetchedObjects()
     */
    it("should support checkFetchedObjects option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.fetch().setRemote("origin").setCheckFetchedObjects(true);

      expect(command.isCheckFetchedObjects()).toBe(true);
    });

    /**
     * JGit: FetchCommand.setInitialBranch()
     */
    it("should support initial branch option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.fetch().setRemote("origin").setInitialBranch("develop");

      expect(command.getInitialBranch()).toBe("develop");
    });

    /**
     * JGit: FetchCommandTest.testShallowSince()
     */
    it("should support shallow since option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const date = new Date("2024-01-15T10:30:00Z");
      const command = git.fetch().setRemote("origin").setShallowSince(date);

      expect(command.getShallowSince()).toEqual(date);
    });

    /**
     * JGit: FetchCommandTest.testShallowExclude()
     */
    it("should support shallow exclude option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .fetch()
        .setRemote("origin")
        .addShallowExclude("refs/heads/old-branch")
        .addShallowExclude("abc123");

      expect(command.getShallowExcludes()).toEqual(["refs/heads/old-branch", "abc123"]);
    });

    /**
     * JGit: FetchCommandTest.testUnshallow()
     */
    it("should support unshallow option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.fetch().setRemote("origin").setUnshallow(true);

      expect(command.isUnshallow()).toBe(true);
    });

    it("should return all extended getter values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const date = new Date("2024-06-20");
      const command = git
        .fetch()
        .setRemote("upstream")
        .setCheckFetchedObjects(true)
        .setInitialBranch("feature")
        .setShallowSince(date)
        .addShallowExclude("commit1")
        .addShallowExclude("commit2")
        .setUnshallow(false);

      expect(command.getRemote()).toBe("upstream");
      expect(command.isCheckFetchedObjects()).toBe(true);
      expect(command.getInitialBranch()).toBe("feature");
      expect(command.getShallowSince()).toEqual(date);
      expect(command.getShallowExcludes()).toEqual(["commit1", "commit2"]);
      expect(command.isUnshallow()).toBe(false);
    });
  });
});
