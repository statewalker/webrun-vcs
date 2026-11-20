/**
 * An in-memory `git init` rooted at a directory (`setDirectory`) or with a git directory of
 * its own name (`setGitDir("meta")`): the worktree is that directory, the git directory is
 * not part of what the worktree holds, and a clone into the fresh repository is accepted
 * (clone.c checks the destination before it makes a repository there).
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

async function cloneInto(git: Git) {
  const server = await createInitializedTestServer();
  await addFileAndCommit(server.serverStores, "file.txt", "content\n", "Second commit");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.mockFetch;
  try {
    return await git.clone().setURI(createTestUrl(server.baseUrl)).call();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("InitCommand rooting and a clone into a fresh repository", () => {
  it("setDirectory roots the worktree at that directory", async () => {
    const files = createInMemoryFilesApi();
    const { git, workingCopy, gitDir } = await Git.init()
      .setFilesApi(files)
      .setDirectory("project")
      .setWorktree(true)
      .call();
    expect(gitDir).toBe("project/.git");
    expect(workingCopy.worktree.getRoot()).toBe("project");
    await workingCopy.worktree.writeContent("a.txt", new TextEncoder().encode("a\n"));
    expect((await files.stats("project/a.txt"))?.kind).toBe("file");
    await git.add().addFilepattern("a.txt").call();
    const status = await git.status().call();
    expect([...status.added]).toEqual(["a.txt"]);
  });

  it("setDirectory without a FilesApi (in memory) accepts a clone", async () => {
    const { git, workingCopy } = await Git.init().setDirectory("dest").setWorktree(true).call();
    const result = await cloneInto(git);
    expect(result.fetchResult.trackingRefUpdates.length).toBeGreaterThan(0);
    const listed: string[] = [];
    for await (const entry of workingCopy.worktree.walk()) listed.push(entry.path);
    expect(listed).toEqual(["file.txt"]);
  });

  it("setDirectory with a FilesApi accepts a clone", async () => {
    const files = createInMemoryFilesApi();
    const { git } = await Git.init()
      .setFilesApi(files)
      .setDirectory("dest")
      .setWorktree(true)
      .call();
    const result = await cloneInto(git);
    expect(result.fetchResult.trackingRefUpdates.length).toBeGreaterThan(0);
    expect((await files.stats("dest/.git/HEAD"))?.kind).toBe("file");
    expect((await files.stats("dest/file.txt"))?.kind).toBe("file");
  });

  it('setGitDir("meta") with a worktree works and accepts a clone', async () => {
    const files = createInMemoryFilesApi();
    const { git, workingCopy, gitDir } = await Git.init()
      .setFilesApi(files)
      .setGitDir("meta")
      .setWorktree(true)
      .call();
    expect(gitDir).toBe("meta");
    expect(workingCopy.worktree.getRoot()).toBe("");
    expect((await files.stats("meta/HEAD"))?.kind).toBe("file");
    const result = await cloneInto(git);
    expect(result.fetchResult.trackingRefUpdates.length).toBeGreaterThan(0);
    expect((await files.stats("file.txt"))?.kind).toBe("file");
  });

  it("a destination holding files is still refused", async () => {
    const files = createInMemoryFilesApi();
    const { git, workingCopy } = await Git.init()
      .setFilesApi(files)
      .setGitDir("meta")
      .setWorktree(true)
      .call();
    await workingCopy.worktree.writeContent("mine.txt", new TextEncoder().encode("x\n"));
    await expect(cloneInto(git)).rejects.toThrow(/already exists and is not an empty directory/);
  });
});
