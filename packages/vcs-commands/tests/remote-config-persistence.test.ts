/**
 * Persistence tests for the Remote* commands.
 *
 * `remote-command.test.ts` covers the in-memory shape of the results. These
 * tests cover the thing that makes a remote a remote: it survives. Every
 * assertion here goes through a *second* config instance built over the same
 * bytes, so a command that merely returns a well-formed object without writing
 * anything cannot pass.
 *
 * The infrastructure is `GitWorkingCopyConfig` (packages/vcs-store-files), which
 * reads and writes the real `.git/config` format; the last test proves native
 * `git` agrees with what these commands write.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { History } from "@statewalker/vcs-core";
import { GitWorkingCopyConfig } from "@statewalker/vcs-store-files";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { backends, memoryFactory, testAuthor } from "./test-helper.js";
import {
  addFileAndCommit,
  addFileAndCommitWc,
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

const exec = promisify(execFile);

const CONFIG_PATH = "/repo/.git/config";

/**
 * The two-method file API `GitWorkingCopyConfig` needs, over a Map.
 *
 * Holding the bytes rather than the object is the whole point: a fresh
 * `GitWorkingCopyConfig` over the same `MemoryConfigFiles` is a genuinely
 * reloaded config, exactly as reopening the repository would be.
 */
class MemoryConfigFiles {
  readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path);
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  /** The config file as text, for asserting on the git format itself. */
  text(path = CONFIG_PATH): string {
    const content = this.files.get(path);
    return content ? new TextDecoder().decode(content) : "";
  }
}

