import type { TransferCheckpoint } from "@statewalker/webrun-content-transfer";
import { describe, expect, it } from "vitest";
import { serveXet, xetUpload } from "../src/index.js";
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

const URL = "http://xet.test";

describe("resumable xet transfer", () => {
  it("resumes an interrupted upload without re-sending already-delivered chunks", async () => {
    const bytes = prng(60000, 51);

    const clientStore = makeStore();
    const clientResolver = memResolver();
    const { ptr, id } = await seedObject(clientStore, clientResolver, bytes);
    const manifest = await clientStore.getManifest(id);
    if (!manifest) throw new Error("no manifest");
    expect(manifest.chunks.length).toBeGreaterThan(1);

    const serverStore = makeStore();
    const serverResolver = memResolver();

    // Run 1: stop after the first chunk is delivered to the server.
    const handler1 = serveXet(serverStore, serverResolver);
    const done: string[] = [];
    const run1 = xetUpload(clientStore, clientResolver, URL, [ptr], {
      fetchImpl: handler1,
      hashContent: csHash,
      limits: { concurrency: 1 },
    });
    for await (const e of run1) {
      if (e.type === "chunk-sent") {
        done.push(e.chunkId);
        break;
      }
    }
    expect(done).toHaveLength(1);
    // The interrupted upload left no completed-object mapping behind.
    expect(await serverResolver.toObject(ptr.oid)).toBeUndefined();

    // Run 2: resume from the checkpoint — the delivered chunk is not re-sent.
    const checkpoint: TransferCheckpoint = { objectIds: [id], done, pending: [] };
    const { store: spiedServer, spy } = spyStore(serverStore);
    const handler2 = serveXet(spiedServer, serverResolver);
    const events = await drain(
      xetUpload(clientStore, clientResolver, URL, [ptr], {
        fetchImpl: handler2,
        checkpoint,
        hashContent: csHash,
        limits: { concurrency: 1 },
      }),
    );

    expect(spy.putChunkIds).not.toContain(done[0]);
    expect(spy.putChunkIds).toHaveLength(manifest.chunks.length - 1);
    expect(events).toContainEqual({ type: "object-uploaded", oid: ptr.oid });

    const serverId = await serverResolver.toObject(ptr.oid);
    expect(serverId).toBe(id);
    if (!serverId) throw new Error("unreachable");
    expect(await collect(serverStore.read(serverId))).toEqual(bytes);
  });
});
