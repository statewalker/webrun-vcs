import { describe, expect, it } from "vitest";
import type { BatchResponse } from "../src/index.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE, serveLfs } from "../src/index.js";
import { makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://lfs.test";

async function batch(handler: (r: Request) => Response | Promise<Response>, body: unknown) {
  const res = await handler(
    new Request(`${URL}/objects/batch`, {
      method: "POST",
      headers: { "content-type": LFS_CONTENT_TYPE, accept: LFS_CONTENT_TYPE },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json()) as BatchResponse };
}

describe("standard LFS batch shape + basic transfer", () => {
  it("download batch response carries basic-transfer download actions with an href", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const ptr = await seedObject(store, resolver, prng(2048, 3));
    const handler = serveLfs(store, resolver);

    const { res, json } = await batch(handler, {
      operation: "download",
      transfers: [BASIC_TRANSFER],
      objects: [{ oid: ptr.oid, size: ptr.size }],
    });

    expect(res.status).toBe(200);
    expect(json.transfer).toBe("basic");
    expect(json.objects).toHaveLength(1);
    const o = json.objects[0];
    expect(o.oid).toBe(ptr.oid);
    expect(o.size).toBe(ptr.size);
    expect(o.actions?.download?.href).toContain(`/objects/${ptr.oid}`);
    expect(o.error).toBeUndefined();
  });

  it("upload batch response carries a basic-transfer upload action", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const handler = serveLfs(store, resolver);
    const oid = "a".repeat(64);

    const { json } = await batch(handler, {
      operation: "upload",
      transfers: [BASIC_TRANSFER],
      objects: [{ oid, size: 10 }],
    });

    expect(json.transfer).toBe("basic");
    expect(json.objects[0].actions?.upload?.href).toContain(`/objects/${oid}`);
  });

  it("basic transfer moves the whole object as a plain PUT/GET body", async () => {
    const bytes = prng(1000, 5);
    const store = makeStore();
    const resolver = memResolver();
    const ptr = await seedObject(store, resolver, bytes);
    const handler = serveLfs(store, resolver);

    // GET the download href → the raw whole-object bytes.
    const getRes = await handler(new Request(`${URL}/objects/${ptr.oid}`, { method: "GET" }));
    expect(getRes.status).toBe(200);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(bytes);
  });
});
