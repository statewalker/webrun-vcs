/**
 * Tests for PullCommand
 *
 * Based on JGit's PullCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 *
 * Note: PullCommand builds refspecs using the remote name, which doesn't work
 * well with URLs directly. These tests focus on the command's configuration
 * and error handling rather than full integration testing.
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, MergeStatus, TagOption } from "../src/index.js";
import { backends, testAuthor } from "./test-helper.js";
import { addFileAndCommit, createTestServer, createTestUrl } from "./transport-test-helper.js";

describe.each(backends)("PullCommand ($name backend)", ({ factory }) => {
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
  describe("pull over the network", () => {
    /**
     * The clearest proof that fetch must store the objects it fetches:
     * PullCommand hands the freshly fetched tip to MergeCommand, which can
     * only fast-forward onto a commit that exists locally.
     *
     * This drives that fetch -> resolve tracking ref -> merge sequence
     * directly rather than through `PullCommand.call()`, because
     * `PullCommand` cannot yet be driven over the network at all: it builds
     * its refspec destination as `refs/remotes/<remote>/<branch>`, and
     * `resolveRemoteUrl()` has no remote-name -> URL config lookup, so
     * `<remote>` must be a URL — whose `//` the refspec parser rejects
     * ("Invalid refspec: source cannot contain //"). Point this test at
     * `git.pull()` once named remotes resolve to URLs.
     */
    it("should fast-forward onto a commit fetched from the remote", async () => {
      // Local repo: HEAD -> refs/heads/main -> base commit
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { workingCopy, repository } = ctx;
      const git = Git.fromWorkingCopy(workingCopy);

      const emptyTreeId = await repository.trees.store([]);
      const baseCommit = {
        tree: emptyTreeId,
        parents: [] as string[],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Base commit",
      };
      const baseId = await repository.commits.store(baseCommit);
      await repository.refs.set("refs/heads/main", baseId);
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, emptyTreeId);

      // Remote: the same base commit (object stores are content-addressed, so
      // storing identical bytes yields the same id), plus one commit on top.
      const server = createTestServer();
      await server.serverStores.trees.store([]);
      const serverBaseId = await server.serverStores.commits.store(baseCommit);
      expect(serverBaseId).toBe(baseId);
      await server.serverStores.refs.set("refs/heads/main", baseId);
      await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/main");

      const remoteUrl = createTestUrl(server.baseUrl);
      const remoteTip = await addFileAndCommit(
        server.serverStores,
        "two.txt",
        "second content",
        "Add two.txt",
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        // What PullCommand.call() does: fetch, resolve the tracking ref,
        // then merge that oid.
        await git
          .fetch()
          .setRemote(remoteUrl)
          .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
          .call();

        const tracking = await repository.refs.resolve("refs/remotes/origin/main");
        expect(tracking?.objectId).toBe(remoteTip);
        if (!tracking?.objectId) return;

        const mergeResult = await git.merge().include(tracking.objectId).call();
        expect(mergeResult.status).toBe(MergeStatus.FAST_FORWARD);

        // HEAD moved to the remote tip...
        const head = await repository.refs.resolve("HEAD");
        expect(head?.objectId).toBe(remoteTip);

        // ...and that commit, with its tree and blob, really is here
        const merged = await repository.commits.load(remoteTip);
        expect(merged).toBeDefined();
        if (!merged) return;
        expect(merged.message).toBe("Add two.txt");
        expect(merged.parents).toContain(baseId);

        const entry = await repository.trees.getEntry(merged.tree, "two.txt");
        expect(entry).toBeDefined();
        if (!entry) return;
        expect(await repository.blobs.has(entry.id)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("options", () => {
    it("should default remote to origin", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull();
      expect(command.getRemote()).toBe("origin");
    });

    it("should set remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setRemote("upstream");
      expect(command.getRemote()).toBe("upstream");
    });

    it("should set remote branch name", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setRemoteBranchName("develop");
      expect(command.getRemoteBranchName()).toBe("develop");
    });

    it("should set rebase mode", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setRebase(true);
      expect(command.isRebase()).toBe(true);
    });

    it("should support setting merge strategy", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setStrategy("recursive");
      expect(command).toBeDefined();
    });

    it("should support fast-forward mode", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setFastForwardMode("ff-only");
      expect(command).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should throw for detached HEAD", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Set up detached HEAD by pointing directly to a commit
      await workingCopy.history.refs.set("HEAD", `${"abc".repeat(13)}a`);

      // Pull requires a branch, not a detached HEAD
      await expect(git.pull().call()).rejects.toThrow("Cannot pull with detached HEAD");
    });

    it("should throw for missing HEAD", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Don't set up HEAD at all
      await expect(git.pull().call()).rejects.toThrow();
    });
  });

  describe("options getters", () => {
    it("should return correct values for all getters", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .pull()
        .setRemote("upstream")
        .setRemoteBranchName("develop")
        .setRebase(true);

      expect(command.getRemote()).toBe("upstream");
      expect(command.getRemoteBranchName()).toBe("develop");
      expect(command.isRebase()).toBe(true);
    });

    it("should return undefined for unset remote branch name", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull();
      expect(command.getRemoteBranchName()).toBeUndefined();
    });

    it("should default rebase to false", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull();
      expect(command.isRebase()).toBe(false);
    });
  });

  describe("method chaining", () => {
    it("should support fluent API", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .pull()
        .setRemote("upstream")
        .setRemoteBranchName("develop")
        .setRebase(false)
        .setStrategy("recursive")
        .setFastForwardMode("ff");

      expect(command.getRemote()).toBe("upstream");
      expect(command.getRemoteBranchName()).toBe("develop");
    });
  });

  /**
   * JGit-ported tests: Extended options
   */
  describe("extended options (JGit parity)", () => {
    /**
     * JGit: PullCommand.setTagOpt()
     */
    it("should support tag option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setTagOpt(TagOption.FETCH_TAGS);

      expect(command.getTagOpt()).toBe(TagOption.FETCH_TAGS);
    });

    it("should default tag option to undefined", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull();

      expect(command.getTagOpt()).toBeUndefined();
    });

    /**
     * JGit: PullCommand.setFastForward()
     */
    it("should support fast-forward mode getter", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.pull().setFastForwardMode("ff-only");

      expect(command.getFastForwardMode()).toBe("ff-only");
    });

    it("should return all extended getter values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .pull()
        .setRemote("upstream")
        .setRemoteBranchName("feature")
        .setRebase(true)
        .setFastForwardMode("ff")
        .setTagOpt(TagOption.NO_TAGS);

      expect(command.getRemote()).toBe("upstream");
      expect(command.getRemoteBranchName()).toBe("feature");
      expect(command.isRebase()).toBe(true);
      expect(command.getFastForwardMode()).toBe("ff");
      expect(command.getTagOpt()).toBe(TagOption.NO_TAGS);
    });
  });
});
