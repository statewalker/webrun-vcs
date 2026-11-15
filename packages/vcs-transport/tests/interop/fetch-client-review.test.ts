/**
 * Review fixes of the fetch client (PR #73), against native `git http-backend` (v2 and v0):
 * an interrupted fetch must not leave the next fetch thinking it has everything; tags follow
 * only for refspecs with a destination; a missing remote ref is an error.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetch } from "../../src/index.js";
import { type GitHttpBackend, gitHttpBackend } from "./git-http-backend.js";
import {
  cleanupDir,
  createTransportRepo,
  git,
  gitAvailable,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";

const describeGit = gitAvailable() ? describe : describe.skip;

/** Commits with incompressible blobs (git fast-import), so the pack is large. */
function addCommits(repo: string, count: number, time: number): string {
  let stream = "";
  for (let i = 0; i < count; i++) {
    const message = `c${i}\n`;
    const content = `${randomBytes(4000).toString("hex")}\n`;
    stream += "commit refs/heads/main\n";
    stream += `committer T <t@example.com> ${time + i * 60} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}`;
    stream += `M 100644 inline f${i}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: stream,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return git(repo, ["rev-parse", "refs/heads/main"]);
}

/** `handler`, with the pack response of a fetch cut off after `limit` bytes. */
function cutOff(
  handler: (request: Request) => Promise<Response>,
  limit: number,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return handler(request);
    const body = await request.clone().text();
    const response = await handler(request);
    if (body.includes("command=ls-refs") || !response.body) return response;
    const reader = response.body.getReader();
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          // an error discards queued chunks: the bytes before the cut go out first
          if (sent >= limit) {
            await reader.cancel();
            controller.error(new Error("connection reset"));
            return;
          }
          const next = await reader.read();
          if (next.done) return controller.close();
          if (sent + next.value.length > limit) {
            controller.enqueue(next.value.subarray(0, limit - sent));
            sent = limit;
            return;
          }
          sent += next.value.length;
          controller.enqueue(next.value);
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
}

describeGit.each([2, 0] as const)("fetch client review fixes (protocol v%i)", (version) => {
  let root: string;
  let dir: string;
  let backend: GitHttpBackend;
  let client: TransportRepo;
  const url = "http://git.test/src.git";

  beforeEach(async () => {
    root = makeTmpDir("vcs-fetch-review-");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", "src.git"]);
    dir = join(root, "src.git");
    backend = gitHttpBackend(root);
    client = await createTransportRepo();
  });
  afterEach(async () => {
    backend.close();
    await client.close();
    cleanupDir(root);
  });

  it("an interrupted fetch leaves objects behind, yet the next fetch transfers the whole history", async () => {
    const tip = addCommits(dir, 30, 1_700_000_000);
    const local = { repository: client.facade, refStore: client.refStore };
    const refspecs = ["+refs/heads/main:refs/remotes/origin/main"];
    await expect(
      fetch({
        url,
        protocolVersion: version,
        // past the first side-band packet (65520 bytes), well before the end of the pack
        fetchImpl: cutOff(backend.handler, 100_000),
        refspecs,
        ...local,
      }),
    ).rejects.toThrow();
    // git sends commits first: the interrupted import left the tip behind, but not its blobs
    expect(await client.facade.has(tip)).toBe(true);
    expect(await client.refStore.get("refs/remotes/origin/main")).toBeUndefined();

    const again = await fetch({
      url,
      protocolVersion: version,
      fetchImpl: backend.handler,
      refspecs,
      ...local,
    });
    expect(again.packObjects).toBeGreaterThan(0);
    expect(await client.refStore.get("refs/remotes/origin/main")).toBe(tip);
    for (const line of git(dir, ["rev-list", "--objects", "main"]).split("\n")) {
      expect(await client.facade.has(line.slice(0, 40)), line).toBe(true);
    }
  });

  it("follows tags only for refspecs with a destination", async () => {
    addCommits(dir, 2, 1_700_000_000);
    git(dir, ["tag", "-a", "v1", "-m", "v1", "main"]);
    const local = { repository: client.facade, refStore: client.refStore };
    const objectsOnly = await fetch({
      url,
      protocolVersion: version,
      fetchImpl: backend.handler,
      refspecs: ["refs/heads/main"],
      ...local,
    });
    expect(objectsOnly.followedTags).toEqual([]);
    expect(objectsOnly.refUpdates).toEqual([]);
    expect(await client.refStore.get("refs/tags/v1")).toBeUndefined();

    const mapped = await fetch({
      url,
      protocolVersion: version,
      fetchImpl: backend.handler,
      refspecs: ["refs/heads/main:refs/remotes/origin/main"],
      ...local,
    });
    expect(mapped.followedTags).toEqual(["refs/tags/v1"]);
  });

  it("a refspec naming a ref the remote does not have is an error", async () => {
    addCommits(dir, 1, 1_700_000_000);
    await expect(
      fetch({
        url,
        protocolVersion: version,
        fetchImpl: backend.handler,
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["refs/heads/nope:refs/remotes/origin/nope"],
      }),
    ).rejects.toThrow("couldn't find remote ref refs/heads/nope");
    // a wildcard that matches nothing, or missingRefsOk (configured refspecs), is fine
    const ok = await fetch({
      url,
      protocolVersion: version,
      fetchImpl: backend.handler,
      repository: client.facade,
      refStore: client.refStore,
      refspecs: ["refs/heads/nope:refs/remotes/origin/nope", "+refs/heads/x/*:refs/remotes/x/*"],
      missingRefsOk: true,
    });
    expect(ok.refUpdates).toEqual([]);
  });
});
