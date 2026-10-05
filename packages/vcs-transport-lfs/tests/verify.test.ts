import { describe, expect, it } from "vitest";
import { lfsDownload, serveLfs } from "../src/index.js";
import { collect, drain, makeStore, memResolver, prng, seedObject, streamOf } from "./helpers.js";

const URL = "http://lfs.test";

describe("whole-object SHA-256 verification", () => {
  it("PUT of bytes not matching the oid is rejected (422) and never stored", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const handler = serveLfs(store, resolver);

    const lyingOid = "b".repeat(64); // not the sha256 of the payload
    const payload = prng(1500, 42);

    const res = await handler(
      new Request(`${URL}/objects/${lyingOid}`, {
        method: "PUT",
        body: payload,
      }),
    );

    expect(res.status).toBe(422);
    // Nothing was stored, no mapping recorded.
    expect(await resolver.toObject(lyingOid)).toBeUndefined();
  });

  it("download whose server bytes do not hash to the oid is rejected, never assembled", async () => {
    // Server stores real bytes but maps them under a WRONG (lying) oid.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const realBytes = prng(2000, 11);
    const d = await serverStore.put(streamOf(realBytes));
    const lyingOid = "c".repeat(64);
    await serverResolver.record(lyingOid, d.id);
    const handler = serveLfs(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();

    const events = await drain(
      lfsDownload(
        clientStore,
        clientResolver,
        URL,
        [{ oid: lyingOid, size: realBytes.length }],
        handler,
      ),
    );

    expect(events.some((e) => e.type === "error" && e.oid === lyingOid)).toBe(true);
    expect(events.some((e) => e.type === "object-downloaded")).toBe(false);
    // Nothing corrupt was assembled into the local store.
    expect(await clientResolver.toObject(lyingOid)).toBeUndefined();
  });

  it("a well-formed object still round-trips (sanity)", async () => {
    const bytes = prng(2000, 12);
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const ptr = await seedObject(serverStore, serverResolver, bytes);
    const handler = serveLfs(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    await drain(lfsDownload(clientStore, clientResolver, URL, [ptr], handler));

    const id = await clientResolver.toObject(ptr.oid);
    if (!id) throw new Error("mapping missing");
    expect(await collect(clientStore.read(id))).toEqual(bytes);
  });
});
