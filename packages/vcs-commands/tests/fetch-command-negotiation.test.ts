/**
 * FetchCommand and CloneCommand on the transport's fetch client: the local refs are offered
 * as haves (an incremental fetch downloads only what is new), shallow options reach the
 * server and the shallow file, and a non-fast-forward is rejected unless forced.
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
  type TestServer,
} from "./transport-test-helper.js";

/** The server's mock fetch, recording the body of every upload-pack POST. */
function recording(server: TestServer) {
  const bodies: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.method === "POST") {
      bodies.push(await input.clone().text());
    }
    return server.mockFetch(input, init);
  }) as typeof globalThis.fetch;
  return { mockFetch, bodies };
}

describe.each(backends)("FetchCommand on the fetch client ($name backend)", ({ factory }) => {
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

  it("sends the local refs' history as haves: the second fetch gets only the new commit", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    const first = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    const { mockFetch, bodies } = recording(server);
    globalThis.fetch = mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);
    const refspec = "refs/heads/main:refs/remotes/origin/main";

    await git.fetch().setRemote(url).setRefSpecs(refspec).call();
    const second = await addFileAndCommit(server.serverStores, "b.txt", "b", "B");
    bodies.length = 0;
    const result = await git.fetch().setRemote(url).setRefSpecs(refspec).call();

    expect(bodies.some((b) => b.includes(`have ${first}`))).toBe(true);
    expect(result.trackingRefUpdates).toEqual([
      expect.objectContaining({
        localRef: "refs/remotes/origin/main",
        oldObjectId: first,
        newObjectId: second,
        status: RefUpdateStatus.FAST_FORWARD,
      }),
    ]);
    expect(await workingCopy.history.commits.has(second)).toBe(true);
  });

  it("rejects a non-fast-forward unless the refspec has + or setForceUpdate is set", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    const base = server.initialCommitId;
    const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    globalThis.fetch = server.mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);
    const refspec = "refs/heads/main:refs/remotes/origin/main";
    await git.fetch().setRemote(url).setRefSpecs(refspec).call();

    // the server's main goes back to its first commit
    await server.serverStores.refs.set("refs/heads/main", base);
    const refused = await git.fetch().setRemote(url).setRefSpecs(refspec).call();
    expect(refused.trackingRefUpdates[0]).toMatchObject({
      status: RefUpdateStatus.REJECTED,
      reason: "non-fast-forward",
    });
    expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(
      tip,
    );

    const forced = await git
      .fetch()
      .setRemote(url)
      .setRefSpecs(refspec)
      .setForceUpdate(true)
      .call();
    expect(forced.trackingRefUpdates[0]?.status).toBe(RefUpdateStatus.FORCED);
    expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(
      base,
    );
  });

  it("depth, shallow-since, shallow-exclude and unshallow reach the server and the shallow file", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    const tip = await addFileAndCommit(server.serverStores, "b.txt", "b", "B");
    const { mockFetch, bodies } = recording(server);
    globalThis.fetch = mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);
    const refspec = "+refs/heads/main:refs/remotes/origin/main";
    const refs = workingCopy.history.refs;

    await git.fetch().setRemote(url).setRefSpecs(refspec).setDepth(1).call();
    expect(await refs.getShallow?.()).toEqual([tip]);
    expect(bodies.some((b) => b.includes("deepen 1"))).toBe(true);

    await git.fetch().setRemote(url).setRefSpecs(refspec).setUnshallow(true).call();
    expect(await refs.getShallow?.()).toEqual([]);
    expect(await workingCopy.history.commits.has(server.initialCommitId)).toBe(true);

    bodies.length = 0;
    const since = new Date(1_700_000_000_000);
    await git
      .fetch()
      .setRemote(url)
      .setRefSpecs(refspec)
      .setShallowSince(since)
      .addShallowExclude("refs/heads/main")
      .call()
      .catch(() => {}); // the server may refuse the combination; the request is what counts
    expect(bodies.some((b) => b.includes("deepen-since 1700000000"))).toBe(true);
    expect(bodies.some((b) => b.includes("deepen-not refs/heads/main"))).toBe(true);
  });

  it("CloneCommand with depth makes a shallow clone with its local branch and HEAD", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    globalThis.fetch = server.mockFetch;
    const workingCopy = await createTestWorkingCopy();
    const git = Git.fromWorkingCopy(workingCopy);

    const result = await git.clone().setURI(url).setDepth(1).call();

    expect(result.headCommit).toBe(tip);
    expect(await workingCopy.history.refs.getShallow?.()).toEqual([tip]);
    expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(
      tip,
    );
    expect(await workingCopy.history.commits.has(server.initialCommitId)).toBe(false);
  });
});
