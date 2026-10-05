import { sha256Hex } from "@statewalker/vcs-transport-lfs";
import type { ContentStore } from "@statewalker/webrun-content-store";
import { describe, expect, it } from "vitest";
import { serveXet, xetDownload } from "../src/index.js";
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
    expect(await clientStore.has(id)).toBe(false); // removed after the mismatch
  });
});
