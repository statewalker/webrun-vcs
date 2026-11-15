import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  createFilesLfsStore,
  type FetchLike,
  type LfsPointer,
  lfsDownload,
  lfsUpload,
  serveLfs,
  sha256Hex,
} from "../src/index.js";
import { collect, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://lfs.test/repo.git/info/lfs";

function batchAnswer(objects: unknown[]): Response {
  return new Response(JSON.stringify({ transfer: "basic", objects }), {
    headers: { "content-type": "application/vnd.git-lfs+json" },
  });
}

describe("the client checks the batch answer against what it asked", () => {
  it("objects the server did not answer for, or answered with another size, are errors", async () => {
    const a = { oid: "a".repeat(64), size: 10 };
    const b = { oid: "b".repeat(64), size: 20 };
    const fetchImpl: FetchLike = async (request) => {
      if (request.method === "POST")
        return batchAnswer([{ ...a, size: 11, actions: { download: { href: `${URL}/x` } } }]);
      throw new Error("no transfer expected");
    };
    const events = await drain(lfsDownload(makeStore(), memResolver(), URL, [a, b], fetchImpl));
    expect(
      events
        .filter((e) => e.type === "error")
        .map((e) => e.oid)
        .sort(),
    ).toEqual([a.oid, b.oid]);
    expect(events.some((e) => e.type === "object-downloaded")).toBe(false);
  });

  it("objects the server added unasked are rejected and never transferred", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const a = await seedObject(store, resolver, prng(100, 1));
    const stranger = { oid: "c".repeat(64), size: 5 };
    const transfers: string[] = [];
    const fetchImpl: FetchLike = async (request) => {
      if (request.method === "POST")
        return batchAnswer([
          { ...a, actions: { upload: { href: `${URL}/objects/${a.oid}` } } },
          { ...stranger, actions: { upload: { href: `${URL}/objects/${stranger.oid}` } } },
        ]);
      transfers.push(request.url);
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    const events = await drain(lfsUpload(store, resolver, URL, [a], fetchImpl));
    expect(events).toContainEqual({ type: "object-uploaded", oid: a.oid });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", oid: stranger.oid }));
    expect(transfers).toEqual([`${URL}/objects/${a.oid}`]);
  });

  it("a batch answered with an error status throws with the server's message", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: "go away" }), {
        status: 403,
        headers: { "content-type": "application/vnd.git-lfs+json" },
      });
    await expect(
      drain(
        lfsDownload(makeStore(), memResolver(), URL, [{ oid: "a".repeat(64), size: 1 }], fetchImpl),
      ),
    ).rejects.toThrow(/403.*go away/);
  });
});

describe("credentials and action headers", () => {
  it("action headers replace the client's case-insensitively: one Authorization, not two joined", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const a = await seedObject(store, resolver, prng(100, 2));
    const seen: (string | null)[] = [];
    const fetchImpl: FetchLike = async (request) => {
      seen.push(request.headers.get("authorization"));
      if (request.method === "POST")
        return batchAnswer([
          {
            ...a,
            actions: {
              upload: {
                href: `${URL}/objects/${a.oid}`,
                header: { Authorization: "Bearer action" },
              },
            },
          },
        ]);
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    await drain(
      lfsUpload(store, resolver, URL, [a], fetchImpl, {
        headers: { authorization: "Bearer mine" },
      }),
    );
    expect(seen).toEqual(["Bearer mine", "Bearer action"]);
  });

  it("credentials become Basic auth on the batch and on transfers unless the object is authenticated", async () => {
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const a = await seedObject(serverStore, serverResolver, prng(100, 3));
    const b = await seedObject(serverStore, serverResolver, prng(100, 4));
    const seen: [string, string | null][] = [];
    const fetchImpl: FetchLike = async (request) => {
      seen.push([request.method, request.headers.get("authorization")]);
      if (request.method === "POST")
        return batchAnswer([
          { ...a, actions: { download: { href: `${URL}/objects/${a.oid}` } } },
          {
            ...b,
            authenticated: true,
            actions: { download: { href: `${URL}/objects/${b.oid}`, header: { "X-Token": "t" } } },
          },
        ]);
      return serveLfs(serverStore, serverResolver)(new Request(request.url));
    };
    const events = await drain(
      lfsDownload(makeStore(), memResolver(), URL, [a, b], fetchImpl, {
        credentials: { username: "u", password: "p" },
      }),
    );
    expect(events.filter((e) => e.type === "object-downloaded")).toHaveLength(2);
    const basic = `Basic ${btoa("u:p")}`;
    expect(seen).toEqual([
      ["POST", basic],
      ["GET", basic],
      ["GET", null],
    ]);
  });

  it("uploads call the verify action with the object's oid and size", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const a = await seedObject(store, resolver, prng(100, 5));
    const verified: unknown[] = [];
    const fetchImpl: FetchLike = async (request) => {
      if (request.url.endsWith("/objects/batch"))
        return batchAnswer([
          {
            ...a,
            actions: {
              upload: { href: `${URL}/objects/${a.oid}` },
              verify: { href: `${URL}/verify`, header: { "X-V": "1" } },
            },
          },
        ]);
      if (request.url.endsWith("/verify")) {
        verified.push([await request.json(), request.headers.get("x-v")]);
        return new Response("{}", { status: 200 });
      }
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    const events = await drain(lfsUpload(store, resolver, URL, [a], fetchImpl));
    expect(events).toContainEqual({ type: "object-uploaded", oid: a.oid });
    expect(verified).toEqual([[{ oid: a.oid, size: a.size }, "1"]]);
  });
});