/** Same API over the real filesystem, for the native-git interop test. */
class NodeConfigFiles {
  async read(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return undefined;
    }
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

async function openConfig(files: MemoryConfigFiles): Promise<GitWorkingCopyConfig> {
  const config = new GitWorkingCopyConfig(files, CONFIG_PATH);
  await config.load();
  return config;
}

describe.each(backends)("Remote config persistence ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  /**
   * Open a working copy over `files`, sharing `repository` when given so that
   * "reopen the repository" keeps the refs and only rebuilds the config.
   */
  async function open(
    files: MemoryConfigFiles,
  ): Promise<{ git: Git; workingCopy: WorkingCopy; repository: History }> {
    const ctx = await factory({ config: await openConfig(files) });
    const previous = cleanup;
    cleanup = async () => {
      await ctx.cleanup?.();
      await previous?.();
    };
    return {
      git: Git.fromWorkingCopy(ctx.workingCopy),
      workingCopy: ctx.workingCopy,
      repository: ctx.repository,
    };
  }

  describe("RemoteAddCommand", () => {
    it("persists name, URL and fetch refspec so a reopened repository sees them", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/origin.git").call();
      // A second remote, with a name that differs only in case from nothing
      // else here and a non-default refspec: a `set()` that ignored its
      // arguments, or a store keyed by anything but the exact name, shows up.
      await first.git
        .remoteAdd()
        .setName("Upstream")
        .setUri("git@example.com:upstream.git")
        .setFetchRefspec("+refs/heads/main:refs/remotes/Upstream/main")
        .call();

      // Drop every in-memory instance; keep only the bytes.
      const reopened = await open(files);
      const remotes = await reopened.git.remoteList().call();
      const byName = new Map(remotes.map((remote) => [remote.name, remote]));

      expect([...byName.keys()].sort()).toEqual(["Upstream", "origin"]);
      expect(byName.get("origin")?.urls).toEqual(["https://example.com/origin.git"]);
      expect(byName.get("origin")?.fetchRefspecs).toEqual(["+refs/heads/*:refs/remotes/origin/*"]);
      expect(byName.get("Upstream")?.urls).toEqual(["git@example.com:upstream.git"]);
      expect(byName.get("Upstream")?.fetchRefspecs).toEqual([
        "+refs/heads/main:refs/remotes/Upstream/main",
      ]);
    });

    it("writes the canonical git config layout", async () => {
      const files = new MemoryConfigFiles();
      const { git } = await open(files);

      await git.remoteAdd().setName("origin").setUri("https://example.com/origin.git").call();

      expect(files.text()).toBe(
        [
          '[remote "origin"]',
          "\turl = https://example.com/origin.git",
          "\tfetch = +refs/heads/*:refs/remotes/origin/*",
          "",
        ].join("\n"),
      );
    });

    it("rejects a duplicate known only from config, with no tracking refs", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();

      const reopened = await open(files);
      await expect(
        reopened.git.remoteAdd().setName("origin").setUri("https://example.com/b.git").call(),
      ).rejects.toThrow("Remote 'origin' already exists");

      // ...and the rejected URL was not written.
      const config = await openConfig(files);
      expect(config.getAll("remote.origin.url")).toEqual(["https://example.com/a.git"]);
    });

    it("rejects a duplicate known only from tracking refs, with no config", async () => {
      const files = new MemoryConfigFiles();
      const { git, workingCopy } = await open(files);

      // `mirror` was never added: it exists only because something fetched
      // into its tracking refs. `remoteList` reports it, so `remoteAdd` must
      // agree that it is already there. (Native git checks config only and
      // would allow this; we keep the two halves of discovery consistent.)
      await workingCopy.history.refs.set("refs/remotes/mirror/main", "a".repeat(40));
      expect((await openConfig(files)).subsections("remote")).toEqual([]);

      await expect(
        git.remoteAdd().setName("mirror").setUri("https://example.com/mirror.git").call(),
      ).rejects.toThrow("Remote 'mirror' already exists");
    });
  });

  describe("RemoteListCommand", () => {
    it("unions configured remotes with those known only from tracking refs", async () => {
      const files = new MemoryConfigFiles();
      const { git, workingCopy } = await open(files);

      await git.remoteAdd().setName("origin").setUri("https://example.com/origin.git").call();
      // `mirror` exists only as tracking refs — never added, never configured.
      await workingCopy.history.refs.set("refs/remotes/mirror/main", "a".repeat(40));

      const remotes = await git.remoteList().call();
      const byName = new Map(remotes.map((remote) => [remote.name, remote]));

      expect([...byName.keys()].sort()).toEqual(["mirror", "origin"]);
      expect(byName.get("origin")?.urls).toEqual(["https://example.com/origin.git"]);
      expect(byName.get("mirror")?.urls).toEqual([]);
      expect(byName.get("mirror")?.fetchRefspecs).toEqual(["+refs/heads/*:refs/remotes/mirror/*"]);
    });

    it("reports every URL and refspec of a multi-valued remote", async () => {
      const files = new MemoryConfigFiles();

      const config = await openConfig(files);
      config.add("remote.origin.url", "https://example.com/one.git");
      config.add("remote.origin.url", "https://example.com/two.git");
      config.add("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      config.add("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
      config.set("remote.origin.pushurl", "git@example.com:one.git");
      config.set("remote.origin.push", "refs/heads/main:refs/heads/main");
      await config.save();

      const { git } = await open(files);
      const [origin] = await git.remoteList().call();

      expect(origin.urls).toEqual(["https://example.com/one.git", "https://example.com/two.git"]);
      expect(origin.fetchRefspecs).toEqual([
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]);
      expect(origin.pushUrls).toEqual(["git@example.com:one.git"]);
      expect(origin.pushRefspecs).toEqual(["refs/heads/main:refs/heads/main"]);
    });
  });

  describe("RemoteRemoveCommand", () => {
    it("removes a remote that has config but no tracking refs", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();

      const reopened = await open(files);
      const removed = await reopened.git.remoteRemove().setRemoteName("origin").call();

      expect(removed?.name).toBe("origin");
      expect(removed?.urls).toEqual(["https://example.com/a.git"]);

      const config = await openConfig(files);
      expect(config.subsections("remote")).toEqual([]);
      expect(await (await open(files)).git.remoteList().call()).toEqual([]);
    });

    it("removes only the named remote", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();
      await first.git.remoteAdd().setName("upstream").setUri("https://example.com/b.git").call();

      const reopened = await open(files);
      await reopened.git.remoteRemove().setRemoteName("origin").call();

      const remotes = await (await open(files)).git.remoteList().call();
      expect(remotes.map((remote) => remote.name)).toEqual(["upstream"]);
      expect(remotes[0].urls).toEqual(["https://example.com/b.git"]);
    });

    it("removes config and tracking refs together", async () => {
      const files = new MemoryConfigFiles();
      const { git, workingCopy } = await open(files);

      await git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();
      await workingCopy.history.refs.set("refs/remotes/origin/main", "a".repeat(40));
      // Both halves are really there before the removal, so the assertions
      // below cannot pass by the config having been empty all along.
      expect((await openConfig(files)).subsections("remote")).toEqual(["origin"]);

      await git.remoteRemove().setRemoteName("origin").call();

      expect(await workingCopy.history.refs.get("refs/remotes/origin/main")).toBeUndefined();
      const config = await openConfig(files);
      expect(config.subsections("remote")).toEqual([]);
      expect(config.getAll("remote.origin.url")).toEqual([]);
    });
  });

  describe("RemoteSetUrlCommand", () => {
    it("persists a replaced fetch URL", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/old.git").call();

      const second = await open(files);
      await second.git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("https://example.com/new.git")
        .call();

      const config = await openConfig(files);
      expect(config.getAll("remote.origin.url")).toEqual(["https://example.com/new.git"]);
      // The refspec written by `remote add` survives a set-url.
      expect(config.getAll("remote.origin.fetch")).toEqual(["+refs/heads/*:refs/remotes/origin/*"]);
    });

    it("persists a push URL without disturbing the fetch URL", async () => {
      const files = new MemoryConfigFiles();

      const first = await open(files);
      await first.git.remoteAdd().setName("origin").setUri("https://example.com/fetch.git").call();

      const second = await open(files);
      await second.git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("git@example.com:push.git")
        .setPush(true)
        .call();

      const config = await openConfig(files);
      expect(config.getAll("remote.origin.pushurl")).toEqual(["git@example.com:push.git"]);
      expect(config.getAll("remote.origin.url")).toEqual(["https://example.com/fetch.git"]);
    });

    it("configures a remote that was known only from tracking refs", async () => {
      const files = new MemoryConfigFiles();
      const { git, workingCopy } = await open(files);

      await workingCopy.history.refs.set("refs/remotes/mirror/main", "a".repeat(40));

      const result = await git
        .remoteSetUrl()
        .setRemoteName("mirror")
        .setRemoteUri("https://example.com/mirror.git")
        .call();

      expect(result.urls).toEqual(["https://example.com/mirror.git"]);
      const config = await openConfig(files);
      expect(config.getAll("remote.mirror.url")).toEqual(["https://example.com/mirror.git"]);
    });

    it("replaces only the URL given to setOldUri", async () => {
      const files = new MemoryConfigFiles();

      const config = await openConfig(files);
      config.add("remote.origin.url", "https://example.com/one.git");
      config.add("remote.origin.url", "https://example.com/two.git");
      await config.save();

      const { git } = await open(files);
      await git
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri("https://example.com/replaced.git")
        .setOldUri("https://example.com/one.git")
        .call();

      expect((await openConfig(files)).getAll("remote.origin.url")).toEqual([
        "https://example.com/replaced.git",
        "https://example.com/two.git",
      ]);
    });
  });

  describe("named remotes over the network", () => {
    it("fetches from a remote named in config", async () => {
      const files = new MemoryConfigFiles();
      const server = createTestServer();
      await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/main");
      const remoteTip = await addFileAndCommit(
        server.serverStores,
        "one.txt",
        "first content",
        "Add one.txt",
      );
      await server.serverStores.refs.set("refs/heads/main", remoteTip);

      const { git, repository } = await open(files);
      await git.remoteAdd().setName("origin").setUri(createTestUrl(server.baseUrl)).call();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;
      try {
        // The remote NAME, not a URL: this is exactly what used to fail with
        // "Invalid refspec: source cannot contain //". No refspecs are given
        // either — those come from `remote.origin.fetch`.
        const result = await git.fetch().setRemote("origin").call();
        expect(result.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }

      const tracking = await repository.refs.resolve("refs/remotes/origin/main");
      expect(tracking?.objectId).toBe(remoteTip);
    });

    it("lists refs of a remote named in config", async () => {
      const files = new MemoryConfigFiles();
      const server = createTestServer();
      await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/main");
      const remoteTip = await addFileAndCommit(
        server.serverStores,
        "one.txt",
        "first content",
        "Add one.txt",
      );
      await server.serverStores.refs.set("refs/heads/main", remoteTip);

      const remoteUrl = createTestUrl(server.baseUrl);
      const { git } = await open(files);
      await git.remoteAdd().setName("origin").setUri(remoteUrl).call();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;
      try {
        const result = await git.lsRemote().setRemote("origin").call();
        // The reported URI is the resolved one, not the name it was given.
        expect(result.uri).toBe(remoteUrl);
        expect(result.refs.map((ref) => ref.name)).toContain("refs/heads/main");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("pushes to a remote named in config", async () => {
      const files = new MemoryConfigFiles();
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const { git, workingCopy } = await open(files);
      const commitId = await addFileAndCommitWc(
        workingCopy,
        "client.txt",
        "client content",
        "Client commit",
      );
      await workingCopy.history.refs.set("HEAD", "refs/heads/main");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      await git.remoteAdd().setName("origin").setUri(remoteUrl).call();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;
      try {
        const result = await git
          .push()
          .setRemote("origin")
          .add("refs/heads/main:refs/heads/pushed")
          .call();
        expect(result.uri).toBe(remoteUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect((await server.serverStores.refs.resolve("refs/heads/pushed"))?.objectId).toBe(
        commitId,
      );
    });

    it("pushes to pushurl in preference to url", async () => {
      const files = new MemoryConfigFiles();
      const server = await createInitializedTestServer();
      const pushUrl = createTestUrl(server.baseUrl);

      const { git, workingCopy } = await open(files);
      const commitId = await addFileAndCommitWc(
        workingCopy,
        "client.txt",
        "client content",
        "Client commit",
      );
      await workingCopy.history.refs.set("HEAD", "refs/heads/main");
      await workingCopy.history.refs.set("refs/heads/main", commitId);

      // The fetch URL points nowhere: only preferring `pushurl` can work.
      await git.remoteAdd().setName("origin").setUri("http://unreachable.invalid/repo.git").call();
      await Git.fromWorkingCopy(workingCopy)
        .remoteSetUrl()
        .setRemoteName("origin")
        .setRemoteUri(pushUrl)
        .setPush(true)
        .call();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;
      try {
        const result = await Git.fromWorkingCopy(workingCopy)
          .push()
          .setRemote("origin")
          .add("refs/heads/main:refs/heads/pushed")
          .call();
        expect(result.uri).toBe(pushUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect((await server.serverStores.refs.resolve("refs/heads/pushed"))?.objectId).toBe(
        commitId,
      );
    });

    it("pulls from a remote named in config", async () => {
      const files = new MemoryConfigFiles();
      const { git, repository, workingCopy } = await open(files);

      // Local: HEAD -> refs/heads/main -> base commit.
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

      // Remote: the same base commit plus one on top.
      const server = createTestServer();
      await server.serverStores.trees.store([]);
      expect(await server.serverStores.commits.store(baseCommit)).toBe(baseId);
      await server.serverStores.refs.set("refs/heads/main", baseId);
      await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/main");
      const remoteTip = await addFileAndCommit(
        server.serverStores,
        "two.txt",
        "second content",
        "Add two.txt",
      );

      await git.remoteAdd().setName("origin").setUri(createTestUrl(server.baseUrl)).call();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;
      try {
        const result = await git.pull().call();
        expect(result.successful).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect((await repository.refs.resolve("HEAD"))?.objectId).toBe(remoteTip);
      const merged = await repository.commits.load(remoteTip);
      expect(merged?.message).toBe("Add two.txt");
    });
  });
});

/**
 * The other half of the feature detection: a working copy whose `config` is the
 * bare `{}` that `MemoryWorkingCopy` defaults to. There is no file to persist
 * to, but the remote must still be remembered for as long as the working copy
 * lives — otherwise `remoteAdd` is still a no-op for every caller that has not
 * wired up a `GitWorkingCopyConfig`.
 */
describe.each(backends)("Remote config without a config file ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createGit(): Promise<{ git: Git; workingCopy: WorkingCopy }> {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    return { git: Git.fromWorkingCopy(ctx.workingCopy), workingCopy: ctx.workingCopy };
  }

  it("remembers an added remote for the life of the working copy", async () => {
    const { git, workingCopy } = await createGit();

    await git.remoteAdd().setName("origin").setUri("https://example.com/origin.git").call();
    await git.remoteAdd().setName("upstream").setUri("https://example.com/upstream.git").call();

    // The commands above are single-use; a new Git over the same working copy
    // is the closest thing to "later" that a fileless config has.
    const remotes = await Git.fromWorkingCopy(workingCopy).remoteList().call();
    const byName = new Map(remotes.map((remote) => [remote.name, remote]));

    expect([...byName.keys()].sort()).toEqual(["origin", "upstream"]);
    expect(byName.get("origin")?.urls).toEqual(["https://example.com/origin.git"]);
    expect(byName.get("upstream")?.urls).toEqual(["https://example.com/upstream.git"]);
  });

  it("rejects a duplicate with no tracking refs in play", async () => {
    const { git, workingCopy } = await createGit();

    await git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();

    await expect(
      Git.fromWorkingCopy(workingCopy)
        .remoteAdd()
        .setName("origin")
        .setUri("https://example.com/b.git")
        .call(),
    ).rejects.toThrow("Remote 'origin' already exists");
  });

  it("removes an added remote, leaving its neighbour alone", async () => {
    const { git, workingCopy } = await createGit();

    await git.remoteAdd().setName("origin").setUri("https://example.com/a.git").call();
    await Git.fromWorkingCopy(workingCopy)
      .remoteAdd()
      .setName("upstream")
      .setUri("https://example.com/b.git")
      .call();

    const removed = await Git.fromWorkingCopy(workingCopy)
      .remoteRemove()
      .setRemoteName("origin")
      .call();
    expect(removed?.urls).toEqual(["https://example.com/a.git"]);

    const remotes = await Git.fromWorkingCopy(workingCopy).remoteList().call();
    expect(remotes.map((remote) => remote.name)).toEqual(["upstream"]);
    expect(remotes[0].urls).toEqual(["https://example.com/b.git"]);
  });

  it("resolves a named remote to its URL for fetch", async () => {
    const { git, workingCopy } = await createGit();

    const server = createTestServer();
    await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/main");
    const remoteTip = await addFileAndCommit(
      server.serverStores,
      "one.txt",
      "first content",
      "Add one.txt",
    );
    await server.serverStores.refs.set("refs/heads/main", remoteTip);

    await git.remoteAdd().setName("origin").setUri(createTestUrl(server.baseUrl)).call();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.mockFetch;
    try {
      await Git.fromWorkingCopy(workingCopy).fetch().setRemote("origin").call();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tracking = await workingCopy.history.refs.resolve("refs/remotes/origin/main");
    expect(tracking?.objectId).toBe(remoteTip);
  });
});

describe("Remote config interop with native git", () => {
  it("writes a config `git remote -v` reads back", async () => {
    const gitVersion = await exec("git", ["--version"]).catch(() => undefined);
    // No git on this machine: nothing to interoperate with.
    if (!gitVersion) return;

    const dir = await mkdtemp(join(tmpdir(), "vcs-remote-config-"));
    try {
      await exec("git", ["init", "-q", "-b", "main", dir]);

      const config = new GitWorkingCopyConfig(new NodeConfigFiles(), join(dir, ".git", "config"));
      await config.load();
      const ctx = await memoryFactory({ config });
      const git = Git.fromWorkingCopy(ctx.workingCopy);

      await git.remoteAdd().setName("origin").setUri("https://example.com/origin.git").call();

      const listed = await exec("git", ["-C", dir, "remote", "-v"]);
      expect(listed.stdout).toContain("origin\thttps://example.com/origin.git (fetch)");
      expect(listed.stdout).toContain("origin\thttps://example.com/origin.git (push)");

      const refspec = await exec("git", ["-C", dir, "config", "--get", "remote.origin.fetch"]);
      expect(refspec.stdout.trim()).toBe("+refs/heads/*:refs/remotes/origin/*");

      // `git init` writes [core]; it must still be there.
      const core = await exec("git", [
        "-C",
        dir,
        "config",
        "--get",
        "core.repositoryformatversion",
      ]);
      expect(core.stdout.trim()).toBe("0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
