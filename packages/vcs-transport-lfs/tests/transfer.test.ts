import { describe, expect, it } from "vitest";
import { lfsDownload, lfsUpload, serveLfs, sha256Hex } from "../src/index.js";
import { collect, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://lfs.test";

describe("lfs basic transfer (loopback)", () => {
  it("upload: the whole object lands in the server's content-store + resolver map", async () => {
    const bytes = prng(5000, 7);

    // Client side: object present locally, mapping known.
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const ptr = await seedObject(clientStore, clientResolver, bytes);

    // Server side: empty, waiting to receive.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveLfs(serverStore, serverResolver);

    const events = await drain(lfsUpload(clientStore, clientResolver, URL, [ptr], handler));

    expect(events).toContainEqual({ type: "batch", operation: "upload", count: 1 });
    expect(events).toContainEqual({ type: "object-uploaded", oid: ptr.oid });

    // The server reconstructed + stored the whole object under ITS content-store id.
    const serverObjId = await serverResolver.toObject(ptr.oid);
    expect(serverObjId).toBeDefined();
    if (!serverObjId) throw new Error("unreachable");
    expect(await serverStore.has(serverObjId)).toBe(true);
    expect(await collect(serverStore.read(serverObjId))).toEqual(bytes);
  });

  it("download: fetch a whole object by sha256 oid into the local content-store", async () => {
    const bytes = prng(9000, 13);

    // Server side: object present.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const ptr = await seedObject(serverStore, serverResolver, bytes);
    const handler = serveLfs(serverStore, serverResolver);

    // Client side: empty.
    const clientStore = makeStore();
    const clientResolver = memResolver();

    const events = await drain(lfsDownload(clientStore, clientResolver, URL, [ptr], handler));

    expect(events).toContainEqual({ type: "batch", operation: "download", count: 1 });
    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });

    const clientObjId = await clientResolver.toObject(ptr.oid);
    expect(clientObjId).toBeDefined();
    if (!clientObjId) throw new Error("unreachable");
    const got = await collect(clientStore.read(clientObjId));
    expect(got).toEqual(bytes);
    // The reassembled bytes hash to the original LFS oid.
    expect(await sha256Hex(got)).toBe(ptr.oid);
  });

  it("round-trips upload then download to a fresh client, yielding the original bytes", async () => {
    const bytes = prng(3333, 99);

    const uploader = makeStore();
    const uploaderResolver = memResolver();
    const ptr = await seedObject(uploader, uploaderResolver, bytes);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveLfs(serverStore, serverResolver);

    await drain(lfsUpload(uploader, uploaderResolver, URL, [ptr], handler));

    const downloader = makeStore();
    const downloaderResolver = memResolver();
    await drain(lfsDownload(downloader, downloaderResolver, URL, [ptr], handler));

    const id = await downloaderResolver.toObject(ptr.oid);
    if (!id) throw new Error("mapping missing");
    expect(await collect(downloader.read(id))).toEqual(bytes);
  });
});
