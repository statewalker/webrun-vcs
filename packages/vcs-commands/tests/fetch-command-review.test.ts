/**
 * FetchCommand and CloneCommand as git (review of PR #73): no tags without a refspec
 * destination, --prune keeps refs a negative refspec protects, a missing remote ref is an
 * error, clone --branch takes a tag as a detached HEAD, clone --depth is single-branch.
 *
 * Runs against all storage backends (Memory, SQL).
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, RefUpdateStatus } from "../src/index.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

describe.each(backends)("fetch and clone as git ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
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

  it("a fetch without refspecs (the remote HEAD) or without destinations creates no tags", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    await server.serverStores.refs.set("refs/tags/v1", server.initialCommitId);
    globalThis.fetch = server.mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);

    const headOnly = await git.fetch().setRemote(url).call();
    expect(headOnly.trackingRefUpdates).toEqual([]);
    expect(await workingCopy.history.refs.get("refs/tags/v1")).toBeUndefined();
    expect(await workingCopy.history.commits.has(server.initialCommitId)).toBe(true);

    await git.fetch().setRemote(url).setRefSpecs("refs/heads/main").call();
    expect(await workingCopy.history.refs.get("refs/tags/v1")).toBeUndefined();

    await git.fetch().setRemote(url).setRefSpecs("refs/heads/main:refs/remotes/origin/main").call();
    expect(await workingCopy.history.refs.get("refs/tags/v1")).toBeDefined();
  });

  it("--prune keeps the refs a negative refspec excludes", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    await server.serverStores.refs.set("refs/heads/wip", server.initialCommitId);
    await server.serverStores.refs.set("refs/heads/old", server.initialCommitId);
    globalThis.fetch = server.mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);
    await git.fetch().setRemote(url).setRefSpecs("+refs/heads/*:refs/remotes/origin/*").call();

    await server.serverStores.refs.remove("refs/heads/wip");
    await server.serverStores.refs.remove("refs/heads/old");
    const result = await git
      .fetch()
      .setRemote(url)
      .setRefSpecs("+refs/heads/*:refs/remotes/origin/*", "^refs/heads/wip")
      .setRemoveDeletedRefs(true)
      .call();

    const deleted = result.trackingRefUpdates.filter((u) => u.status === RefUpdateStatus.DELETED);
    expect(deleted.map((u) => u.localRef)).toEqual(["refs/remotes/origin/old"]);
    expect(await workingCopy.history.refs.get("refs/remotes/origin/wip")).toBeDefined();
    expect(await workingCopy.history.refs.get("refs/remotes/origin/old")).toBeUndefined();
  });

  it("a refspec naming a ref the remote does not have is an error", async () => {
    const server = await createInitializedTestServer();
    globalThis.fetch = server.mockFetch;
    const git = Git.fromWorkingCopy(await createTestWorkingCopy());
    await expect(
      git
        .fetch()
        .setRemote(createTestUrl(server.baseUrl))
        .setRefSpecs("refs/heads/nope:refs/remotes/origin/nope")
        .call(),
    ).rejects.toThrow("couldn't find remote ref refs/heads/nope");
  });

  it("clone --branch: a missing branch is an error, a tag is checked out detached", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    const tagged = server.initialCommitId;
    await server.serverStores.refs.set("refs/tags/v1", tagged);
    await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    globalThis.fetch = server.mockFetch;

    const missing = Git.fromWorkingCopy(await createTestWorkingCopy());
    await expect(missing.clone().setURI(url).setBranch("nope").call()).rejects.toThrow(
      "Remote branch nope not found in upstream origin",
    );
    await cleanup?.();
    cleanup = undefined;

    const workingCopy = await createTestWorkingCopy();
    const result = await Git.fromWorkingCopy(workingCopy)
      .clone()
      .setURI(url)
      .setBranch("v1")
      .call();
    expect(result.headCommit).toBe(tagged);
    const head = await workingCopy.history.refs.get("HEAD");
    expect(head && "objectId" in head ? head.objectId : undefined).toBe(tagged);
    expect(await workingCopy.history.refs.get("refs/tags/v1")).toBeDefined();
  });

  it("clone --depth fetches only the remote HEAD's branch (git: --depth implies --single-branch)", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    await server.serverStores.refs.set("refs/heads/other", server.initialCommitId);
    const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    globalThis.fetch = server.mockFetch;
    const workingCopy = await createTestWorkingCopy();

    const result = await Git.fromWorkingCopy(workingCopy).clone().setURI(url).setDepth(1).call();
    expect(result.headCommit).toBe(tip);
    expect(result.fetchResult.trackingRefUpdates.map((u) => u.localRef)).toEqual([
      "refs/remotes/origin/main",
    ]);
    expect(await workingCopy.history.refs.get("refs/remotes/origin/other")).toBeUndefined();
  });
});
