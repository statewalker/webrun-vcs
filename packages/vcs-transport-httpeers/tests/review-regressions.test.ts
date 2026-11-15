/**
 * Regressions from the P3.10 review (PR #75): swarm stalls and Range-ignoring sources, blame
 * after a resumed partial, the token pinned to the remote's origin, one parser for the git
 * service, identity only from an edge or `provenPeer`, no transferAuth bypass, and the nits.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createFilesLfsStore,
  type FetchLike,
  type LfsObjectStore,
  type LfsPointer,
  sha256Hex,
} from "@statewalker/vcs-transport-lfs";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitRules,
  type LfsSource,
  lfsSwarmDownload,
  MeshRedirectError,
  meshGitHandler,
  meshGitPush,
  meshLfsHandler,
  meshRemoteFetch,
  servePeerConnection,
  withMeshToken,
} from "../src/index.js";
import {
  collect,
  commit,
  createHub,
  createRepo,
  type Hub,
  prng,
  type TestRepo,
} from "./helpers.js";

const CHUNK = 64 * 1024;
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const pointerOf = async (bytes: Uint8Array): Promise<LfsPointer> => ({
  oid: await sha256Hex(bytes),
  size: bytes.length,
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A store holding `bytes`, optionally with its reads replaced. */
async function holding(
  bytes: Uint8Array,
  p: LfsPointer,
  read?: (store: LfsObjectStore) => LfsObjectStore["read"],
): Promise<LfsObjectStore> {
  const store = createFilesLfsStore(new MemFilesApi());
  await store.put(bytes, p);
  return read ? { ...store, read: read(store) } : store;
}

/** A mesh LFS source over a duplex, for caller A as a member. */
async function source(hub: Hub, name: string, objects: LfsObjectStore): Promise<LfsSource> {
  const handler = meshLfsHandler({ objects, access: { issuer: hub.issuer, now: hub.now } });
  return {
    name,
    url: `http://${name}.mesh/repo.git/info/lfs`,
    fetchImpl: meshRemoteFetch({
      call: servePeerConnection(handler, { remotePeer: "A" }),
      token: await hub.token("A", ["member"]),
    }),
  };
}

/** Flips one byte in every 64 KiB. */
const corrupt = (store: LfsObjectStore): LfsObjectStore["read"] =>
  async function* (oid, range) {
    let at = range?.offset ?? 0;
    for await (const chunk of store.read(oid, range)) {
      const copy = new Uint8Array(chunk);
      for (let i = 0; i < copy.length; i++)
        if ((at + i) % 65536 === 7) copy[i] = (copy[i] as number) ^ 0xff;
      at += copy.length;
      yield copy;
    }
  };

/** Sends the first 10 bytes asked for, then nothing ever again. */
const stalling = (store: LfsObjectStore): LfsObjectStore["read"] =>
  async function* (oid, range) {
    for await (const chunk of store.read(oid, range)) {
      yield chunk.subarray(0, 10);
      break;
    }
    await new Promise(() => {});
  };

/** Wraps a source's ranged requests. */
function wrapRanged(
  s: LfsSource,
  wrap: (request: Request, next: FetchLike, index: number) => Promise<Response>,
): LfsSource {
  const next = s.fetchImpl as FetchLike;
  let n = 0;
  return {
    ...s,
    fetchImpl: (request) =>
      request.headers.has("range") ? wrap(request, next, n++) : next(request),
  };
}

