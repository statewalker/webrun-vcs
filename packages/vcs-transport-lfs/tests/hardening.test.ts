import type { ObjectId } from "@statewalker/webrun-content-store";
import { describe, expect, it } from "vitest";
import {
  type LfsPointer,
  type LfsResolver,
  lfsDownload,
  lfsUpload,
  parseLfsPointer,
  serveLfs,
  sha256Hex,
} from "../src/index.js";
import { collect, csHash, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://lfs.test";

/** A response body that records whether it was cancelled or read to its end. */
function trackedBody(chunks: Uint8Array[]) {
  const state = { cancelled: false, done: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++]);
        else {
          state.done = true;
          controller.close();
        }
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function put(oid: string, body: BodyInit, headers?: HeadersInit): Request {
  return new Request(`${URL}/objects/${oid}`, { method: "PUT", body, headers });
}

describe("a refused object is left for gc, never removed", () => {
  it("a lying PUT of the same bytes does not delete an object a correct PUT is recording", async () => {
    const bytes = prng(6000, 101);
    const realOid = await sha256Hex(bytes);
    const lyingOid = "f".repeat(64);
    const store = makeStore();
    const inner = memResolver();
    // A resolver whose writes take a while (a persistent map): the correct
    // upload has stored its object but not recorded it yet.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let recording: () => void = () => {};
    const started = new Promise<void>((r) => {
      recording = r;
    });
    const resolver: LfsResolver = {
      toObject: (oid) => inner.toObject(oid),
      async record(oid, id) {
        recording();
        await gate;
        await inner.record(oid, id);
      },
    };
    const handler = serveLfs(store, resolver);

    const correct = handler(put(realOid, bytes.slice()));
    await started; // stored, recording in progress
    const lying = await handler(put(lyingOid, bytes.slice()));
    expect(lying.status).toBe(422);
    release();
    expect((await correct).status).toBe(200);

    const res = await handler(new Request(`${URL}/objects/${realOid}`));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("a refused PUT is not recorded, and gc over the resolver's ids reclaims it", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const kept = await seedObject(store, resolver, prng(3000, 102));
    const payload = prng(4000, 103);
    const lyingOid = "a".repeat(64);
    const res = await serveLfs(store, resolver)(put(lyingOid, payload));
    expect(res.status).toBe(422);
    expect(await resolver.toObject(lyingOid)).toBeUndefined();

    const id = await csHash(
      (async function* () {
        yield payload;
      })(),
    );
    expect(await store.has(id)).toBe(true); // left for gc
    const swept = await store.gc(resolver.roots());
    expect(swept.removedObjects).toBe(1);
    expect(await store.has(id)).toBe(false);
    const keptId = (await resolver.toObject(kept.oid)) as ObjectId;
    expect(await store.has(keptId)).toBe(true);
  });

  it("a refused download is not recorded, and gc over the resolver's ids reclaims it", async () => {
    const served = prng(5000, 104);
    const ptr = { oid: "b".repeat(64), size: served.length };
    const store = makeStore();
    const resolver = memResolver();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") {
        return Response.json({
          transfer: "basic",
          objects: [{ ...ptr, actions: { download: { href: `${URL}/o/${ptr.oid}` } } }],
        });
      }
      return new Response(served.slice());
    };
    const events = await drain(lfsDownload(store, resolver, URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "sha256 mismatch" });
    expect(await resolver.toObject(ptr.oid)).toBeUndefined();
    expect((await store.gc(resolver.roots())).removedObjects).toBe(1);
  });
});

describe("lfsUpload: per-object failures never stop the batch", () => {
  async function twoObjects() {
    const store = makeStore();
    const resolver = memResolver();
    const a = await seedObject(store, resolver, prng(2000, 111));
    const b = await seedObject(store, resolver, prng(3000, 112));
    return { store, resolver, a, b };
  }

  function uploadBatch(objects: LfsPointer[]): Response {
    return Response.json({
      transfer: "basic",
      objects: objects.map((o) => ({
        ...o,
        actions: { upload: { href: `${URL}/o/${o.oid}` } },
      })),
    });
  }

  it("takes content-length from the local object; a wrong batch size errors that object only", async () => {
    const { store, resolver, a, b } = await twoObjects();
    const lengths = new Map<string, string | null>();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return uploadBatch([{ ...a, size: a.size + 7 }, b]);
      lengths.set(request.url, request.headers.get("content-length"));
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    const events = await drain(lfsUpload(store, resolver, URL, [a, b], fetchImpl));
    expect(events.find((e) => e.type === "error")).toMatchObject({ oid: a.oid });
    expect(events).not.toContainEqual({ type: "object-uploaded", oid: a.oid });
    expect(events).toContainEqual({ type: "object-uploaded", oid: b.oid });
    expect(lengths.has(`${URL}/o/${a.oid}`)).toBe(false);
    expect(lengths.get(`${URL}/o/${b.oid}`)).toBe(String(b.size));
  });

  it("an object whose local size disagrees with the requested pointer is an error", async () => {
    const { store, resolver, a, b } = await twoObjects();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return uploadBatch([a, b]);
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    const events = await drain(
      lfsUpload(store, resolver, URL, [{ ...a, size: a.size - 1 }, b], fetchImpl),
    );
    expect(events.find((e) => e.type === "error")).toMatchObject({ oid: a.oid });
    expect(events).toContainEqual({ type: "object-uploaded", oid: b.oid });
  });

  it("a fetch that rejects for one object becomes its error event; the rest still upload", async () => {
    const { store, resolver, a, b } = await twoObjects();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return uploadBatch([a, b]);
      if (request.url.endsWith(a.oid)) throw new TypeError("connection reset");
      await request.arrayBuffer();
      return new Response(null, { status: 200 });
    };
    const events = await drain(lfsUpload(store, resolver, URL, [a, b], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: a.oid, reason: "connection reset" });
    expect(events).toContainEqual({ type: "object-uploaded", oid: b.oid });
  });
});

