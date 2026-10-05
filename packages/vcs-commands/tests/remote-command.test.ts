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

      // A tracking ref too: either half — the config section written by the
      // add above, or a ref under refs/remotes/origin/ — makes the remote
      // exist. (See remote-config-persistence.test.ts for the config-only
      // case, which this working copy's plain `{}` config cannot outlive.)
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));

      // Try to add duplicate
      await expect(
        git.remoteAdd().setName("origin").setUri("https://github.com/other/repo").call(),
      ).rejects.toThrow("Remote 'origin' already exists");
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

      // Create remote tracking refs
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));
      await workingCopy.history.refs.set("refs/remotes/origin/feature", "b".repeat(40));

      const result = await git.remoteRemove().setRemoteName("origin").call();

      expect(result).toBeDefined();
      expect(result?.name).toBe("origin");

      // Refs should be deleted
      const mainRef = await workingCopy.history.refs.get("refs/remotes/origin/main");
      const featureRef = await workingCopy.history.refs.get("refs/remotes/origin/feature");
      expect(mainRef).toBeUndefined();
      expect(featureRef).toBeUndefined();
    });

    it("should return undefined for non-existent remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const result = await git.remoteRemove().setRemoteName("nonexistent").call();

      expect(result).toBeUndefined();
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

      // Create remote tracking refs
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));

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

      // Create remote tracking refs
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));

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
      ).rejects.toThrow("Remote 'nonexistent' does not exist");
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
