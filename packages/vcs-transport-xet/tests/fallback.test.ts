import { serveLfs, sha256Hex } from "@statewalker/vcs-transport-lfs";
import { describe, expect, it } from "vitest";
import { xetDownload, xetUpload } from "../src/index.js";
import { collect, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

const URL = "http://basic.test";

describe("basic-LFS fallback (server offers no xet)", () => {
  it("upload falls back to whole-object LFS and lands the object on the server", async () => {
    const bytes = prng(5000, 41);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { ptr } = await seedObject(clientStore, clientResolver, bytes);

    // A basic-only server: serveLfs never advertises xet.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveLfs(serverStore, serverResolver);

    const events = await drain(
      xetUpload(clientStore, clientResolver, URL, [ptr], { fetchImpl: handler }),
    );

    expect(events).toContainEqual({ type: "batch", operation: "upload", count: 1 });
    expect(events).toContainEqual({ type: "object-uploaded", oid: ptr.oid });

    const serverId = await serverResolver.toObject(ptr.oid);
    if (!serverId) throw new Error("mapping missing");
    expect(await collect(serverStore.read(serverId))).toEqual(bytes);
  });

  it("download falls back to whole-object LFS and reconstructs, sha256 verified", async () => {
    const bytes = prng(9000, 42);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr } = await seedObject(serverStore, serverResolver, bytes);
    const handler = serveLfs(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();

    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [ptr], { fetchImpl: handler }),
    );

    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });

    const clientId = await clientResolver.toObject(ptr.oid);
    if (!clientId) throw new Error("mapping missing");
    const got = await collect(clientStore.read(clientId));
    expect(got).toEqual(bytes);
    expect(await sha256Hex(got)).toBe(ptr.oid);
  });

  it("round-trips upload then download to a fresh client over the basic fallback", async () => {
    const bytes = prng(3333, 43);

    const uploader = makeStore();
    const uploaderResolver = memResolver();
    const { ptr } = await seedObject(uploader, uploaderResolver, bytes);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveLfs(serverStore, serverResolver);

    await drain(xetUpload(uploader, uploaderResolver, URL, [ptr], { fetchImpl: handler }));

    const downloader = makeStore();
    const downloaderResolver = memResolver();
    await drain(xetDownload(downloader, downloaderResolver, URL, [ptr], { fetchImpl: handler }));

    const id = await downloaderResolver.toObject(ptr.oid);
    if (!id) throw new Error("mapping missing");
    expect(await collect(downloader.read(id))).toEqual(bytes);
  });
});
