import type { FilesApi } from "@statewalker/vcs-utils/files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  createFilesLfsStore,
  type FetchLike,
  LFS_CONTENT_TYPE,
  type LfsPointer,
  lfsDownload,
  serveLfs,
  sha256Hex,
} from "../src/index.js";
import { drain, prng } from "./helpers.js";

/** Regression tests for the P3.7 review findings. */
const ENDPOINT = "https://lfs.example/repo.git/info/lfs";

async function listFiles(files: FilesApi, path: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await files.exists(path))) return out;
  for await (const e of files.list(path, { recursive: true }))
    if (e.kind === "file") out.push(e.path);
  return out;
}

function batchWith(objects: unknown[]): Response {
  return new Response(JSON.stringify({ transfer: "basic", objects }), {
    headers: { "content-type": LFS_CONTENT_TYPE },
  });
}

describe("client credentials stay with the endpoint's origin", () => {
  async function run(href: string, extra: Record<string, unknown> = {}) {
    const bytes = new TextEncoder().encode("hello");
    const oid = await sha256Hex(bytes);
    const seen: {
      url: string;
      auth: string | null;
      token: string | null;
      action: string | null;
    }[] = [];
    const fetchImpl: FetchLike = async (request) => {
      seen.push({
        url: request.url,
        auth: request.headers.get("authorization"),
        token: request.headers.get("x-token"),
        action: request.headers.get("x-action"),
      });
      if (request.url.endsWith("/objects/batch"))
        return batchWith([
          { oid, size: 5, actions: { download: { href, header: { "X-Action": "a" } } } },
        ]);
      return new Response(bytes);
    };
    const events = await drain(
      lfsDownload(createFilesLfsStore(new MemFilesApi()), ENDPOINT, [{ oid, size: 5 }], fetchImpl, {
        credentials: { username: "u", password: "p" },
        headers: { "x-token": "secret" },
        ...extra,
      }),
    );
    expect(events).toContainEqual({ type: "object-downloaded", oid });
    return seen;
  }

  it("a foreign action host gets neither credentials nor client headers, only the action's", async () => {
    const seen = await run("https://other-host.example/blob");
    expect(seen[0]?.auth).toMatch(/^Basic /); // the batch, on the endpoint
    expect(seen[1]).toEqual({
      url: "https://other-host.example/blob",
      auth: null,
      token: null,
      action: "a",
    });
  });

  it("an action on the endpoint's origin gets them", async () => {
    const seen = await run("https://lfs.example/objects/blob");
    expect(seen[1]?.auth).toBe(`Basic ${btoa("u:p")}`);
    expect(seen[1]?.token).toBe("secret");
    expect(seen[1]?.action).toBe("a");
  });

  it("headersFor gives headers for other origins", async () => {
    const seen = await run("https://cdn.example/blob", {
      headersFor: (href: string) =>
        new URL(href).origin === "https://cdn.example"
          ? { authorization: "Bearer cdn" }
          : undefined,
    });
    expect(seen[1]?.auth).toBe("Bearer cdn");
    expect(seen[1]?.token).toBeNull();
  });
});

