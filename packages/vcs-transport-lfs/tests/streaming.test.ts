import { createHash, randomBytes } from "node:crypto";
import type { ByteStream, ContentStore } from "@statewalker/webrun-content-store";
import { describe, expect, it } from "vitest";
import {
  createLfsPointer,
  formatLfsPointer,
  type LfsPointer,
  lfsDownload,
  lfsUpload,
  parseLfsPointer,
  serveLfs,
  sha256Hex,
} from "../src/index.js";
import { collect, csHash, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://lfs.test";
const CHUNK = 64 * 1024;
const BIG = 50 * 1024 * 1024; // 800 chunks of 64 KiB
/** How far a producer may run ahead of its consumer (bytes) before the test fails. */
const READ_AHEAD = 8 * CHUNK;

/**
 * A lazily generated large object: chunk `i` is a fixed random block stamped
 * with `i`, produced only when pulled. `produced` counts the bytes handed out.
 */
function lazyObject(size: number) {
  const base = new Uint8Array(randomBytes(CHUNK));
  const counter = { produced: 0 };
  const chunkAt = (i: number) => {
    const len = Math.min(CHUNK, size - i * CHUNK);
    const out = base.slice(0, len);
    new DataView(out.buffer).setUint32(0, i);
    return out;
  };
  const count = Math.ceil(size / CHUNK);
  const pointer = (): LfsPointer => {
    const h = createHash("sha256");
    for (let i = 0; i < count; i++) h.update(chunkAt(i));
    return { oid: h.digest("hex"), size };
  };
  async function* chunks(): ByteStream {
    for (let i = 0; i < count; i++) {
      const c = chunkAt(i);
      counter.produced += c.length;
      yield c;
    }
  }
  return { counter, chunks, pointer };
}

/** A pull-driven ReadableStream: the next chunk is produced only when read. */
function pullStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const r = await it.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Wrap a store so `put` reports each byte it consumes, checking the read-ahead. */
function watchedStore(
  inner: ContentStore,
  counter: { produced: number },
): ContentStore & { maxAhead: () => number; consumed: () => number } {
  let consumed = 0;
  let maxAhead = 0;
  return {
    ...inner,
    put(content) {
      async function* watched(): ByteStream {
        for await (const chunk of content) {
          // Produced but not yet consumed when this chunk arrives (the chunk included)
          maxAhead = Math.max(maxAhead, counter.produced - consumed);
          consumed += chunk.length;
          yield chunk;
        }
      }
      return inner.put(watched());
    },
    maxAhead: () => maxAhead,
    consumed: () => consumed,
  };
}

function batchResponse(operation: "upload" | "download", ptr: LfsPointer): Response {
  return Response.json({
    transfer: "basic",
    objects: [
      { oid: ptr.oid, size: ptr.size, actions: { [operation]: { href: `${URL}/o/${ptr.oid}` } } },
    ],
  });
}

describe("sha256Hex and pointers hash content as a stream", () => {
  it("sha256Hex accepts a byte stream and matches Node's digest", async () => {
    const bytes = prng(200_000, 5);
    async function* pieces(): ByteStream {
      for (let i = 0; i < bytes.length; i += 777) yield bytes.subarray(i, i + 777);
    }
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256Hex(pieces())).toBe(expected);
    expect(await sha256Hex(bytes)).toBe(expected);
  });

  it("createLfsPointer streams the content; format and parse round-trip the pointer file", async () => {
    const { chunks, pointer } = lazyObject(3 * CHUNK + 17);
    const ptr = await createLfsPointer(chunks());
    expect(ptr).toEqual(pointer());
    const text = formatLfsPointer(ptr);
    expect(text).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${ptr.oid}\nsize ${ptr.size}\n`,
    );
    expect(parseLfsPointer(text)).toEqual(ptr);
    expect(parseLfsPointer("not a pointer")).toBeUndefined();
  });
});

describe("lfsUpload streams the request body", () => {
  it("sends a lazily generated 50 MiB object as a stream consumed incrementally", async () => {
    const obj = lazyObject(BIG);
    const ptr = obj.pointer();
    const store = {
      read: () => obj.chunks(),
      getManifest: async () => ({ size: BIG }),
    } as unknown as ContentStore;
    const resolver = memResolver();
    await resolver.record(ptr.oid, "local-id");

    let streamed = false;
    let maxAhead = 0;
    let received = 0;
    const hash = createHash("sha256");
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return batchResponse("upload", ptr);
      streamed = (request as Request & { duplex?: string }).duplex === "half";
      const reader = (request.body as ReadableStream<Uint8Array>).getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        maxAhead = Math.max(maxAhead, obj.counter.produced - received);
        received += r.value.length;
        hash.update(r.value);
      }
      return new Response(null, { status: 200 });
    };

    const events = await drain(lfsUpload(store, resolver, URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-uploaded", oid: ptr.oid });
    expect(streamed).toBe(true);
    expect(received).toBe(BIG);
    expect(hash.digest("hex")).toBe(ptr.oid);
    expect(maxAhead).toBeLessThanOrEqual(READ_AHEAD);
  }, 60_000);
});

describe("lfsDownload hashes while it stores", () => {
  it("stores a 50 MiB download with bounded read-ahead and verifies it", async () => {
    const obj = lazyObject(BIG);
    const ptr = obj.pointer();
    const store = watchedStore(makeStore(), obj.counter);
    const resolver = memResolver();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return batchResponse("download", ptr);
      return new Response(pullStream(obj.chunks()), { status: 200 });
    };

    const events = await drain(lfsDownload(store, resolver, URL, [ptr], fetchImpl));
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(store.consumed()).toBe(BIG);
    expect(store.maxAhead()).toBeLessThanOrEqual(READ_AHEAD);
    const id = await resolver.toObject(ptr.oid);
    expect(id).toBeDefined();
    expect(await store.getManifest(id as string)).toMatchObject({ size: BIG });
  }, 60_000);

  async function corrupted(served: Uint8Array, ptr: LfsPointer) {
    const store = makeStore();
    const resolver = memResolver();
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return batchResponse("download", ptr);
      return new Response(
        pullStream(
          (async function* () {
            yield served;
          })(),
        ),
      );
    };
    const events = await drain(lfsDownload(store, resolver, URL, [ptr], fetchImpl));
    const storedId = await csHash(
      (async function* () {
        yield served;
      })(),
    );
    return { events, store, resolver, storedId };
  }

  it("refuses a download whose bytes do not hash to the oid, recording nothing; gc reclaims it", async () => {
    const served = prng(5000, 11);
    const ptr = { oid: "c".repeat(64), size: served.length };
    const { events, store, resolver, storedId } = await corrupted(served, ptr);
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "sha256 mismatch" });
    expect(await resolver.toObject(ptr.oid)).toBeUndefined();
    expect(await store.has(storedId)).toBe(true); // not removed: left for gc
    await store.gc(resolver.roots());
    expect(await store.has(storedId)).toBe(false);
  });

  it("refuses a download shorter than the pointer size, recording nothing; gc reclaims it", async () => {
    const real = prng(5000, 12);
    const served = real.subarray(0, 4000);
    const ptr = { oid: await sha256Hex(real), size: real.length };
    const { events, store, resolver, storedId } = await corrupted(served, ptr);
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "size mismatch" });
    expect(await resolver.toObject(ptr.oid)).toBeUndefined();
    expect(await store.has(storedId)).toBe(true); // not removed: left for gc
    await store.gc(resolver.roots());
    expect(await store.has(storedId)).toBe(false);
  });

  it("refuses a download longer than the pointer size, leaving nothing stored", async () => {
    const served = prng(5000, 13);
    const ptr = { oid: await sha256Hex(served), size: 4000 };
    const { events, store, resolver, storedId } = await corrupted(served, ptr);
    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "size mismatch" });
    expect(await resolver.toObject(ptr.oid)).toBeUndefined();
    expect(await store.has(storedId)).toBe(false);
  });

  it("keeps an object already stored for its real oid when a lying download repeats it", async () => {
    const bytes = prng(5000, 14);
    const store = makeStore();
    const resolver = memResolver();
    const real = await seedObject(store, resolver, bytes);
    const lie = { oid: "d".repeat(64), size: bytes.length };
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.method === "POST") return batchResponse("download", lie);
      return new Response(bytes);
    };
    const events = await drain(lfsDownload(store, resolver, URL, [lie], fetchImpl));
    expect(events).toContainEqual({ type: "error", oid: lie.oid, reason: "sha256 mismatch" });
    const id = (await resolver.toObject(real.oid)) as string;
    expect(await collect(store.read(id))).toEqual(bytes);
  });
});

describe("serveLfs streams uploads and downloads", () => {
  it("hashes a streamed 50 MiB PUT while storing it, with bounded read-ahead", async () => {
    const obj = lazyObject(BIG);
    const ptr = obj.pointer();
    const store = watchedStore(makeStore(), obj.counter);
    const resolver = memResolver();
    const handler = serveLfs(store, resolver);
    const res = await handler(
      new Request(`${URL}/objects/${ptr.oid}`, {
        method: "PUT",
        body: pullStream(obj.chunks()),
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(200);
    expect(store.consumed()).toBe(BIG);
    expect(store.maxAhead()).toBeLessThanOrEqual(READ_AHEAD);
    expect(await resolver.toObject(ptr.oid)).toBeDefined();
  }, 60_000);

  it("refuses a streamed PUT whose bytes do not hash to the oid, recording nothing; gc reclaims it", async () => {
    const payload = prng(4000, 21);
    const store = makeStore();
    const resolver = memResolver();
    const handler = serveLfs(store, resolver);
    const oid = "e".repeat(64);
    const res = await handler(
      new Request(`${URL}/objects/${oid}`, {
        method: "PUT",
        body: pullStream(
          (async function* () {
            yield payload;
          })(),
        ),
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(422);
    expect(await resolver.toObject(oid)).toBeUndefined();
    const storedId = await csHash(
      (async function* () {
        yield payload;
      })(),
    );
    expect(await store.has(storedId)).toBe(true); // not removed: left for gc
    await store.gc(resolver.roots());
    expect(await store.has(storedId)).toBe(false);
  });

  it("serves a GET as a stream with the object's content-length", async () => {
    const bytes = prng(300_000, 22);
    const store = makeStore();
    const resolver = memResolver();
    const ptr = await seedObject(store, resolver, bytes);
    const res = await serveLfs(store, resolver)(new Request(`${URL}/objects/${ptr.oid}`));
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
