import { type LfsResolver, sha256Hex } from "@statewalker/vcs-transport-lfs";
import type { ContentStore } from "@statewalker/webrun-content-store";
import { describe, expect, it } from "vitest";
import { serveXet, xetDownload, xetUpload } from "../src/index.js";
import {
  collect,
  csHash,
  drain,
  makeStore,
  memResolver,
  prng,
  seedObject,
  streamOf,
} from "./helpers.js";

const URL = "http://xet.test";

describe("xet interop / integrity", () => {
  it("reconstructs the exact whole object; the reassembly hashes to the LFS oid", async () => {
    const bytes = prng(60000, 61);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr } = await seedObject(serverStore, serverResolver, bytes);
    const handler = serveXet(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    const id = await clientResolver.toObject(ptr.oid);
    if (!id) throw new Error("mapping missing");
    const got = await collect(clientStore.read(id));
    expect(got).toEqual(bytes);
    expect(await sha256Hex(got)).toBe(ptr.oid); // whole-file SHA-256 == LFS oid
  });

  it("rejects a corrupted chunk served by the peer (never records the object)", async () => {
    const bytes = prng(60000, 62);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr, id } = await seedObject(serverStore, serverResolver, bytes);
    const manifest = await serverStore.getManifest(id);
    if (!manifest) throw new Error("no manifest");

    // A peer that serves one corrupted chunk.
    const target = manifest.chunks[0].id;
    const corrupt = await collect(serverStore.getChunk(target));
    corrupt[0] ^= 0xff;
    const badServer: ContentStore = {
      ...serverStore,
      getChunk: (cid) => (cid === target ? streamOf(corrupt) : serverStore.getChunk(cid)),
    };
    const handler = serveXet(badServer, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(await clientResolver.toObject(ptr.oid)).toBeUndefined();
    expect(await clientStore.has(id)).toBe(false);
  });

  it("rejects an object whose whole-file bytes do not hash to the requested oid", async () => {
    // The peer's chunks are all self-consistent, but it maps a bogus oid onto a
    // real object — the whole-file SHA-256 guard must catch the mismatch.
    const real = prng(60000, 63);
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { id } = await seedObject(serverStore, serverResolver, real);

    const bogusOid = await sha256Hex(prng(1000, 7)); // not the sha256 of `real`
    await serverResolver.record(bogusOid, id); // peer lies: bogusOid → real object
    const handler = serveXet(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const ptr = { oid: bogusOid, size: real.length };
    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events).toContainEqual({ type: "error", oid: bogusOid, reason: "sha256 mismatch" });
    expect(await clientResolver.toObject(bogusOid)).toBeUndefined();
    expect(await clientStore.has(id)).toBe(true); // not removed: left for gc
    await clientStore.gc(clientResolver.roots());
    expect(await clientStore.has(id)).toBe(false);
  });
});

describe("xet streaming verification", () => {
  it("rejects a download whose size differs from the pointer (oid right), recording nothing", async () => {
    const real = prng(60000, 71);
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr, id } = await seedObject(serverStore, serverResolver, real);
    const handler = serveXet(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const lying = { oid: ptr.oid, size: ptr.size + 1 };
    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [lying], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events).toContainEqual({ type: "error", oid: ptr.oid, reason: "size mismatch" });
    expect(await clientResolver.toObject(ptr.oid)).toBeUndefined();
    expect(await clientStore.has(id)).toBe(true); // not removed: left for gc
    await clientStore.gc(clientResolver.roots());
    expect(await clientStore.has(id)).toBe(false);
  });

  it("the server refuses a xet upload whose bytes do not hash to the oid", async () => {
    const real = prng(60000, 72);
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { id } = await seedObject(clientStore, clientResolver, real);
    const bogusOid = await sha256Hex(prng(1000, 9));
    await clientResolver.record(bogusOid, id); // the client lies: bogusOid → real object

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveXet(serverStore, serverResolver);
    const events = await drain(
      xetUpload(clientStore, clientResolver, URL, [{ oid: bogusOid, size: real.length }], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events.some((e) => e.type === "error" && e.oid === bogusOid)).toBe(true);
    expect(events).not.toContainEqual({ type: "object-uploaded", oid: bogusOid });
    expect(await serverResolver.toObject(bogusOid)).toBeUndefined();
    expect(await serverStore.has(id)).toBe(true); // not removed: left for gc
    await serverStore.gc(serverResolver.roots());
    expect(await serverStore.has(id)).toBe(false);
  });
});

describe("a refused xet object is left for gc, never removed", () => {
  it("a lying download of the same bytes does not delete an object a correct download is recording", async () => {
    const real = prng(60000, 81);
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr, id } = await seedObject(serverStore, serverResolver, real);
    const bogusOid = await sha256Hex(prng(1000, 82));
    await serverResolver.record(bogusOid, id); // the peer lies: bogusOid → real object
    const handler = serveXet(serverStore, serverResolver);

    const clientStore = makeStore();
    const inner = memResolver();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let recording: () => void = () => {};
    const started = new Promise<void>((r) => {
      recording = r;
    });
    const clientResolver: LfsResolver = {
      toObject: (oid) => inner.toObject(oid),
      async record(oid, objectId) {
        recording();
        await gate; // a slow persistent map: verified and stored, not yet recorded
        await inner.record(oid, objectId);
      },
    };
    const opts = { fetchImpl: handler, hashContent: csHash };
    const correct = drain(xetDownload(clientStore, clientResolver, URL, [ptr], opts));
    await started;
    const lying = await drain(
      xetDownload(clientStore, clientResolver, URL, [{ oid: bogusOid, size: real.length }], opts),
    );
    expect(lying).toContainEqual({ type: "error", oid: bogusOid, reason: "sha256 mismatch" });
    release();
    expect(await correct).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(await collect(clientStore.read(id))).toEqual(real);
  });

  it("a refused download is not recorded, and gc over the resolver's ids reclaims it", async () => {
    const real = prng(60000, 83);
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { id } = await seedObject(serverStore, serverResolver, real);
    const bogusOid = await sha256Hex(prng(1000, 84));
    await serverResolver.record(bogusOid, id);
    const handler = serveXet(serverStore, serverResolver);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const events = await drain(
      xetDownload(clientStore, clientResolver, URL, [{ oid: bogusOid, size: real.length }], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );
    expect(events).toContainEqual({ type: "error", oid: bogusOid, reason: "sha256 mismatch" });
    expect(await clientResolver.toObject(bogusOid)).toBeUndefined();
    expect(await clientStore.has(id)).toBe(true); // left for gc
    expect((await clientStore.gc(clientResolver.roots())).removedObjects).toBe(1);
    expect(await clientStore.has(id)).toBe(false);
  });

  it("a refused xet upload is not recorded on the server, and gc reclaims it there", async () => {
    const real = prng(60000, 85);
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { id } = await seedObject(clientStore, clientResolver, real);
    const bogusOid = await sha256Hex(prng(1000, 86));
    await clientResolver.record(bogusOid, id);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const handler = serveXet(serverStore, serverResolver);
    const events = await drain(
      xetUpload(clientStore, clientResolver, URL, [{ oid: bogusOid, size: real.length }], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );
    expect(events.some((e) => e.type === "error" && e.oid === bogusOid)).toBe(true);
    expect(await serverResolver.toObject(bogusOid)).toBeUndefined();
    expect(await serverStore.has(id)).toBe(true); // left for gc
    expect((await serverStore.gc(serverResolver.roots())).removedObjects).toBe(1);
    expect(await serverStore.has(id)).toBe(false);
  });
});