describe("1: a stalled peer does not stall the swarm", () => {
  it("an idle source takes over the stalled chunk; the stalled source is dropped", async () => {
    const hub = await createHub();
    const bytes = prng(16 * CHUNK, 9);
    const p = await pointerOf(bytes);
    const slow = await source(hub, "slow", await holding(bytes, p, stalling));
    const good = await source(hub, "good", await holding(bytes, p));
    const local = createFilesLfsStore(new MemFilesApi());
    const started = Date.now();
    const r = await lfsSwarmDownload([p], [slow, good], local, {
      chunkSize: CHUNK,
      reassignAfterMs: 150,
      idleTimeoutMs: 10_000,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.downloaded).toEqual([p.oid]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });

  it("a lone stalled source times out (idleTimeoutMs) instead of hanging", async () => {
    const hub = await createHub();
    const bytes = prng(4 * CHUNK, 10);
    const p = await pointerOf(bytes);
    const slow = await source(hub, "slow", await holding(bytes, p, stalling));
    const started = Date.now();
    const r = await lfsSwarmDownload([p], [slow], createFilesLfsStore(new MemFilesApi()), {
      chunkSize: CHUNK,
      idleTimeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.failed[0]?.reason).toMatch(/stalled/);
  });

  it("abort ends a stalled download promptly", async () => {
    const hub = await createHub();
    const bytes = prng(4 * CHUNK, 11);
    const p = await pointerOf(bytes);
    const slow = await source(hub, "slow", await holding(bytes, p, stalling));
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("gave up")), 100);
    const started = Date.now();
    await expect(
      lfsSwarmDownload([p], [slow], createFilesLfsStore(new MemFilesApi()), {
        chunkSize: CHUNK,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/gave up/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("2: a source ignoring Range is read once, not once per chunk", () => {
  it("bytes on the wire are about the object's size", async () => {
    const hub = await createHub();
    const bytes = prng(32 * CHUNK, 4);
    const p = await pointerOf(bytes);
    let wire = 0;
    const b = wrapRanged(await source(hub, "b", await holding(bytes, p)), async (req, next) => {
      const headers = new Headers(req.headers);
      headers.delete("range");
      const res = await next(new Request(req, { headers }));
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          const r = await reader.read();
          if (r.done) return c.close();
          wire += r.value.length;
          c.enqueue(r.value);
        },
        cancel: () => reader.cancel(),
      });
      return new Response(body, { status: 200, headers: res.headers });
    });
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload([p], [b], local, { chunkSize: CHUNK });
    expect(r.downloaded).toEqual([p.oid]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
    expect(wire).toBeLessThanOrEqual(bytes.length + CHUNK);
  });
});

describe("3: blame after resuming from a partial another source wrote", () => {
  it("the honest source is not blamed; the corrupting one is", async () => {
    const hub = await createHub();
    const CH = 128 * 1024;
    const bytes = prng(4 * CH, 3);
    const p = await pointerOf(bytes);
    const fail503 = (at: Set<number>) => async (req: Request, next: FetchLike, i: number) =>
      at.has(i) ? new Response("down", { status: 503 }) : next(req);
    const sources = [
      wrapRanged(await source(hub, "good", await holding(bytes, p)), fail503(new Set([1]))),
      wrapRanged(await source(hub, "bad", await holding(bytes, p, corrupt)), fail503(new Set([1]))),
      wrapRanged(await source(hub, "good2", await holding(bytes, p)), fail503(new Set([0]))),
    ];
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload([p], sources, local, { chunkSize: CH });
    expect(r.downloaded).toEqual([p.oid]);
    expect(r.bad).toEqual(["bad"]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });
});

describe("swarm nits", () => {
  it("invalid windowBytes is refused", async () => {
    const store = createFilesLfsStore(new MemFilesApi());
    for (const windowBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(lfsSwarmDownload([], [], store, { windowBytes })).rejects.toThrow(/windowBytes/);
  });

  it("no more than windowBytes is received ahead of a slow write position", async () => {
    const hub = await createHub();
    const bytes = prng(16 * CHUNK, 12);
    const p = await pointerOf(bytes);
    let fastBytes = 0;
    let fastAtRelease = -1;
    const slow = wrapRanged(
      await source(hub, "slow", await holding(bytes, p)),
      async (req, next, i) => {
        if (i === 0) {
          await new Promise((r) => setTimeout(r, 300));
          fastAtRelease = fastBytes;
        }
        return next(req);
      },
    );
    const fast = wrapRanged(
      await source(hub, "fast", await holding(bytes, p)),
      async (req, next) => {
        const res = await next(req);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            const r = await reader.read();
            if (r.done) return c.close();
            fastBytes += r.value.length;
            c.enqueue(r.value);
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, { status: res.status, headers: res.headers });
      },
    );
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload([p], [slow, fast], local, {
      chunkSize: CHUNK,
      windowBytes: 2 * CHUNK,
      reassignAfterMs: 10_000,
    });
    expect(r.downloaded).toEqual([p.oid]);
    expect(fastAtRelease).toBeGreaterThan(0);
    expect(fastAtRelease).toBeLessThanOrEqual(2 * CHUNK);
  });

  it("a 206 for another range is refused (fallback), a body longer than its range is cut", async () => {
    const hub = await createHub();
    const bytes = prng(6 * CHUNK, 13);
    const p = await pointerOf(bytes);
    const wrongRange = wrapRanged(
      await source(hub, "wrong", await holding(bytes, p)),
      async (req, next) => {
        const res = await next(req);
        const headers = new Headers(res.headers);
        headers.set("content-range", `bytes 1-${CHUNK}/${bytes.length}`);
        return new Response(res.body, { status: 206, headers });
      },
    );
    const long = wrapRanged(
      await source(hub, "long", await holding(bytes, p)),
      async (req, next) => {
        // asks for more than the client did, answers with the client's range header
        const asked = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "") as RegExpExecArray;
        const headers = new Headers(req.headers);
        headers.set("range", `bytes=${asked[1]}-`);
        const res = await next(new Request(req, { headers }));
        const out = new Headers(res.headers);
        out.set("content-range", `bytes ${asked[1]}-${asked[2]}/${bytes.length}`);
        return new Response(res.body, { status: 206, headers: out });
      },
    );
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload([p], [wrongRange, long], local, { chunkSize: CHUNK });
    expect(r.downloaded).toEqual([p.oid]);
    expect(r.received.long).toBe(bytes.length);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });
});

/** A loopback HTTP server; returns its origin. */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("4: the token stays on the remote's origin", () => {
  it("a cross-origin redirect is refused and the other host never sees the token", async () => {
    let seen: string | undefined = "none";
    const evil = await listen((req, res) => {
      seen = req.headers["x-httpeers-token"] as string | undefined;
      res.end("ok");
    });
    const evilOnLocalhost = evil.replace("127.0.0.1", "localhost");
    seen = "none";
    const peer = await listen((_req, res) => {
      res.writeHead(302, { location: `${evilOnLocalhost}/steal` });
      res.end();
    });
    const f = meshRemoteFetch({ fetchImpl: (r) => fetch(r), token: "SECRET-TOKEN" });
    await expect(
      f(new Request(`${peer}/repo.git/info/refs?service=git-upload-pack`)),
    ).rejects.toThrow(MeshRedirectError);
    expect(seen).toBe("none");
  });

  it("a same-origin redirect is followed with the token", async () => {
    const tokens: (string | undefined)[] = [];
    const peer = await listen((req, res) => {
      tokens.push(req.headers["x-httpeers-token"] as string | undefined);
      if (req.url?.startsWith("/old")) {
        res.writeHead(301, { location: "/new" });
        res.end();
      } else res.end("here");
    });
    const f = meshRemoteFetch({ fetchImpl: (r) => fetch(r), token: "T1", origin: peer });
    const res = await f(new Request(`${peer}/old`));
    expect(await res.text()).toBe("here");
    expect(tokens).toEqual(["T1", "T1"]);
  });

  it("a request to another origin than the remote's carries no token", async () => {
    const seen: (string | null)[] = [];
    const f = withMeshToken(
      async (r) => {
        seen.push(r.headers.get("x-httpeers-token"));
        return new Response("ok");
      },
      "T",
      { origin: "http://peer-b" },
    );
    await f(new Request("http://peer-b/repo.git/info/refs"));
    await f(new Request("http://elsewhere/x"));
    expect(seen).toEqual(["T", null]);
  });

  it("LFS action hrefs on another origin get neither the mesh token nor the source headers", async () => {
    const bytes = prng(3 * CHUNK, 14);
    const p = await pointerOf(bytes);
    const seen: { url: string; token: string | null; custom: string | null }[] = [];
    const endpoint: FetchLike = async (req) => {
      seen.push({
        url: req.url,
        token: req.headers.get("x-httpeers-token"),
        custom: req.headers.get("x-custom"),
      });
      if (req.url.endsWith("/objects/batch"))
        return Response.json({
          transfer: "basic",
          objects: [{ ...p, actions: { download: { href: `http://cdn.example/${p.oid}` } } }],
        });
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "") as RegExpExecArray;
      const [a, b] = [Number(m[1]), Number(m[2])];
      return new Response(bytes.slice(a, b + 1), {
        status: 206,
        headers: { "content-range": `bytes ${a}-${b}/${bytes.length}` },
      });
    };
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload(
      [p],
      [
        {
          name: "b",
          url: "http://peer-b/repo.git/info/lfs",
          fetchImpl: meshRemoteFetch({ fetchImpl: async (r) => endpoint(r), token: "T" }),
          headers: { "x-custom": "secret" },
        },
      ],
      local,
      { chunkSize: CHUNK },
    );
    expect(r.downloaded).toEqual([p.oid]);
    expect(seen[0]).toMatchObject({ token: "T", custom: "secret" });
    const transfers = seen.slice(1);
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) expect(t).toMatchObject({ token: null, custom: null });
  });
});

describe("git handler", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.close();
  });
  async function served() {
    const r = await createRepo();
    repos.push(r);
    const c = await commit(r, "c1", { "a.txt": "x" });
    await r.refStore.update("refs/heads/main", c);
    return r;
  }

  it("5: a repeated service parameter is refused (400), not read two ways", async () => {
    const hub = await createHub();
    const repo = await served();
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: { issuer: hub.issuer, now: hub.now },
    });
    const call = servePeerConnection(handler, { remotePeer: "R" });
    const f = withMeshToken((r) => fetchOverDuplex(call, r), await hub.token("R", ["member"]));
    const direct = await f(new Request("http://b/repo.git/info/refs?service=git-receive-pack"));
    await direct.body?.cancel();
    expect(direct.status).toBe(403);
    for (const q of [
      "service=git-upload-pack&service=git-receive-pack",
      "service=git-receive-pack&service=git-upload-pack",
    ]) {
      const smuggled = await f(new Request(`http://b/repo.git/info/refs?${q}`));
      await smuggled.body?.cancel();
      expect(smuggled.status).toBe(400);
      expect(smuggled.headers.get("content-type") ?? "").not.toContain("receive-pack");
    }
  });

  it("6: access.provenPeer alone identifies the caller", async () => {
    const hub = await createHub();
    const repo = await served();
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: { issuer: hub.issuer, now: hub.now, provenPeer: () => "R" },
    });
    const ok = await withMeshToken(
      handler,
      await hub.token("R", ["member"]),
    )(new Request("http://b/repo.git/info/refs?service=git-upload-pack"));
    await ok.body?.cancel();
    expect(ok.status).toBe(200);
    // the transport proved R: a token for T, and a peer header naming T, do not make it T
    const spoof = await handler(
      new Request("http://b/repo.git/info/refs?service=git-upload-pack", {
        headers: { "x-httpeers-peer": "T", "x-httpeers-token": await hub.token("T", ["admin"]) },
      }),
    );
    await spoof.body?.cancel();
    expect(spoof.status).toBe(401);
  });

  it("6: mounted without an edge, a client's peer header is not trusted (401)", async () => {
    const hub = await createHub();
    const repo = await served();
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: { issuer: hub.issuer, now: hub.now },
    });
    const res = await handler(
      new Request("http://b/repo.git/info/refs?service=git-upload-pack", {
        headers: { "x-httpeers-peer": "R", "x-httpeers-token": await hub.token("R", ["admin"]) },
      }),
    );
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("nit: an own namespace without a trailing slash does not admit sibling prefixes", async () => {
    const hub = await createHub();
    const repo = await served();
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: { issuer: hub.issuer, now: hub.now, rules: gitRules({ contributors: true }) },
      ownNamespace: (peer) => `refs/peers/${peer}`,
    });
    const call = servePeerConnection(handler, { remotePeer: "a" });
    const token = await hub.token("a", ["member"]);
    const main = (await repo.refStore.get("refs/heads/main")) as string;
    const push = (dest: string) =>
      meshGitPush({
        url: "http://b/repo.git",
        call,
        token,
        refspecs: [`refs/heads/main:${dest}`],
        repository: repo.facade,
        refStore: repo.refStore,
      });
    expect((await push("refs/peers/ab/x")).updates[0]?.status).toBe("remote-rejected");
    expect((await push("refs/peers/a/x")).updates[0]?.status).toBe("ok");
  });
});

