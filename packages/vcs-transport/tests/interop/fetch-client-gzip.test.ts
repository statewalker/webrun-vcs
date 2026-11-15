/**
 * The fetch client gzips large upload-pack request bodies (`Content-Encoding: gzip`), as git's
 * remote-curl does for bodies over 1024 bytes: a negotiation with many haves. Our server and
 * `git http-backend` both take them.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFetchHandler, fetch, GZIP_REQUEST_MIN_BYTES } from "../../src/index.js";
import { gitHttpBackend } from "./git-http-backend.js";
import {
  cleanupDir,
  commitInRepo,
  createTransportRepo,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";
import { serveFetchHandler } from "./http-server.js";

const describeGit = gitAvailable() ? describe : describe.skip;

interface Seen {
  encoding: string | null;
  bytes: number;
}

/** A fetchImpl that records each POST's Content-Encoding and body size. */
function recording(handler: (request: Request) => Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = async (request: Request) => {
    if (request.method !== "POST") return handler(request);
    const body = new Uint8Array(await request.arrayBuffer());
    seen.push({ encoding: request.headers.get("content-encoding"), bytes: body.length });
    return handler(new Request(request.url, { method: "POST", headers: request.headers, body }));
  };
  return { seen, fetchImpl };
}

/**
 * A server with `c0`, a client with c0 under 60 commits of its own: the negotiation walks them
 * (many haves) before it meets c0. `stale`: the remote-tracking ref still names c0 (a v0
 * server must then answer every batch with NAK, git's get_common_commits); otherwise it is
 * removed.
 */
async function setup(repos: TransportRepo[], options: { stale?: boolean } = {}) {
  const server = await createTransportRepo();
  const client = await createTransportRepo();
  repos.push(server, client);
  const c0 = await commitInRepo(server, "c0", { "a.txt": "0\n" });
  await server.refStore.update("refs/heads/main", c0);
  await server.history.refs.setSymbolic("HEAD", "refs/heads/main");
  const handler = createFetchHandler({
    resolveRepository: async () => ({ repository: server.facade, refStore: server.refStore }),
  });
  await fetch({
    url: "http://ours.test/r.git",
    fetchImpl: handler,
    repository: client.facade,
    refStore: client.refStore,
    refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
  });
  let tip = c0;
  for (let i = 0; i < 60; i++) {
    tip = await commitInRepo(client, `local ${i}`, { "l.txt": `${i}\n` }, [tip]);
  }
  await client.refStore.update("refs/heads/main", tip);
  if (!options.stale) await client.history.refs.remove("refs/remotes/origin/main");
  const c1 = await commitInRepo(server, "c1", { "a.txt": "1\n" }, [c0]);
  await server.refStore.update("refs/heads/main", c1);
  return { server, client, handler, c1 };
}

describe("fetch client: gzipped request bodies", () => {
  const repos: TransportRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.close();
  });

  for (const [protocolVersion, stale] of [
    [0, false],
    [2, false],
    // a stale tracking ref names c0: the client knows it common and sends ~16 haves only
  ] as const) {
    it(`protocol v${protocolVersion}${stale ? ", stale tracking ref" : ""}: a large have-batch goes gzipped, a small request does not`, async () => {
      const { client, handler, c1 } = await setup(repos, { stale });
      const { seen, fetchImpl } = recording(handler);
      const result = await fetch({
        url: "http://ours.test/r.git",
        fetchImpl,
        protocolVersion,
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      });
      expect(await client.refStore.get("refs/remotes/origin/main")).toBe(c1);
      expect(result.stats.haves).toBeGreaterThan(30);
      const gzipped = seen.filter((s) => s.encoding === "gzip");
      expect(gzipped.length).toBeGreaterThan(0);
      // the small requests (v2 ls-refs; the first round's wants) go as they are
      expect(seen.some((s) => s.encoding === null && s.bytes <= GZIP_REQUEST_MIN_BYTES)).toBe(true);
    });
  }
});

describeGit("fetch client: git http-backend takes the gzipped bodies", () => {
  const repos: TransportRepo[] = [];
  let root: string | undefined;
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.close();
    if (root) cleanupDir(root);
  });

  it("a negotiation with many haves against native git", async () => {
    const { client, handler, c1 } = await setup(repos);
    root = makeTmpDir("vcs-gzip-");
    // the server's repository, cloned into a bare native one through our server (async: the
    // server runs in this process)
    const ours = await serveFetchHandler(handler);
    try {
      await promisify(execFile)(
        "git",
        ["clone", "-q", "--bare", `${ours.baseUrl}/r.git`, join(root, "r.git")],
        {
          env: { ...loopbackEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          timeout: 30000,
        },
      );
    } finally {
      await ours.close();
    }
    const backend = gitHttpBackend(root);
    try {
      const { seen, fetchImpl } = recording(backend.handler);
      await fetch({
        url: "http://git.test/r.git",
        fetchImpl,
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      });
      expect(await client.refStore.get("refs/remotes/origin/main")).toBe(c1);
      expect(seen.some((s) => s.encoding === "gzip")).toBe(true);
    } finally {
      backend.close();
    }
  });
});

describe("fetch client: gzipRequests: false", () => {
  const repos: TransportRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.close();
  });

  it("sends every request body as it is (a browser behind a CORS proxy)", async () => {
    const { client, handler, c1 } = await setup(repos);
    const { seen, fetchImpl } = recording(handler);
    await fetch({
      url: "http://ours.test/r.git",
      fetchImpl,
      gzipRequests: false,
      repository: client.facade,
      refStore: client.refStore,
      refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
    });
    expect(await client.refStore.get("refs/remotes/origin/main")).toBe(c1);
    expect(seen.some((s) => s.bytes > GZIP_REQUEST_MIN_BYTES)).toBe(true);
    expect(seen.every((s) => s.encoding === null)).toBe(true);
  });
});