describe("resume answers git-lfs restarts from zero", () => {
  async function setup() {
    const bytes = prng(10, 1);
    const ptr: LfsPointer = { oid: await sha256Hex(bytes), size: 10 };
    const files = new MemFilesApi();
    const store = createFilesLfsStore(files);
    await store.partial?.append(ptr.oid, [bytes.subarray(0, 4)]);
    return { bytes, ptr, files, store };
  }

  function server(bytes: Uint8Array, firstAnswer: () => Response) {
    const ranges: (string | null)[] = [];
    let first = true;
    const fetchImpl: FetchLike = async (request) => {
      if (request.url.endsWith("/objects/batch"))
        return batchWith([
          {
            oid: await sha256Hex(bytes),
            size: 10,
            actions: { download: { href: `${ENDPOINT}/o` } },
          },
        ]);
      ranges.push(request.headers.get("range"));
      if (first) {
        first = false;
        return firstAnswer();
      }
      return new Response(bytes.slice(), { status: 200 });
    };
    return { fetchImpl, ranges };
  }

  it("a 206 from another offset drops the partial and starts again from 0", async () => {
    const { bytes, ptr, store } = await setup();
    const { fetchImpl, ranges } = server(
      bytes,
      () =>
        new Response(bytes.slice(2), { status: 206, headers: { "content-range": "bytes 2-9/10" } }),
    );
    const events = await drain(lfsDownload(store, ENDPOINT, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(ranges).toEqual(["bytes=4-", null]);
    expect(await store.partial?.size(ptr.oid)).toBe(0);
  });

  it("a 206 without Content-Range does the same", async () => {
    const { bytes, ptr, store } = await setup();
    const { fetchImpl, ranges } = server(
      bytes,
      () => new Response(bytes.slice(4), { status: 206 }),
    );
    const events = await drain(lfsDownload(store, ENDPOINT, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(ranges).toEqual(["bytes=4-", null]);
  });

  it("a 416 drops the partial and starts again from 0", async () => {
    const { bytes, ptr, store } = await setup();
    const { fetchImpl, ranges } = server(
      bytes,
      () => new Response(null, { status: 416, headers: { "content-range": "bytes */10" } }),
    );
    const events = await drain(lfsDownload(store, ENDPOINT, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(ranges).toEqual(["bytes=4-", null]);
  });

  it("restarts once only: a second bad answer is an error with nothing kept", async () => {
    const { ptr, store } = await setup();
    const fetchImpl: FetchLike = async (request) => {
      if (request.url.endsWith("/objects/batch"))
        return batchWith([{ ...ptr, actions: { download: { href: `${ENDPOINT}/o` } } }]);
      return new Response(null, { status: 416 });
    };
    const events = await drain(lfsDownload(store, ENDPOINT, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "download failed: 416" });
    expect(await store.partial?.size(ptr.oid)).toBe(0);
  });
});

/** A MemFilesApi whose `move` misbehaves. */
function withMove(move: FilesApi["move"]): FilesApi {
  const files = new MemFilesApi();
  return new Proxy(files, {
    get(target, prop, receiver) {
      if (prop === "move") return move.bind(target);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FilesApi;
}

describe("files store moves", () => {
  it("a move that throws leaves no temporary file, and the error surfaces", async () => {
    const files = withMove(async () => {
      throw new Error("disk on fire");
    });
    const store = createFilesLfsStore(files);
    const bytes = prng(100, 2);
    const oid = await sha256Hex(bytes);
    await expect(store.put(bytes, { oid, size: 100 })).rejects.toThrow("disk on fire");
    await expect(store.partial?.append(oid, [bytes])).rejects.toThrow("disk on fire");
    expect(await listFiles(files, "lfs")).toEqual([]);
  });

  it("a copy-then-delete move that could not remove its source is completed", async () => {
    let real: FilesApi["move"] | undefined;
    const files = withMove(async function (this: FilesApi, source, target) {
      real ??= MemFilesApi.prototype.move;
      await real.call(this, source, target);
      // the target is written; pretend the source removal failed half way
      const error = new Error("source left behind");
      error.name = "MoveIncompleteError";
      throw error;
    });
    const store = createFilesLfsStore(files);
    const bytes = prng(100, 3);
    const oid = await sha256Hex(bytes);
    expect(await store.put(bytes, { oid, size: 100 })).toEqual({ ok: true, size: 100 });
    expect(await store.size(oid)).toBe(100);
    expect(await listFiles(files, "lfs/tmp")).toEqual([]);
  });

  it("an aborted PUT leaves no temporary file", async () => {
    const files = new MemFilesApi();
    const handler = serveLfs(createFilesLfsStore(files));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new Error("client went away"));
      },
    });
    await handler(
      new Request(`http://h/info/lfs/objects/${"a".repeat(64)}`, {
        method: "PUT",
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(await listFiles(files, "lfs")).toEqual([]);
  });
});

describe("partials shared by stores over one FilesApi", () => {
  it("two store instances over the same files and root serialize their downloads", async () => {
    const files = new MemFilesApi();
    const a = createFilesLfsStore(files, "repo");
    const b = createFilesLfsStore(files, "repo/");
    const order: string[] = [];
    const first = a.partial?.exclusive?.("f".repeat(64), async () => {
      order.push("a start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a end");
    });
    const second = b.partial?.exclusive?.("f".repeat(64), async () => {
      order.push("b");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });

  it("append refuses to write the new bytes after a partial that vanished mid-read", async () => {
    const files = new MemFilesApi();
    const store = createFilesLfsStore(files);
    const oid = "e".repeat(64);
    await store.partial?.append(oid, [prng(100, 4)]);
    const realRead = files.read.bind(files);
    // the .part is removed by someone else while it is being copied
    (files as { read: FilesApi["read"] }).read = (path, options) => {
      if (path.endsWith(".part")) {
        return (async function* () {
          await files.remove(path);
          yield* realRead(path, options);
        })();
      }
      return realRead(path, options);
    };
    let pulled = false;
    async function* tail() {
      pulled = true;
      yield prng(10, 5);
    }
    await expect(store.partial?.append(oid, tail())).rejects.toThrow(/changed/);
    expect(pulled).toBe(false);
    expect(await store.partial?.size(oid)).toBe(0);
    expect(await listFiles(files, "lfs/tmp")).toEqual([]);
  });
});

describe("server authorizes before validating", () => {
  const deny = { authorize: () => false };

  it("an unauthenticated verify with a malformed body is 401, not 422", async () => {
    const handler = serveLfs(createFilesLfsStore(new MemFilesApi()), deny);
    const res = await handler(
      new Request("http://h/info/lfs/verify", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(401);
  });

  it("an unauthenticated PUT with an invalid oid is 401, not 422", async () => {
    const handler = serveLfs(createFilesLfsStore(new MemFilesApi()), deny);
    const res = await handler(
      new Request("http://h/info/lfs/objects/nope", { method: "PUT", body: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("with transferAuth, a malformed verify is refused as unauthorized", async () => {
    const handler = serveLfs(createFilesLfsStore(new MemFilesApi()), {
      transferAuth: { header: () => ({}), check: () => false },
    });
    const res = await handler(
      new Request("http://h/info/lfs/verify", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("server errors do not leak", () => {
  it("a 500 says nothing internal, carries a request_id, and reaches onError", async () => {
    const errors: [unknown, string][] = [];
    const broken = createFilesLfsStore(new MemFilesApi());
    broken.size = async () => {
      throw new Error("secret /var/db/path exploded");
    };
    const handler = serveLfs(broken, {
      onError: (error, _request, requestId) => void errors.push([error, requestId]),
    });
    const res = await handler(new Request(`http://h/info/lfs/objects/${"a".repeat(64)}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string; request_id: string };
    expect(body.message).not.toContain("secret");
    expect(typeof body.request_id).toBe("string");
    expect(errors).toHaveLength(1);
    expect((errors[0] as [Error, string])[0].message).toContain("secret");
    expect(errors[0]?.[1]).toBe(body.request_id);
  });
});
