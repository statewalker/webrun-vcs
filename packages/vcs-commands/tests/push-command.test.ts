/**
 * Tests for PushCommand
 *
 * Based on JGit's PushCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { PushStatus } from "../src/results/push-result.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommitWc,
  createInitializedTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

describe.each(backends)("PushCommand ($name backend)", ({ factory }) => {
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
    it("should push refs to remote repository", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create client with its own commit
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create initial commit in client
      const commitId = await addFileAndCommitWc(
        workingCopy,
        "client-file.txt",
        "client content",
        "Initial client commit",
      );

      // Set up HEAD on client
      await workingCopy.history.refs.set("HEAD", "refs/heads/main");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/feature")
          .call();

        // Should have pushed something
        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should return empty result when nothing to push", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create client without any refs
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.push().setRemote(remoteUrl).call();

        // Should return empty result
        expect(result.remoteUpdates.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("refspecs", () => {
    it("should push with explicit refspec", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create commit
      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/main")
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should push multiple refspecs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create commits for multiple branches
      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);
      await workingCopy.history.refs.set("refs/heads/feature", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/heads/main", "refs/heads/feature:refs/heads/feature")
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should push with add method", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);
      await workingCopy.history.refs.set("refs/heads/feature", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/main")
          .add("refs/heads/feature:refs/heads/feature")
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("force push", () => {
    it("should add + prefix when force is enabled", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/main")
          .setForce(true)
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not duplicate + prefix if already present", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("+refs/heads/main:refs/heads/main") // Already has +
          .setForce(true)
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("push all", () => {
    it("should push all branches when setPushAll is true", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create multiple branches
      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);
      await workingCopy.history.refs.set("refs/heads/feature", commitId);
      await workingCopy.history.refs.set("refs/heads/develop", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.push().setRemote(remoteUrl).setPushAll(true).call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("push tags", () => {
    it("should push tags when setPushTags is true", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create commit and tag
      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);
      await workingCopy.history.refs.set("refs/tags/v1.0", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.push().setRemote(remoteUrl).setPushTags(true).call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("atomic push", () => {
    it("should set atomic option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/main")
          .setAtomic(true)
          .call();

        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("dry run", () => {
    it("should not actually push in dry run mode", async () => {
      const server = await createInitializedTestServer();
      const _remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      // Note: Dry run behavior depends on transport implementation
      // This test verifies the option is accepted
      expect(git.push().setDryRun(true).isDryRun()).toBe(true);
    });
  });

  describe("result", () => {
    it("should return push result with uri", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/new-branch")
          .call();

        expect(result.uri).toBe(remoteUrl);
        expect(result.remoteUpdates).toBeDefined();
        expect(result.bytesSent).toBeGreaterThanOrEqual(0);
        expect(result.objectCount).toBeGreaterThanOrEqual(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("remote ref updates", () => {
    /**
     * Set up a client with two branches pointing at two DIFFERENT commits, so a
     * source/destination mix-up (or a single memoised OID reused for every ref)
     * cannot pass. Destinations are deliberately named differently from sources.
     */
    async function createTwoBranchClient(workingCopy: WorkingCopy): Promise<{
      mainCommit: string;
      topicCommit: string;
    }> {
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "first");
      const topicCommit = await addFileAndCommitWc(workingCopy, "b.txt", "b", "second");
      await workingCopy.history.refs.set("refs/heads/main", mainCommit);
      await workingCopy.history.refs.set("refs/heads/topic", topicCommit);
      expect(mainCommit).not.toBe(topicCommit);
      return { mainCommit, topicCommit };
    }

    it("should report the object id the server actually stored for each ref", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      const { mainCommit, topicCommit } = await createTwoBranchClient(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/dest-one")
          .add("refs/heads/topic:refs/heads/dest-two")
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const byRemote = new Map(result.remoteUpdates.map((u) => [u.remoteName, u]));
      expect([...byRemote.keys()].sort()).toEqual(["refs/heads/dest-one", "refs/heads/dest-two"]);

      // Each reported newObjectId must equal what the SERVER actually holds for
      // that destination ref — not merely a non-empty string.
      for (const [dest, expectedSrc, expectedOid] of [
        ["refs/heads/dest-one", "refs/heads/main", mainCommit],
        ["refs/heads/dest-two", "refs/heads/topic", topicCommit],
      ] as const) {
        const update = byRemote.get(dest);
        expect(update).toBeDefined();
        const serverOid = (await server.serverStores.refs.resolve(dest))?.objectId;
        expect(serverOid).toBe(expectedOid);
        expect(update?.newObjectId).toBe(serverOid);
        expect(update?.srcRef).toBe(expectedSrc);
        expect(update?.status).toBe(PushStatus.OK);
        expect(update?.delete).toBe(false);
      }
    });

    it("should report the pushed object id when force-pushing a +-prefixed refspec", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      const { mainCommit, topicCommit } = await createTwoBranchClient(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git
          .push()
          .setRemote(remoteUrl)
          // one already carries "+", the other gets it added by setForce
          .add("+refs/heads/main:refs/heads/forced-one")
          .add("refs/heads/topic:refs/heads/forced-two")
          .setForce(true)
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const byRemote = new Map(result.remoteUpdates.map((u) => [u.remoteName, u]));
      expect(byRemote.get("refs/heads/forced-one")?.newObjectId).toBe(mainCommit);
      expect(byRemote.get("refs/heads/forced-one")?.srcRef).toBe("refs/heads/main");
      expect(byRemote.get("refs/heads/forced-two")?.newObjectId).toBe(topicCommit);
      expect(byRemote.get("refs/heads/forced-two")?.srcRef).toBe("refs/heads/topic");
      expect(byRemote.get("refs/heads/forced-one")?.forceUpdate).toBe(true);
    });

    it("should report the pushed object id for a same-name refspec via pushAll", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      const { mainCommit, topicCommit } = await createTwoBranchClient(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git.push().setRemote(remoteUrl).setPushAll(true).call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const byRemote = new Map(result.remoteUpdates.map((u) => [u.remoteName, u]));
      expect(byRemote.get("refs/heads/main")?.newObjectId).toBe(mainCommit);
      expect(byRemote.get("refs/heads/main")?.srcRef).toBe("refs/heads/main");
      expect(byRemote.get("refs/heads/topic")?.newObjectId).toBe(topicCommit);
      expect(byRemote.get("refs/heads/topic")?.srcRef).toBe("refs/heads/topic");
    });
  });

  describe("delete refs", () => {
    it("should delete a remote ref via an empty-source refspec", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Give the server a branch to delete.
      await server.serverStores.refs.set("refs/heads/doomed", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "first");
      await workingCopy.history.refs.set("refs/heads/main", mainCommit);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git.push().setRemote(remoteUrl).add(":refs/heads/doomed").call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(result.remoteUpdates.length).toBe(1);
      const update = result.remoteUpdates[0];
      expect(update?.remoteName).toBe("refs/heads/doomed");
      expect(update?.delete).toBe(true);
      expect(update?.newObjectId).toBe("0".repeat(40));
      // There is no local ref behind a delete.
      expect(update?.srcRef).toBeUndefined();
      // The server accepted it (this status comes from its report-status line).
      expect(update?.status).toBe(PushStatus.OK);

      // ...and the ref no longer points at the commit it did before. (Whether the
      // server drops the ref or zeroes it is the server's business; either way it
      // must not still resolve to the old commit.)
      const after = await server.serverStores.refs.resolve("refs/heads/doomed");
      expect(after?.objectId).not.toBe(server.initialCommitId);
    });

    it("should mark only the delete when a delete and an update are pushed together", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      await server.serverStores.refs.set("refs/heads/doomed", server.initialCommitId);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "first");
      await workingCopy.history.refs.set("refs/heads/main", mainCommit);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/kept")
          .add(":refs/heads/doomed")
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const byRemote = new Map(result.remoteUpdates.map((u) => [u.remoteName, u]));

      const kept = byRemote.get("refs/heads/kept");
      expect(kept?.delete).toBe(false);
      expect(kept?.newObjectId).toBe(mainCommit);
      expect(kept?.srcRef).toBe("refs/heads/main");
      expect((await server.serverStores.refs.resolve("refs/heads/kept"))?.objectId).toBe(
        mainCommit,
      );

      const doomed = byRemote.get("refs/heads/doomed");
      expect(doomed?.delete).toBe(true);
      expect(doomed?.newObjectId).toBe("0".repeat(40));
      expect(doomed?.srcRef).toBeUndefined();
    });
  });

  describe("expected old object id and reject classification", () => {
    /** The remote's advertised value in the stub-server tests below. */
    const STUB_REMOTE_OID = "7".repeat(40);
    const ZERO = "0".repeat(40);

    /** Encode a single pkt-line (payload must carry its own trailing newline). */
    function pkt(payload: string): string {
      return (payload.length + 4).toString(16).padStart(4, "0") + payload;
    }

    /**
     * A stub receive-pack server that advertises refs/heads/main at a known
     * value and answers with the given status line for it. Lets a rejection
     * reason be chosen exactly, which the real test server cannot do.
     */
    function stubServerFetch(statusLine: string): typeof globalThis.fetch {
      return (async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/info/refs")) {
          const body =
            pkt("# service=git-receive-pack\n") +
            "0000" +
            pkt(`${STUB_REMOTE_OID} refs/heads/main\0report-status side-band-64k\n`) +
            "0000";
          return new Response(body, { status: 200 });
        }
        const report = `${pkt("unpack ok\n")}${pkt(statusLine)}0000`;
        return new Response(report, { status: 200 });
      }) as typeof globalThis.fetch;
    }

    async function pushMainAgainst(
      fetchImpl: typeof globalThis.fetch,
      destRef: string,
    ): Promise<Awaited<ReturnType<ReturnType<Git["push"]>["call"]>>> {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const localCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "unrelated");
      await workingCopy.history.refs.set("refs/heads/main", localCommit);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      try {
        return await git
          .push()
          .setRemote("http://localhost:3000/test.git")
          .add(`refs/heads/main:${destRef}`)
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    it("reports the remote's pre-push oid when the server refuses a non-fast-forward", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // A commit with no ancestry in common with the server's history: pushing
      // it onto the server's existing branch is not a fast-forward.
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const localCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "unrelated");
      await workingCopy.history.refs.set("refs/heads/main", localCommit);
      expect(localCommit).not.toBe(server.initialCommitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/main")
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const update = result.remoteUpdates.find((u) => u.remoteName === "refs/heads/main");
      // The remote's REAL pre-push value — not the zero id a missing wire-up
      // would be indistinguishable from.
      expect(update?.expectedOldObjectId).toBe(server.initialCommitId);
      expect(update?.expectedOldObjectId).not.toBe(ZERO);
      expect(update?.status).toBe(PushStatus.REJECTED_NONFASTFORWARD);
      // The server kept its own commit.
      expect((await server.serverStores.refs.resolve("refs/heads/main"))?.objectId).toBe(
        server.initialCommitId,
      );
    });

    it("reports the zero id as the expected old value when creating a ref on the remote", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
      const localCommit = await addFileAndCommitWc(workingCopy, "a.txt", "a", "first");
      await workingCopy.history.refs.set("refs/heads/main", localCommit);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      let result: Awaited<ReturnType<ReturnType<typeof git.push>["call"]>>;
      try {
        result = await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/brand-new")
          .call();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const update = result.remoteUpdates.find((u) => u.remoteName === "refs/heads/brand-new");
      expect(update?.status).toBe(PushStatus.OK);
      // Defined and zero — the remote had no such ref — rather than absent.
      expect(update?.expectedOldObjectId).toBe(ZERO);
    });

    it("classifies a non-fast-forward rejection as REJECTED_NONFASTFORWARD", async () => {
      const result = await pushMainAgainst(
        stubServerFetch("ng refs/heads/main non-fast-forward\n"),
        "refs/heads/main",
      );

      const update = result.remoteUpdates.find((u) => u.remoteName === "refs/heads/main");
      expect(update?.status).toBe(PushStatus.REJECTED_NONFASTFORWARD);
      expect(update?.message).toBe("non-fast-forward");
      expect(update?.expectedOldObjectId).toBe(STUB_REMOTE_OID);
    });

    it("classifies any other rejection as REJECTED_OTHER", async () => {
      const result = await pushMainAgainst(
        stubServerFetch("ng refs/heads/main pre-receive hook declined\n"),
        "refs/heads/main",
      );

      const update = result.remoteUpdates.find((u) => u.remoteName === "refs/heads/main");
      expect(update?.status).toBe(PushStatus.REJECTED_OTHER);
      expect(update?.message).toBe("pre-receive hook declined");
      expect(update?.expectedOldObjectId).toBe(STUB_REMOTE_OID);
    });

    it("classifies a locking failure as REJECTED_OTHER, not as a non-fast-forward", async () => {
      const result = await pushMainAgainst(
        stubServerFetch("ng refs/heads/main failed to lock\n"),
        "refs/heads/main",
      );

      const update = result.remoteUpdates.find((u) => u.remoteName === "refs/heads/main");
      expect(update?.status).toBe(PushStatus.REJECTED_OTHER);
    });
  });

  describe("callOrThrow", () => {
    it("should not throw for successful push", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // Should not throw
        await git
          .push()
          .setRemote(remoteUrl)
          .add("refs/heads/main:refs/heads/new-branch")
          .callOrThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("error handling", () => {
    it("should throw for invalid remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const commitId = await addFileAndCommitWc(workingCopy, "file.txt", "content", "Commit");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response("Not Found", { status: 404 });
      };

      try {
        await expect(
          git
            .push()
            .setRemote("http://invalid/repo.git")
            .add("refs/heads/main:refs/heads/main")
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
        .push()
        .setRemote("upstream")
        .setForce(true)
        .setAtomic(true)
        .setThin(false)
        .setDryRun(true);

      expect(command.getRemote()).toBe("upstream");
      expect(command.isForce()).toBe(true);
      expect(command.isAtomic()).toBe(true);
      expect(command.isThin()).toBe(false);
      expect(command.isDryRun()).toBe(true);
    });
  });

  /**
   * JGit-ported tests: Extended options
   */
  describe("extended options (JGit parity)", () => {
    /**
     * JGit: PushCommand.setUseBitmaps()
     */
    it("should support useBitmaps option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.push().setRemote("origin").setUseBitmaps(false);

      expect(command.isUseBitmaps()).toBe(false);
    });

    it("should default useBitmaps to true", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.push().setRemote("origin");

      expect(command.isUseBitmaps()).toBe(true);
    });

    /**
     * JGit: PushCommand.setPushOptions()
     */
    it("should support push options", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .push()
        .setRemote("origin")
        .setPushOptions(["ci.skip", "merge_request.create"]);

      expect(command.getPushOptions()).toEqual(["ci.skip", "merge_request.create"]);
    });

    /**
     * JGit: PushCommand.setReceivePack()
     */
    it("should support receive-pack option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.push().setRemote("origin").setReceivePack("/opt/git/receive-pack");

      expect(command.getReceivePack()).toBe("/opt/git/receive-pack");
    });

    it("should return all extended getter values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .push()
        .setRemote("upstream")
        .setForce(true)
        .setAtomic(true)
        .setThin(false)
        .setDryRun(true)
        .setUseBitmaps(false)
        .setPushOptions(["option1", "option2"])
        .setReceivePack("/custom/receive-pack");

      expect(command.getRemote()).toBe("upstream");
      expect(command.isForce()).toBe(true);
      expect(command.isAtomic()).toBe(true);
      expect(command.isThin()).toBe(false);
      expect(command.isDryRun()).toBe(true);
      expect(command.isUseBitmaps()).toBe(false);
      expect(command.getPushOptions()).toEqual(["option1", "option2"]);
      expect(command.getReceivePack()).toBe("/custom/receive-pack");
    });
  });
});