/** A download response whose body breaks after `cut` bytes. */
function brokenBody(bytes: Uint8Array, cut: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes.slice(0, cut));
      } else controller.error(new TypeError("connection reset"));
    },
  });
}

describe("resumable downloads into a FilesApi store", () => {
  async function setup(size: number) {
    const bytes = prng(size, 20);
    const ptr: LfsPointer = { oid: await sha256Hex(bytes), size };
    const server = createFilesLfsStore(new MemFilesApi());
    await server.put(bytes, ptr);
    const handler = serveLfs(server);
    const files = new MemFilesApi();
    const local = createFilesLfsStore(files);
    return { bytes, ptr, handler, files, local };
  }

  it("keeps the bytes of a broken download and resumes with Range: bytes=N-", async () => {
    const { bytes, ptr, handler, files, local } = await setup(10_000);
    const ranges: (string | null)[] = [];
    let breakIt = true;
    const fetchImpl: FetchLike = async (request) => {
      const res = await handler(request);
      if (request.method !== "GET") return res;
      ranges.push(request.headers.get("range"));
      if (!breakIt) return res;
      breakIt = false;
      await res.body?.cancel();
      return new Response(brokenBody(bytes, 4000), { status: 200 });
    };
    const first = await drain(lfsDownload(local, URL, [ptr], fetchImpl));
    expect(first.find((e) => e.type === "error")).toBeDefined();
    expect(await local.size(ptr.oid)).toBeUndefined();
    expect(await local.partial?.size(ptr.oid)).toBe(4000);
    expect((await files.stats(`lfs/incomplete/${ptr.oid}.part`))?.kind).toBe("file");

    const second = await drain(lfsDownload(local, URL, [ptr], fetchImpl));
    expect(second).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(ranges).toEqual([null, "bytes=4000-"]);
    expect(await local.size(ptr.oid)).toBe(ptr.size);
    expect(await collect(local.read(ptr.oid))).toEqual(bytes);
    expect(await local.partial?.size(ptr.oid)).toBe(0);
  });

  it("a server answering 200 to a Range request restarts from zero", async () => {
    const { bytes, ptr, handler, local } = await setup(5000);
    await local.partial?.append(ptr.oid, [bytes.slice(0, 1000)]);
    const fetchImpl: FetchLike = async (request) => {
      const res = await handler(request);
      if (request.method !== "GET") return res;
      await res.body?.cancel();
      return new Response(bytes.slice(), { status: 200 }); // ignores the Range
    };
    const events = await drain(lfsDownload(local, URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(await collect(local.read(ptr.oid))).toEqual(bytes);
  });

  it("held bytes that do not hash to the oid are refused and dropped", async () => {
    const { bytes, ptr, handler, local } = await setup(5000);
    const bad = bytes.slice(0, 1000);
    bad[10] ^= 0xff;
    await local.partial?.append(ptr.oid, [bad]);
    const events = await drain(lfsDownload(local, URL, [ptr], handler));
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "sha256 mismatch" });
    expect(await local.size(ptr.oid)).toBeUndefined();
    expect(await local.partial?.size(ptr.oid)).toBe(0);
    // and the next attempt starts over and succeeds
    const again = await drain(lfsDownload(local, URL, [ptr], handler));
    expect(again).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
  });

  it("objects already held are not asked for", async () => {
    const { ptr, handler, local } = await setup(100);
    await drain(lfsDownload(local, URL, [ptr], handler));
    const fetchImpl: FetchLike = async () => {
      throw new Error("no request expected");
    };
    const events = await drain(lfsDownload(local, URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
  });

  it("upload from a FilesApi store to a server that holds some objects", async () => {
    const files = new MemFilesApi();
    const local = createFilesLfsStore(files);
    const x = prng(300, 30);
    const y = prng(400, 31);
    const px = { oid: await sha256Hex(x), size: x.length };
    const py = { oid: await sha256Hex(y), size: y.length };
    await local.put(x, px);
    await local.put(y, py);
    const server = createFilesLfsStore(new MemFilesApi());
    await server.put(x, px);
    const puts: string[] = [];
    const handler = serveLfs(server);
    const fetchImpl: FetchLike = async (request) => {
      if (request.method === "PUT") puts.push(request.url);
      return handler(request);
    };
    const events = await drain(lfsUpload(local, URL, [px, py], fetchImpl));
    expect(events).toContainEqual({ type: "object-uploaded", oid: py.oid });
    expect(puts).toEqual([`${URL}/objects/${py.oid}`]);
    expect(await server.size(py.oid)).toBe(py.size);
  });
});