describe("LFS handler", () => {
  async function lfsFor(
    hub: Hub,
    objects: LfsObjectStore,
    peer: string,
    roles: string[],
    extra = {},
  ) {
    const handler = meshLfsHandler({
      objects,
      access: { issuer: hub.issuer, now: hub.now },
      ...extra,
    });
    return meshRemoteFetch({
      call: servePeerConnection(handler, { remotePeer: peer }),
      token: await hub.token(peer, roles),
    });
  }

  it("7: transferAuth cannot let a reader upload", async () => {
    const hub = await createHub();
    const bytes = prng(1000, 15);
    const p = await pointerOf(bytes);
    const objects = createFilesLfsStore(new MemFilesApi());
    const f = await lfsFor(hub, objects, "R", ["member"], {
      transferAuth: { header: () => ({}), check: () => true },
    });
    const res = await f(
      new Request(`http://b/repo.git/info/lfs/objects/${p.oid}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.length) },
        body: bytes as BodyInit,
      }),
    );
    await res.body?.cancel();
    expect(res.status).toBe(403);
    expect(await objects.size(p.oid)).toBeUndefined();
  });

  it("HEAD of an object needs git:read; verify needs git:write", async () => {
    const hub = await createHub();
    const bytes = prng(2000, 16);
    const p = await pointerOf(bytes);
    const objects = await holding(bytes, p);
    const url = `http://b/repo.git/info/lfs`;
    const reader = await lfsFor(hub, objects, "R", ["member"]);
    const head = await reader(new Request(`${url}/objects/${p.oid}`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const verify = (f: FetchLike) =>
      f(
        new Request(`${url}/verify`, {
          method: "POST",
          headers: { "content-type": "application/vnd.git-lfs+json" },
          body: JSON.stringify(p),
        }),
      );
    const refused = await verify(reader);
    await refused.body?.cancel();
    expect(refused.status).toBe(403);
    const admin = await lfsFor(hub, objects, "T", ["admin"]);
    const ok = await verify(admin);
    await ok.body?.cancel();
    expect(ok.status).toBe(200);
  });
});
