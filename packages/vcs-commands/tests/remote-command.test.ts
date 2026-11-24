/**
 * Tests for Remote* commands (RemoteAddCommand, RemoteRemoveCommand,
 * RemoteListCommand, RemoteSetUrlCommand)
 *
 * Based on JGit's RemoteConfigTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { backends } from "./test-helper.js";

describe.each(backends)("RemoteAddCommand ($name backend)", ({ factory }) => {
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
    it("should add a remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const result = await git
        .remoteAdd()
        .setName("origin")
        .setUri("https://github.com/user/repo")
        .call();

      expect(result.name).toBe("origin");
      expect(result.urls).toContain("https://github.com/user/repo");
      expect(result.fetchRefspecs).toContain("+refs/heads/*:refs/remotes/origin/*");
    });

    it("should use custom fetch refspec", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const result = await git
        .remoteAdd()
        .setName("upstream")
        .setUri("https://github.com/other/repo")
        .setFetchRefspec("+refs/heads/main:refs/remotes/upstream/main")
        .call();

      expect(result.fetchRefspecs).toContain("+refs/heads/main:refs/remotes/upstream/main");
    });

    it("should throw for duplicate remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Add first remote
      await git.remoteAdd().setName("origin").setUri("https://github.com/user/repo").call();

      // The config section written by the add above makes the remote exist (git's
      // remote_is_configured); tracking refs alone would not.

      // Try to add duplicate
      await expect(
        git.remoteAdd().setName("origin").setUri("https://github.com/other/repo").call(),
      ).rejects.toThrow("error: remote origin already exists.");
    });

    it("should throw for missing name", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.remoteAdd().setUri("https://github.com/user/repo").call()).rejects.toThrow(
        "Remote name must be specified",
      );
    });

    it("should throw for missing URI", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.remoteAdd().setName("origin").call()).rejects.toThrow(
        "Remote URI must be specified",
      );
    });

    it("refuses a name git's valid_remote_name refuses, writing nothing", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      for (const name of ["a b", "x\ny", "bad..name"]) {
        await expect(git.remoteAdd().setName(name).setUri("https://h/r").call()).rejects.toThrow(
          `'${name}' is not a valid remote name`,
        );
      }
      expect(await git.remoteList().call()).toEqual([]);
    });
  });

  describe("getters", () => {
    it("should return correct values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.remoteAdd().setName("origin").setUri("https://github.com/user/repo");

      expect(command.getName()).toBe("origin");
      expect(command.getUri()).toBe("https://github.com/user/repo");
    });
  });
});

describe.each(backends)("RemoteRemoveCommand ($name backend)", ({ factory }) => {
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
    it("should remove a remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // A configured remote with remote tracking refs (git refuses a remote without config)
      await git.remoteAdd().setName("origin").setUri("https://github.com/user/repo").call();
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));
      await workingCopy.history.refs.set("refs/remotes/origin/feature", "b".repeat(40));

      const result = await Git.fromWorkingCopy(workingCopy)
        .remoteRemove()
        .setRemoteName("origin")
        .call();

      expect(result).toBeDefined();
      expect(result?.name).toBe("origin");

      // Refs should be deleted
      const mainRef = await workingCopy.history.refs.get("refs/remotes/origin/main");
      const featureRef = await workingCopy.history.refs.get("refs/remotes/origin/feature");
      expect(mainRef).toBeUndefined();
      expect(featureRef).toBeUndefined();
    });

    it("should throw git's error for a non-existent remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.remoteRemove().setRemoteName("nonexistent").call()).rejects.toThrow(
        "No such remote: 'nonexistent'",
      );
    });

    it("refuses a remote known only from its tracking refs, deleting nothing (as git)", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));

      await expect(git.remoteRemove().setRemoteName("origin").call()).rejects.toThrow(
        "No such remote: 'origin'",
      );
      expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(
        "a".repeat(40),
      );
    });

    it("should throw for missing name", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.remoteRemove().call()).rejects.toThrow("Remote name must be specified");
    });
  });

  describe("getters", () => {
    it("should return correct values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.remoteRemove().setRemoteName("origin");
      expect(command.getRemoteName()).toBe("origin");
    });
  });
});

describe.each(backends)("RemoteListCommand ($name backend)", ({ factory }) => {
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
    it("should list remotes", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Create remote tracking refs for multiple remotes
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));
      await workingCopy.history.refs.set("refs/remotes/upstream/main", "b".repeat(40));

      const result = await git.remoteList().call();

      expect(result.length).toBe(2);
      expect(result.map((r) => r.name)).toContain("origin");
      expect(result.map((r) => r.name)).toContain("upstream");
    });

    it("should return empty array when no remotes", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const result = await git.remoteList().call();

      expect(result).toEqual([]);
    });

    it("should include default fetch refspec", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));

      const result = await git.remoteList().call();

      expect(result.length).toBe(1);
      expect(result[0].fetchRefspecs).toContain("+refs/heads/*:refs/remotes/origin/*");
    });
  });
});

describe.each(backends)("RemoteSetUrlCommand ($name backend)", ({ factory }) => {
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
    it("should set URL for existing remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // A configured remote (tracking refs alone are none to git's set-url)
      await git.remoteAdd().setName("origin").setUri("https://github.com/old/repo").call();

      const result = await git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("https://github.com/new/repo")
        .call();

      expect(result.name).toBe("origin");
      expect(result.urls).toContain("https://github.com/new/repo");
    });

    it("should set push URL", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // A configured remote (tracking refs alone are none to git's set-url)
      await git.remoteAdd().setName("origin").setUri("https://github.com/old/repo").call();

      const result = await git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("git@github.com:user/repo.git")
        .setPush(true)
        .call();

      expect(result.name).toBe("origin");
      expect(result.pushUrls).toContain("git@github.com:user/repo.git");
    });

    it("should throw for non-existent remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(
        git
          .remoteSetUrl()
          .setRemoteName("nonexistent")
          .setRemoteUri("https://github.com/user/repo")
          .call(),
      ).rejects.toThrow("error: No such remote 'nonexistent'");
    });

    it("should throw for missing name", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(
        git.remoteSetUrl().setRemoteUri("https://github.com/user/repo").call(),
      ).rejects.toThrow("Remote name must be specified");
    });

    it("should throw for missing URI", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.remoteSetUrl().setRemoteName("origin").call()).rejects.toThrow(
        "Remote URI must be specified",
      );
    });
  });

  describe("getters", () => {
    it("should return correct values", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("https://github.com/user/repo")
        .setPush(true);

      expect(command.getRemoteName()).toBe("origin");
      expect(command.getRemoteUri()).toBe("https://github.com/user/repo");
      expect(command.isPush()).toBe(true);
    });
  });

  describe("setOldUri", () => {
    it("should accept old URI parameter", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      // Just verify the method exists and is chainable
      const command = git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("https://github.com/new/repo")
        .setOldUri("https://github.com/old/repo");

      expect(command).toBeDefined();
    });
  });
});
