import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  createFilesLfsStore,
  LFS_CONTENT_TYPE,
  type LfsObjectStore,
  type LfsServerOptions,
  serveLfs,
  sha256Hex,
} from "../src/index.js";
import { makeStore, memResolver, prng, seedObject } from "./helpers.js";

/**
 * The server side of git-lfs's docs/api: batch.md (operations, per-object
 * errors, hash_algo, limits), basic-transfers.md (PUT, GET with Range, verify)
 * and authentication.md (401 with `LFS-Authenticate`, action headers).
 */
const BASE = "http://lfs.test/repo.git/info/lfs";

function batchRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/objects/batch`, {
    method: "POST",
    headers: { "content-type": LFS_CONTENT_TYPE, accept: LFS_CONTENT_TYPE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Json = Record<string, unknown> & {
  objects?: Record<string, unknown>[];
  message?: string;
};

async function filesServer(opts: LfsServerOptions = {}) {
  const store = createFilesLfsStore(new MemFilesApi());
  return { store, handler: serveLfs(store, opts) };
}

async function seed(store: LfsObjectStore, bytes: Uint8Array) {
  const oid = await sha256Hex(bytes);
  const res = await store.put(bytes, { oid, size: bytes.length });
  if (!res.ok) throw new Error(res.reason);
  return { oid, size: bytes.length };
}

describe("batch API (docs/api/batch.md)", () => {
  it("answers in application/vnd.git-lfs+json with hash_algo sha256; hrefs keep the path prefix", async () => {
    const { store, handler } = await filesServer();
    const a = await seed(store, prng(100, 1));
    const res = await handler(batchRequest({ operation: "download", objects: [a] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(LFS_CONTENT_TYPE);
    const json = (await res.json()) as Json;
    expect(json.transfer).toBe("basic");
    expect(json.hash_algo).toBe("sha256");
    const actions = json.objects?.[0]?.actions as { download: { href: string } };
    expect(actions.download.href).toBe(`${BASE}/objects/${a.oid}`);
  });

  it("an upload batch gives no actions for objects held, upload + verify for the others", async () => {
    const { store, handler } = await filesServer();
    const held = await seed(store, prng(100, 2));
    const missing = { oid: await sha256Hex(prng(50, 3)), size: 50 };
    const res = await handler(batchRequest({ operation: "upload", objects: [held, missing] }));
    const json = (await res.json()) as Json;
    expect(json.objects?.[0]).toEqual({ oid: held.oid, size: held.size });
    const actions = json.objects?.[1]?.actions as Record<string, { href: string }>;
    expect(actions.upload.href).toBe(`${BASE}/objects/${missing.oid}`);
    expect(actions.verify.href).toBe(`${BASE}/verify`);
  });

  it("the content-store server also skips held objects on upload", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const held = await seedObject(store, resolver, prng(100, 4));
    const res = await serveLfs(
      store,
      resolver,
    )(batchRequest({ operation: "upload", objects: [held] }));
    expect(((await res.json()) as Json).objects?.[0]).toEqual(held);
  });

  it("per-object errors: 404 missing on download, 422 invalid oid or size", async () => {
    const { store, handler } = await filesServer();
    const a = await seed(store, prng(100, 5));
    const res = await handler(
      batchRequest({
        operation: "download",
        objects: [
          { oid: "b".repeat(64), size: 1 },
          { oid: "XYZ", size: 1 },
          { oid: "c".repeat(64), size: -1 },
          { ...a, size: a.size + 1 },
          null,
        ],
      }),
    );
    expect(res.status).toBe(200);
    const objects = ((await res.json()) as Json).objects ?? [];
    const codes = objects.map((o) => (o.error as { code: number }).code);
    expect(codes).toEqual([404, 422, 422, 422, 422]);
    for (const o of objects)
      expect(typeof (o.error as { message: unknown }).message).toBe("string");
  });

  it("a hash_algo other than sha256 is 409", async () => {
    const { handler } = await filesServer();
    const res = await handler(
      batchRequest({ operation: "download", objects: [], hash_algo: "sha512" }),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe(LFS_CONTENT_TYPE);
    expect(typeof ((await res.json()) as Json).message).toBe("string");
  });

  it("a malformed batch is 422 with an error object", async () => {
    const { handler } = await filesServer();
    for (const body of ["{", JSON.stringify({ operation: "copy", objects: [] }), "[]"]) {
      const res = await handler(batchRequest(body));
      expect(res.status).toBe(422);
      expect(typeof ((await res.json()) as Json).message).toBe("string");
    }
  });

  it("limits: objects per batch and request bytes are 413; objects over the size limit 422", async () => {
    const { handler } = await filesServer({
      maxBatchObjects: 2,
      maxBatchBytes: 600,
      maxObjectSize: 1000,
    });
    const three = [1, 2, 3].map((i) => ({ oid: String(i).repeat(64), size: 1 }));
    expect((await handler(batchRequest({ operation: "upload", objects: three }))).status).toBe(413);
    const big = JSON.stringify({ operation: "upload", objects: [], pad: "x".repeat(700) });
    expect((await handler(batchRequest(big))).status).toBe(413);
    const res = await handler(
      batchRequest({ operation: "upload", objects: [{ oid: "d".repeat(64), size: 1001 }] }),
    );
    expect(res.status).toBe(200);
    const o = ((await res.json()) as Json).objects?.[0] as { error: { code: number } };
    expect(o.error.code).toBe(422);
  });

  it("an Accept the server cannot satisfy is 406", async () => {
    const { handler } = await filesServer();
    const res = await handler(
      batchRequest({ operation: "download", objects: [] }, { accept: "text/html" }),
    );
    expect(res.status).toBe(406);
  });

  it("error objects carry request_id (from x-request-id) and documentation_url when configured", async () => {
    const { handler } = await filesServer({ documentationUrl: "https://lfs.test/help" });
    const res = await handler(
      batchRequest(
        { operation: "download", objects: [], hash_algo: "md5" },
        { "x-request-id": "r-1" },
      ),
    );
    expect(await res.json()).toEqual({
      message: expect.any(String),
      request_id: "r-1",
      documentation_url: "https://lfs.test/help",
    });
  });

  it("publicUrl sets the hrefs", async () => {
    const { store, handler } = await filesServer({
      publicUrl: "https://example.com/r.git/info/lfs/",
    });
    const a = await seed(store, prng(10, 6));
    const json = (await (
      await handler(batchRequest({ operation: "download", objects: [a] }))
    ).json()) as Json;
    const actions = json.objects?.[0]?.actions as { download: { href: string } };
    expect(actions.download.href).toBe(`https://example.com/r.git/info/lfs/objects/${a.oid}`);
  });
});

