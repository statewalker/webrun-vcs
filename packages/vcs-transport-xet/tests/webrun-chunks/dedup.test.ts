import type { ContentStore } from "@statewalker/webrun-content-store";
import { describe, expect, it } from "vitest";
import {
  serveWebrunChunks,
  webrunChunksDownload,
  webrunChunksUpload,
} from "../../src/webrun-chunks/index.js";
import {
  collect,
  csHash,
  drain,
  makeStore,
  memResolver,
  prng,
  seedObject,
  spyStore,
} from "./helpers.js";

const URL = "http://chunks.test";

async function manifestChunks(store: ContentStore, id: string) {
  const manifest = await store.getManifest(id);
  if (!manifest) throw new Error("no manifest");
  return manifest.chunks;
}

/** Copy a set of chunks from one store to another (pre-seed the far side). */
async function seedChunks(from: ContentStore, to: ContentStore, ids: string[]): Promise<void> {
  for (const id of ids) await to.putChunk(id, from.getChunk(id));
}

describe("webrun-chunks chunk dedup (loopback)", () => {
  it("upload against a webrun-chunks server sends only the chunks the server is missing", async () => {
    const bytes = prng(60000, 21);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { ptr, id } = await seedObject(clientStore, clientResolver, bytes);
    const chunks = await manifestChunks(clientStore, id);
    expect(chunks.length).toBeGreaterThan(1); // dedup is meaningful

    // Server already holds the FIRST chunk.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const seeded = chunks[0].id;
    await seedChunks(clientStore, serverStore, [seeded]);
    const { store: spiedServer, spy } = spyStore(serverStore);
    const handler = serveWebrunChunks(spiedServer, serverResolver);

    const events = await drain(
      webrunChunksUpload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events).toContainEqual({ type: "object-uploaded", oid: ptr.oid });
    expect(spy.putChunkIds).not.toContain(seeded);
    expect(spy.putChunkIds).toHaveLength(chunks.length - 1);

    // The whole object roundtrips into the server's content-store + resolver map.
    const serverId = await serverResolver.toObject(ptr.oid);
    expect(serverId).toBe(id); // same hasher → same content id
    if (!serverId) throw new Error("unreachable");
    expect(await collect(serverStore.read(serverId))).toEqual(bytes);
  });

  it("upload of a partially-shared object transfers only the small delta", async () => {
    const bytes = prng(60000, 22);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { ptr, id } = await seedObject(clientStore, clientResolver, bytes);
    const chunks = await manifestChunks(clientStore, id);

    // Server already holds ALL chunks but the last → exactly one must move.
    const serverStore = makeStore();
    const serverResolver = memResolver();
    const shared = chunks.slice(0, -1).map((c) => c.id);
    await seedChunks(clientStore, serverStore, shared);
    const { store: spiedServer, spy } = spyStore(serverStore);
    const handler = serveWebrunChunks(spiedServer, serverResolver);

    await drain(
      webrunChunksUpload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(spy.putChunkIds).toHaveLength(1);
    expect(spy.putChunkIds).toEqual([chunks[chunks.length - 1].id]);
    expect(await collect(serverStore.read(id))).toEqual(bytes);
  });

  it("download against a webrun-chunks server pulls only the missing chunks and reconstructs", async () => {
    const bytes = prng(60000, 23);

    const serverStore = makeStore();
    const serverResolver = memResolver();
    const { ptr, id } = await seedObject(serverStore, serverResolver, bytes);
    const chunks = await manifestChunks(serverStore, id);
    const handler = serveWebrunChunks(serverStore, serverResolver);

    // Client already holds the FIRST chunk.
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const seeded = chunks[0].id;
    await seedChunks(serverStore, clientStore, [seeded]);
    const { store: spiedClient, spy } = spyStore(clientStore);

    const events = await drain(
      webrunChunksDownload(spiedClient, clientResolver, URL, [ptr], {
        fetchImpl: handler,
        hashContent: csHash,
      }),
    );

    expect(events).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    expect(spy.putChunkIds).not.toContain(seeded);
    expect(spy.putChunkIds).toHaveLength(chunks.length - 1);

    const clientId = await clientResolver.toObject(ptr.oid);
    expect(clientId).toBe(id);
    if (!clientId) throw new Error("unreachable");
    expect(await collect(clientStore.read(clientId))).toEqual(bytes);
  });
});