describe("responses that are not read are released", () => {
  it("cancels the body of an upload response", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const a = await seedObject(store, resolver, prng(1000, 121));
    const body = trackedBody([new Uint8Array(10), new Uint8Array(10)]);
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") {
        return Response.json({
          transfer: "basic",
          objects: [{ ...a, actions: { upload: { href: `${URL}/o/${a.oid}` } } }],
        });
      }
      await request.arrayBuffer();
      return new Response(body.stream, { status: 200 });
    };
    const events = await drain(lfsUpload(store, resolver, URL, [a], fetchImpl));
    expect(events).toContainEqual({ type: "object-uploaded", oid: a.oid });
    expect(body.state.cancelled || body.state.done).toBe(true);
  });

  it("cancels the body of a download response that is not ok", async () => {
    const ptr = { oid: "c".repeat(64), size: 10 };
    const body = trackedBody([new TextEncoder().encode("forbidden")]);
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") {
        return Response.json({
          transfer: "basic",
          objects: [{ ...ptr, actions: { download: { href: `${URL}/o/${ptr.oid}` } } }],
        });
      }
      return new Response(body.stream, { status: 403 });
    };
    const events = await drain(lfsDownload(makeStore(), memResolver(), URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "download failed: 403" });
    expect(body.state.cancelled || body.state.done).toBe(true);
  });

  it("cancels the body of a download that runs past the pointer size", async () => {
    const chunks = Array.from({ length: 100 }, (_, i) => prng(1000, 200 + i));
    const body = trackedBody(chunks);
    const ptr = { oid: "d".repeat(64), size: 2500 };
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") {
        return Response.json({
          transfer: "basic",
          objects: [{ ...ptr, actions: { download: { href: `${URL}/o/${ptr.oid}` } } }],
        });
      }
      return new Response(body.stream);
    };
    const events = await drain(lfsDownload(makeStore(), memResolver(), URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "size mismatch" });
    expect(body.state.cancelled).toBe(true);
    expect(body.state.pulled).toBeLessThan(10);
  });
});

describe("serveLfs caps a PUT at its content-length", () => {
  it("refuses a PUT body longer than its content-length, writing no object", async () => {
    const payload = prng(5000, 131);
    const oid = await sha256Hex(payload);
    const store = makeStore();
    const resolver = memResolver();
    const res = await serveLfs(
      store,
      resolver,
    )(put(oid, payload, { "content-length": String(payload.length - 1000) }));
    expect(res.status).toBe(422);
    expect(await resolver.toObject(oid)).toBeUndefined();
    const id = await csHash(
      (async function* () {
        yield payload;
      })(),
    );
    expect(await store.has(id)).toBe(false);
  });

  it("still accepts a PUT whose body matches its content-length", async () => {
    const payload = prng(5000, 132);
    const oid = await sha256Hex(payload);
    const store = makeStore();
    const resolver = memResolver();
    const res = await serveLfs(
      store,
      resolver,
    )(put(oid, payload, { "content-length": String(payload.length) }));
    expect(res.status).toBe(200);
    expect(await collect(store.read((await resolver.toObject(oid)) as ObjectId))).toEqual(payload);
  });
});

describe("parseLfsPointer follows the git-lfs pointer spec", () => {
  const V = "version https://git-lfs.github.com/spec/v1";
  const oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";

  it("accepts version first and the other keys in alphabetical order", () => {
    expect(parseLfsPointer(`${V}\noid sha256:${oid}\nsize 12345\n`)).toEqual({ oid, size: 12345 });
    expect(
      parseLfsPointer(`${V}\next-0-foo sha256:${"0".repeat(64)}\noid sha256:${oid}\nsize 1\n`),
    ).toEqual({ oid, size: 1 });
  });

  it("rejects keys out of order", () => {
    expect(parseLfsPointer(`${V}\nsize 12345\noid sha256:${oid}\n`)).toBeUndefined();
    expect(parseLfsPointer(`oid sha256:${oid}\n${V}\nsize 1\n`)).toBeUndefined();
    expect(parseLfsPointer(`${V}\noid sha256:${oid}\noid sha256:${oid}\nsize 1\n`)).toBeUndefined();
  });

  it("rejects a size that is not a safe integer", () => {
    expect(parseLfsPointer(`${V}\noid sha256:${oid}\nsize 9007199254740993\n`)).toBeUndefined();
    expect(parseLfsPointer(`${V}\noid sha256:${oid}\nsize ${"9".repeat(400)}\n`)).toBeUndefined();
  });
});