describe("authentication (docs/api/authentication.md)", () => {
  const authorize: LfsServerOptions["authorize"] = (request, operation) => {
    const auth = request.headers.get("authorization");
    if (auth === `Basic ${btoa("writer:pw")}`) return true;
    if (auth === `Basic ${btoa("reader:pw")}`) return operation === "download";
    return false;
  };

  it("denied without credentials: 401 with LFS-Authenticate; with credentials: 403", async () => {
    const { handler } = await filesServer({ authorize });
    const anon = await handler(batchRequest({ operation: "download", objects: [] }));
    expect(anon.status).toBe(401);
    expect(anon.headers.get("lfs-authenticate")).toBe('Basic realm="Git LFS"');
    expect(anon.headers.get("content-type")).toBe(LFS_CONTENT_TYPE);
    expect(typeof ((await anon.json()) as Json).message).toBe("string");
    const reader = { authorization: `Basic ${btoa("reader:pw")}` };
    expect(
      (await handler(batchRequest({ operation: "download", objects: [] }, reader))).status,
    ).toBe(200);
    const upload = await handler(batchRequest({ operation: "upload", objects: [] }, reader));
    expect(upload.status).toBe(403);
    expect(upload.headers.get("lfs-authenticate")).toBeNull();
  });

  it("authorizes before parsing: an anonymous malformed batch is 401, not 422", async () => {
    const { handler } = await filesServer({ authorize });
    expect((await handler(batchRequest("{"))).status).toBe(401);
  });

  it("without transferAuth, transfers go through authorize too", async () => {
    const { store, handler } = await filesServer({ authorize });
    const a = await seed(store, prng(10, 7));
    expect((await handler(new Request(`${BASE}/objects/${a.oid}`))).status).toBe(401);
    const ok = await handler(
      new Request(`${BASE}/objects/${a.oid}`, {
        headers: { authorization: `Basic ${btoa("reader:pw")}` },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("transferAuth: per-action headers with expires_in, authenticated objects, checked transfers", async () => {
    const tokens = new Map<string, string>();
    const { store, handler } = await filesServer({
      authorize,
      transferAuth: {
        expiresIn: 600,
        header(operation, oid) {
          const token = `${operation}-${oid.slice(0, 8)}`;
          tokens.set(token, `${operation}:${oid}`);
          return { Authorization: `RemoteAuth ${token}` };
        },
        check(request, operation, oid) {
          const token = request.headers.get("authorization")?.replace("RemoteAuth ", "") ?? "";
          return tokens.get(token) === `${operation}:${oid}`;
        },
      },
    });
    const a = await seed(store, prng(10, 8));
    const b = await seed(store, prng(10, 9));
    const writer = { authorization: `Basic ${btoa("writer:pw")}` };
    const json = (await (
      await handler(batchRequest({ operation: "download", objects: [a] }, writer))
    ).json()) as Json;
    const o = json.objects?.[0] as {
      authenticated?: boolean;
      actions: { download: { href: string; header: Record<string, string>; expires_in: number } };
    };
    expect(o.authenticated).toBe(true);
    expect(o.actions.download.expires_in).toBe(600);
    const header = o.actions.download.header;
    expect(header.Authorization).toBe(`RemoteAuth download-${a.oid.slice(0, 8)}`);
    const get = await handler(new Request(o.actions.download.href, { headers: header }));
    expect(get.status).toBe(200);
    // the same header does not open another object, nor the batch's own credentials a transfer
    expect(
      (await handler(new Request(`${BASE}/objects/${b.oid}`, { headers: header }))).status,
    ).toBe(401);
    expect(
      (await handler(new Request(`${BASE}/objects/${a.oid}`, { headers: writer }))).status,
    ).toBe(401);
  });
});

describe("basic transfer (docs/api/basic-transfers.md)", () => {
  it("GET with Range: bytes=N- is 206 with Content-Range; past the end 416", async () => {
    const { store, handler } = await filesServer();
    const bytes = prng(1000, 10);
    const a = await seed(store, bytes);
    const href = `${BASE}/objects/${a.oid}`;
    const full = await handler(new Request(href));
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("1000");
    await full.body?.cancel();
    const tail = await handler(new Request(href, { headers: { range: "bytes=600-" } }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 600-999/1000");
    expect(tail.headers.get("content-length")).toBe("400");
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(600));
    const mid = await handler(new Request(href, { headers: { range: "bytes=10-19" } }));
    expect(mid.status).toBe(206);
    expect(new Uint8Array(await mid.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    const past = await handler(new Request(href, { headers: { range: "bytes=1000-" } }));
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */1000");
  });

  it("the content-store server answers ranges too", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const bytes = prng(5000, 11);
    const a = await seedObject(store, resolver, bytes);
    const res = await serveLfs(
      store,
      resolver,
    )(new Request(`${BASE}/objects/${a.oid}`, { headers: { range: "bytes=4000-" } }));
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.subarray(4000));
  });

  it("verify: 200 when the object is held with that size, 404 otherwise, 422 malformed", async () => {
    const { store, handler } = await filesServer();
    const a = await seed(store, prng(100, 12));
    const verify = (body: unknown) =>
      handler(
        new Request(`${BASE}/verify`, {
          method: "POST",
          headers: { "content-type": LFS_CONTENT_TYPE, accept: LFS_CONTENT_TYPE },
          body: JSON.stringify(body),
        }),
      );
    expect((await verify(a)).status).toBe(200);
    expect((await verify({ ...a, size: 99 })).status).toBe(404);
    expect((await verify({ oid: "e".repeat(64), size: 1 })).status).toBe(404);
    expect((await verify({ oid: "nope" })).status).toBe(422);
  });

  it("PUT: verified (422 on mismatch), size-limited (413), invalid Content-Length 400", async () => {
    const { store, handler } = await filesServer({ maxObjectSize: 100 });
    const bytes = prng(80, 13);
    const oid = await sha256Hex(bytes);
    const put = (path: string, body: Uint8Array, headers: Record<string, string> = {}) =>
      handler(
        new Request(`${BASE}/objects/${path}`, { method: "PUT", body: body as BodyInit, headers }),
      );
    expect((await put("f".repeat(64), bytes)).status).toBe(422);
    expect(await store.size("f".repeat(64))).toBeUndefined();
    expect((await put(await sha256Hex(prng(200, 1)), prng(200, 1))).status).toBe(413);
    expect((await put(oid, bytes, { "content-length": "abc" })).status).toBe(400);
    expect((await put(oid, bytes)).status).toBe(200);
    expect(await store.size(oid)).toBe(80);
  });
});
